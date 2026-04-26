import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { deriveWorldClock } from '@tina/shared';
import { type NamedPersona, RelationshipStore } from '@tina/sim';
import { describe, expect, test } from 'vitest';
import { ArcRoutes, buildArcDescription, resolveArcSlug } from './arc-routes.js';
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
    end(body?: string | Buffer) {
      state.body = typeof body === 'string' ? body : (body?.toString('binary') ?? '');
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

const NAMED: NamedPersona[] = [
  fakePersona('ava-okafor', 'Ava Okafor'),
  fakePersona('hiro-abe', 'Hiro Abe'),
  fakePersona('mei-tanaka', 'Mei Tanaka'),
];

function buildRoutes(
  opts: {
    named?: NamedPersona[];
    moments?: MomentStore;
    relationships?: RelationshipStore;
    isSessionNudged?: ((sessionId: string) => unknown | null) | null;
    perIpPerMin?: number;
    globalPerMin?: number;
    now?: () => number;
    currentSimTime?: () => number;
  } = {},
) {
  const named = opts.named ?? NAMED;
  const moments = opts.moments ?? new MomentStore({ maxMoments: 50 });
  const relationships = opts.relationships ?? new RelationshipStore();
  const cache = new OgCache({ maxEntries: 16 });
  const routes = new ArcRoutes({
    named,
    moments,
    cache,
    relationships,
    isSessionNudged: opts.isSessionNudged ?? null,
    simSpeed: 30,
    currentSimTime: opts.currentSimTime ?? (() => 7 * 24 * 3600),
    publicBaseUrl: 'https://tinyhouse.up.railway.app',
    perIpPerMin: opts.perIpPerMin,
    globalPerMin: opts.globalPerMin,
    now: opts.now,
  });
  return { routes, moments, cache, relationships, named };
}

function captureClose(
  moments: MomentStore,
  opts: {
    sessionId: string;
    a: NamedPersona;
    b: NamedPersona;
    simTime: number;
    transcriptTurns?: number;
    zone?: string;
  },
): void {
  const turns = Array.from({ length: opts.transcriptTurns ?? 2 }, (_, i) => ({
    speakerId: i % 2 === 0 ? opts.a.manifest.id : opts.b.manifest.id,
    text: `turn ${i}`,
    at: opts.simTime - (opts.transcriptTurns ?? 2) + i,
  }));
  moments.captureClose(
    {
      sessionId: opts.sessionId,
      simTime: opts.simTime,
      openedAt: opts.simTime - 60,
      transcript: turns,
      participants: [
        {
          id: opts.a.manifest.id,
          name: opts.a.manifest.name,
          named: true,
          color: opts.a.manifest.glyph.color,
        },
        {
          id: opts.b.manifest.id,
          name: opts.b.manifest.name,
          named: true,
          color: opts.b.manifest.glyph.color,
        },
      ],
      zone: opts.zone ?? 'cafe',
      closeReason: 'idle',
    },
    deriveWorldClock(opts.simTime, 30),
  );
}

describe('resolveArcSlug', () => {
  const resolverMap = new Map<string, NamedPersona>();
  for (const p of NAMED) {
    resolverMap.set(p.manifest.id, p);
    const first = p.manifest.name.split(/\s+/, 1)[0]!.toLowerCase();
    if (!resolverMap.has(first)) resolverMap.set(first, p);
  }

  test('resolves first-name pair in either order to the same canonical slug', () => {
    const a = resolveArcSlug('mei-hiro', resolverMap);
    const b = resolveArcSlug('hiro-mei', resolverMap);
    const c = resolveArcSlug('MEI-HIRO', resolverMap);
    expect(a?.canonicalSlug).toBe('hiro-mei');
    expect(b?.canonicalSlug).toBe('hiro-mei');
    expect(c?.canonicalSlug).toBe('hiro-mei');
  });

  test('canonical order is id-ascending — ava sorts before hiro', () => {
    const r = resolveArcSlug('hiro-ava', resolverMap);
    expect(r?.canonicalSlug).toBe('ava-hiro');
    expect(r?.a.manifest.id).toBe('ava-okafor');
    expect(r?.b.manifest.id).toBe('hiro-abe');
  });

  test('returns null when either side is unknown', () => {
    expect(resolveArcSlug('mei-nobody', resolverMap)).toBeNull();
    expect(resolveArcSlug('nobody-mei', resolverMap)).toBeNull();
  });

  test('returns null when both halves resolve to the same persona', () => {
    expect(resolveArcSlug('mei-mei', resolverMap)).toBeNull();
  });

  test('returns null when slug has no separator', () => {
    expect(resolveArcSlug('mei', resolverMap)).toBeNull();
  });
});

describe('ArcRoutes.handleArcPage', () => {
  test('renders 200 + HTML for a canonical slug with arcs/moments', () => {
    const { routes, moments, relationships } = buildRoutes();
    captureClose(moments, {
      sessionId: 's1',
      a: NAMED[2]!,
      b: NAMED[1]!,
      simTime: 7 * 24 * 3600,
    });
    relationships.recordClose({
      a: 'mei-tanaka',
      b: 'hiro-abe',
      simTime: 7 * 24 * 3600,
      turnCount: 4,
    });
    const res = mockRes();
    const out = routes.handleArcPage(mockReq(), res, 'hiro-mei');
    expect(out.status).toBe(200);
    expect(out.canonicalSlug).toBe('hiro-mei');
    expect(res.responseHeaders['content-type']).toContain('text/html');
    expect(res.body).toContain('og:url');
    expect(res.body).toContain('https://tinyhouse.up.railway.app/arc/hiro-mei');
    expect(res.body).toContain('Mei Tanaka');
    expect(res.body).toContain('Hiro Abe');
    // Stat pills + arc chip both rendered.
    expect(res.body).toContain('arc-chip');
    expect(res.body).toContain('Arc history');
    // Moments together section + character cross-link.
    expect(res.body).toContain('href="/character/mei-tanaka"');
    expect(res.body).toContain('href="/character/hiro-abe"');
  });

  test('non-canonical slug 302-redirects to canonical', () => {
    const { routes, moments, relationships } = buildRoutes();
    captureClose(moments, {
      sessionId: 's1',
      a: NAMED[2]!,
      b: NAMED[1]!,
      simTime: 7 * 24 * 3600,
    });
    relationships.recordClose({
      a: 'mei-tanaka',
      b: 'hiro-abe',
      simTime: 7 * 24 * 3600,
      turnCount: 2,
    });
    const res = mockRes();
    const out = routes.handleArcPage(mockReq(), res, 'mei-hiro');
    expect(out.status).toBe(302);
    expect(out.canonicalSlug).toBe('hiro-mei');
    expect(out.redirected).toBe(true);
    expect(res.responseHeaders.location).toBe('/arc/hiro-mei');
  });

  test('uppercase non-canonical also redirects', () => {
    const { routes, moments, relationships } = buildRoutes();
    captureClose(moments, {
      sessionId: 's1',
      a: NAMED[2]!,
      b: NAMED[1]!,
      simTime: 7 * 24 * 3600,
    });
    relationships.recordClose({
      a: 'mei-tanaka',
      b: 'hiro-abe',
      simTime: 7 * 24 * 3600,
      turnCount: 2,
    });
    const res = mockRes();
    const out = routes.handleArcPage(mockReq(), res, 'MEI-HIRO');
    expect(out.status).toBe(302);
    expect(res.responseHeaders.location).toBe('/arc/hiro-mei');
  });

  test('returns 404 when slug has no separator', () => {
    const { routes } = buildRoutes();
    const res = mockRes();
    const out = routes.handleArcPage(mockReq(), res, 'mei');
    expect(out.status).toBe(404);
    expect(res.body).toContain('arc not found');
  });

  test('returns 404 when either half is unknown', () => {
    const { routes } = buildRoutes();
    const res = mockRes();
    const out = routes.handleArcPage(mockReq(), res, 'mei-nobody');
    expect(out.status).toBe(404);
  });

  test('returns 404 when pair has no recorded interaction', () => {
    const { routes } = buildRoutes();
    const res = mockRes();
    const out = routes.handleArcPage(mockReq(), res, 'ava-mei');
    expect(out.status).toBe(404);
    expect(res.body).toContain('no arc yet');
  });

  test('rejects malformed names with 404 (no path traversal)', () => {
    const { routes } = buildRoutes();
    const res = mockRes();
    const out = routes.handleArcPage(mockReq(), res, '../etc/passwd');
    expect(out.status).toBe(404);
  });

  test('rate-limits per IP and returns 429', () => {
    const { routes, moments, relationships } = buildRoutes({
      perIpPerMin: 2,
      globalPerMin: 100,
      now: () => 1_000_000,
    });
    captureClose(moments, {
      sessionId: 's1',
      a: NAMED[2]!,
      b: NAMED[1]!,
      simTime: 7 * 24 * 3600,
    });
    relationships.recordClose({
      a: 'mei-tanaka',
      b: 'hiro-abe',
      simTime: 7 * 24 * 3600,
      turnCount: 4,
    });
    for (let i = 0; i < 2; i++) {
      const out = routes.handleArcPage(mockReq(), mockRes(), 'hiro-mei');
      expect(out.status).toBe(200);
    }
    const res = mockRes();
    const out = routes.handleArcPage(mockReq(), res, 'hiro-mei');
    expect(out.status).toBe(429);
    expect(out.rateLimited).toBe(true);
    expect(res.responseHeaders['retry-after']).toBeDefined();
  });

  test('moments timeline includes only this pair (filters out third-party moments)', () => {
    const { routes, moments, relationships } = buildRoutes();
    // Pair moment (mei × hiro)
    captureClose(moments, {
      sessionId: 's1',
      a: NAMED[2]!,
      b: NAMED[1]!,
      simTime: 7 * 24 * 3600,
    });
    // Different pair (mei × ava) — must not appear on hiro-mei page.
    captureClose(moments, {
      sessionId: 's2',
      a: NAMED[2]!,
      b: NAMED[0]!,
      simTime: 7 * 24 * 3600 - 100,
    });
    relationships.recordClose({
      a: 'mei-tanaka',
      b: 'hiro-abe',
      simTime: 7 * 24 * 3600,
      turnCount: 4,
    });
    const res = mockRes();
    routes.handleArcPage(mockReq(), res, 'hiro-mei');
    expect(res.statusCode).toBe(200);
    // The other pair's session should not be linked from this page.
    expect(res.body).toContain('href="/moment/');
    expect(res.body).not.toMatch(/Ava Okafor/);
  });

  test('escapes user-controlled headlines in output', () => {
    const { routes, moments, relationships } = buildRoutes();
    moments.captureClose(
      {
        sessionId: 's1',
        simTime: 7 * 24 * 3600,
        openedAt: 100,
        transcript: [
          {
            speakerId: 'mei-tanaka',
            text: '<script>alert(1)</script>',
            at: 7 * 24 * 3600,
          },
        ],
        participants: [
          {
            id: 'mei-tanaka',
            name: 'Mei Tanaka',
            named: true,
            color: '#abcdef',
          },
          {
            id: 'hiro-abe',
            name: 'Hiro Abe',
            named: true,
            color: '#fedcba',
          },
        ],
        zone: 'cafe',
        closeReason: 'idle',
      },
      deriveWorldClock(7 * 24 * 3600, 30),
    );
    relationships.recordClose({
      a: 'mei-tanaka',
      b: 'hiro-abe',
      simTime: 7 * 24 * 3600,
      turnCount: 1,
    });
    const res = mockRes();
    routes.handleArcPage(mockReq(), res, 'hiro-mei');
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('<script>alert(1)</script>');
  });

  test('nudges-applied counter reflects isSessionNudged hits', () => {
    const nudged = new Set<string>(['s1', 's3']);
    const { routes, moments, relationships } = buildRoutes({
      isSessionNudged: (sid) => (nudged.has(sid) ? 'spark' : null),
    });
    for (const sid of ['s1', 's2', 's3']) {
      captureClose(moments, {
        sessionId: sid,
        a: NAMED[2]!,
        b: NAMED[1]!,
        simTime: 7 * 24 * 3600,
      });
    }
    relationships.recordClose({
      a: 'mei-tanaka',
      b: 'hiro-abe',
      simTime: 7 * 24 * 3600,
      turnCount: 4,
    });
    const res = mockRes();
    routes.handleArcPage(mockReq(), res, 'hiro-mei');
    expect(res.statusCode).toBe(200);
    // The "nudges" stat pill should show 2 (s1 + s3).
    expect(res.body).toMatch(/<span class="num">2<\/span><span class="key">nudges<\/span>/);
    // Total moments shows 3.
    expect(res.body).toMatch(/<span class="num">3<\/span><span class="key">moments<\/span>/);
  });
});

describe('ArcRoutes.handleArcOgImage', () => {
  test('renders a 1200x630 PNG with caching', async () => {
    const { routes, moments, relationships, cache } = buildRoutes();
    captureClose(moments, {
      sessionId: 's1',
      a: NAMED[2]!,
      b: NAMED[1]!,
      simTime: 7 * 24 * 3600,
    });
    relationships.recordClose({
      a: 'mei-tanaka',
      b: 'hiro-abe',
      simTime: 7 * 24 * 3600,
      turnCount: 4,
    });
    const res = mockRes();
    await routes.handleArcOgImage(mockReq(), res, 'hiro-mei');
    expect(res.statusCode).toBe(200);
    expect(res.responseHeaders['content-type']).toBe('image/png');
    expect(res.responseHeaders['x-og-cache']).toBe('miss');
    // Cache write is fire-and-forget — drain microtasks.
    await new Promise((r) => setImmediate(r));
    expect(cache.size()).toBe(1);
    const res2 = mockRes();
    await routes.handleArcOgImage(mockReq(), res2, 'hiro-mei');
    expect(res2.responseHeaders['x-og-cache']).toBe('hit');
  });

  test('returns 404 when pair has no recorded interaction', async () => {
    const { routes } = buildRoutes();
    const res = mockRes();
    await routes.handleArcOgImage(mockReq(), res, 'ava-mei');
    expect(res.statusCode).toBe(404);
  });

  test('returns 404 for unknown slug', async () => {
    const { routes } = buildRoutes();
    const res = mockRes();
    await routes.handleArcOgImage(mockReq(), res, 'nobody-elsewhere');
    expect(res.statusCode).toBe(404);
  });

  test('rejects malformed names with 404', async () => {
    const { routes } = buildRoutes();
    const res = mockRes();
    await routes.handleArcOgImage(mockReq(), res, '../etc/passwd');
    expect(res.statusCode).toBe(404);
  });
});

describe('buildArcDescription', () => {
  test('leads with arc label + affinity, then freshest headline', () => {
    const { routes, moments, relationships } = buildRoutes();
    captureClose(moments, {
      sessionId: 's1',
      a: NAMED[2]!,
      b: NAMED[1]!,
      simTime: 7 * 24 * 3600,
    });
    relationships.recordClose({
      a: 'mei-tanaka',
      b: 'hiro-abe',
      simTime: 7 * 24 * 3600,
      turnCount: 6,
    });
    // Drive a render to obtain the description side-effect through the page.
    const res = mockRes();
    routes.handleArcPage(mockReq(), res, 'hiro-mei');
    // Canonical order is id-ascending, so hiro-abe wins the lead position.
    expect(res.body).toContain('Hiro Abe &amp; Mei Tanaka');
    expect(res.body).toContain('og:description');
    // Spot-check the helper directly.
    const desc = buildArcDescription({
      pair: {
        a: NAMED[1]!,
        b: NAMED[2]!,
        canonicalSlug: 'hiro-mei',
      },
      arcLabel: 'warming',
      affinity: 0.42,
      sharedConversationCount: 1,
      lastInteractionSim: 0,
      windowStartDay: 0,
      moments: [],
      sparkline: [],
      totalMoments: 0,
      nudgesApplied: 0,
    });
    expect(desc).toContain('Hiro Abe & Mei Tanaka');
    expect(desc).toContain('warming');
    expect(desc).toContain('+0.42');
  });
});
