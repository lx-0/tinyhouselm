import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { type WorldObject, type Zone, deriveWorldClock } from '@tina/shared';
import { describe, expect, test } from 'vitest';
import { MomentStore } from './moments.js';
import { OgCache } from './og-routes.js';
import { ZoneRoutes, buildZoneDescription, buildZoneResolver } from './zone-routes.js';

function mockReq(
  opts: {
    method?: string;
    url?: string;
    headers?: Record<string, string>;
    remoteAddress?: string;
  } = {},
): IncomingMessage {
  const stream = Readable.from([]) as unknown as IncomingMessage;
  stream.method = opts.method ?? 'GET';
  stream.url = opts.url ?? '/';
  stream.headers = opts.headers ?? {};
  (stream as unknown as { socket: { remoteAddress: string } }).socket = {
    remoteAddress: opts.remoteAddress ?? '127.0.0.1',
  };
  return stream;
}

type MockRes = ServerResponse & {
  statusCode: number;
  body: string;
  responseHeaders: Record<string, string | string[]>;
};

function mockRes(): MockRes {
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
    end(body?: string | Buffer) {
      state.body = typeof body === 'string' ? body : (body?.toString('binary') ?? '');
    },
  } as unknown as MockRes;
  return res;
}

const STARTER_ZONES: Zone[] = [
  { name: 'cafe', x: 1, y: 1, width: 9, height: 8 },
  { name: 'park', x: 19, y: 1, width: 12, height: 9 },
  { name: 'work', x: 19, y: 14, width: 9, height: 7 },
  { name: 'home', x: 1, y: 16, width: 13, height: 6 },
];

function buildRoutes(
  opts: {
    zones?: Zone[];
    moments?: MomentStore;
    listObjectsInZone?: (canonical: string) => WorldObject[];
    perIpPerMin?: number;
    globalPerMin?: number;
    now?: () => number;
  } = {},
) {
  const moments = opts.moments ?? new MomentStore({ maxMoments: 50 });
  const cache = new OgCache({ maxEntries: 16 });
  const routes = new ZoneRoutes({
    moments,
    cache,
    zones: opts.zones ?? STARTER_ZONES,
    listObjectsInZone: opts.listObjectsInZone,
    simSpeed: 30,
    publicBaseUrl: 'https://tinyhouse.up.railway.app',
    perIpPerMin: opts.perIpPerMin,
    globalPerMin: opts.globalPerMin,
    now: opts.now,
  });
  return { routes, moments, cache };
}

describe('buildZoneResolver', () => {
  test('maps id, slug, and first-word case-insensitively', () => {
    const zones: Zone[] = [
      { name: 'cafe', x: 0, y: 0, width: 1, height: 1 },
      { name: 'Coffee Shop', x: 0, y: 0, width: 1, height: 1 },
    ];
    const r = buildZoneResolver(zones);
    expect(r.get('cafe')?.name).toBe('cafe');
    expect(r.get('coffee')?.name).toBe('Coffee Shop');
    expect(r.get('coffee-shop')?.name).toBe('Coffee Shop');
    // canonical lowercase id wins on collision
    expect(r.get('coffee-shop'.toLowerCase())?.name).toBe('Coffee Shop');
  });

  test('canonical lowercase name wins ties — earlier zones not overridden', () => {
    const zones: Zone[] = [
      { name: 'park', x: 0, y: 0, width: 1, height: 1 },
      { name: 'parkour', x: 0, y: 0, width: 1, height: 1 },
    ];
    const r = buildZoneResolver(zones);
    expect(r.get('park')?.name).toBe('park');
    // 'parkour'.first-word = 'parkour', no collision
    expect(r.get('parkour')?.name).toBe('parkour');
  });
});

describe('buildZoneDescription', () => {
  test('falls back to a quiet line on empty zones', () => {
    expect(buildZoneDescription('cafe', [])).toContain('Nothing has happened in cafe yet');
  });

  test('leads with moment count and freshest headline', () => {
    const moments = new MomentStore({ maxMoments: 5, idGenerator: () => 'mid' });
    moments.captureClose(
      {
        sessionId: 's1',
        simTime: 100,
        openedAt: 0,
        transcript: [],
        participants: [
          { id: 'a', name: 'A', named: false, color: null },
          { id: 'b', name: 'B', named: false, color: null },
        ],
        zone: 'cafe',
        closeReason: 'idle',
      },
      deriveWorldClock(100, 30),
    );
    const list = moments.list();
    const desc = buildZoneDescription('cafe', list);
    expect(desc).toContain('1 recent moments in cafe');
  });
});

describe('ZoneRoutes.handleZonePage', () => {
  test('renders 200 + HTML for a known zone (case-insensitive)', () => {
    const { routes } = buildRoutes();
    for (const slug of ['cafe', 'CAFE', 'Cafe']) {
      const res = mockRes();
      const out = routes.handleZonePage(mockReq(), res, slug);
      expect(out.status).toBe(200);
      expect(out.canonicalName).toBe('cafe');
      expect(res.responseHeaders['content-type']).toContain('text/html');
      expect(res.body).toContain('og:url');
      expect(res.body).toContain('https://tinyhouse.up.railway.app/zone/cafe');
      expect(res.body).toContain('https://tinyhouse.up.railway.app/zone/cafe/og.png');
    }
  });

  test('empty-zone fallback (TINA-744 Verification): page still renders with header + empty-state copy', () => {
    const { routes } = buildRoutes();
    const res = mockRes();
    const out = routes.handleZonePage(mockReq(), res, 'park');
    expect(out.status).toBe(200);
    expect(res.body).toContain('Top characters');
    expect(res.body).toContain('Affordance objects');
    expect(res.body).toContain('Recent moments');
    expect(res.body).toContain('No characters have appeared');
    expect(res.body).toContain('No affordance objects');
    expect(res.body).toContain('Nothing has happened in park yet');
  });

  test('returns 404 + HTML when zone is unknown — lists known zones', () => {
    const { routes } = buildRoutes();
    const res = mockRes();
    const out = routes.handleZonePage(mockReq(), res, 'nowhere');
    expect(out.status).toBe(404);
    expect(out.canonicalName).toBeNull();
    expect(res.body).toContain('zone not found');
    // The 404 page should suggest known zones
    expect(res.body).toContain('href="/zone/cafe"');
    expect(res.body).toContain('href="/zone/park"');
  });

  test('rejects names that fail the safety pattern (no path traversal)', () => {
    const { routes } = buildRoutes();
    const res = mockRes();
    const out = routes.handleZonePage(mockReq(), res, '../etc/passwd');
    expect(out.status).toBe(404);
  });

  test('renders moments + top characters + affordance objects for a busy zone', () => {
    const moments = new MomentStore({
      maxMoments: 10,
      idGenerator: (() => {
        let n = 0;
        return () => `m${++n}`;
      })(),
    });
    moments.captureClose(
      {
        sessionId: 's1',
        simTime: 1000,
        openedAt: 950,
        transcript: [{ speakerId: 'mei', text: 'hi', at: 1000 }],
        participants: [
          { id: 'mei', name: 'Mei Tanaka', named: true, color: '#abcdef' },
          { id: 'hiro', name: 'Hiro Abe', named: true, color: '#fedcba' },
        ],
        zone: 'cafe',
        closeReason: 'idle',
      },
      deriveWorldClock(1000, 30),
    );
    moments.captureClose(
      {
        sessionId: 's2',
        simTime: 2000,
        openedAt: 1950,
        transcript: [{ speakerId: 'mei', text: 'again', at: 2000 }],
        participants: [
          { id: 'mei', name: 'Mei Tanaka', named: true, color: '#abcdef' },
          { id: 'rin', name: 'Rin Wood', named: true, color: '#aaffcc' },
        ],
        zone: 'cafe',
        closeReason: 'idle',
      },
      deriveWorldClock(2000, 30),
    );
    moments.captureGroup(
      {
        sessionId: 'g1',
        simTime: 3000,
        participants: [
          { id: 'mei', name: 'Mei Tanaka', named: true, color: '#abcdef' },
          { id: 'hiro', name: 'Hiro Abe', named: true, color: '#fedcba' },
          { id: 'ava', name: 'Ava Okafor', named: true, color: '#cccccc' },
        ],
        zone: 'cafe',
      },
      deriveWorldClock(3000, 30),
    );
    // A zone:'park' moment should NOT show up on the cafe page.
    moments.captureClose(
      {
        sessionId: 'sX',
        simTime: 5000,
        openedAt: 4950,
        transcript: [],
        participants: [
          { id: 'mei', name: 'Mei Tanaka', named: true, color: '#abcdef' },
          { id: 'rin', name: 'Rin Wood', named: true, color: '#aaffcc' },
        ],
        zone: 'park',
        closeReason: 'idle',
      },
      deriveWorldClock(5000, 30),
    );
    const objects: WorldObject[] = [
      {
        id: 'bench-1',
        label: 'park bench',
        pos: { x: 5, y: 5 },
        zone: 'cafe',
        droppedAtSim: 100,
        affordance: 'bench',
      },
    ];
    const { routes } = buildRoutes({
      moments,
      listObjectsInZone: (canonical) =>
        objects.filter((o) => (o.zone ?? '').toLowerCase() === canonical),
    });
    const res = mockRes();
    routes.handleZonePage(mockReq(), res, 'cafe');
    expect(res.statusCode).toBe(200);
    // Only cafe moments (3 of 4) appear, group badge included.
    expect(res.body).toContain('href="/moment/m1"');
    expect(res.body).toContain('href="/moment/m2"');
    expect(res.body).toContain('href="/moment/m3"');
    expect(res.body).not.toContain('href="/moment/m4"');
    expect(res.body).toContain('data-kind="group">group');
    // Top characters render with character links + appearance counts.
    expect(res.body).toContain('href="/character/mei"');
    expect(res.body).toContain('×3');
    expect(res.body).toContain('×2');
    // Affordance object renders.
    expect(res.body).toContain('park bench');
    expect(res.body).toContain('🪑');
    // Moments index cross-link.
    expect(res.body).toContain('href="/moments?zone=cafe"');
  });

  test('rate-limits per IP and returns 429', () => {
    const { routes } = buildRoutes({ perIpPerMin: 2, globalPerMin: 100, now: () => 1_000_000 });
    for (let i = 0; i < 2; i++) {
      const out = routes.handleZonePage(mockReq(), mockRes(), 'cafe');
      expect(out.status).toBe(200);
    }
    const res = mockRes();
    const out = routes.handleZonePage(mockReq(), res, 'cafe');
    expect(out.status).toBe(429);
    expect(out.rateLimited).toBe(true);
    expect(res.responseHeaders['retry-after']).toBeDefined();
  });

  test('escapes user-controlled headline + participant names in HTML output', () => {
    const moments = new MomentStore({ maxMoments: 5, idGenerator: () => 'mZ' });
    moments.captureClose(
      {
        sessionId: 'sZ',
        simTime: 1,
        openedAt: 0,
        transcript: [{ speakerId: 'xss', text: '<script>alert(1)</script>', at: 1 }],
        participants: [
          { id: 'xss', name: '<b>Xss</b>', named: false, color: null },
          { id: 'b', name: 'B', named: false, color: null },
        ],
        zone: 'cafe',
        closeReason: 'idle',
      },
      deriveWorldClock(1, 30),
    );
    const { routes } = buildRoutes({ moments });
    const res = mockRes();
    routes.handleZonePage(mockReq(), res, 'cafe');
    expect(res.statusCode).toBe(200);
    // Participant name + transcript injection must not survive raw.
    expect(res.body).not.toContain('<b>Xss</b>');
    expect(res.body).toContain('&lt;b&gt;Xss&lt;/b&gt;');
  });
});

describe('ZoneRoutes.handleZoneOgImage', () => {
  test('renders a 1200x630 PNG with caching', async () => {
    const { routes, cache } = buildRoutes();
    const res = mockRes();
    await routes.handleZoneOgImage(mockReq(), res, 'cafe');
    expect(res.statusCode).toBe(200);
    expect(res.responseHeaders['content-type']).toBe('image/png');
    expect(res.responseHeaders['x-og-cache']).toBe('miss');
    // Cache write is fire-and-forget — flush the microtask queue.
    await new Promise((r) => setImmediate(r));
    expect(cache.size()).toBe(1);
    const res2 = mockRes();
    await routes.handleZoneOgImage(mockReq(), res2, 'cafe');
    expect(res2.responseHeaders['x-og-cache']).toBe('hit');
  });

  test('returns 404 for unknown zone', async () => {
    const { routes } = buildRoutes();
    const res = mockRes();
    await routes.handleZoneOgImage(mockReq(), res, 'nowhere');
    expect(res.statusCode).toBe(404);
  });

  test('rejects malformed names with 404', async () => {
    const { routes } = buildRoutes();
    const res = mockRes();
    await routes.handleZoneOgImage(mockReq(), res, '../etc/passwd');
    expect(res.statusCode).toBe(404);
  });
});
