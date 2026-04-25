import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { type MomentRecord, deriveWorldClock } from '@tina/shared';
import { type NudgeDirection, RelationshipStore } from '@tina/sim';
import { describe, expect, test } from 'vitest';
import {
  type Digest,
  DigestRoutes,
  buildDigest,
  buildDigestHeadline,
  formatDigestDate,
  parseDigestDate,
} from './digest-routes.js';
import { MomentStore } from './moments.js';
import { OG_HEIGHT, OG_WIDTH } from './og-image.js';
import { OgCache } from './og-routes.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const SECONDS_PER_DAY = 86400;

function mockReq(
  opts: { headers?: Record<string, string>; remoteAddress?: string } = {},
): IncomingMessage {
  const stream = Readable.from([]) as unknown as IncomingMessage;
  stream.method = 'GET';
  stream.url = '/';
  stream.headers = opts.headers ?? {};
  (stream as unknown as { socket: { remoteAddress: string } }).socket = {
    remoteAddress: opts.remoteAddress ?? '127.0.0.1',
  };
  return stream;
}

type MockRes = ServerResponse & {
  statusCode: number;
  body: Buffer;
  responseHeaders: Record<string, string | string[]>;
};

function mockRes(): MockRes {
  const state = {
    statusCode: 0,
    body: Buffer.alloc(0),
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
    end(body?: string | Buffer) {
      if (body == null) state.body = Buffer.alloc(0);
      else if (typeof body === 'string') state.body = Buffer.from(body);
      else state.body = Buffer.from(body);
    },
  } as unknown as MockRes;
  return res;
}

interface SeedSpec {
  sessionId: string;
  hour: number;
  day: number;
  variant?: 'conversation' | 'group';
  participants: Array<{ id: string; name: string; named: boolean; color?: string | null }>;
  zone?: string | null;
  transcriptTurns?: number;
}

function makeStore(spec: SeedSpec[]): MomentStore {
  let n = 0;
  const idGen = () => `m${++n}`;
  const store = new MomentStore({ maxMoments: 100, idGenerator: idGen });
  for (const s of spec) {
    const simTime = s.day * SECONDS_PER_DAY + s.hour * 3600;
    const participants = s.participants.map((p) => ({
      id: p.id,
      name: p.name,
      named: p.named,
      color: p.color ?? '#cccccc',
    }));
    if (s.variant === 'group') {
      store.captureGroup(
        {
          sessionId: s.sessionId,
          simTime,
          participants,
          zone: s.zone ?? 'plaza',
        },
        deriveWorldClock(simTime, 30),
      );
    } else {
      const turns = Array.from({ length: s.transcriptTurns ?? 1 }, (_, i) => ({
        speakerId: participants[i % participants.length]!.id,
        text: 'hi',
        at: simTime + i,
      }));
      store.captureClose(
        {
          sessionId: s.sessionId,
          simTime,
          openedAt: simTime,
          transcript: turns,
          participants,
          zone: s.zone ?? null,
          closeReason: 'idle',
        },
        deriveWorldClock(simTime, 30),
      );
    }
  }
  return store;
}

describe('parseDigestDate', () => {
  test('canonical sd-N round-trips', () => {
    expect(parseDigestDate('sd-12', 5)).toEqual({ day: 12, canonical: 'sd-12' });
    expect(parseDigestDate('sd-0', 5)).toEqual({ day: 0, canonical: 'sd-0' });
  });

  test('today and yesterday resolve from currentSimDay', () => {
    expect(parseDigestDate('today', 12)).toEqual({ day: 12, canonical: 'sd-12' });
    expect(parseDigestDate('yesterday', 12)).toEqual({ day: 11, canonical: 'sd-11' });
  });

  test('yesterday on day 0 returns null', () => {
    expect(parseDigestDate('yesterday', 0)).toBeNull();
  });

  test('rejects malformed input', () => {
    expect(parseDigestDate('SD-12', 5)).toBeNull();
    expect(parseDigestDate('sd--1', 5)).toBeNull();
    expect(parseDigestDate('../etc/passwd', 5)).toBeNull();
    expect(parseDigestDate('', 5)).toBeNull();
    expect(parseDigestDate('sd-9999999', 5)).toBeNull();
  });
});

describe('formatDigestDate', () => {
  test('emits canonical sd-N format', () => {
    expect(formatDigestDate(0)).toBe('sd-0');
    expect(formatDigestDate(42)).toBe('sd-42');
  });
});

describe('buildDigest — picker determinism', () => {
  test('returns empty digest when no moments match the day', () => {
    const store = makeStore([
      {
        sessionId: 's1',
        day: 5,
        hour: 9,
        participants: [
          { id: 'mei', name: 'Mei', named: true },
          { id: 'rin', name: 'Rin', named: true },
        ],
      },
    ]);
    const digest = buildDigest(store.list(), 12);
    expect(digest.entries).toEqual([]);
    expect(digest.top).toBeNull();
    expect(digest.headline).toBe('TINA — Sim-Day 12: a quiet day');
    expect(digest.dateKey).toBe('sd-12');
  });

  test('group variant ranks above named pairs', () => {
    const store = makeStore([
      {
        sessionId: 'pair',
        day: 7,
        hour: 8,
        participants: [
          { id: 'mei', name: 'Mei', named: true },
          { id: 'rin', name: 'Rin', named: true },
        ],
      },
      {
        sessionId: 'group1',
        day: 7,
        hour: 9,
        variant: 'group',
        participants: [
          { id: 'mei', name: 'Mei', named: true },
          { id: 'rin', name: 'Rin', named: true },
          { id: 'kai', name: 'Kai', named: true },
        ],
        zone: 'plaza',
      },
    ]);
    const digest = buildDigest(store.list(), 7);
    expect(digest.top?.rec.sessionId).toBe('group1');
    expect(digest.entries[1]?.rec.sessionId).toBe('pair');
  });

  test('arc strength orders named pairs (warming > cooling > steady > new)', () => {
    const rels = new RelationshipStore();
    // Seed each pair via one closed conversation, then forcibly stamp arcs.
    const seedClose = (a: string, b: string, label: 'warming' | 'cooling' | 'steady' | 'new') => {
      rels.recordClose({ a, b, simTime: 8 * 3600, turnCount: 4 });
      const pair = rels.getPair(a, b)!;
      pair.arcLabel = label;
    };
    seedClose('a1', 'a2', 'steady');
    seedClose('b1', 'b2', 'warming');
    seedClose('c1', 'c2', 'cooling');
    seedClose('d1', 'd2', 'new');

    const store = makeStore([
      {
        sessionId: 'steady',
        day: 7,
        hour: 9,
        participants: [
          { id: 'a1', name: 'A1', named: true },
          { id: 'a2', name: 'A2', named: true },
        ],
      },
      {
        sessionId: 'warming',
        day: 7,
        hour: 10,
        participants: [
          { id: 'b1', name: 'B1', named: true },
          { id: 'b2', name: 'B2', named: true },
        ],
      },
      {
        sessionId: 'cooling',
        day: 7,
        hour: 11,
        participants: [
          { id: 'c1', name: 'C1', named: true },
          { id: 'c2', name: 'C2', named: true },
        ],
      },
      {
        sessionId: 'new',
        day: 7,
        hour: 12,
        participants: [
          { id: 'd1', name: 'D1', named: true },
          { id: 'd2', name: 'D2', named: true },
        ],
      },
    ]);
    const digest = buildDigest(store.list(), 7, { relationships: rels });
    expect(digest.entries.map((e) => e.rec.sessionId)).toEqual([
      'warming',
      'cooling',
      'new',
      'steady',
    ]);
  });

  test('freshness then id are deterministic tiebreaks', () => {
    const store = makeStore([
      // Two named pairs, no arc data → both tie on group + arc strength.
      {
        sessionId: 'older',
        day: 4,
        hour: 9,
        participants: [
          { id: 'a', name: 'A', named: true },
          { id: 'b', name: 'B', named: true },
        ],
      },
      {
        sessionId: 'newer',
        day: 4,
        hour: 18,
        participants: [
          { id: 'c', name: 'C', named: true },
          { id: 'd', name: 'D', named: true },
        ],
      },
    ]);
    const digest = buildDigest(store.list(), 4);
    expect(digest.entries[0]?.rec.sessionId).toBe('newer');
    expect(digest.entries[1]?.rec.sessionId).toBe('older');
  });

  test('caps at topN', () => {
    const spec: SeedSpec[] = Array.from({ length: 15 }, (_, i) => ({
      sessionId: `s${i}`,
      day: 3,
      hour: i % 24,
      participants: [
        { id: `a${i}`, name: 'A', named: false },
        { id: `b${i}`, name: 'B', named: false },
      ],
    }));
    const store = makeStore(spec);
    const digest = buildDigest(store.list(), 3, { topN: 5 });
    expect(digest.entries).toHaveLength(5);
  });

  test('headline byte-stable: same state → same digest output twice', () => {
    const rels = new RelationshipStore();
    rels.recordClose({ a: 'mei', b: 'rin', simTime: 7 * 3600, turnCount: 4 });
    rels.getPair('mei', 'rin')!.arcLabel = 'warming';
    const buildOnce = () => {
      const store = makeStore([
        {
          sessionId: 's1',
          day: 6,
          hour: 12,
          participants: [
            { id: 'mei', name: 'Mei', named: true },
            { id: 'rin', name: 'Rin', named: true },
          ],
        },
        {
          sessionId: 's2',
          day: 6,
          hour: 14,
          variant: 'group',
          participants: [
            { id: 'mei', name: 'Mei', named: true },
            { id: 'rin', name: 'Rin', named: true },
            { id: 'kai', name: 'Kai', named: true },
          ],
          zone: 'plaza',
        },
      ]);
      return buildDigest(store.list(), 6, { relationships: rels });
    };
    const a = buildOnce();
    const b = buildOnce();
    expect(a.headline).toBe(b.headline);
    expect(a.entries.map((e) => e.rec.id)).toEqual(b.entries.map((e) => e.rec.id));
  });

  test('participant list is unique and stable order across entries', () => {
    const store = makeStore([
      {
        sessionId: 's1',
        day: 8,
        hour: 9,
        participants: [
          { id: 'mei', name: 'Mei', named: true },
          { id: 'rin', name: 'Rin', named: true },
        ],
      },
      {
        sessionId: 's2',
        day: 8,
        hour: 10,
        participants: [
          { id: 'rin', name: 'Rin', named: true },
          { id: 'kai', name: 'Kai', named: true },
        ],
      },
    ]);
    const digest = buildDigest(store.list(), 8);
    expect(digest.participants.map((p) => p.id)).toEqual(['rin', 'kai', 'mei']);
  });

  test('nudged subset is filtered via isSessionNudged hook', () => {
    const store = makeStore([
      {
        sessionId: 'nudged',
        day: 9,
        hour: 9,
        participants: [
          { id: 'mei', name: 'Mei', named: true },
          { id: 'rin', name: 'Rin', named: true },
        ],
      },
      {
        sessionId: 'plain',
        day: 9,
        hour: 10,
        participants: [
          { id: 'kai', name: 'Kai', named: true },
          { id: 'sun', name: 'Sun', named: true },
        ],
      },
    ]);
    const digest = buildDigest(store.list(), 9, {
      isSessionNudged: (id) => (id === 'nudged' ? 'spark' : null),
    });
    expect(digest.nudged.map((e) => e.rec.sessionId)).toEqual(['nudged']);
    expect(digest.nudged[0]?.nudge?.direction).toBe<NudgeDirection>('spark');
  });
});

describe('buildDigestHeadline', () => {
  test('quiet day fallback when no top entry', () => {
    expect(buildDigestHeadline(3, null)).toBe('TINA — Sim-Day 3: a quiet day');
  });
});

describe('DigestRoutes.handleDigestPage', () => {
  function setupRoutes(currentDay = 5) {
    const store = makeStore([
      {
        sessionId: 's1',
        day: currentDay,
        hour: 14,
        participants: [
          { id: 'mei', name: 'Mei', named: true },
          { id: 'rin', name: 'Rin', named: true },
        ],
        transcriptTurns: 4,
      },
    ]);
    const cache = new OgCache({ maxEntries: 10 });
    const routes = new DigestRoutes({
      store,
      cache,
      currentSimTime: () => currentDay * SECONDS_PER_DAY + 16 * 3600,
      simSpeed: 30,
    });
    return { store, cache, routes };
  }

  test('200 + HTML for sd-N with at least one moment', () => {
    const { routes } = setupRoutes(5);
    const res = mockRes();
    const out = routes.handleDigestPage(mockReq(), res, 'sd-5');
    expect(out.status).toBe(200);
    expect(out.canonicalDate).toBe('sd-5');
    expect(res.responseHeaders['content-type']).toMatch(/text\/html/);
    expect(res.body.toString()).toContain('Sim-Day 5');
    expect(res.body.toString()).toContain('og:image');
  });

  test('today/yesterday alias resolves to canonical', () => {
    const { routes } = setupRoutes(5);
    const r1 = mockRes();
    const o1 = routes.handleDigestPage(mockReq(), r1, 'today');
    expect(o1.canonicalDate).toBe('sd-5');
    const r2 = mockRes();
    const o2 = routes.handleDigestPage(mockReq(), r2, 'yesterday');
    expect(o2.canonicalDate).toBe('sd-4');
  });

  test('404 for malformed date', () => {
    const { routes } = setupRoutes();
    const res = mockRes();
    const out = routes.handleDigestPage(mockReq(), res, '../etc/passwd');
    expect(out.status).toBe(404);
    expect(res.statusCode).toBe(404);
  });

  test('rate-limits past per-IP window', () => {
    const store = makeStore([]);
    const cache = new OgCache({ maxEntries: 10 });
    const routes = new DigestRoutes({
      store,
      cache,
      currentSimTime: () => 0,
      simSpeed: 30,
      perIpPerMin: 1,
      globalPerMin: 100,
    });
    const r1 = mockRes();
    routes.handleDigestPage(mockReq({ remoteAddress: '1.1.1.1' }), r1, 'sd-0');
    expect(r1.statusCode).toBe(200);
    const r2 = mockRes();
    const out = routes.handleDigestPage(mockReq({ remoteAddress: '1.1.1.1' }), r2, 'sd-0');
    expect(r2.statusCode).toBe(429);
    expect(out.rateLimited).toBe(true);
  });

  test('empty day still renders 200 with quiet-day headline', () => {
    const { routes } = setupRoutes(5);
    const res = mockRes();
    const out = routes.handleDigestPage(mockReq(), res, 'sd-99');
    expect(out.status).toBe(200);
    expect(res.body.toString()).toContain('a quiet day');
  });
});

describe('DigestRoutes.handleDigestOgImage', () => {
  function setupRoutes() {
    const store = makeStore([
      {
        sessionId: 's1',
        day: 7,
        hour: 14,
        participants: [
          { id: 'mei', name: 'Mei', named: true },
          { id: 'rin', name: 'Rin', named: true },
        ],
      },
    ]);
    const cache = new OgCache({ maxEntries: 10 });
    const renders: Array<[string, string]> = [];
    const routes = new DigestRoutes({
      store,
      cache,
      currentSimTime: () => 7 * SECONDS_PER_DAY + 16 * 3600,
      simSpeed: 30,
      onOgRender: (date, ip) => renders.push([date, ip]),
    });
    return { store, cache, routes, renders };
  }

  test('200 PNG with cache miss then hit; onOgRender bumped each time', async () => {
    const { routes, renders } = setupRoutes();
    const r1 = mockRes();
    await routes.handleDigestOgImage(mockReq({ remoteAddress: '5.5.5.5' }), r1, 'sd-7');
    expect(r1.statusCode).toBe(200);
    expect(r1.responseHeaders['content-type']).toBe('image/png');
    expect(r1.responseHeaders['x-og-cache']).toBe('miss');
    expect(r1.body.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(r1.body.readUInt32BE(16)).toBe(OG_WIDTH);
    expect(r1.body.readUInt32BE(20)).toBe(OG_HEIGHT);

    const r2 = mockRes();
    await routes.handleDigestOgImage(mockReq({ remoteAddress: '5.5.5.5' }), r2, 'sd-7');
    expect(r2.responseHeaders['x-og-cache']).toBe('hit');
    expect(r2.body.equals(r1.body)).toBe(true);

    expect(renders).toEqual([
      ['sd-7', '5.5.5.5'],
      ['sd-7', '5.5.5.5'],
    ]);
  });

  test('today gets short cache header, historical gets immutable', async () => {
    const { routes } = setupRoutes();
    const r1 = mockRes();
    await routes.handleDigestOgImage(mockReq(), r1, 'today');
    expect(String(r1.responseHeaders['cache-control'])).toContain('max-age=60');
    expect(String(r1.responseHeaders['cache-control'])).not.toContain('immutable');

    const r2 = mockRes();
    await routes.handleDigestOgImage(mockReq(), r2, 'sd-2');
    expect(String(r2.responseHeaders['cache-control'])).toContain('immutable');
  });

  test('404 for malformed date', async () => {
    const { routes } = setupRoutes();
    const res = mockRes();
    await routes.handleDigestOgImage(mockReq(), res, '../etc/passwd');
    expect(res.statusCode).toBe(404);
  });

  test('cache LRU evicts under sustained traffic — no unbounded growth', async () => {
    const store = makeStore([]);
    const cache = new OgCache({ maxEntries: 3 });
    const routes = new DigestRoutes({
      store,
      cache,
      currentSimTime: () => 50 * SECONDS_PER_DAY,
      simSpeed: 30,
    });
    for (let i = 0; i < 10; i++) {
      const res = mockRes();
      await routes.handleDigestOgImage(mockReq(), res, `sd-${i}`);
      expect(res.statusCode).toBe(200);
    }
    expect(routes.cacheSize()).toBe(3);
  });
});

describe('Digest type contract', () => {
  test('Digest object exposes the documented surface', () => {
    const store = makeStore([
      {
        sessionId: 's1',
        day: 1,
        hour: 9,
        participants: [
          { id: 'a', name: 'A', named: true },
          { id: 'b', name: 'B', named: true },
        ],
      },
    ]);
    const d: Digest = buildDigest(store.list(), 1);
    expect(d.dateKey).toBe('sd-1');
    expect(d.day).toBe(1);
    expect(d.entries.length).toBe(1);
    expect(d.top).not.toBeNull();
    expect(d.participants.length).toBe(2);
    expect(d.arcsTouched).toEqual([]);
    expect(d.nudged).toEqual([]);
  });
});
