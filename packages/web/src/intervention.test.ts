import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  Delta,
  InterventionKind,
  ObjectAffordance,
  SimTime,
  Vec2,
  WorldObject,
} from '@tina/shared';
import { describe, expect, it } from 'vitest';
import { InterventionHandlers } from './intervention.js';

interface FakeResp {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function fakeReq(opts: {
  method: string;
  headers?: Record<string, string>;
  remoteAddress?: string;
  body?: unknown;
}): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage & { push: (c: Buffer | null) => void };
  Object.assign(req, {
    method: opts.method,
    headers: opts.headers ?? {},
    socket: { remoteAddress: opts.remoteAddress ?? '127.0.0.1' },
  });
  const raw = opts.body == null ? '' : JSON.stringify(opts.body);
  // Support `for await` over the request.
  (req as unknown as { [Symbol.asyncIterator]: () => AsyncIterator<Buffer> })[
    Symbol.asyncIterator
  ] = async function* () {
    if (raw.length > 0) yield Buffer.from(raw);
  };
  return req as IncomingMessage;
}

function fakeRes(): ServerResponse & FakeResp {
  const res: FakeResp & {
    writeHead: ServerResponse['writeHead'];
    setHeader: ServerResponse['setHeader'];
    end: ServerResponse['end'];
  } = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(statusCode: number, headers?: Record<string, string | number | string[]>) {
      res.statusCode = statusCode;
      if (headers) {
        for (const [k, v] of Object.entries(headers)) res.headers[k.toLowerCase()] = String(v);
      }
      return res as unknown as ServerResponse;
    },
    setHeader(name: string, value: string | number | readonly string[]) {
      res.headers[name.toLowerCase()] = String(value);
      return res as unknown as ServerResponse;
    },
    end(body?: string) {
      if (body) res.body += body;
      return res as unknown as ServerResponse;
    },
  } as unknown as FakeResp & ServerResponse;
  return res as ServerResponse & FakeResp;
}

interface FakeRuntimeCalls {
  whisper: Array<{ agentId: string; text: string }>;
  event: Array<{ text: string; zone?: string | null; agentIds?: string[] }>;
  drop: Array<{
    label: string;
    zone?: string | null;
    pos?: Vec2;
    id?: string;
    affordance?: ObjectAffordance | null;
  }>;
  remove: Array<{ id: string }>;
  nudge: Array<{ a: string; b: string; direction: 'spark' | 'tension' | 'reconcile' }>;
}

function fakeRuntime(
  calls: FakeRuntimeCalls,
  overrides?: Partial<{ drop: WorldObject; removeAffected: string[] }>,
): InstanceType<typeof InterventionHandlers>['runtime' & string] {
  const simTime: SimTime = 42;
  const runtime = {
    injectWhisper: (input: { agentId: string; text: string }) => {
      calls.whisper.push(input);
      return { simTime, affected: [input.agentId], summary: input.text };
    },
    injectWorldEvent: (input: { text: string; zone?: string | null; agentIds?: string[] }) => {
      calls.event.push(input);
      return { simTime, affected: input.agentIds ?? ['a', 'b'], summary: input.text };
    },
    dropObject: (input: {
      label: string;
      zone?: string | null;
      pos?: Vec2;
      id?: string;
      affordance?: ObjectAffordance | null;
    }) => {
      calls.drop.push(input);
      const object: WorldObject = overrides?.drop ?? {
        id: input.id ?? 'obj-1',
        label: input.label,
        pos: input.pos ?? { x: 0, y: 0 },
        zone: input.zone ?? null,
        droppedAtSim: simTime,
        affordance: input.affordance ?? null,
      };
      return { simTime, affected: ['a'], summary: `dropped ${input.label}`, object };
    },
    removeObject: (input: { id: string }) => {
      calls.remove.push(input);
      return {
        simTime,
        affected: overrides?.removeAffected ?? ['a'],
        summary: `removed ${input.id}`,
      };
    },
    queueRelationshipNudge: (input: {
      a: string;
      b: string;
      direction: 'spark' | 'tension' | 'reconcile';
    }) => {
      calls.nudge.push(input);
      return {
        simTime,
        affected: [input.a, input.b],
        summary: `nudge ${input.direction}: ${input.a} ↔ ${input.b}`,
        nudge: { a: input.a, b: input.b, direction: input.direction, queuedAtSim: simTime },
      };
    },
  };
  return runtime as unknown as ReturnType<typeof fakeRuntime>;
}

function makeHandlers(
  adminToken: string | null = 'secret',
  calls: FakeRuntimeCalls = { whisper: [], event: [], drop: [], remove: [], nudge: [] },
) {
  const broadcasts: Delta[] = [];
  const admits: InterventionKind[] = [];
  const handlers = new InterventionHandlers({
    runtime: fakeRuntime(calls),
    broadcast: (d) => broadcasts.push(d),
    onAdmit: (k) => admits.push(k),
    adminToken,
  });
  return { handlers, broadcasts, admits, calls };
}

describe('InterventionHandlers.tryHandle', () => {
  it('returns false for non-POST / non-matching paths', async () => {
    const { handlers } = makeHandlers();
    const req = fakeReq({ method: 'GET' });
    const res = fakeRes();
    expect(await handlers.tryHandle(req, res, '/api/admin/intervention/whisper')).toBe(false);
    expect(await handlers.tryHandle(req, res, '/api/admin/bootstrap')).toBe(false);
  });

  it('401 when admin token is required and missing', async () => {
    const { handlers } = makeHandlers('secret');
    const req = fakeReq({
      method: 'POST',
      remoteAddress: '8.8.8.8',
      body: { agentId: 'a', text: 'hi' },
    });
    const res = fakeRes();
    await handlers.tryHandle(req, res, '/api/admin/intervention/whisper');
    expect(res.statusCode).toBe(401);
  });

  it('401 when admin token is wrong', async () => {
    const { handlers } = makeHandlers('secret');
    const req = fakeReq({
      method: 'POST',
      headers: { 'x-admin-token': 'nope' },
      body: { agentId: 'a', text: 'hi' },
    });
    const res = fakeRes();
    await handlers.tryHandle(req, res, '/api/admin/intervention/whisper');
    expect(res.statusCode).toBe(401);
  });

  it('200 when admin token matches', async () => {
    const { handlers, broadcasts, admits, calls } = makeHandlers('secret');
    const req = fakeReq({
      method: 'POST',
      headers: { 'x-admin-token': 'secret' },
      body: { agentId: 'a', text: 'hi' },
    });
    const res = fakeRes();
    await handlers.tryHandle(req, res, '/api/admin/intervention/whisper');
    expect(res.statusCode).toBe(200);
    expect(calls.whisper).toEqual([{ agentId: 'a', text: 'hi' }]);
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({ kind: 'intervention', type: 'whisper' });
    expect(admits).toEqual(['whisper']);
  });

  it('200 from localhost when no admin token is configured', async () => {
    const { handlers } = makeHandlers(null);
    const req = fakeReq({
      method: 'POST',
      remoteAddress: '127.0.0.1',
      body: { agentId: 'a', text: 'hi' },
    });
    const res = fakeRes();
    await handlers.tryHandle(req, res, '/api/admin/intervention/whisper');
    expect(res.statusCode).toBe(200);
  });

  it('401 from non-localhost when no admin token is configured', async () => {
    const { handlers } = makeHandlers(null);
    const req = fakeReq({
      method: 'POST',
      remoteAddress: '8.8.8.8',
      body: { agentId: 'a', text: 'hi' },
    });
    const res = fakeRes();
    await handlers.tryHandle(req, res, '/api/admin/intervention/whisper');
    expect(res.statusCode).toBe(401);
  });

  it('400 when JSON body is malformed', async () => {
    const { handlers } = makeHandlers('secret');
    const req = new EventEmitter() as IncomingMessage;
    Object.assign(req, {
      method: 'POST',
      headers: { 'x-admin-token': 'secret' },
      socket: { remoteAddress: '127.0.0.1' },
    });
    (req as unknown as { [Symbol.asyncIterator]: () => AsyncIterator<Buffer> })[
      Symbol.asyncIterator
    ] = async function* () {
      yield Buffer.from('not-json');
    };
    const res = fakeRes();
    await handlers.tryHandle(req, res, '/api/admin/intervention/whisper');
    expect(res.statusCode).toBe(400);
  });

  it('400 when fields are missing or invalid', async () => {
    const { handlers } = makeHandlers('secret');
    const req = fakeReq({
      method: 'POST',
      headers: { 'x-admin-token': 'secret' },
      body: { agentId: 'a', text: '   ' },
    });
    const res = fakeRes();
    await handlers.tryHandle(req, res, '/api/admin/intervention/whisper');
    expect(res.statusCode).toBe(400);
  });

  it('413-equivalent: 400 when body exceeds max size', async () => {
    const big = 'x'.repeat(5000);
    const { handlers } = makeHandlers('secret');
    const req = fakeReq({
      method: 'POST',
      headers: { 'x-admin-token': 'secret' },
      body: { agentId: 'a', text: big },
    });
    const res = fakeRes();
    await handlers.tryHandle(req, res, '/api/admin/intervention/whisper');
    expect(res.statusCode).toBe(400);
  });

  it('event handler passes zone and agentIds through', async () => {
    const { handlers, calls, broadcasts } = makeHandlers('secret');
    const req = fakeReq({
      method: 'POST',
      headers: { 'x-admin-token': 'secret' },
      body: { text: 'fire!', zone: 'cafe', agentIds: ['a', 'b'] },
    });
    const res = fakeRes();
    await handlers.tryHandle(req, res, '/api/admin/intervention/event');
    expect(res.statusCode).toBe(200);
    expect(calls.event[0]).toMatchObject({ text: 'fire!', zone: 'cafe', agentIds: ['a', 'b'] });
    expect(broadcasts[0]).toMatchObject({
      kind: 'intervention',
      type: 'world_event',
      zone: 'cafe',
    });
  });

  it('object drop forwards affordance + rejects unknown values (TINA-416)', async () => {
    const { handlers, calls, broadcasts } = makeHandlers('secret');
    const okReq = fakeReq({
      method: 'POST',
      headers: { 'x-admin-token': 'secret' },
      body: { op: 'drop', label: 'park bench', zone: 'park', affordance: 'bench' },
    });
    const okRes = fakeRes();
    await handlers.tryHandle(okReq, okRes, '/api/admin/intervention/object');
    expect(okRes.statusCode).toBe(200);
    expect(calls.drop[0]).toMatchObject({ label: 'park bench', affordance: 'bench' });
    expect(broadcasts[0]).toMatchObject({ kind: 'intervention', type: 'object_drop' });

    const badReq = fakeReq({
      method: 'POST',
      headers: { 'x-admin-token': 'secret' },
      body: { op: 'drop', label: 'mystery', affordance: 'gizmo' },
    });
    const badRes = fakeRes();
    await handlers.tryHandle(badReq, badRes, '/api/admin/intervention/object');
    expect(badRes.statusCode).toBe(400);
    // Bogus drop must not have been forwarded to the runtime.
    expect(calls.drop).toHaveLength(1);
  });

  it('object drop and remove dispatch correctly', async () => {
    const { handlers, calls, broadcasts } = makeHandlers('secret');
    const dropReq = fakeReq({
      method: 'POST',
      headers: { 'x-admin-token': 'secret' },
      body: { op: 'drop', label: 'letter', zone: 'cafe' },
    });
    const dropRes = fakeRes();
    await handlers.tryHandle(dropReq, dropRes, '/api/admin/intervention/object');
    expect(dropRes.statusCode).toBe(200);
    expect(calls.drop[0]).toMatchObject({ label: 'letter', zone: 'cafe' });
    expect(broadcasts[0]).toMatchObject({ kind: 'intervention', type: 'object_drop' });

    const removeReq = fakeReq({
      method: 'POST',
      headers: { 'x-admin-token': 'secret' },
      body: { op: 'remove', id: 'obj-1' },
    });
    const removeRes = fakeRes();
    await handlers.tryHandle(removeReq, removeRes, '/api/admin/intervention/object');
    expect(removeRes.statusCode).toBe(200);
    expect(calls.remove).toEqual([{ id: 'obj-1' }]);
    expect(broadcasts[1]).toMatchObject({ kind: 'intervention', type: 'object_remove' });
  });

  it('nudge handler dispatches to queueRelationshipNudge and broadcasts the intervention delta', async () => {
    const { handlers, calls, broadcasts, admits } = makeHandlers('secret');
    const req = fakeReq({
      method: 'POST',
      headers: { 'x-admin-token': 'secret' },
      body: { a: 'mei', b: 'bruno', direction: 'spark' },
    });
    const res = fakeRes();
    await handlers.tryHandle(req, res, '/api/admin/intervention/nudge');
    expect(res.statusCode).toBe(200);
    expect(calls.nudge).toEqual([{ a: 'mei', b: 'bruno', direction: 'spark' }]);
    expect(broadcasts[0]).toMatchObject({
      kind: 'intervention',
      type: 'relationship_nudge',
      affected: ['mei', 'bruno'],
    });
    expect(admits).toEqual(['relationship_nudge']);
  });

  it('nudge handler rejects unknown direction and missing fields', async () => {
    const { handlers } = makeHandlers('secret');
    const bad = fakeReq({
      method: 'POST',
      headers: { 'x-admin-token': 'secret' },
      body: { a: 'mei', b: 'bruno', direction: 'whoops' },
    });
    const badRes = fakeRes();
    await handlers.tryHandle(bad, badRes, '/api/admin/intervention/nudge');
    expect(badRes.statusCode).toBe(400);

    const missing = fakeReq({
      method: 'POST',
      headers: { 'x-admin-token': 'secret' },
      body: { a: 'mei', direction: 'spark' },
    });
    const missingRes = fakeRes();
    await handlers.tryHandle(missing, missingRes, '/api/admin/intervention/nudge');
    expect(missingRes.statusCode).toBe(400);
  });

  it('nudge endpoint shares the same per-IP rate limit as other interventions', async () => {
    const now = 1_000_000;
    const calls: FakeRuntimeCalls = { whisper: [], event: [], drop: [], remove: [], nudge: [] };
    const runtime = fakeRuntime(calls);
    const handlers = new InterventionHandlers({
      runtime,
      broadcast: () => {},
      adminToken: 'secret',
      perIpRatePerMin: 2,
      globalRatePerMin: 100,
      now: () => now,
    });
    const mk = () =>
      fakeReq({
        method: 'POST',
        headers: { 'x-admin-token': 'secret' },
        remoteAddress: '10.0.0.7',
        body: { a: 'mei', b: 'bruno', direction: 'spark' },
      });
    const r1 = fakeRes();
    const r2 = fakeRes();
    const r3 = fakeRes();
    await handlers.tryHandle(mk(), r1, '/api/admin/intervention/nudge');
    await handlers.tryHandle(mk(), r2, '/api/admin/intervention/nudge');
    await handlers.tryHandle(mk(), r3, '/api/admin/intervention/nudge');
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r3.statusCode).toBe(429);
  });

  it('rate limits the same IP past perIpRatePerMin', async () => {
    let now = 1_000_000;
    const runtime = fakeRuntime({
      whisper: [],
      event: [],
      drop: [],
      remove: [],
      nudge: [],
    });
    const handlers = new InterventionHandlers({
      runtime,
      broadcast: () => {},
      adminToken: 'secret',
      perIpRatePerMin: 2,
      globalRatePerMin: 100,
      now: () => now,
    });
    const mk = () =>
      fakeReq({
        method: 'POST',
        headers: { 'x-admin-token': 'secret' },
        remoteAddress: '10.0.0.1',
        body: { agentId: 'a', text: 'hi' },
      });
    const r1 = fakeRes();
    const r2 = fakeRes();
    const r3 = fakeRes();
    await handlers.tryHandle(mk(), r1, '/api/admin/intervention/whisper');
    await handlers.tryHandle(mk(), r2, '/api/admin/intervention/whisper');
    await handlers.tryHandle(mk(), r3, '/api/admin/intervention/whisper');
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r3.statusCode).toBe(429);
    expect(r3.headers['retry-after']).toBeDefined();

    // Advance past the window and the bucket resets.
    now += 61_000;
    const r4 = fakeRes();
    await handlers.tryHandle(mk(), r4, '/api/admin/intervention/whisper');
    expect(r4.statusCode).toBe(200);
  });
});
