import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { deriveWorldClock } from '@tina/shared';
import { type NamedPersona, RelationshipStore } from '@tina/sim';
import { describe, expect, test } from 'vitest';
import { CharacterRoutes } from './character-routes.js';
import { MomentStore } from './moments.js';
import { ObservabilityStore } from './observability.js';
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
      occupation: 'librarian',
      age: 42,
      schedule: [
        { hour: 9, zone: 'work', intent: 'open the branch' },
        { hour: 12, zone: 'park', intent: 'lunch at the bench' },
        { hour: 19, zone: 'home', intent: 'reading at home' },
      ],
    },
    skill: {} as unknown as NamedPersona['skill'],
    memoryRoot: `/tmp/${id}`,
    manifestPath: `/tmp/${id}.yaml`,
    scheduleByHour: new Map([
      [9, { hour: 9, zone: 'work', intent: 'open the branch' }],
      [12, { hour: 12, zone: 'park', intent: 'lunch at the bench' }],
      [19, { hour: 19, zone: 'home', intent: 'reading at home' }],
    ]),
  };
}

function buildRoutes(
  opts: {
    named?: NamedPersona[];
    moments?: MomentStore;
    relationships?: RelationshipStore | null;
    observability?: ObservabilityStore;
  } = {},
) {
  const named = opts.named ?? [
    fakePersona('mei-tanaka', 'Mei Tanaka'),
    fakePersona('hiro-abe', 'Hiro Abe'),
  ];
  const moments = opts.moments ?? new MomentStore({ maxMoments: 50 });
  const observability = opts.observability ?? new ObservabilityStore();
  const routes = new CharacterRoutes({
    named,
    moments,
    relationships: opts.relationships ?? null,
    observability,
    simSpeed: 30,
    publicBaseUrl: 'https://tinyhouse.up.railway.app',
  });
  return { routes, named, moments, observability };
}

describe('CharacterRoutes.handleCharacterPage', () => {
  test('renders 200 + HTML for a known character (case-insensitive)', () => {
    const { routes } = buildRoutes();
    for (const slug of ['mei-tanaka', 'Mei-Tanaka', 'MEI-TANAKA']) {
      const res = mockRes();
      const out = routes.handleCharacterPage(mockReq(), res, slug);
      expect(out.status).toBe(200);
      expect(out.personaId).toBe('mei-tanaka');
      expect(res.responseHeaders['content-type']).toContain('text/html');
      expect(res.body).toContain('Mei Tanaka');
      expect(res.body).toContain('Mei Tanaka&#39;s bio.');
      expect(res.body).toContain('og:url');
      expect(res.body).toContain('https://tinyhouse.up.railway.app/character/mei-tanaka');
    }
  });

  test('resolves first-name slug to the named persona', () => {
    const { routes } = buildRoutes();
    const res = mockRes();
    const out = routes.handleCharacterPage(mockReq(), res, 'mei');
    expect(out.status).toBe(200);
    expect(out.personaId).toBe('mei-tanaka');
  });

  test('returns 404 + HTML when name is unknown', () => {
    const { routes } = buildRoutes();
    const res = mockRes();
    const out = routes.handleCharacterPage(mockReq(), res, 'nobody');
    expect(out.status).toBe(404);
    expect(out.personaId).toBeNull();
    expect(res.responseHeaders['content-type']).toContain('text/html');
    expect(res.body).toContain('character not found');
    // 404 page should still link back home and list the named roster.
    expect(res.body).toContain('back to the live sim');
    expect(res.body).toContain('Mei Tanaka');
  });

  test('rejects names that fail the safety pattern', () => {
    const { routes } = buildRoutes();
    const res = mockRes();
    const out = routes.handleCharacterPage(mockReq(), res, '../etc/passwd');
    expect(out.status).toBe(404);
  });

  test('renders empty-state copy when there are no arcs / moments / affordances (TINA-482 boot edge case)', () => {
    const { routes } = buildRoutes();
    const res = mockRes();
    routes.handleCharacterPage(mockReq(), res, 'mei-tanaka');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Today's schedule");
    expect(res.body).toContain('Current arcs');
    expect(res.body).toContain('Recent moments');
    expect(res.body).toContain('Recent affordance uses');
    expect(res.body).toContain('No tracked relationships yet.');
    expect(res.body).toContain('No recent moments yet');
    expect(res.body).toContain('No affordance uses tracked yet');
    // Schedule strip renders all 24 hours regardless of authored coverage.
    expect(res.body).toContain('00:00');
    expect(res.body).toContain('23:00');
    expect(res.body).toContain('open the branch');
  });

  test('renders arcs, recent moments (with group badge) and affordance uses', () => {
    const moments = new MomentStore({
      maxMoments: 10,
      idGenerator: (() => {
        let n = 0;
        return () => `mom${++n}`;
      })(),
    });
    moments.captureClose(
      {
        sessionId: 's1',
        simTime: 15 * 3600,
        openedAt: 15 * 3600,
        transcript: [{ speakerId: 'mei-tanaka', text: 'hi', at: 15 * 3600 }],
        participants: [
          { id: 'mei-tanaka', name: 'Mei Tanaka', named: true, color: '#abcdef' },
          { id: 'hiro-abe', name: 'Hiro Abe', named: true, color: '#fedcba' },
        ],
        zone: 'cafe',
        closeReason: 'idle',
      },
      deriveWorldClock(15 * 3600, 30),
    );
    moments.captureGroup(
      {
        sessionId: 'g1',
        simTime: 18 * 3600,
        participants: [
          { id: 'mei-tanaka', name: 'Mei Tanaka', named: true, color: '#abcdef' },
          { id: 'hiro-abe', name: 'Hiro Abe', named: true, color: '#fedcba' },
          { id: 'ava-okafor', name: 'Ava Okafor', named: true, color: '#cccccc' },
        ],
        zone: 'park',
      },
      deriveWorldClock(18 * 3600, 30),
    );
    const relationships = new RelationshipStore();
    relationships.recordClose({ a: 'mei-tanaka', b: 'hiro-abe', simTime: 100, turnCount: 6 });
    relationships.recordClose({ a: 'mei-tanaka', b: 'hiro-abe', simTime: 200, turnCount: 6 });
    relationships.rolloverDay(8 * 86400);
    const observability = new ObservabilityStore();
    observability.recordAffordanceEvent({
      agentId: 'mei-tanaka',
      agentName: 'Mei Tanaka',
      objectId: 'bench-1',
      label: 'park bench',
      affordance: 'sit',
      zone: 'park',
      simTime: 12 * 3600,
    });
    const { routes } = buildRoutes({ moments, relationships, observability });
    const res = mockRes();
    routes.handleCharacterPage(mockReq(), res, 'mei-tanaka');
    expect(res.statusCode).toBe(200);
    // arc chip for warming Mei × Hiro
    expect(res.body).toContain('arc-chip');
    expect(res.body).toContain('data-arc="warming"');
    expect(res.body).toContain('Hiro Abe');
    // moment links — both 1:1 and group should render with /moment/ deep links
    expect(res.body).toContain('href="/moment/mom1"');
    expect(res.body).toContain('href="/moment/mom2"');
    expect(res.body).toContain('class="badge">group');
    // affordance row
    expect(res.body).toContain('sat at');
    expect(res.body).toContain('park bench');
  });

  test('rate-limits per IP and returns 429', () => {
    const { routes: r } = buildRoutes();
    // Rebuild with a tight per-IP cap so we don't have to fire 60 requests.
    const tight = new CharacterRoutes({
      named: [fakePersona('mei-tanaka', 'Mei Tanaka')],
      moments: new MomentStore({ maxMoments: 5 }),
      observability: new ObservabilityStore(),
      simSpeed: 30,
      perIpPerMin: 2,
      globalPerMin: 100,
      now: () => 1_000_000,
    });
    void r;
    for (let i = 0; i < 2; i++) {
      const res = mockRes();
      const out = tight.handleCharacterPage(mockReq(), res, 'mei-tanaka');
      expect(out.status).toBe(200);
    }
    const res = mockRes();
    const out = tight.handleCharacterPage(mockReq(), res, 'mei-tanaka');
    expect(out.status).toBe(429);
    expect(out.rateLimited).toBe(true);
    expect(res.responseHeaders['retry-after']).toBeDefined();
  });

  test('emits the OG image meta tag set when the cache is wired (TINA-882)', () => {
    const ogCache = new OgCache({ maxEntries: 4 });
    const routes = new CharacterRoutes({
      named: [fakePersona('mei-tanaka', 'Mei Tanaka')],
      moments: new MomentStore({ maxMoments: 5 }),
      observability: new ObservabilityStore(),
      simSpeed: 30,
      publicBaseUrl: 'https://tinyhouse.up.railway.app',
      ogCache,
    });
    const res = mockRes();
    routes.handleCharacterPage(mockReq(), res, 'mei-tanaka');
    expect(res.statusCode).toBe(200);
    // All four OG/Twitter image tags + summary_large_image card.
    expect(res.body).toContain('og:image');
    expect(res.body).toContain('https://tinyhouse.up.railway.app/character/mei-tanaka/og.png');
    expect(res.body).toContain('og:image:width" content="1200"');
    expect(res.body).toContain('og:image:height" content="630"');
    expect(res.body).toContain('og:image:type" content="image/png"');
    expect(res.body).toContain('twitter:card" content="summary_large_image"');
  });

  test('falls back to text-only OG meta when no cache is wired', () => {
    const { routes } = buildRoutes();
    const res = mockRes();
    routes.handleCharacterPage(mockReq(), res, 'mei-tanaka');
    expect(res.body).toContain('twitter:card" content="summary"');
    expect(res.body).not.toContain('og:image');
  });

  test('escapes user-controlled bio + headline content (with OG cache off)', () => {
    const xssyPersona = fakePersona('xss', 'Xss');
    xssyPersona.manifest.bio = '<script>alert(1)</script>';
    const moments = new MomentStore({
      maxMoments: 5,
      idGenerator: () => 'momX',
    });
    moments.captureClose(
      {
        sessionId: 's-xss',
        simTime: 1000,
        openedAt: 1000,
        transcript: [{ speakerId: 'xss', text: '<script>', at: 1000 }],
        participants: [
          { id: 'xss', name: '<b>Xss</b>', named: true, color: null },
          { id: 'other', name: 'Other', named: true, color: null },
        ],
        zone: '<zone>',
        closeReason: 'idle',
      },
      deriveWorldClock(1000, 30),
    );
    const routes = new CharacterRoutes({
      named: [xssyPersona],
      moments,
      observability: new ObservabilityStore(),
      simSpeed: 30,
    });
    const res = mockRes();
    routes.handleCharacterPage(mockReq(), res, 'xss');
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('<script>alert(1)</script>');
    expect(res.body).toContain('&lt;script&gt;');
    expect(res.body).toContain('&lt;zone&gt;');
  });
});

describe('CharacterRoutes.handleCharacterOgImage (TINA-882)', () => {
  function buildOgRoutes(persona = fakePersona('mei-tanaka', 'Mei Tanaka')) {
    const ogCache = new OgCache({ maxEntries: 8 });
    const moments = new MomentStore({
      maxMoments: 5,
      idGenerator: (() => {
        let n = 0;
        return () => `mom${++n}`;
      })(),
    });
    const ogRenders: Array<{ id: string; ip: string }> = [];
    const routes = new CharacterRoutes({
      named: [persona, fakePersona('hiro-abe', 'Hiro Abe')],
      moments,
      observability: new ObservabilityStore(),
      simSpeed: 30,
      ogCache,
      onOgRender: (id, ip) => {
        ogRenders.push({ id, ip });
      },
    });
    return { routes, ogCache, moments, ogRenders };
  }

  test('200 PNG on a known character with LRU caching', async () => {
    const { routes, ogCache } = buildOgRoutes();
    const res = mockRes();
    await routes.handleCharacterOgImage(mockReq(), res, 'mei-tanaka');
    expect(res.statusCode).toBe(200);
    expect(res.responseHeaders['content-type']).toBe('image/png');
    expect(res.responseHeaders['x-og-cache']).toBe('miss');
    // Cache write is fire-and-forget — drain microtasks before checking size.
    await new Promise((r) => setImmediate(r));
    expect(ogCache.size()).toBe(1);
    // Second hit serves from the cache.
    const res2 = mockRes();
    await routes.handleCharacterOgImage(mockReq(), res2, 'mei-tanaka');
    expect(res2.responseHeaders['x-og-cache']).toBe('hit');
  });

  test('first-name slug resolves to canonical id for cache key', async () => {
    const { routes, ogCache } = buildOgRoutes();
    const res = mockRes();
    await routes.handleCharacterOgImage(mockReq(), res, 'mei');
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(ogCache.size()).toBe(1);
    // Same persona via the manifest id should be a cache hit, not miss.
    const res2 = mockRes();
    await routes.handleCharacterOgImage(mockReq(), res2, 'mei-tanaka');
    expect(res2.responseHeaders['x-og-cache']).toBe('hit');
  });

  test('returns 404 for unknown character', async () => {
    const { routes } = buildOgRoutes();
    const res = mockRes();
    await routes.handleCharacterOgImage(mockReq(), res, 'nobody');
    expect(res.statusCode).toBe(404);
  });

  test('rejects malformed names with 404', async () => {
    const { routes } = buildOgRoutes();
    const res = mockRes();
    await routes.handleCharacterOgImage(mockReq(), res, '../etc/passwd');
    expect(res.statusCode).toBe(404);
  });

  test('falls through to 404 when no cache is wired', async () => {
    const routes = new CharacterRoutes({
      named: [fakePersona('mei-tanaka', 'Mei Tanaka')],
      moments: new MomentStore({ maxMoments: 5 }),
      observability: new ObservabilityStore(),
      simSpeed: 30,
    });
    const res = mockRes();
    await routes.handleCharacterOgImage(mockReq(), res, 'mei-tanaka');
    expect(res.statusCode).toBe(404);
  });

  test('shares the rate limiter with the HTML route', async () => {
    const ogCache = new OgCache({ maxEntries: 4 });
    const routes = new CharacterRoutes({
      named: [fakePersona('mei-tanaka', 'Mei Tanaka')],
      moments: new MomentStore({ maxMoments: 5 }),
      observability: new ObservabilityStore(),
      simSpeed: 30,
      perIpPerMin: 2,
      globalPerMin: 100,
      now: () => 1_000_000,
      ogCache,
    });
    // Hit the HTML route twice — that exhausts the per-IP bucket of 2.
    for (let i = 0; i < 2; i++) {
      const r = mockRes();
      const out = routes.handleCharacterPage(mockReq(), r, 'mei-tanaka');
      expect(out.status).toBe(200);
    }
    // The OG route should share the bucket and be 429'd.
    const res = mockRes();
    await routes.handleCharacterOgImage(mockReq(), res, 'mei-tanaka');
    expect(res.statusCode).toBe(429);
  });

  test('fires onOgRender with canonical persona id and request IP', async () => {
    const { routes, ogRenders } = buildOgRoutes();
    const res = mockRes();
    await routes.handleCharacterOgImage(mockReq({ remoteAddress: '203.0.113.5' }), res, 'mei');
    expect(res.statusCode).toBe(200);
    expect(ogRenders).toEqual([{ id: 'mei-tanaka', ip: '203.0.113.5' }]);
  });
});
