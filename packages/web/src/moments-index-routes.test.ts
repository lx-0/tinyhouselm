import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { type MomentRecord, deriveWorldClock } from '@tina/shared';
import type { NamedPersona, RelationshipStore } from '@tina/sim';
import { describe, expect, test } from 'vitest';
import { MomentsIndexRoutes, buildFilterKey } from './moments-index-routes.js';
import { MomentStore } from './moments.js';
import { OgCache } from './og-routes.js';

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
    end(body?: string) {
      state.body = body ?? '';
    },
  } as unknown as MockRes;
  return res;
}

function fakePersona(id: string, name: string): NamedPersona {
  return {
    manifest: {
      id,
      name,
      bio: `${name}'s bio.`,
      archetype: 'librarian',
      glyph: { color: '#abcdef', accent: '#012345' },
      traits: [],
      routines: [],
      voice: 'measured.',
      seedMemories: [],
    },
    skill: {} as unknown as NamedPersona['skill'],
    memoryRoot: `/tmp/${id}`,
    manifestPath: `/tmp/${id}.yaml`,
    scheduleByHour: null,
  };
}

function makeStore(opts: { count?: number; named?: NamedPersona[] } = {}): MomentStore {
  const store = new MomentStore({
    maxMoments: 200,
    idGenerator: (() => {
      let n = 0;
      return () => `mom${++n}`;
    })(),
  });
  // 30 conversation moments × Mei&Hiro in cafe at sim seconds 1000..1029.
  const count = opts.count ?? 30;
  for (let i = 0; i < count; i++) {
    store.captureClose(
      {
        sessionId: `s${i}`,
        simTime: 1000 + i,
        openedAt: 1000 + i,
        transcript: [{ speakerId: 'mei-tanaka', text: `hi ${i}`, at: 1000 + i }],
        participants: [
          { id: 'mei-tanaka', name: 'Mei Tanaka', named: true, color: '#abcdef' },
          { id: 'hiro-abe', name: 'Hiro Abe', named: true, color: '#fedcba' },
        ],
        zone: 'cafe',
        closeReason: 'idle',
      },
      deriveWorldClock(1000 + i, 30),
    );
  }
  return store;
}

function buildRoutes(
  opts: {
    moments?: MomentStore;
    named?: NamedPersona[];
    relationships?: RelationshipStore | null;
    perIpPerMin?: number;
    pageSize?: number;
    publicBaseUrl?: string;
  } = {},
) {
  const named = opts.named ?? [
    fakePersona('mei-tanaka', 'Mei Tanaka'),
    fakePersona('hiro-abe', 'Hiro Abe'),
    fakePersona('ava-okafor', 'Ava Okafor'),
  ];
  const moments = opts.moments ?? makeStore({ named });
  const routes = new MomentsIndexRoutes({
    named,
    moments,
    relationships: opts.relationships ?? null,
    simSpeed: 30,
    publicBaseUrl: opts.publicBaseUrl ?? 'https://tinyhouse.up.railway.app',
    perIpPerMin: opts.perIpPerMin ?? 60,
    pageSize: opts.pageSize ?? 25,
  });
  return { routes, moments, named };
}

function call(routes: MomentsIndexRoutes, search: string, ip = '127.0.0.1') {
  const res = mockRes();
  const params = new URLSearchParams(search);
  const out = routes.handleIndexPage(mockReq({ remoteAddress: ip }), res, params);
  return { res, out };
}

describe('MomentsIndexRoutes.handleIndexPage', () => {
  test('200 + HTML on the unfiltered index, returns 25 newest rows', () => {
    const { routes } = buildRoutes();
    const { res, out } = call(routes, '');
    expect(out.status).toBe(200);
    expect(out.filterKey).toBe('');
    expect(res.responseHeaders['content-type']).toContain('text/html');
    expect(res.body).toContain('All moments');
    expect(res.body).toContain('Moments — TinyHouse');
    expect(res.body).toContain('og:url');
    expect(res.body).toContain('https://tinyhouse.up.railway.app/moments');
    // 25 rows by default. Newest first → mom30 down to mom6.
    expect(res.body).toContain('href="/moment/mom30"');
    expect(res.body).toContain('href="/moment/mom6"');
    expect(res.body).not.toContain('href="/moment/mom5"');
    // Pager link to the cursor for the 26th-newest record.
    expect(res.body).toContain('older →');
  });

  test('cursor paginates older results', () => {
    const { routes } = buildRoutes();
    // Last sim time on page 1 is 1005 (mom6). Cursor=1005 should start at 1004.
    const { res, out } = call(routes, 'cursor=1005');
    expect(out.status).toBe(200);
    expect(res.body).toContain('href="/moment/mom5"');
    expect(res.body).toContain('href="/moment/mom1"');
    // No further page after the oldest record.
    expect(res.body).not.toContain('older →');
  });

  test('character filter resolves slug to id and AND-matches participants', () => {
    const moments = makeStore({ count: 5 });
    moments.captureClose(
      {
        sessionId: 'extra1',
        simTime: 2000,
        openedAt: 2000,
        transcript: [],
        participants: [
          { id: 'ava-okafor', name: 'Ava Okafor', named: true, color: '#cccccc' },
          { id: 'hiro-abe', name: 'Hiro Abe', named: true, color: '#fedcba' },
        ],
        zone: 'park',
        closeReason: 'idle',
      },
      deriveWorldClock(2000, 30),
    );
    const { routes } = buildRoutes({ moments });
    // Filter by mei → only Mei&Hiro records, skips Ava's. The +1 record
    // appended above is mom6 (no Mei), should be excluded.
    const { res, out } = call(routes, 'character=mei');
    expect(out.status).toBe(200);
    expect(out.filterKey).toBe('character=mei-tanaka');
    expect(res.body).not.toContain('href="/moment/mom6"');
    expect(res.body).toContain('href="/moment/mom5"');
    // OG title shifts to lead with the character.
    expect(res.body).toContain('Mei Tanaka — moments · TinyHouse');
  });

  test('character filter ANDs multiple comma-separated names', () => {
    const moments = makeStore({ count: 0 });
    // Both records share the same store + idGenerator from makeStore; they
    // mint mom1 and mom2 in order.
    moments.captureClose(
      {
        sessionId: 'meihiro',
        simTime: 3000,
        openedAt: 3000,
        transcript: [],
        participants: [
          { id: 'mei-tanaka', name: 'Mei Tanaka', named: true, color: '#abcdef' },
          { id: 'hiro-abe', name: 'Hiro Abe', named: true, color: '#fedcba' },
        ],
        zone: 'cafe',
        closeReason: 'idle',
      },
      deriveWorldClock(3000, 30),
    );
    moments.captureClose(
      {
        sessionId: 'meiava',
        simTime: 3001,
        openedAt: 3001,
        transcript: [],
        participants: [
          { id: 'mei-tanaka', name: 'Mei Tanaka', named: true, color: '#abcdef' },
          { id: 'ava-okafor', name: 'Ava Okafor', named: true, color: '#cccccc' },
        ],
        zone: 'park',
        closeReason: 'idle',
      },
      deriveWorldClock(3001, 30),
    );
    const { routes } = buildRoutes({ moments });
    const { res, out } = call(routes, 'character=mei,hiro');
    expect(out.status).toBe(200);
    // Sorted in canonical key, so dedup buckets agree across URL orderings.
    expect(out.filterKey).toBe('character=hiro-abe,mei-tanaka');
    expect(res.body).toContain('href="/moment/mom1"');
    expect(res.body).not.toContain('href="/moment/mom2"');
  });

  test('zone filter exact-matches and survives case', () => {
    const moments = makeStore({ count: 0 });
    moments.captureClose(
      {
        sessionId: 'in-cafe',
        simTime: 4000,
        openedAt: 4000,
        transcript: [],
        participants: [
          { id: 'mei-tanaka', name: 'Mei Tanaka', named: true, color: '#abcdef' },
          { id: 'hiro-abe', name: 'Hiro Abe', named: true, color: '#fedcba' },
        ],
        zone: 'cafe',
        closeReason: 'idle',
      },
      deriveWorldClock(4000, 30),
    );
    moments.captureClose(
      {
        sessionId: 'in-park',
        simTime: 4001,
        openedAt: 4001,
        transcript: [],
        participants: [
          { id: 'mei-tanaka', name: 'Mei Tanaka', named: true, color: '#abcdef' },
          { id: 'hiro-abe', name: 'Hiro Abe', named: true, color: '#fedcba' },
        ],
        zone: 'park',
        closeReason: 'idle',
      },
      deriveWorldClock(4001, 30),
    );
    const { routes } = buildRoutes({ moments });
    const { res, out } = call(routes, 'zone=cafe');
    expect(out.status).toBe(200);
    expect(out.filterKey).toBe('zone=cafe');
    expect(res.body).toContain('href="/moment/mom1"');
    expect(res.body).not.toContain('href="/moment/mom2"');
  });

  test('variant filter narrows to group-only moments', () => {
    const moments = makeStore({ count: 3 });
    moments.captureGroup(
      {
        sessionId: 'g1',
        simTime: 5000,
        participants: [
          { id: 'mei-tanaka', name: 'Mei Tanaka', named: true, color: '#abcdef' },
          { id: 'hiro-abe', name: 'Hiro Abe', named: true, color: '#fedcba' },
          { id: 'ava-okafor', name: 'Ava Okafor', named: true, color: '#cccccc' },
        ],
        zone: 'park',
      },
      deriveWorldClock(5000, 30),
    );
    const { routes } = buildRoutes({ moments });
    const { res, out } = call(routes, 'variant=group');
    expect(out.status).toBe(200);
    expect(out.filterKey).toBe('variant=group');
    expect(res.body).toContain('href="/moment/mom4"');
    // mom1..3 are conversations and should be filtered out.
    expect(res.body).not.toContain('href="/moment/mom1"');
    expect(res.body).toContain('group');
  });

  test('combinations AND together (character + zone)', () => {
    const moments = makeStore({ count: 0 });
    moments.captureClose(
      {
        sessionId: 'mei-cafe',
        simTime: 6000,
        openedAt: 6000,
        transcript: [],
        participants: [
          { id: 'mei-tanaka', name: 'Mei Tanaka', named: true, color: '#abcdef' },
          { id: 'hiro-abe', name: 'Hiro Abe', named: true, color: '#fedcba' },
        ],
        zone: 'cafe',
        closeReason: 'idle',
      },
      deriveWorldClock(6000, 30),
    );
    moments.captureClose(
      {
        sessionId: 'mei-park',
        simTime: 6001,
        openedAt: 6001,
        transcript: [],
        participants: [
          { id: 'mei-tanaka', name: 'Mei Tanaka', named: true, color: '#abcdef' },
          { id: 'hiro-abe', name: 'Hiro Abe', named: true, color: '#fedcba' },
        ],
        zone: 'park',
        closeReason: 'idle',
      },
      deriveWorldClock(6001, 30),
    );
    const { routes } = buildRoutes({ moments });
    const { res, out } = call(routes, 'character=mei&zone=cafe');
    expect(out.status).toBe(200);
    expect(out.filterKey).toBe('character=mei-tanaka&zone=cafe');
    expect(res.body).toContain('href="/moment/mom1"');
    expect(res.body).not.toContain('href="/moment/mom2"');
  });

  test('400 on malformed character / zone / variant / cursor tokens', () => {
    const { routes } = buildRoutes();
    expect(call(routes, 'character=../etc/passwd').out.status).toBe(400);
    expect(call(routes, 'zone=%21%21').out.status).toBe(400);
    expect(call(routes, 'variant=spaceship').out.status).toBe(400);
    expect(call(routes, 'cursor=abc').out.status).toBe(400);
    // Unknown character resolves to 400 (mirror of /character 404 contract,
    // but here it's a filter validation error).
    expect(call(routes, 'character=notapersona').out.status).toBe(400);
  });

  test('empty filter view renders an empty-state message', () => {
    const moments = makeStore({ count: 0 });
    const { routes } = buildRoutes({ moments });
    const { res } = call(routes, '');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('No moments matched these filters yet');
  });

  test('rate-limits per IP and returns 429', () => {
    const { routes } = buildRoutes({ perIpPerMin: 2 });
    expect(call(routes, '').out.status).toBe(200);
    expect(call(routes, '').out.status).toBe(200);
    const { res, out } = call(routes, '');
    expect(out.status).toBe(429);
    expect(out.rateLimited).toBe(true);
    expect(res.responseHeaders['retry-after']).toBeDefined();
  });

  test('canonical/og:url reflects active filters', () => {
    const { routes } = buildRoutes();
    const { res } = call(routes, 'character=mei&zone=cafe&variant=conversation');
    // `&` is HTML-escaped inside the meta attribute — the canonical content
    // is identical; only the attribute encoding differs.
    expect(res.body).toContain(
      'href="https://tinyhouse.up.railway.app/moments?character=mei-tanaka&amp;zone=cafe&amp;variant=conversation"',
    );
  });

  test('escapes user-controlled headline + zone content', () => {
    const moments = new MomentStore({
      maxMoments: 5,
      idGenerator: () => 'momX',
    });
    // Hand-craft a record with hostile zone via captureClose.
    moments.captureClose(
      {
        sessionId: 'xss',
        simTime: 7000,
        openedAt: 7000,
        transcript: [{ speakerId: 'mei-tanaka', text: '<b>hi</b>', at: 7000 }],
        participants: [
          { id: 'mei-tanaka', name: 'Mei Tanaka', named: true, color: '#abcdef' },
          { id: '<b>other</b>', name: '<b>Other</b>', named: false, color: null },
        ],
        zone: 'cafe',
        closeReason: 'idle',
      },
      deriveWorldClock(7000, 30),
    );
    // Manually inject a hostile zone after capture by mutating the record.
    const all = moments.list();
    if (all[0]) all[0].zone = '<scary>';
    const { routes } = buildRoutes({ moments });
    const { res } = call(routes, '');
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('<b>Other</b>');
    expect(res.body).toContain('&lt;b&gt;Other&lt;/b&gt;');
    expect(res.body).toContain('&lt;scary&gt;');
  });
});

describe('MomentsIndexRoutes /moments/og.png (TINA-1092)', () => {
  function mockBinaryRes(): MockRes & { binary: Buffer } {
    const state = {
      statusCode: 0,
      body: '',
      binary: Buffer.alloc(0),
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
      get binary() {
        return state.binary;
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
        if (Buffer.isBuffer(body)) {
          // Copy to widen ArrayBufferLike → ArrayBuffer (matches og-routes.test).
          state.binary = Buffer.from(body);
        } else {
          state.body = body ?? '';
        }
      },
    } as unknown as MockRes & { binary: Buffer };
    return res;
  }

  function buildOgRoutes(
    opts: {
      moments?: MomentStore;
      cache?: OgCache | null;
      onOgRender?: (ip: string) => void;
      perIpPerMin?: number;
    } = {},
  ) {
    const named = [
      fakePersona('mei-tanaka', 'Mei Tanaka'),
      fakePersona('hiro-abe', 'Hiro Abe'),
      fakePersona('ava-okafor', 'Ava Okafor'),
    ];
    const moments = opts.moments ?? makeStore({ named });
    const cache = opts.cache === undefined ? new OgCache() : opts.cache;
    const routes = new MomentsIndexRoutes({
      named,
      moments,
      relationships: null,
      simSpeed: 30,
      publicBaseUrl: 'https://tinyhouse.up.railway.app',
      ogCache: cache,
      onOgRender: opts.onOgRender,
      perIpPerMin: opts.perIpPerMin ?? 60,
    });
    return { routes, moments, cache };
  }

  test('hasOgImage() reflects whether the cache is wired', () => {
    const { routes: with_ } = buildOgRoutes();
    expect(with_.hasOgImage()).toBe(true);
    const { routes: without } = buildOgRoutes({ cache: null });
    expect(without.hasOgImage()).toBe(false);
  });

  test('200 PNG on first hit, x-og-cache: miss', async () => {
    const { routes } = buildOgRoutes();
    const res = mockBinaryRes();
    await routes.handleMomentsIndexOgImage(mockReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.responseHeaders['content-type']).toBe('image/png');
    expect(res.responseHeaders['x-og-cache']).toBe('miss');
    expect(res.binary.length).toBeGreaterThan(1000);
    // PNG signature.
    expect(
      res.binary
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBe(true);
  });

  test('second hit serves from cache (x-og-cache: hit, identical bytes)', async () => {
    const { routes } = buildOgRoutes();
    const res1 = mockBinaryRes();
    await routes.handleMomentsIndexOgImage(mockReq(), res1);
    // Wait a tick so the fire-and-forget cache.set lands in the in-memory map.
    await new Promise((r) => setImmediate(r));
    const res2 = mockBinaryRes();
    await routes.handleMomentsIndexOgImage(mockReq(), res2);
    expect(res2.responseHeaders['x-og-cache']).toBe('hit');
    expect(res2.binary.equals(res1.binary)).toBe(true);
  });

  test('cache key churns when the freshest moment changes', async () => {
    const { routes, moments } = buildOgRoutes();
    const res1 = mockBinaryRes();
    await routes.handleMomentsIndexOgImage(mockReq(), res1);
    await new Promise((r) => setImmediate(r));
    // Append a new freshest moment — cache key should now be a miss.
    moments.captureClose(
      {
        sessionId: 'fresh',
        simTime: 50_000,
        openedAt: 50_000,
        transcript: [],
        participants: [
          { id: 'mei-tanaka', name: 'Mei Tanaka', named: true, color: '#abcdef' },
          { id: 'ava-okafor', name: 'Ava Okafor', named: true, color: '#cccccc' },
        ],
        zone: 'park',
        closeReason: 'idle',
      },
      deriveWorldClock(50_000, 30),
    );
    const res2 = mockBinaryRes();
    await routes.handleMomentsIndexOgImage(mockReq(), res2);
    expect(res2.responseHeaders['x-og-cache']).toBe('miss');
    // Different freshest record + different participants ⇒ different bytes.
    expect(res2.binary.equals(res1.binary)).toBe(false);
  });

  test('renders a fallback card on a cold sim (empty store)', async () => {
    const empty = new MomentStore({ maxMoments: 5 });
    const { routes } = buildOgRoutes({ moments: empty });
    const res = mockBinaryRes();
    await routes.handleMomentsIndexOgImage(mockReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.binary.length).toBeGreaterThan(1000);
  });

  test('404 when the OG cache is not wired', async () => {
    const { routes } = buildOgRoutes({ cache: null });
    const res = mockBinaryRes();
    await routes.handleMomentsIndexOgImage(mockReq(), res);
    expect(res.statusCode).toBe(404);
  });

  test('shares the per-IP rate limiter with the index page', async () => {
    const { routes } = buildOgRoutes({ perIpPerMin: 2 });
    // Two index hits exhaust the per-IP bucket.
    expect(call(routes, '').out.status).toBe(200);
    expect(call(routes, '').out.status).toBe(200);
    const res = mockBinaryRes();
    await routes.handleMomentsIndexOgImage(mockReq(), res);
    expect(res.statusCode).toBe(429);
    expect(res.responseHeaders['retry-after']).toBeDefined();
  });

  test('onOgRender callback fires with the requesting IP after a 200', async () => {
    const seen: string[] = [];
    const { routes } = buildOgRoutes({ onOgRender: (ip) => seen.push(ip) });
    const res = mockBinaryRes();
    await routes.handleMomentsIndexOgImage(mockReq({ remoteAddress: '203.0.113.7' }), res);
    expect(res.statusCode).toBe(200);
    expect(seen).toEqual(['203.0.113.7']);
  });

  test('HTML index page emits og:image meta tags when the OG cache is wired', () => {
    const { routes } = buildOgRoutes();
    const { res } = call(routes, '');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(
      '<meta property="og:image" content="https://tinyhouse.up.railway.app/moments/og.png" />',
    );
    expect(res.body).toContain('<meta property="og:image:width" content="1200" />');
    expect(res.body).toContain('<meta property="og:image:height" content="630" />');
    expect(res.body).toContain(
      '<meta name="twitter:image" content="https://tinyhouse.up.railway.app/moments/og.png" />',
    );
    expect(res.body).toContain('<meta name="twitter:card" content="summary_large_image" />');
  });

  test('HTML index page falls back to text-card meta when OG cache is absent', () => {
    const { routes } = buildOgRoutes({ cache: null });
    const { res } = call(routes, '');
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('og:image');
    expect(res.body).toContain('<meta name="twitter:card" content="summary" />');
  });
});

describe('buildFilterKey', () => {
  test('sorts characters and field order so URL variants share a bucket', () => {
    expect(
      buildFilterKey({
        characterIds: ['mei-tanaka', 'hiro-abe'],
        zone: 'cafe',
        variant: 'group',
      }),
    ).toBe('character=hiro-abe,mei-tanaka&variant=group&zone=cafe');
    expect(
      buildFilterKey({
        characterIds: ['hiro-abe', 'mei-tanaka'],
        zone: 'cafe',
        variant: 'group',
      }),
    ).toBe('character=hiro-abe,mei-tanaka&variant=group&zone=cafe');
  });

  test('returns empty string for unfiltered view', () => {
    expect(buildFilterKey({ characterIds: [], zone: null, variant: null })).toBe('');
  });
});
