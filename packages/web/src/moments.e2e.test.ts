import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAction } from '@tina/shared';
import { deriveWorldClock } from '@tina/shared';
import {
  type HeartbeatPolicy,
  ParaMemory,
  Runtime,
  type RuntimeEvent,
  SimulationClock,
  World,
  parseSkillSource,
} from '@tina/sim';
import { describe, expect, test } from 'vitest';
import { MomentRoutes } from './moment-routes.js';
import { MomentStore } from './moments.js';

describe('moment capture e2e (runtime → store → route)', () => {
  test('drive a conversation → close → fetch the resulting /moment/:id', async () => {
    const world = new World({
      width: 16,
      height: 16,
      clock: new SimulationClock({ mode: 'stepped', speed: 30, tickHz: 10 }),
    });

    // Both agents within speechRadius so recordSpeech opens a session.
    const meiRoot = await mkdtemp(join(tmpdir(), 'tina-e2e-mei-'));
    const hiroRoot = await mkdtemp(join(tmpdir(), 'tina-e2e-hiro-'));

    const lines: Array<{ agent: string; text: string; tick: number }> = [
      { agent: 'mei', text: 'hi hiro, got a sec?', tick: 1 },
      { agent: 'hiro', text: "oh hey mei, what's up?", tick: 2 },
      { agent: 'mei', text: 'coffee?', tick: 3 },
      { agent: 'hiro', text: 'sure, my shout.', tick: 4 },
    ];
    const scriptedSpeech: HeartbeatPolicy = {
      async decide(ctx) {
        const hit = lines.find((l) => l.agent === ctx.persona.id && l.tick === ctx.perception.tick);
        if (hit) return [{ kind: 'speak', to: null, text: hit.text }] satisfies AgentAction[];
        return [{ kind: 'wait', seconds: 1 }] satisfies AgentAction[];
      },
    };

    const runtime = new Runtime({
      world,
      policy: scriptedSpeech,
      agents: [
        {
          skill: parseSkillSource(
            '---\nname: mei\ndescription: warm, curious\n---\n\n# Mei\n',
            '/virtual/mei/SKILL.md',
          ),
          memory: new ParaMemory({
            root: meiRoot,
            now: () => new Date('2026-04-23T12:00:00Z'),
          }),
          initial: { position: { x: 8, y: 8 } },
        },
        {
          skill: parseSkillSource(
            '---\nname: hiro\ndescription: steady, dry humor\n---\n\n# Hiro\n',
            '/virtual/hiro/SKILL.md',
          ),
          memory: new ParaMemory({
            root: hiroRoot,
            now: () => new Date('2026-04-23T12:00:00Z'),
          }),
          initial: { position: { x: 9, y: 8 } },
        },
      ],
      seed: 7,
      tickMs: 100,
      reflections: false,
      memoryFlushEveryTicks: 0,
    });

    const store = new MomentStore({
      maxMoments: 10,
      idGenerator: (() => {
        let n = 0;
        return () => `e2e${++n}`;
      })(),
      now: () => '2026-04-23T12:00:00.000Z',
    });

    const closeEvents: Array<Extract<RuntimeEvent, { kind: 'conversation_close' }>> = [];
    runtime.setOnEvent((event) => {
      if (event.kind !== 'conversation_close') return;
      closeEvents.push(event);
      if (event.participants.length < 2) return;
      store.captureClose(
        {
          sessionId: event.sessionId,
          simTime: event.simTime,
          openedAt: event.transcript[0]?.at ?? event.simTime,
          transcript: event.transcript.map((t) => ({ ...t })),
          participants: event.participants.map((id) => ({
            id,
            name: id === 'mei' ? 'Mei' : id === 'hiro' ? 'Hiro' : id,
            named: true,
            color: id === 'mei' ? '#ffaaaa' : '#aaffff',
          })),
          zone: null,
          closeReason: event.reason,
        },
        deriveWorldClock(event.simTime, world.clock.speed),
      );
    });

    // Tick enough to cover scripted speech + idle timeout so the session closes.
    await runtime.runTicks(120);

    // Flush any outstanding persistence — make sure the session actually closed.
    await runtime.flushConversations();

    // There should be exactly one multi-party close with both participants.
    const multiParty = closeEvents.find((e) => e.participants.length >= 2);
    expect(
      multiParty,
      `expected a multi-party conversation_close, got: ${JSON.stringify(closeEvents.map((e) => ({ sessionId: e.sessionId, participants: e.participants, reason: e.reason })))}`,
    ).toBeDefined();
    expect(store.count()).toBeGreaterThanOrEqual(1);

    const allMoments = store.list();
    const moment = allMoments.find((m) => m.participants.length >= 2 && m.transcript.length > 0);
    expect(moment).toBeDefined();
    expect(moment!.participants.map((p) => p.id).sort()).toEqual(['hiro', 'mei']);
    expect(moment!.transcript.length).toBeGreaterThan(0);
    expect(moment!.headline).toMatch(/Mei|Hiro/);

    // Route handler: GET /api/moments/:id returns the record.
    const routes = new MomentRoutes({
      store,
      publicBaseUrl: 'https://tinyhouse.up.railway.app',
      checkAdmin: () => ({ ok: true }) as const,
    });
    const jsonRes = mkRes();
    routes.handleMomentJson(jsonRes, moment!.id);
    expect(jsonRes.statusCode).toBe(200);
    const parsed = JSON.parse(jsonRes.body);
    expect(parsed.id).toBe(moment!.id);

    // Route handler: GET /moment/:id returns HTML with the headline + OG tags.
    const pageRes = mkRes();
    routes.handleMomentPage(pageRes, moment!.id);
    expect(pageRes.statusCode).toBe(200);
    expect(pageRes.body).toContain('og:type');
    expect(pageRes.body).toContain(moment!.headline);
    expect(pageRes.body).toContain(`/moment/${moment!.id}`);
  }, 15_000);
});

type MockRes = import('node:http').ServerResponse & {
  statusCode: number;
  body: string;
  responseHeaders: Record<string, string | string[]>;
};

function mkRes(): MockRes {
  const state = {
    statusCode: 0,
    body: '',
    responseHeaders: {} as Record<string, string | string[]>,
  };
  const res = {
    get statusCode() {
      return state.statusCode;
    },
    set statusCode(v: number) {
      state.statusCode = v;
    },
    get body() {
      return state.body;
    },
    get responseHeaders() {
      return state.responseHeaders;
    },
    writeHead(status: number, headers?: Record<string, string | string[]>) {
      state.statusCode = status;
      if (headers) Object.assign(state.responseHeaders, headers);
      return this;
    },
    setHeader(name: string, value: string | string[]) {
      state.responseHeaders[name] = value;
    },
    end(body?: string) {
      state.body = body ?? '';
    },
  } as unknown as MockRes;
  return res;
}
