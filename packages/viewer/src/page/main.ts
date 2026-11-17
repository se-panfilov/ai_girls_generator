/// <reference lib="dom" />
// The viewer page. It loads the Spine export through the official Spine web runtime (spine-webcomponents 4.3) and plays its animations.
// The page does not animate anything itself: the runtime reads the bones, slots, and animation keys from the exported JSON.
// window.aiggViewer gives the state to the smoke test. It is a read and control surface for tests, not an API.
import { errorText, type PageConfig, parsePageConfig, withTimeout } from '@viewer/pageconfig';

const loadTimeoutMs = 60_000;
/** A short cross-fade when the animation changes. The runtime supports it directly (AnimationStateData.defaultMix). */
const mixSeconds = 0.2;

// Local types of the runtime objects that the page uses (spine-webcomponents 4.3.13 and spine-core 4.3.13). runtime.js loads the runtime.
type TrackEntry = { readonly animation: { readonly name: string } | null; readonly trackTime: number };
type AnimationState = { timeScale: number; getTrack: (track: number) => TrackEntry | null; setAnimation: (track: number, name: string, loop: boolean) => unknown };
type Bone = { readonly data: { readonly name: string }; readonly appliedPose: { readonly rotation: number; readonly worldX: number; readonly worldY: number } };
type Skeleton = { readonly bones: readonly Bone[]; readonly slots: readonly unknown[]; readonly data: { readonly animations: readonly unknown[]; findAnimation: (name: string) => unknown } };
type SpineWebComponentSkeleton = HTMLElement & {
  readonly whenReady: Promise<SpineWebComponentSkeleton>;
  readonly skeleton?: Skeleton;
  readonly state?: AnimationState;
  readonly disposed: boolean;
  dispose: () => void;
};

type Status = 'loading' | 'ready' | 'error' | 'disposed';
type BoneSample = { readonly name: string; readonly rotation: number; readonly worldX: number; readonly worldY: number };
type Snapshot = {
  readonly status: Status;
  readonly message: string;
  readonly animation: string | null;
  readonly paused: boolean;
  readonly trackTime: number | null;
  readonly sameSkeleton: boolean;
  readonly skeletonsCreated: number;
  readonly bones: readonly BoneSample[];
  readonly animations: readonly string[];
};
type ViewerApi = {
  snapshot: () => Snapshot;
  play: (name: string) => void;
  pause: (paused: boolean) => void;
  restart: () => void;
  dispose: () => void;
};

declare global {
  interface Window {
    aiggViewer?: ViewerApi;
  }
}

const element = (id: string): HTMLElement => {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`The page has no element #${id}.`);
  return found;
};

const statusElement = element('status') as HTMLOutputElement;
const animationElement = element('animation');
const stage = element('stage');
const buttons = {
  idle: element('idle') as HTMLButtonElement,
  wave: element('wave') as HTMLButtonElement,
  pause: element('pause') as HTMLButtonElement,
  restart: element('restart') as HTMLButtonElement
};

let status: Status = 'loading';
let message = 'Loading…';
let widget: SpineWebComponentSkeleton | null = null;
let firstSkeleton: unknown = null;
let skeletonsCreated = 0;
let paused = false;
let config: PageConfig | null = null;

function setStatus(next: Status, text: string): void {
  status = next;
  message = text;
  statusElement.dataset.status = next;
  statusElement.textContent = text;
  statusElement.setAttribute('role', next === 'error' ? 'alert' : 'status');
  const enabled = next === 'ready';
  for (const button of Object.values(buttons)) button.disabled = !enabled;
}

function fail(error: unknown): void {
  if (status === 'error' || status === 'disposed') return;
  setStatus('error', errorText(error));
}

function currentAnimation(): string | null {
  return widget?.state?.getTrack(0)?.animation?.name ?? null;
}

function showAnimation(): void {
  const name = currentAnimation();
  animationElement.textContent = name ?? 'none';
  buttons.idle.setAttribute('aria-pressed', String(name === 'idle'));
  buttons.wave.setAttribute('aria-pressed', String(name === 'wave'));
  buttons.pause.textContent = paused ? 'Resume' : 'Pause';
}

/** Changes the animation on track 0 of the same skeleton. No new skeleton is created. */
function play(name: string): void {
  const state = widget?.state;
  if (status !== 'ready' || !state || !config?.animations.includes(name)) return;
  state.setAnimation(0, name, true);
  showAnimation();
}

function pause(value: boolean): void {
  const state = widget?.state;
  if (status !== 'ready' || !state) return;
  paused = value;
  state.timeScale = paused ? 0 : 1;
  showAnimation();
}

function restart(): void {
  const name = currentAnimation();
  if (name !== null) play(name);
}

/** Frees the GPU textures, the skeleton, and the element through the runtime (SpineWebComponentSkeleton.dispose). */
function dispose(): void {
  if (widget !== null && !widget.disposed) widget.dispose();
  widget = null;
  setStatus('disposed', 'Viewer disposed.');
}

function snapshot(): Snapshot {
  const skeleton = widget?.skeleton;
  const entry = widget?.state?.getTrack(0);
  return {
    status,
    message,
    animation: currentAnimation(),
    paused,
    trackTime: entry ? entry.trackTime : null,
    sameSkeleton: skeleton !== undefined && skeleton === firstSkeleton,
    skeletonsCreated,
    bones: skeleton ? skeleton.bones.map((bone) => ({ name: bone.data.name, rotation: bone.appliedPose.rotation, worldX: bone.appliedPose.worldX, worldY: bone.appliedPose.worldY })) : [],
    animations: config?.animations ?? []
  };
}

async function loadConfig(): Promise<PageConfig> {
  let response: Response;
  try {
    response = await fetch('viewer.json', { cache: 'no-store' });
  } catch {
    throw new Error('The viewer server does not answer. Start it again with the documented command.');
  }
  if (!response.ok) throw new Error(`viewer.json: HTTP ${response.status}.`);
  const parsed = parsePageConfig(await response.json());
  if (typeof parsed === 'string') throw new Error(parsed);
  return parsed;
}

/** Checks that each export file answers, so that a missing file gets a clear message before the runtime starts. */
async function checkFiles(urls: readonly string[]): Promise<void> {
  for (const url of urls) {
    const response = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}. The file is missing or cannot be loaded.`);
  }
}

async function start(): Promise<void> {
  setStatus('loading', 'Loading viewer.json…');
  config = await loadConfig();
  await checkFiles([config.skeleton, config.atlas]);
  await withTimeout(customElements.whenDefined('spine-skeleton'), loadTimeoutMs, 'The Spine web runtime did not start.');
  setStatus('loading', `Loading ${config.skeleton}, ${config.atlas}, and the atlas pages…`);
  const created = document.createElement('spine-skeleton') as SpineWebComponentSkeleton;
  created.setAttribute('identifier', 'character');
  created.setAttribute('atlas', config.atlas);
  created.setAttribute('skeleton', config.skeleton);
  created.setAttribute('animation', 'idle');
  // The bounds include all frames of both animations, so the raised arm and the sword stay in the view.
  created.setAttribute('animation-bounds', config.required.join(','));
  created.setAttribute('fit', 'contain');
  created.setAttribute('default-mix', String(mixSeconds));
  for (const side of ['pad-top', 'pad-bottom', 'pad-left', 'pad-right']) created.setAttribute(side, '0.04');
  widget = created;
  stage.appendChild(created);
  const ready = await withTimeout(created.whenReady, loadTimeoutMs, `The Spine runtime did not finish loading in ${loadTimeoutMs / 1000} s.`);
  if (!ready.skeleton || !ready.state) throw new Error('The Spine runtime did not make a skeleton.');
  for (const name of config.required) {
    if (!ready.skeleton.data.findAnimation(name)) throw new Error(`The skeleton has no animation ${name}.`);
  }
  firstSkeleton = ready.skeleton;
  skeletonsCreated += 1;
  setStatus('ready', `Ready: ${ready.skeleton.bones.length} bones, ${ready.skeleton.slots.length} slots, ${ready.skeleton.data.animations.length} animations.`);
  play('idle');
}

window.aiggViewer = { snapshot, play, pause, restart, dispose };
buttons.idle.addEventListener('click', () => {
  play('idle');
});
buttons.wave.addEventListener('click', () => {
  play('wave');
});
buttons.pause.addEventListener('click', () => {
  pause(!paused);
});
buttons.restart.addEventListener('click', restart);
window.addEventListener('error', (event) => {
  if (status === 'loading') fail(event.error ?? event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  if (status === 'loading') fail(event.reason);
});
window.addEventListener('pagehide', dispose);
start().catch(fail);
