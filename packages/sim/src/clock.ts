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
}
