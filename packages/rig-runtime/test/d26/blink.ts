import { seededRandom } from '@rig-runtime/modules';
import { problem, throwIfAny } from '@rig-runtime/problems';
import type { Spine } from '@rig-runtime/spine';

// D26 spike (experiment, not production). Periodic, seeded activation of a one-shot secondary animation (blinking).
// The scheduler has its own clock. It does not depend on the primary track, the modules or the skin, so a module change or a
// primary animation change does not restart it.

export type BlinkOptions = {
  readonly seed: number;
  /** Seconds between two blink starts: a uniform value in [minInterval, maxInterval]. */
  readonly minInterval: number;
  readonly maxInterval: number;
  readonly track: number;
  readonly animation: string;
};

export type BlinkSnapshot = { readonly time: number; readonly nextAt: number; readonly count: number; readonly starts: readonly number[] };

/** Blink start times in [0, duration) for a seed. The scheduler gives the same times (rounded up to its frame steps). */
export function plannedBlinks(options: Pick<BlinkOptions, 'seed' | 'minInterval' | 'maxInterval'>, duration: number): number[] {
  const random = seededRandom(options.seed);
  const times: number[] = [];
  for (let at = interval(options, random); at < duration; at += interval(options, random)) times.push(at);
  return times;
}

function interval(options: Pick<BlinkOptions, 'minInterval' | 'maxInterval'>, random: () => number): number {
  return options.minInterval + random() * (options.maxInterval - options.minInterval);
}

export class BlinkScheduler {
  private readonly random: () => number;
  private time = 0;
  private nextAt: number;
  private readonly starts: number[] = [];

  /** `blinkDuration` is the length of the blink animation. An interval shorter than it would cut a blink, so it is an error. */
  constructor(
    readonly options: BlinkOptions,
    blinkDuration: number
  ) {
    const valid = Number.isSafeInteger(options.seed) && Number.isFinite(options.minInterval) && Number.isFinite(options.maxInterval);
    if (!valid || options.minInterval <= blinkDuration || options.maxInterval < options.minInterval || options.maxInterval > 600) {
      throwIfAny([problem('E_BLINK_OPTIONS', `The blink needs an integer seed and ${blinkDuration} s < minInterval <= maxInterval <= 600 s.`)]);
    }
    this.random = seededRandom(options.seed);
    this.nextAt = interval(options, this.random);
  }

  /**
   * Advances the scheduler clock by `delta` seconds and starts the blink animation on its own track when a blink is due.
   * Call it before `AnimationState.update` with the same delta. A start replaces the previous, finished blink entry of the track.
   */
  update(delta: number, state: Spine.AnimationState): void {
    if (!(delta >= 0) || !Number.isFinite(delta)) throwIfAny([problem('E_BLINK_DELTA', 'The frame delta must be a finite non-negative number.')]);
    this.time += delta;
    while (this.time >= this.nextAt) {
      this.starts.push(this.nextAt);
      state.setAnimation(this.options.track, this.options.animation, false);
      this.nextAt += interval(this.options, this.random);
    }
  }

  snapshot(): BlinkSnapshot {
    return { time: this.time, nextAt: this.nextAt, count: this.starts.length, starts: [...this.starts] };
  }
}
