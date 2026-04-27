import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { deriveWorldClock } from '@tina/shared';
import { type NamedPersona, RelationshipStore } from '@tina/sim';
import { describe, expect, test } from 'vitest';
import { CharactersIndexRoutes } from './characters-index-routes.js';
import { MomentStore } from './moments.js';
import { OgCache } from './og-routes.js';

function mockReq(
  opts: { headers?: Record<string, string>; remoteAddress?: string } = {},
): IncomingMessage {
  const stream = Readable.from([]) as unknown as IncomingMessage;
  stream.method = 'GET';
  stream.url = '/characters';
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

function makeStore(): MomentStore {
  const store = new MomentStore({
    maxMoments: 200,
    idGenerator: (() => {
      let n = 0;
      return () => `mom${++n}`;
    })(),
  });
  // Two named conversation moments — Mei&Hiro is freshest.
  store.captureClose(
    {
      sessionId: 'sess1',
      simTime: 1000,
      openedAt: 1000,
      transcript: [],
      participants: [
        { id: 'ava-okafor', name: 'Ava Okafor', named: true, color: '#aaa' },
        { id: 'hiro-abe', name: 'Hiro Abe', named: true, color: '#bbb' },
      ],
      zone: 'park',
      closeReason: 'idle',
    },
    deriveWorldClock(1000, 30),
  );
  store.captureClose(
    {
      sessionId: 'sess2',
      simTime: 1100,
      openedAt: 1100,
      transcript: [],
      participants: [
        { id: 'mei-tanaka', name: 'Mei Tanaka', named: true, color: '#abcdef' },
        { id: 'hiro-abe', name: 'Hiro Abe', named: true, color: '#bbb' },
      ],
      zone: 'cafe',
      closeReason: 'idle',
    },
    deriveWorldClock(1100, 30),
  );
  return store;
}

function buildRoutes(
  opts: {
    named?: NamedPersona[];
    moments?: MomentStore;
    relationships?: RelationshipStore | null;
    publicBaseUrl?: string | null;
    ogCache?: OgCache | null;
    perIpPerMin?: number;
  } = {},
) {
  const named = opts.named ?? [
    fakePersona('mei-tanaka', 'Mei Tanaka', '#abcdef'),
    fakePersona('hiro-abe', 'Hiro Abe', '#fedcba'),
    fakePersona('ava-okafor', 'Ava Okafor', '#aabbcc'),
  ];
  const moments = opts.moments ?? makeStore();
  const routes = new CharactersIndexRoutes({
    named,
    moments,
    relationships: opts.relationships ?? null,
    publicBaseUrl: opts.publicBaseUrl ?? 'https://tinyhouse.up.railway.app',
    ogCache: opts.ogCache ?? null,
    perIpPerMin: opts.perIpPerMin ?? 60,
  });
  return { routes, named, moments };
}

describe('CharactersIndexRoutes.handleIndexPage', () => {
  test('200 + HTML on the index, lists all named characters in display-name asc order', () => {
    const { routes } = buildRoutes();
    const res = mockRes();
    const out = routes.handleIndexPage(mockReq(), res);
    expect(out.status).toBe(200);
    expect(out.rateLimited).toBe(false);
    expect(res.responseHeaders['content-type']).toContain('text/html');
    const body = String(res.body);
    expect(body).toContain('Meet the cast');
    expect(body).toContain('Characters — TinyHouse');
    expect(body).toContain('og:url');
    expect(body).toContain('https://tinyhouse.up.railway.app/characters');
    // Display-name asc → Ava → Hiro → Mei.
    const ava = body.indexOf('Ava Okafor');
    const hiro = body.indexOf('Hiro Abe');
    const mei = body.indexOf('Mei Tanaka');
    expect(ava).toBeGreaterThan(0);
    expect(hiro).toBeGreaterThan(0);
    expect(mei).toBeGreaterThan(0);
    expect(ava).toBeLessThan(hiro);
    expect(hiro).toBeLessThan(mei);
    // Each character links to /character/:id.
    expect(body).toContain('href="/character/mei-tanaka"');
    expect(body).toContain('href="/character/hiro-abe"');
    expect(body).toContain('href="/character/ava-okafor"');
    // Footer Cast → moments cross-link.
    expect(body).toContain('href="/moments"');
  });

  test('OG meta tags only emitted when ogCache is wired', () => {
    const { routes } = buildRoutes({ ogCache: null });
    const res = mockRes();
    routes.handleIndexPage(mockReq(), res);
    const body = String(res.body);
    expect(body).not.toContain('og:image');
    expect(body).toContain('twitter:card" content="summary"');

    const cache = new OgCache({});
    const wired = buildRoutes({ ogCache: cache });
    const res2 = mockRes();
    wired.routes.handleIndexPage(mockReq(), res2);
    const body2 = String(res2.body);
    expect(body2).toContain(
      'og:image" content="https://tinyhouse.up.railway.app/characters/og.png"',
    );
    expect(body2).toContain('og:image:width" content="1200"');
    expect(body2).toContain('og:image:height" content="630"');
    expect(body2).toContain('twitter:card" content="summary_large_image"');
  });

  test('empty roster renders the no-cast-yet copy and still 200s', () => {
    const { routes } = buildRoutes({ named: [] });
    const res = mockRes();
    const out = routes.handleIndexPage(mockReq(), res);
    expect(out.status).toBe(200);
    const body = String(res.body);
    expect(body).toContain('No cast yet');
    expect(body).toContain('0 characters');
  });

  test('strongest arc chip surfaces with named counterparty link', () => {
    const named = [fakePersona('mei-tanaka', 'Mei Tanaka'), fakePersona('hiro-abe', 'Hiro Abe')];
    const moments = makeStore();
    const relationships = new RelationshipStore({ maxPairs: 50 });
    relationships.recordClose({ a: 'mei-tanaka', b: 'hiro-abe', simTime: 100, turnCount: 6 });
    relationships.recordClose({ a: 'mei-tanaka', b: 'hiro-abe', simTime: 200, turnCount: 6 });
    relationships.rolloverDay(8 * 86400);
    const { routes } = buildRoutes({ named, moments, relationships });
    const res = mockRes();
    routes.handleIndexPage(mockReq(), res);
    const body = String(res.body);
    // Mei's row should have a warming arc chip linking back to Hiro.
    expect(body).toContain('href="/character/hiro-abe"');
    expect(body).toContain('arc-chip');
    expect(body).toContain('warming');
  });

  test('per-IP rate limit returns 429 with retry-after header', () => {
    const { routes } = buildRoutes({ perIpPerMin: 2 });
    routes.handleIndexPage(mockReq(), mockRes());
    routes.handleIndexPage(mockReq(), mockRes());
    const res = mockRes();
    const out = routes.handleIndexPage(mockReq(), res);
    expect(out.status).toBe(429);
    expect(out.rateLimited).toBe(true);
    expect(res.responseHeaders['retry-after']).toBeDefined();
  });
});

describe('CharactersIndexRoutes.handleCharactersIndexOgImage', () => {
  test('returns a 1200x630 PNG and writes to cache on miss', async () => {
    const cache = new OgCache({});
    const { routes } = buildRoutes({ ogCache: cache });
    const res = mockRes();
    await routes.handleCharactersIndexOgImage(mockReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.responseHeaders['content-type']).toBe('image/png');
    expect(res.responseHeaders['x-og-cache']).toBe('miss');
    const body = res.body as Buffer;
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    // PNG magic bytes.
    expect(body[0]).toBe(0x89);
    expect(body[1]).toBe(0x50);
    expect(body[2]).toBe(0x4e);
    expect(body[3]).toBe(0x47);
    // Cache write is fire-and-forget; flush by polling once.
    await new Promise((r) => setImmediate(r));
    expect(cache.size()).toBeGreaterThanOrEqual(1);
  });

  test('second request returns the cached PNG (x-og-cache: hit)', async () => {
    const cache = new OgCache({});
    const { routes } = buildRoutes({ ogCache: cache });
    await routes.handleCharactersIndexOgImage(mockReq(), mockRes());
    await new Promise((r) => setImmediate(r));
    const res = mockRes();
    await routes.handleCharactersIndexOgImage(mockReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.responseHeaders['x-og-cache']).toBe('hit');
  });

  test('404 when ogCache is unwired', async () => {
    const { routes } = buildRoutes({ ogCache: null });
    const res = mockRes();
    await routes.handleCharactersIndexOgImage(mockReq(), res);
    expect(res.statusCode).toBe(404);
  });

  test('rate limiter is shared between page + image route', async () => {
    const cache = new OgCache({});
    const { routes } = buildRoutes({ ogCache: cache, perIpPerMin: 2 });
    routes.handleIndexPage(mockReq(), mockRes());
    routes.handleIndexPage(mockReq(), mockRes());
    const res = mockRes();
    await routes.handleCharactersIndexOgImage(mockReq(), res);
    expect(res.statusCode).toBe(429);
  });

  test('onOgRender fires with the visitor IP after a successful render', async () => {
    const cache = new OgCache({});
    let observed: string | null = null;
    const named = [fakePersona('mei-tanaka', 'Mei Tanaka'), fakePersona('hiro-abe', 'Hiro Abe')];
    const moments = makeStore();
    const routes = new CharactersIndexRoutes({
      named,
      moments,
      ogCache: cache,
      onOgRender: (ip) => {
        observed = ip;
      },
      publicBaseUrl: 'https://tinyhouse.up.railway.app',
    });
    await routes.handleCharactersIndexOgImage(mockReq({ remoteAddress: '10.1.2.3' }), mockRes());
    expect(observed).toBe('10.1.2.3');
  });

  test('cache key changes when freshest moment id changes', async () => {
    const cache = new OgCache({});
    const moments = makeStore();
    const named = [fakePersona('mei-tanaka', 'Mei Tanaka'), fakePersona('hiro-abe', 'Hiro Abe')];
    const routes = new CharactersIndexRoutes({
      named,
      moments,
      ogCache: cache,
      publicBaseUrl: 'https://tinyhouse.up.railway.app',
    });
    await routes.handleCharactersIndexOgImage(mockReq(), mockRes());
    await new Promise((r) => setImmediate(r));
    const sizeAfter1 = cache.size();
    // Land a brand-new freshest moment.
    moments.captureClose(
      {
        sessionId: 'sessNew',
        simTime: 5000,
        openedAt: 5000,
        transcript: [],
        participants: [
          { id: 'mei-tanaka', name: 'Mei Tanaka', named: true, color: '#abcdef' },
          { id: 'ava-okafor', name: 'Ava Okafor', named: true, color: '#aabbcc' },
        ],
        zone: 'park',
        closeReason: 'idle',
      },
      deriveWorldClock(5000, 30),
    );
    const res = mockRes();
    await routes.handleCharactersIndexOgImage(mockReq(), res);
    expect(res.responseHeaders['x-og-cache']).toBe('miss');
    await new Promise((r) => setImmediate(r));
    expect(cache.size()).toBeGreaterThan(sizeAfter1);
  });
});
