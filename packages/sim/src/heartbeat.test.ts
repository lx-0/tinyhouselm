import type { AgentSnap, WorldObject, Zone } from '@tina/shared';
import { describe, expect, it } from 'vitest';
import { pickAffordanceTarget, pickLeisureZone } from './heartbeat.js';
import type { Perception } from './perception.js';
import { seededRng } from './rng.js';

function mkZone(name: string, x = 0, y = 0): Zone {
  return { name, x, y, width: 2, height: 2 };
}

function mkPerception(overrides: Partial<Perception>): Perception {
  const self: AgentSnap = {
    id: 'self',
    name: 'self',
    position: { x: 0, y: 0 },
    zone: null,
    facing: 'S',
    currentAction: 'idle',
    gotoTarget: null,
  };
  return {
    tick: 0,
    simTime: 0,
    timeOfDay: 'midday',
    self,
    nearby: [],
    recentSpeech: [],
    recentFacts: [],
    recentObservations: [],
    worldBounds: { width: 16, height: 16 },
    zones: [],
    locations: [],
    zoneAffinityHints: null,
    affordanceObjects: [],
    ...overrides,
  };
}

describe('pickLeisureZone', () => {
  it('returns null when no zones are available', () => {
    const rng = seededRng('test-a');
    expect(pickLeisureZone(rng, mkPerception({ zones: [] }))).toBeNull();
  });

  it('falls back to uniform pick when no affinity hints are attached', () => {
    const zones = [mkZone('cafe'), mkZone('park'), mkZone('work')];
    const counts = new Map<string, number>([
      ['cafe', 0],
      ['park', 0],
      ['work', 0],
    ]);
    const rng = seededRng('uniform-test');
    for (let i = 0; i < 600; i++) {
      const zone = pickLeisureZone(rng, mkPerception({ zones, zoneAffinityHints: null }));
      counts.set(zone!.name, (counts.get(zone!.name) ?? 0) + 1);
    }
    for (const [, n] of counts) {
      expect(n).toBeGreaterThan(140);
      expect(n).toBeLessThan(260);
    }
  });
});

describe('pickAffordanceTarget (TINA-416)', () => {
  function bench(id: string, x: number, y: number, zone: string | null = null): WorldObject {
    return { id, label: 'park bench', pos: { x, y }, zone, droppedAtSim: 0, affordance: 'bench' };
  }

  it('returns null when no objects match', () => {
    const obj = pickAffordanceTarget(['bench'], mkPerception({ affordanceObjects: [] }));
    expect(obj).toBeNull();
  });

  it('ignores objects with the wrong affordance type', () => {
    const food: WorldObject = {
      id: 'f',
      label: 'pie',
      pos: { x: 1, y: 1 },
      zone: null,
      droppedAtSim: 0,
      affordance: 'food',
    };
    const obj = pickAffordanceTarget(['bench'], mkPerception({ affordanceObjects: [food] }));
    expect(obj).toBeNull();
  });

  it('picks the closest matching object by chebyshev distance', () => {
    const a = bench('a', 10, 10);
    const b = bench('b', 2, 2);
    const c = bench('c', 5, 5);
    const obj = pickAffordanceTarget(['bench'], mkPerception({ affordanceObjects: [a, b, c] }));
    expect(obj?.id).toBe('b');
  });

  it('breaks ties on chebyshev distance with the lower id (deterministic)', () => {
    // Two benches equidistant from the origin (cheby = 3); deterministic id order wins.
    const a = bench('z-late', 3, 0);
    const b = bench('a-early', 0, 3);
    const obj = pickAffordanceTarget(['bench'], mkPerception({ affordanceObjects: [a, b] }));
    expect(obj?.id).toBe('a-early');
  });

  it('respects the zoneFilter when set (acceptance: bench in Kitchen pulls leisure routing)', () => {
    const inKitchen = bench('k', 4, 4, 'kitchen');
    const inPark = bench('p', 1, 1, 'park');
    // Filter to "kitchen" — even though `park` is closer, only the kitchen bench is eligible.
    const obj = pickAffordanceTarget(
      ['bench'],
      mkPerception({ affordanceObjects: [inKitchen, inPark] }),
      'kitchen',
    );
    expect(obj?.id).toBe('k');
  });
});

describe('pickLeisureZone bias', () => {
  it('biases toward zones where high-affinity friends are', () => {
    const zones = [mkZone('cafe'), mkZone('park'), mkZone('work')];
    const hints = new Map<string, number>([
      ['cafe', 1.0], // friends here
      ['park', 0],
      ['work', -0.8], // one sour pair
    ]);
    const rng = seededRng('biased-test');
    const counts = new Map<string, number>([
      ['cafe', 0],
      ['park', 0],
      ['work', 0],
    ]);
    for (let i = 0; i < 1200; i++) {
      const zone = pickLeisureZone(rng, mkPerception({ zones, zoneAffinityHints: hints }));
      counts.set(zone!.name, (counts.get(zone!.name) ?? 0) + 1);
    }
    const cafe = counts.get('cafe')!;
    const park = counts.get('park')!;
    const work = counts.get('work')!;
    // cafe weight 1.5, park 1.0, work 0.6 → expected ratios ~0.48 / 0.32 / 0.19.
    expect(cafe).toBeGreaterThan(park);
    expect(park).toBeGreaterThan(work);
    // Non-zero chance of unexpected encounters for drama — sour zones never
    // get zeroed out.
    expect(work).toBeGreaterThan(80);
  });
});
