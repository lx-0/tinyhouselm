import { describe, expect, it } from 'vitest';
import { SimulationClock } from './clock.js';

describe('SimulationClock', () => {
  it('advances sim time by real_ms * speed', () => {
    const c = new SimulationClock({ mode: 'stepped', speed: 60, startSimTime: 0 });
    c.advance(1000);
    expect(c.simTime).toBe(60);
    expect(c.ticks).toBe(1);
  });

  it('defaults to realtime mode at 10Hz', () => {
    const c = new SimulationClock();
    expect(c.mode).toBe('realtime');
    expect(c.tickHz).toBe(10);
    expect(c.tickMs).toBe(100);
  });
});
