import type { SimTime } from '@tina/shared';

export type ClockMode = 'realtime' | 'stepped';

export interface ClockOptions {
  mode?: ClockMode;
  speed?: number;
  tickHz?: number;
  startSimTime?: SimTime;
}

export class SimulationClock {
  readonly mode: ClockMode;
  speed: number;
  readonly tickHz: number;
  readonly tickMs: number;
  private _simTime: SimTime;
  private _ticks = 0;

  constructor(opts: ClockOptions = {}) {
    this.mode = opts.mode ?? 'realtime';
    this.speed = opts.speed ?? 60;
    this.tickHz = opts.tickHz ?? 10;
    this.tickMs = 1000 / this.tickHz;
    this._simTime = opts.startSimTime ?? 0;
  }

  get simTime(): SimTime {
    return this._simTime;
  }

  get ticks(): number {
    return this._ticks;
  }

  advance(realMs: number): number {
    const simDelta = (realMs / 1000) * this.speed;
    this._simTime += simDelta;
    this._ticks += 1;
    return simDelta;
  }

  /**
   * One-shot restore hook used by snapshot loading. Overwrites simTime / ticks
   * / speed. Intended to be called exactly once, before the first `advance()`.
   */
  restore(state: { simTime: SimTime; ticks: number; speed?: number }): void {
    if (this._ticks !== 0) {
      throw new Error('SimulationClock.restore() called after ticks have advanced');
    }
    this._simTime = state.simTime;
    this._ticks = state.ticks;
    if (typeof state.speed === 'number' && Number.isFinite(state.speed)) {
      this.speed = state.speed;
    }
  }
}
