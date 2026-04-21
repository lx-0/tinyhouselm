import { dayPhaseForHour, deriveWorldClock } from '@tina/shared';
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

describe('deriveWorldClock', () => {
  it('derives day/hour/minute/dayOfWeek from simTime', () => {
    // day 2, 13:45
    const simTime = 2 * 86400 + 13 * 3600 + 45 * 60;
    const c = deriveWorldClock(simTime, 60);
    expect(c.day).toBe(2);
    expect(c.hour).toBe(13);
    expect(c.minute).toBe(45);
    expect(c.dayOfWeek).toBe(2);
    expect(c.phase).toBe('day');
    expect(c.speed).toBe(60);
  });

  it('labels dawn/day/dusk/night bands', () => {
    expect(dayPhaseForHour(2)).toBe('night');
    expect(dayPhaseForHour(5)).toBe('dawn');
    expect(dayPhaseForHour(8)).toBe('day');
    expect(dayPhaseForHour(19)).toBe('dusk');
    expect(dayPhaseForHour(22)).toBe('night');
  });

  it('wraps dayOfWeek across the week boundary', () => {
    const c = deriveWorldClock(7 * 86400 + 60, 60);
    expect(c.day).toBe(7);
    expect(c.dayOfWeek).toBe(0);
    expect(c.minute).toBe(1);
  });
});
