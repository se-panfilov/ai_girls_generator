import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// D26 spike (experiment, not production). This module derives the isolated spike fixture from a copy of the L1 owner export.
// The L1 files stay unchanged. The derived files are in test/fixtures/d26-spike/ and a test compares them with this output.

type Json = Record<string, unknown>;

export const l1Dir = fileURLToPath(new URL('../fixtures/l1-owner/', import.meta.url));
export const spikeDir = fileURLToPath(new URL('../fixtures/d26-spike/', import.meta.url));

export const spikeRigId = 'humanoid_girl_v1_d26_spike';
export const spikeContractVersion = '0.3.0';

/** The new face slot. It is on bone `head`, directly above slot `head` in the draw order, below `ear_near` and `hair_front`. */
export const eyesSlot = {
  id: 'eyes',
  bone: 'head',
  /** Attachment centre in the space of bone `head` (y up), as in the Spine JSON. */
  x: 30,
  y: 120,
  width: 140,
  height: 48,
  /** Region names are `eyes_0`, `eyes_1` and `eyes_2`: open, partly closed, closed. */
  path: 'eyes_',
  frames: 3
} as const;

/** Primary animations of the L1 set. They own the body bones and run on track 0. */
export const primaryAnimations = ['idle', 'run', 'jump_start', 'jump_air', 'jump_land', 'crouch_enter', 'shoot_stand', 'shoot_crouch', 'hit'] as const;

/** Owner table of the spike: each animation has exactly one owner, and each owner has its own track. */
export const animationOwners = [
  { owner: 'primary', track: 0, animations: [...primaryAnimations] },
  { owner: 'blink', track: 1, animations: ['blink'] },
  { owner: 'tail', track: 2, animations: ['tail_idle', 'tail_run', 'tail_jump'] }
] as const;

/** Tail animation that goes with a primary animation. The controller starts it on the tail track. */
export const tailCompanion = { owner: 'tail', fallback: 'tail_idle', byPrimary: { run: 'tail_run', jump_air: 'tail_jump' } } as const;

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const record = (value: unknown, name: string): Json => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`The L1 export has no object ${name}.`);
  return value as Json;
};
const list = (value: unknown, name: string): Json[] => {
  if (!Array.isArray(value)) throw new Error(`The L1 export has no array ${name}.`);
  return value as Json[];
};

/**
 * Derives the spike skeleton from the L1 export:
 * 1. Adds slot `eyes` above `head` with a region attachment that has a 3-frame Spine sequence.
 * 2. Moves the `tail_1` keys out of the primary animations `run` and `jump_air` into the secondary animations `tail_run` and `tail_jump`
 *    (the same values and times). Adds `tail_idle` and a small `tail_2` movement, which only the tail owner keys.
 * 3. Adds the secondary animation `blink`: a SequenceTimeline open → partly closed → closed → partly closed → open, then hold open.
 */
export function deriveSkeleton(source: Json): Json {
  const json = clone(source);
  const skeleton = record(json.skeleton, 'skeleton');
  skeleton.hash = 'd26-spike';
  const slots = list(json.slots, 'slots');
  const head = slots.findIndex((slot) => slot.name === 'head');
  if (head < 0) throw new Error('The L1 export has no slot head.');
  slots.splice(head + 1, 0, { name: eyesSlot.id, bone: eyesSlot.bone, attachment: eyesSlot.id });
  const skins = list(json.skins, 'skins');
  const attachments = record(skins[0]?.attachments, 'skins[0].attachments');
  attachments[eyesSlot.id] = {
    [eyesSlot.id]: { path: eyesSlot.path, x: eyesSlot.x, y: eyesSlot.y, width: eyesSlot.width, height: eyesSlot.height, sequence: { count: eyesSlot.frames, start: 0, setup: 0 } }
  };
  const animations = record(json.animations, 'animations');
  const bonesOf = (name: string): Json => record(record(animations[name], name).bones, `${name}.bones`);
  const runBones = bonesOf('run');
  const jumpBones = bonesOf('jump_air');
  const runTail = runBones.tail_1;
  const jumpTail = jumpBones.tail_1;
  if (runTail === undefined || jumpTail === undefined) throw new Error('The L1 export has no tail_1 keys in run and jump_air.');
  delete runBones.tail_1;
  delete jumpBones.tail_1;
  animations.tail_run = { bones: { tail_1: runTail, tail_2: { rotate: [{ value: 8 }, { time: 0.3, value: -8 }, { time: 0.6, value: 8 }] } } };
  animations.tail_jump = { bones: { tail_1: jumpTail, tail_2: { rotate: [{ value: -10 }] } } };
  animations.tail_idle = {
    bones: {
      tail_1: { rotate: [{ value: 4 }, { time: 0.6, value: -4 }, { time: 1.2, value: 4 }] },
      tail_2: { rotate: [{ value: -3 }, { time: 0.6, value: 3 }, { time: 1.2, value: -3 }] }
    }
  };
  animations.blink = {
    attachments: {
      default: {
        [eyesSlot.id]: {
          [eyesSlot.id]: {
            sequence: [
              { mode: 'once', index: 0, delay: 0.05 },
              { time: 0.15, mode: 'onceReverse', delay: 0.05 },
              { time: 0.3, mode: 'hold', index: 0 }
            ]
          }
        }
      }
    }
  };
  // Stable key order of the animation map.
  json.animations = Object.fromEntries(
    Object.keys(animations)
      .sort()
      .map((name) => [name, animations[name]])
  );
  return json;
}

/** Derives the spike contract: the new slot `eyes` with its rectangle, new draw order indexes, the new animations and the owner table. */
export function deriveContract(source: Json, skeletonText: string): Json {
  const json = clone(source);
  json.rigId = spikeRigId;
  json.contractVersion = spikeContractVersion;
  json.experiment = 'D26 spike fixture. Not a production contract. Derived from the L1 test contract 0.2.0.';
  const spine = record(json.spine, 'spine');
  spine.skeletonFile = 'skeleton.json';
  spine.skeletonSha256 = sha256(skeletonText);
  const slots = list(json.slots, 'slots');
  const head = slots.find((slot) => slot.id === 'head');
  const headRect = record(head?.attachmentRect, 'head.attachmentRect');
  if (!head || typeof head.drawOrder !== 'number') throw new Error('The L1 contract has no slot head.');
  const order = head.drawOrder + 1;
  for (const slot of slots) if (typeof slot.drawOrder === 'number' && slot.drawOrder >= order) slot.drawOrder += 1;
  // Canvas rectangle (y down) of the eyes: the head rectangle centre plus the offset of the eyes from the head attachment centre.
  const headAttachment = { x: 7, y: 110 };
  const centreX = Number(headRect.x) + Number(headRect.w) / 2 + (eyesSlot.x - headAttachment.x);
  const centreY = Number(headRect.y) + Number(headRect.h) / 2 - (eyesSlot.y - headAttachment.y);
  const eyes = {
    id: eyesSlot.id,
    bone: eyesSlot.bone,
    drawOrder: order,
    required: false,
    category: 'face',
    attachmentRect: { x: centreX - eyesSlot.width / 2, y: centreY - eyesSlot.height / 2, w: eyesSlot.width, h: eyesSlot.height },
    frames: { count: eyesSlot.frames, names: ['open', 'partly_closed', 'closed'] }
  };
  slots.splice(slots.indexOf(head) + 1, 0, eyes);
  const animations = list(json.animations, 'animations');
  animations.push({ id: 'blink', loop: false }, { id: 'tail_idle', loop: true }, { id: 'tail_run', loop: true }, { id: 'tail_jump', loop: true });
  json.animationOwners = clone(animationOwners);
  json.companions = [clone(tailCompanion)];
  return json;
}

/** The text of the derived fixture files. JSON with two-space indent and a final newline. */
export function deriveFixtureTexts(): { skeleton: string; contract: string } {
  const skeletonSource = JSON.parse(readFileSync(`${l1Dir}editor-out/skeleton.json`, 'utf8')) as Json;
  const contractSource = JSON.parse(readFileSync(`${l1Dir}rig.contract.json`, 'utf8')) as Json;
  const skeleton = `${JSON.stringify(deriveSkeleton(skeletonSource), null, 2)}\n`;
  const contract = `${JSON.stringify(deriveContract(contractSource, skeleton), null, 2)}\n`;
  return { skeleton, contract };
}

export const readSpikeFile = (name: 'skeleton.json' | 'rig.contract.json'): string => readFileSync(`${spikeDir}${name}`, 'utf8');
