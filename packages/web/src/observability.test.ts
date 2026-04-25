import type { ConversationTurn } from '@tina/shared';
import { describe, expect, test } from 'vitest';
import { ObservabilityStore } from './observability.js';

function turn(speakerId: string, text: string, at: number): ConversationTurn {
  return { speakerId, text, at };
}

describe('ObservabilityStore', () => {
  test('records conversations newest-first and enforces max size', () => {
    const store = new ObservabilityStore({ maxConversations: 3 });
    for (let i = 0; i < 5; i++) {
      store.recordConversation({
        sessionId: `s${i}`,
        participants: ['alpha', 'bravo'],
        participantNames: ['Alpha', 'Bravo'],
        transcript: [turn('alpha', `hi ${i}`, i)],
        openedAt: i,
        closedAt: i + 1,
        reason: 'idle',
      });
    }
    const boot = store.bootstrap();
    expect(boot.conversations.map((c) => c.sessionId)).toEqual(['s4', 's3', 's2']);
  });

  test('aggregates undirected relationships with turn counts', () => {
    const store = new ObservabilityStore();
    store.recordConversation({
      sessionId: 's1',
      participants: ['bravo', 'alpha'],
      participantNames: ['Bravo', 'Alpha'],
      transcript: [turn('alpha', 'hi', 0), turn('bravo', 'hey', 1)],
      openedAt: 0,
      closedAt: 2,
      reason: 'idle',
    });
    store.recordConversation({
      sessionId: 's2',
      participants: ['alpha', 'bravo'],
      participantNames: ['Alpha', 'Bravo'],
      transcript: [turn('alpha', 'again', 10), turn('alpha', 'still there?', 12)],
      openedAt: 10,
      closedAt: 13,
      reason: 'drifted',
    });
    const rels = store.relationsList();
    expect(rels).toHaveLength(1);
    const r = rels[0]!;
    expect([r.a, r.b].sort()).toEqual(['alpha', 'bravo']);
    expect(r.conversations).toBe(2);
    expect(r.turns).toBe(4);
    expect(r.lastAt).toBe(13);
  });

  test('multi-party conversations create edges for every pair', () => {
    const store = new ObservabilityStore();
    store.recordConversation({
      sessionId: 'g1',
      participants: ['a', 'b', 'c'],
      participantNames: ['A', 'B', 'C'],
      transcript: [turn('a', 'x', 0), turn('b', 'y', 1), turn('c', 'z', 2)],
      openedAt: 0,
      closedAt: 3,
      reason: 'idle',
    });
    const rels = store.relationsList();
    expect(rels).toHaveLength(3);
    for (const r of rels) expect(r.conversations).toBe(1);
  });

  test('bootstrap sorts relations by conversation count desc', () => {
    const store = new ObservabilityStore();
    for (let i = 0; i < 3; i++) {
      store.recordConversation({
        sessionId: `s${i}`,
        participants: ['a', 'b'],
        participantNames: ['A', 'B'],
        transcript: [turn('a', 'x', i)],
        openedAt: i,
        closedAt: i + 1,
        reason: 'idle',
      });
    }
    store.recordConversation({
      sessionId: 'one',
      participants: ['c', 'd'],
      participantNames: ['C', 'D'],
      transcript: [turn('c', 'x', 0)],
      openedAt: 0,
      closedAt: 1,
      reason: 'idle',
    });
    const boot = store.bootstrap();
    expect(boot.relations[0]!.conversations).toBe(3);
    expect(boot.relations[1]!.conversations).toBe(1);
  });

  test('per-agent affordance ring is newest-first and capped (TINA-482)', () => {
    const store = new ObservabilityStore({ maxAffordancesPerAgent: 3 });
    for (let i = 0; i < 5; i++) {
      store.recordAffordanceEvent({
        agentId: 'mei',
        agentName: 'Mei',
        objectId: `obj${i}`,
        label: `bench ${i}`,
        affordance: 'sit',
        zone: 'park',
        simTime: i,
      });
    }
    const recent = store.recentAffordancesFor('mei', 5);
    expect(recent.map((e) => e.objectId)).toEqual(['obj4', 'obj3', 'obj2']);
    expect(store.recentAffordancesFor('hiro', 5)).toEqual([]);
  });

  test('recentAffordancesFor honors the per-call limit', () => {
    const store = new ObservabilityStore();
    for (let i = 0; i < 4; i++) {
      store.recordAffordanceEvent({
        agentId: 'mei',
        agentName: 'Mei',
        objectId: `obj${i}`,
        label: 'bench',
        affordance: 'sit',
        zone: 'park',
        simTime: i,
      });
    }
    expect(store.recentAffordancesFor('mei', 2)).toHaveLength(2);
  });

  test('plan events and reflections capped and newest-first', () => {
    const store = new ObservabilityStore({ maxPlanEvents: 2, maxReflections: 2 });
    for (let i = 0; i < 4; i++) {
      store.recordPlanEvent({
        kind: 'plan_committed',
        id: 'alpha',
        name: 'Alpha',
        simTime: i,
        detail: `d${i}`,
      });
      store.recordReflection({
        id: 'alpha',
        name: 'Alpha',
        reflectionId: `r${i}`,
        summary: `sum ${i}`,
        sourceCount: 3,
        trigger: 'manual',
        simTime: i,
      });
    }
    const boot = store.bootstrap();
    expect(boot.planEvents.map((p) => p.detail)).toEqual(['d3', 'd2']);
    expect(boot.reflections.map((r) => r.reflectionId)).toEqual(['r3', 'r2']);
  });
});
