import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { deriveWorldClock } from '@tina/shared';
import { type NamedPersona, RelationshipStore } from '@tina/sim';
import { describe, expect, test } from 'vitest';
import { ArcsIndexRoutes } from './arcs-index-routes.js';
import { MomentStore } from './moments.js';
import { OgCache } from './og-routes.js';

function mockReq(
  opts: { headers?: Record<string, string>; remoteAddress?: string } = {},
): IncomingMessage {
  const stream = Readable.from([]) as unknown as IncomingMessage;
  stream.method = 'GET';
  stream.url = '/arcs';
  stream.headers = opts.headers ?? {};
  (stream as unknown as { socket: { remoteAddress: string } }).socket = {
    remoteAddress: opts.remoteAddress ?? '127.0.0.1',
  };
  return stream;
}

type MockRes = ServerResponse & {
  statusCode: number;
  body: string | Buffer;
  responseHeaders: Record<string, string | string[]>;
};

function mockRes(): MockRes {
  const state = {
    statusCode: 0,
    body: '' as string | Buffer,
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
      state.body = body ?? '';
    },
  } as unknown as MockRes;
  return res;
}

function fakePersona(id: string, name: string, color = '#abcdef'): NamedPersona {
  return {
    manifest: {
      id,
      name,
      bio: `${name}'s bio.`,
      archetype: 'librarian',
      glyph: { color, accent: '#012345' },
      traits: [],
      routines: [],
      voice: 'measured.',
      seedMemories: [],
      occupation: 'archivist',
      age: 28,
    },
    skill: {} as unknown as NamedPersona['skill'],
    memoryRoot: `/tmp/${id}`,
    manifestPath: `/tmp/${id}.yaml`,
    scheduleByHour: null,
  };
}

function landMoment(
  store: MomentStore,
  sessionId: string,
  simTime: number,
  participants: Array<{ id: string; name: string; color: string }>,
  zone = 'park',
) {
  store.captureClose(
    {
      sessionId,
      simTime,
      openedAt: simTime,
      transcript: [],
      participants: participants.map((p) => ({ ...p, named: true })),
      zone,
      closeReason: 'idle',
    },
    deriveWorldClock(simTime, 30),
  );
}

function buildFixture(opts: { withWarming?: boolean; withCooling?: boolean } = {}) {
  const named: NamedPersona[] = [
    fakePersona('ava-okafor', 'Ava Okafor', '#aabbcc'),
    fakePersona('hiro-abe', 'Hiro Abe', '#bbccdd'),
    fakePersona('mei-tanaka', 'Mei Tanaka', '#abcdef'),
  ];
  const moments = new MomentStore({
    maxMoments: 200,
    idGenerator: (() => {
      let n = 0;
      return () => `mom${++n}`;
    })(),
  });
  const relationships = new RelationshipStore({ maxPairs: 50 });
  if (opts.withWarming) {
    relationships.recordClose({ a: 'mei-tanaka', b: 'hiro-abe', simTime: 100, turnCount: 6 });
    relationships.recordClose({ a: 'mei-tanaka', b: 'hiro-abe', simTime: 200, turnCount: 6 });
    relationships.rolloverDay(8 * 86400);
    landMoment(moments, 'mh1', 200, [
      { id: 'mei-tanaka', name: 'Mei Tanaka', color: '#abcdef' },
      { id: 'hiro-abe', name: 'Hiro Abe', color: '#bbccdd' },
    ]);
  }
  if (opts.withCooling) {
    // Negative-turn / sparse closes → drift toward cooling.
    relationships.recordClose({ a: 'ava-okafor', b: 'hiro-abe', simTime: 50, turnCount: 1 });
    relationships.rolloverDay(8 * 86400);
    landMoment(moments, 'ah1', 80, [
      { id: 'ava-okafor', name: 'Ava Okafor', color: '#aabbcc' },
      { id: 'hiro-abe', name: 'Hiro Abe', color: '#bbccdd' },
    ]);
  }
  return { named, moments, relationships };
}

function buildRoutes(
  opts: {
    named?: NamedPersona[];
    moments?: MomentStore;
    relationships?: RelationshipStore;
    publicBaseUrl?: string | null;
    ogCache?: OgCache | null;
    perIpPerMin?: number;
  } = {},
) {
  const fx = buildFixture({ withWarming: true });
  const named = opts.named ?? fx.named;
  const moments = opts.moments ?? fx.moments;
  const relationships = opts.relationships ?? fx.relationships;
  const routes = new ArcsIndexRoutes({
    named,
    moments,
    relationships,
    publicBaseUrl: opts.publicBaseUrl ?? 'https://tinyhouse.up.railway.app',
    ogCache: opts.ogCache ?? null,
    perIpPerMin: opts.perIpPerMin ?? 60,
  });
  return { routes, named, moments, relationships };
}

function emptyParams(): URLSearchParams {
  return new URLSearchParams();
}

describe('ArcsIndexRoutes.handleIndexPage', () => {
  test('200 + HTML on the index, lists named pairs with arc chip and canonical slug links', () => {
    const { routes } = buildRoutes();
    const res = mockRes();
    const out = routes.handleIndexPage(mockReq(), res, emptyParams());
    expect(out.status).toBe(200);
    expect(out.rateLimited).toBe(false);
    expect(res.responseHeaders['content-type']).toContain('text/html');
    const body = String(res.body);
    expect(body).toContain('Relationship arcs');
    expect(body).toContain('og:url');
    expect(body).toContain('https://tinyhouse.up.railway.app/arcs');
    expect(body).toContain('arc-chip');
    // Canonical slug for hiro<mei (id-asc) is hiro-mei.
    expect(body).toContain('href="/arc/hiro-mei"');
    // Cross-links to siblings.
    expect(body).toContain('href="/characters"');
    expect(body).toContain('href="/moments"');
    // Ranking toggle is present and `strongest` is active by default.
    expect(body).toContain('class="active"');
    expect(body).toContain('rank=freshest');
  });

  test('empty roster renders the no-arcs-yet copy and still 200s', () => {
    const named = [fakePersona('mei-tanaka', 'Mei Tanaka')];
    const moments = new MomentStore({ maxMoments: 50 });
    const relationships = new RelationshipStore({ maxPairs: 50 });
    const routes = new ArcsIndexRoutes({
      named,
      moments,
      relationships,
      publicBaseUrl: 'https://tinyhouse.up.railway.app',
    });
    const res = mockRes();
    const out = routes.handleIndexPage(mockReq(), res, emptyParams());
    expect(out.status).toBe(200);
    const body = String(res.body);
    expect(body).toContain('No arcs yet');
    expect(body).toContain('0 pairs');
  });

  test('default ranking is arc_strength desc — strongest pair appears first', () => {
    const fx = buildFixture({ withWarming: true, withCooling: true });
    // Land another close to push mei↔hiro to a higher absolute affinity.
    fx.relationships.recordClose({
      a: 'mei-tanaka',
      b: 'hiro-abe',
      simTime: 300,
      turnCount: 8,
    });
    const routes = new ArcsIndexRoutes({
      named: fx.named,
      moments: fx.moments,
      relationships: fx.relationships,
    });
    const res = mockRes();
    routes.handleIndexPage(mockReq(), res, emptyParams());
    const body = String(res.body);
    const meiHiro = body.indexOf('href="/arc/hiro-mei"');
    const avaHiro = body.indexOf('href="/arc/ava-hiro"');
    expect(meiHiro).toBeGreaterThan(0);
    expect(avaHiro).toBeGreaterThan(0);
    expect(meiHiro).toBeLessThan(avaHiro);
  });

  test('?rank=freshest reorders rows by freshest pair-moment desc', () => {
    const fx = buildFixture({ withWarming: true, withCooling: true });
    // Land a brand-new ava↔hiro moment after the warming pair's last moment.
    landMoment(fx.moments, 'ah_late', 9000, [
      { id: 'ava-okafor', name: 'Ava Okafor', color: '#aabbcc' },
      { id: 'hiro-abe', name: 'Hiro Abe', color: '#bbccdd' },
    ]);
    const routes = new ArcsIndexRoutes({
      named: fx.named,
      moments: fx.moments,
      relationships: fx.relationships,
    });
    const params = new URLSearchParams('rank=freshest');
    const res = mockRes();
    routes.handleIndexPage(mockReq(), res, params);
    const body = String(res.body);
    const avaHiro = body.indexOf('href="/arc/ava-hiro"');
    const meiHiro = body.indexOf('href="/arc/hiro-mei"');
    expect(avaHiro).toBeGreaterThan(0);
    expect(meiHiro).toBeGreaterThan(0);
    expect(avaHiro).toBeLessThan(meiHiro);
  });

  test('OG meta tags only emitted when ogCache is wired', () => {
    const { routes } = buildRoutes({ ogCache: null });
    const res = mockRes();
    routes.handleIndexPage(mockReq(), res, emptyParams());
    const body = String(res.body);
    expect(body).not.toContain('og:image');
    expect(body).toContain('twitter:card" content="summary"');

    const cache = new OgCache({});
    const wired = buildRoutes({ ogCache: cache });
    const res2 = mockRes();
    wired.routes.handleIndexPage(mockReq(), res2, emptyParams());
    const body2 = String(res2.body);
    expect(body2).toContain('og:image" content="https://tinyhouse.up.railway.app/arcs/og.png"');
    expect(body2).toContain('og:image:width" content="1200"');
    expect(body2).toContain('twitter:card" content="summary_large_image"');
  });

  test('per-IP rate limit returns 429 with retry-after header', () => {
    const { routes } = buildRoutes({ perIpPerMin: 2 });
    routes.handleIndexPage(mockReq(), mockRes(), emptyParams());
    routes.handleIndexPage(mockReq(), mockRes(), emptyParams());
    const res = mockRes();
    const out = routes.handleIndexPage(mockReq(), res, emptyParams());
    expect(out.status).toBe(429);
    expect(out.rateLimited).toBe(true);
    expect(res.responseHeaders['retry-after']).toBeDefined();
  });
});

describe('ArcsIndexRoutes.handleArcsIndexOgImage', () => {
  test('returns a 1200x630 PNG and writes to cache on miss', async () => {
    const cache = new OgCache({});
    const { routes } = buildRoutes({ ogCache: cache });
    const res = mockRes();
    await routes.handleArcsIndexOgImage(mockReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.responseHeaders['content-type']).toBe('image/png');
    expect(res.responseHeaders['x-og-cache']).toBe('miss');
    const body = res.body as Buffer;
    expect(Buffer.isBuffer(body)).toBe(true);
    // PNG magic bytes.
    expect(body[0]).toBe(0x89);
    expect(body[1]).toBe(0x50);
    expect(body[2]).toBe(0x4e);
    expect(body[3]).toBe(0x47);
    await new Promise((r) => setImmediate(r));
    expect(cache.size()).toBeGreaterThanOrEqual(1);
  });

  test('second request returns the cached PNG (x-og-cache: hit)', async () => {
    const cache = new OgCache({});
    const { routes } = buildRoutes({ ogCache: cache });
    await routes.handleArcsIndexOgImage(mockReq(), mockRes());
    await new Promise((r) => setImmediate(r));
    const res = mockRes();
    await routes.handleArcsIndexOgImage(mockReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.responseHeaders['x-og-cache']).toBe('hit');
  });

  test('renders empty-state PNG when no named pairs exist', async () => {
    const cache = new OgCache({});
    const named = [fakePersona('mei-tanaka', 'Mei Tanaka')];
    const moments = new MomentStore({ maxMoments: 50 });
    const relationships = new RelationshipStore({ maxPairs: 50 });
    const routes = new ArcsIndexRoutes({
      named,
      moments,
      relationships,
      ogCache: cache,
    });
    const res = mockRes();
    await routes.handleArcsIndexOgImage(mockReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.responseHeaders['content-type']).toBe('image/png');
  });

  test('404 when ogCache is unwired', async () => {
    const { routes } = buildRoutes({ ogCache: null });
    const res = mockRes();
    await routes.handleArcsIndexOgImage(mockReq(), res);
    expect(res.statusCode).toBe(404);
  });

  test('rate limiter is shared between page + image route', async () => {
    const cache = new OgCache({});
    const { routes } = buildRoutes({ ogCache: cache, perIpPerMin: 2 });
    routes.handleIndexPage(mockReq(), mockRes(), emptyParams());
    routes.handleIndexPage(mockReq(), mockRes(), emptyParams());
    const res = mockRes();
    await routes.handleArcsIndexOgImage(mockReq(), res);
    expect(res.statusCode).toBe(429);
  });

  test('onOgRender fires with the visitor IP after a successful render', async () => {
    const cache = new OgCache({});
    let observed: string | null = null;
    const fx = buildFixture({ withWarming: true });
    const routes = new ArcsIndexRoutes({
      named: fx.named,
      moments: fx.moments,
      relationships: fx.relationships,
      ogCache: cache,
      onOgRender: (ip) => {
        observed = ip;
      },
    });
    await routes.handleArcsIndexOgImage(mockReq({ remoteAddress: '10.1.2.3' }), mockRes());
    expect(observed).toBe('10.1.2.3');
  });

  test('cache key changes when the leaderboard hash changes', async () => {
    const cache = new OgCache({});
    const fx = buildFixture({ withWarming: true });
    const routes = new ArcsIndexRoutes({
      named: fx.named,
      moments: fx.moments,
      relationships: fx.relationships,
      ogCache: cache,
    });
    await routes.handleArcsIndexOgImage(mockReq(), mockRes());
    await new Promise((r) => setImmediate(r));
    const sizeBefore = cache.size();
    // Push the affinity hard enough that the rounded-2dp signature shifts.
    for (let i = 0; i < 5; i++) {
      fx.relationships.recordClose({
        a: 'mei-tanaka',
        b: 'hiro-abe',
        simTime: 1000 + i,
        turnCount: 8,
      });
    }
    fx.relationships.rolloverDay(15 * 86400);
    landMoment(fx.moments, 'mh_new', 12000, [
      { id: 'mei-tanaka', name: 'Mei Tanaka', color: '#abcdef' },
      { id: 'hiro-abe', name: 'Hiro Abe', color: '#bbccdd' },
    ]);
    const res = mockRes();
    await routes.handleArcsIndexOgImage(mockReq(), res);
    expect(res.responseHeaders['x-og-cache']).toBe('miss');
    await new Promise((r) => setImmediate(r));
    expect(cache.size()).toBeGreaterThan(sizeBefore);
  });
});
