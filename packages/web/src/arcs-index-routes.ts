import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MomentRecord } from '@tina/shared';
import type { ArcLabel, NamedPersona, PairState, RelationshipStore } from '@tina/sim';
import type { MomentStore } from './moments.js';
import { composeArcsIndexOg } from './og-image.js';
import type { OgCache } from './og-routes.js';

/**
 * `/arcs` index page + OG image (TINA-1215).
 *
 * Closes the public-index symmetry: every per-:slug surface (moment, character,
 * zone, arc, digest) already has a public page, but the *index* over named-pair
 * relationship arcs was admin-only. Pair arcs are the most narratively
 * memorable share artifact ("the falling out", "the reconciliation"), so a
 * public `/arcs` page funnels cold visitors into every existing per-pair page.
 *
 * - Single global page, optional ?rank=arc_strength|freshest selector.
 * - Empty-state safe — "no arcs yet" copy when no named pair has crossed paths.
 * - Pure read-side aggregation over `RelationshipStore` + `MomentRecord` LRU
 *   + the named-character registry. No new persistence. No LLM. No sim
 *   hot-path.
 * - Per-IP rate limit shared between page + image (60/min, mirrors TINA-1162).
 */

export type ArcsIndexLogger = (
  level: 'info' | 'warn' | 'error',
  event: string,
  fields?: Record<string, unknown>,
) => void;

const noopLog: ArcsIndexLogger = () => {};

const WINDOW_MS = 60_000;

const ARC_GLYPHS: Record<ArcLabel, string> = {
  new: '🌀',
  warming: '🌱',
  cooling: '🥶',
  estranged: '🔕',
  steady: '💤',
};

export type ArcsIndexRanking = 'arc_strength' | 'freshest';
export const DEFAULT_ARCS_INDEX_RANKING: ArcsIndexRanking = 'arc_strength';

export interface ArcsIndexRouteOptions {
  named: NamedPersona[];
  moments: MomentStore;
  /** Required relationships store — without it the page has no arcs to surface. */
  relationships: RelationshipStore;
  publicBaseUrl?: string | null;
  /** Per-IP page hits per minute. Default 60 — matches the rest of the site. */
  perIpPerMin?: number;
  /** Global ceiling per minute. Default 600. */
  globalPerMin?: number;
  /**
   * Disk-backed OG image cache. Keyed on (top-pairs hash, freshest moment id)
   * so the card refreshes whenever new pair-moments land or the leaderboard
   * shifts. Pass `null` to disable the OG route.
   */
  ogCache?: OgCache | null;
  /** Bumped after a 200 OG render — drives `arcsIndexOgRenders`. */
  onOgRender?: (visitorOrIp: string) => void;
  log?: ArcsIndexLogger;
  now?: () => number;
}

export interface ArcsIndexOutcome {
  status: number;
  rateLimited: boolean;
}

interface Bucket {
  count: number;
  windowStart: number;
}

interface ArcRow {
  pair: PairState;
  a: NamedPersona;
  b: NamedPersona;
  canonicalSlug: string;
  freshestMomentId: string | null;
  freshestHeadline: string;
  /** Sim-time of the freshest pair-moment, or null when none exist. */
  freshestSimTime: number | null;
}

/** Pairs drawn as glyph-doublets in the OG card. */
const OG_PAIR_CAP = 6;
/** Minimum pairs the OG card layout reserves for. */
const OG_PAIR_MIN = 4;

export class ArcsIndexRoutes {
  private readonly named: NamedPersona[];
  private readonly namedById: Map<string, NamedPersona>;
  private readonly moments: MomentStore;
  private readonly relationships: RelationshipStore;
  private readonly publicBaseUrl: string | null;
  private readonly perIpRate: number;
  private readonly globalRate: number;
  private readonly ogCache: OgCache | null;
  private readonly onOgRender?: (visitorOrIp: string) => void;
  private readonly log: ArcsIndexLogger;
  private readonly now: () => number;
  private readonly perIp = new Map<string, Bucket>();
  private readonly globalBucket: Bucket = { count: 0, windowStart: 0 };

  constructor(opts: ArcsIndexRouteOptions) {
    this.named = opts.named;
    this.namedById = new Map(opts.named.map((p) => [p.manifest.id, p]));
    this.moments = opts.moments;
    this.relationships = opts.relationships;
    this.publicBaseUrl = (opts.publicBaseUrl ?? null)?.replace(/\/+$/, '') ?? null;
    this.perIpRate = opts.perIpPerMin ?? 60;
    this.globalRate = opts.globalPerMin ?? 600;
    this.ogCache = opts.ogCache ?? null;
    this.onOgRender = opts.onOgRender;
    this.log = opts.log ?? noopLog;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Whether the OG image route is wired. */
  hasOgImage(): boolean {
    return this.ogCache !== null;
  }

  /**
   * GET /arcs. Public, no auth. 200 + HTML on success, 429 on rate limit.
   * Optional `?rank=freshest` query param swaps the deterministic ranking;
   * any other value falls back to the default `arc_strength` ranking.
   */
  handleIndexPage(
    req: IncomingMessage,
    res: ServerResponse,
    query: URLSearchParams,
  ): ArcsIndexOutcome {
    const ip = clientIp(req);
    const rate = this.checkRate(ip);
    if (!rate.ok) {
      res.setHeader('retry-after', String(Math.ceil(rate.retryAfterMs / 1000)));
      writeHtml(
        res,
        429,
        simpleErrorPage('slow down', 'Too many arcs-index lookups from this IP.'),
      );
      return { status: 429, rateLimited: true };
    }
    const ranking = parseRanking(query.get('rank'));
    const rows = this.buildRows();
    sortRows(rows, ranking);
    const html = this.renderHtml(rows, ranking);
    writeHtml(res, 200, html);
    return { status: 200, rateLimited: false };
  }

  /**
   * GET /arcs/og.png. Public. 200 PNG always (renders an empty-state card
   * when no named pairs have arcs), 429 on rate-limit. Shares the per-IP /
   * global limiter with `handleIndexPage` so noisy crawlers hammering both
   * routes still get bounded.
   *
   * Cache key combines a hash of the top arc-strength snapshot with the
   * freshest pair-moment id so the card refreshes whenever the leaderboard
   * shifts or a new pair-moment lands. The OG card always renders the
   * default `arc_strength` ranking — `?rank=freshest` does not produce a
   * distinct image, mirroring how `/moments?character=…` reuses one OG.
   */
  async handleArcsIndexOgImage(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.ogCache) {
      writePlain(res, 404, 'not found');
      return;
    }
    const ip = clientIp(req);
    const rate = this.checkRate(ip);
    if (!rate.ok) {
      res.setHeader('retry-after', String(Math.ceil(rate.retryAfterMs / 1000)));
      writePlain(res, 429, 'rate limited');
      return;
    }
    const rows = this.buildRows();
    sortRows(rows, DEFAULT_ARCS_INDEX_RANKING);
    const cacheKey = buildCacheKey(rows);
    let png: Buffer;
    let cacheHit = false;
    const t0 = this.now();
    const cached = await this.ogCache.get(cacheKey);
    if (cached) {
      png = cached;
      cacheHit = true;
    } else {
      png = composeArcsIndexOg(buildOgInput(rows));
      // Fire-and-forget — never block the response on the cache write.
      void this.ogCache.set(cacheKey, png).catch((err) => {
        this.log('warn', 'arcs_index.og.cache.set.error', {
          key: cacheKey,
          message: err instanceof Error ? err.message : String(err),
        });
      });
    }
    res.writeHead(200, {
      'content-type': 'image/png',
      'content-length': String(png.length),
      'cache-control': 'public, max-age=60',
      'x-og-cache': cacheHit ? 'hit' : 'miss',
    });
    res.end(png);
    this.log('info', 'arcs_index.og.render', {
      key: cacheKey,
      cacheHit,
      bytes: png.length,
      ms: this.now() - t0,
    });
    this.onOgRender?.(ip);
  }

  /**
   * Build per-row data over the named-pair subset of `RelationshipStore`.
   * Skips pairs where either side isn't in the named registry.
   */
  private buildRows(): ArcRow[] {
    const rows: ArcRow[] = [];
    const freshestByPairKey = this.collectFreshestPairMoments();
    for (const pair of this.relationships.list()) {
      const a = this.namedById.get(pair.a);
      const b = this.namedById.get(pair.b);
      if (!a || !b) continue;
      const [first, second] = a.manifest.id < b.manifest.id ? ([a, b] as const) : ([b, a] as const);
      const canonicalSlug = `${firstNameSlug(first)}-${firstNameSlug(second)}`;
      const key = pairKey(pair.a, pair.b);
      const freshest = freshestByPairKey.get(key) ?? null;
      rows.push({
        pair,
        a: first,
        b: second,
        canonicalSlug,
        freshestMomentId: freshest?.id ?? null,
        freshestHeadline: freshest?.headline ?? '',
        freshestSimTime: freshest?.simTime ?? null,
      });
    }
    return rows;
  }

  /**
   * Walk the MomentRecord LRU once, newest-first, and record the freshest
   * record per named-pair key. Each record contributes to every named pair
   * present in its participants list (group moments can update multiple
   * pairs in one pass).
   */
  private collectFreshestPairMoments(): Map<string, MomentRecord> {
    const out = new Map<string, MomentRecord>();
    const all = this.moments.list();
    for (let i = all.length - 1; i >= 0; i--) {
      const rec = all[i]!;
      const namedIds: string[] = [];
      for (const p of rec.participants) {
        if (p.named && this.namedById.has(p.id)) namedIds.push(p.id);
      }
      if (namedIds.length < 2) continue;
      for (let j = 0; j < namedIds.length; j++) {
        for (let k = j + 1; k < namedIds.length; k++) {
          const key = pairKey(namedIds[j]!, namedIds[k]!);
          if (!out.has(key)) out.set(key, rec);
        }
      }
    }
    return out;
  }

  private renderHtml(rows: ArcRow[], ranking: ArcsIndexRanking): string {
    const canonical = this.buildCanonical(ranking);
    const ogTitle = 'Relationship arcs — TinyHouse';
    const totalPairs = rows.length;
    const ogDescription =
      totalPairs === 0
        ? 'TinyHouse — no named-pair arcs yet.'
        : `Every relationship arc in TinyHouse — ${totalPairs} named ${totalPairs === 1 ? 'pair' : 'pairs'} with their current arc, affinity, and freshest shared moment.`;
    const ogImageUrl = this.ogCache ? this.buildOgImageUrl() : null;
    const ogImageMeta = ogImageUrl
      ? `<meta property="og:image" content="${escapeHtml(ogImageUrl)}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:type" content="image/png" />
  <meta name="twitter:image" content="${escapeHtml(ogImageUrl)}" />`
      : '';
    const twitterCard = ogImageUrl ? 'summary_large_image' : 'summary';
    const rowsHtml = renderRowsHtml(rows);
    const rankToggle = renderRankToggle(ranking);
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(ogTitle)}</title>
  <meta name="description" content="${escapeHtml(ogDescription)}" />
  <meta property="og:type" content="website" />
  <meta property="og:title" content="${escapeHtml(ogTitle)}" />
  <meta property="og:description" content="${escapeHtml(ogDescription)}" />
  <meta property="og:url" content="${escapeHtml(canonical)}" />
  <meta property="og:site_name" content="tinyhouse" />
  ${ogImageMeta}
  <meta name="twitter:card" content="${twitterCard}" />
  <meta name="twitter:title" content="${escapeHtml(ogTitle)}" />
  <meta name="twitter:description" content="${escapeHtml(ogDescription)}" />
  <link rel="canonical" href="${escapeHtml(canonical)}" />
  <style>
    :root { color-scheme: dark; }
    html, body { margin: 0; padding: 0; background: #0f0d15; color: #e7e5ee; font-family: -apple-system, system-ui, Segoe UI, sans-serif; }
    main { max-width: 760px; margin: 0 auto; padding: 32px 20px 80px; }
    a { color: #b9b0dc; text-decoration: none; }
    a:hover { text-decoration: underline; }
    header.top { display: flex; justify-content: space-between; align-items: center; font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; color: #8888aa; margin-bottom: 18px; }
    h1 { font-size: 22px; line-height: 1.2; margin: 0 0 18px; color: #e7e5ee; }
    p.lead { font-size: 13px; line-height: 1.55; color: #8888aa; margin: 0 0 16px; }
    .rank-toggle { display: flex; gap: 6px; margin: 0 0 22px; font-size: 11px; }
    .rank-toggle a { padding: 4px 10px; border-radius: 999px; background: rgba(255,255,255,0.05); color: #b9b0dc; }
    .rank-toggle a.active { background: rgba(245,201,122,0.18); color: #f5c97a; }
    .row { display: flex; gap: 14px; align-items: flex-start; padding: 14px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
    .row:last-child { border-bottom: none; }
    .pair-glyphs { display: flex; align-items: center; gap: 4px; flex-shrink: 0; padding-top: 2px; }
    .pair-glyphs .glyph { width: 36px; height: 36px; border-radius: 50%; position: relative; box-shadow: 0 0 0 3px #f5c97a; }
    .pair-glyphs .star { position: absolute; top: -3px; right: -3px; color: #f5c97a; font-size: 10px; }
    .pair-glyphs .amp { color: #f5c97a; font-size: 14px; }
    .row .body { flex: 1; min-width: 0; }
    .row .name-line { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
    .row .name { font-size: 16px; font-weight: 600; color: #e7e5ee; }
    .row .name a { color: inherit; }
    .row .name a:hover { color: #f5c97a; text-decoration: underline; }
    .row .meta-line { font-size: 11px; color: #8888aa; margin-top: 6px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .arc-chip { display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border-radius: 999px; font-size: 11px; background: rgba(185,176,220,0.10); color: #d6d0e6; text-transform: capitalize; }
    .arc-chip[data-arc="warming"] { background: rgba(140, 200, 150, 0.14); color: #c8e8cf; }
    .arc-chip[data-arc="cooling"] { background: rgba(150, 180, 230, 0.14); color: #cddaf0; }
    .arc-chip[data-arc="estranged"] { background: rgba(220, 140, 140, 0.14); color: #f0c7c7; }
    .arc-chip[data-arc="steady"] { background: rgba(200, 200, 200, 0.10); color: #cccccc; }
    .arc-chip[data-arc="new"] { background: rgba(245, 201, 122, 0.14); color: #f0d8a8; }
    .strength-bar { display: inline-flex; align-items: center; gap: 6px; font-family: ui-monospace, Menlo, monospace; font-size: 10px; color: #8888aa; }
    .strength-bar .track { width: 80px; height: 4px; border-radius: 2px; background: rgba(255,255,255,0.06); position: relative; overflow: hidden; }
    .strength-bar .fill { position: absolute; top: 0; left: 50%; height: 100%; transform-origin: left center; }
    .strength-bar .fill[data-sign="pos"] { background: rgba(140, 200, 150, 0.7); }
    .strength-bar .fill[data-sign="neg"] { background: rgba(220, 140, 140, 0.7); transform-origin: right center; left: auto; right: 50%; }
    .strength-bar .fill[data-sign="zero"] { background: rgba(200, 200, 200, 0.18); width: 2px; left: calc(50% - 1px); }
    .row .headline { font-size: 12px; color: #b5b5c5; margin-top: 6px; line-height: 1.45; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; }
    .row .moment-link { color: inherit; }
    .empty { padding: 60px 0 20px; text-align: center; color: #8888aa; font-size: 13px; line-height: 1.6; font-style: italic; }
    footer { margin-top: 40px; font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #55556a; display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    footer a { color: #b9b0dc; }
  </style>
</head>
<body>
  <main>
    <header class="top">
      <span>tinyhouse · arcs</span>
      <a href="/">live sim →</a>
    </header>
    <h1>Relationship arcs</h1>
    <p class="lead">Every named pair in TinyHouse — with their current arc label, running affinity, and freshest shared moment. Tap a pair to land on its public arc page.</p>
    ${rankToggle}
    ${rowsHtml}
    <footer>
      <span>${totalPairs === 1 ? '1 pair' : `${totalPairs} pairs`}</span>
      <span><a href="/characters">cast →</a> · <a href="/moments">moments →</a></span>
    </footer>
  </main>
</body>
</html>`;
  }

  private buildOgImageUrl(): string {
    if (this.publicBaseUrl) return `${this.publicBaseUrl}/arcs/og.png`;
    return '/arcs/og.png';
  }

  private buildCanonical(ranking: ArcsIndexRanking): string {
    const path = ranking === DEFAULT_ARCS_INDEX_RANKING ? '/arcs' : `/arcs?rank=${ranking}`;
    if (this.publicBaseUrl) return `${this.publicBaseUrl}${path}`;
    return path;
  }

  private checkRate(ip: string): { ok: true } | { ok: false; retryAfterMs: number } {
    const now = this.now();
    const g = this.globalBucket;
    if (now - g.windowStart >= WINDOW_MS) {
      g.windowStart = now;
      g.count = 0;
    }
    if (g.count >= this.globalRate) {
      return { ok: false, retryAfterMs: WINDOW_MS - (now - g.windowStart) };
    }
    let bucket = this.perIp.get(ip);
    if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
      bucket = { count: 0, windowStart: now };
      this.perIp.set(ip, bucket);
    }
    if (bucket.count >= this.perIpRate) {
      return { ok: false, retryAfterMs: WINDOW_MS - (now - bucket.windowStart) };
    }
    bucket.count += 1;
    g.count += 1;
    return { ok: true };
  }
}

function parseRanking(raw: string | null | undefined): ArcsIndexRanking {
  if (raw === 'freshest') return 'freshest';
  return DEFAULT_ARCS_INDEX_RANKING;
}

/**
 * Sort rows in-place under the chosen ranking. Both rankings end with an
 * id-asc tiebreak on the canonical slug so output is fully deterministic.
 */
function sortRows(rows: ArcRow[], ranking: ArcsIndexRanking): void {
  if (ranking === 'freshest') {
    rows.sort((x, y) => {
      const xt = x.freshestSimTime;
      const yt = y.freshestSimTime;
      if (xt !== null && yt !== null && xt !== yt) return yt - xt;
      if (xt !== null && yt === null) return -1;
      if (xt === null && yt !== null) return 1;
      if (x.pair.lastInteractionSim !== y.pair.lastInteractionSim) {
        return y.pair.lastInteractionSim - x.pair.lastInteractionSim;
      }
      return x.canonicalSlug.localeCompare(y.canonicalSlug);
    });
    return;
  }
  // arc_strength: |affinity| desc, sharedConversationCount desc,
  // lastInteractionSim desc, then canonical-slug asc.
  rows.sort((x, y) => {
    const ax = Math.abs(x.pair.affinity);
    const ay = Math.abs(y.pair.affinity);
    if (ax !== ay) return ay - ax;
    if (x.pair.sharedConversationCount !== y.pair.sharedConversationCount) {
      return y.pair.sharedConversationCount - x.pair.sharedConversationCount;
    }
    if (x.pair.lastInteractionSim !== y.pair.lastInteractionSim) {
      return y.pair.lastInteractionSim - x.pair.lastInteractionSim;
    }
    return x.canonicalSlug.localeCompare(y.canonicalSlug);
  });
}

function renderRankToggle(active: ArcsIndexRanking): string {
  const cls = (r: ArcsIndexRanking) => (r === active ? 'active' : '');
  return `<div class="rank-toggle">
    <a href="/arcs" class="${cls('arc_strength')}">strongest</a>
    <a href="/arcs?rank=freshest" class="${cls('freshest')}">freshest</a>
  </div>`;
}

function renderRowsHtml(rows: ArcRow[]): string {
  if (rows.length === 0) {
    return '<div class="empty">No arcs yet — pair pages will appear here once two named characters cross paths.</div>';
  }
  return rows
    .map((row) => {
      const slug = encodeURIComponent(row.canonicalSlug);
      const ma = row.a.manifest;
      const mb = row.b.manifest;
      const arcChip = `<span class="arc-chip" data-arc="${escapeHtml(row.pair.arcLabel)}">${escapeHtml(ARC_GLYPHS[row.pair.arcLabel])} ${escapeHtml(row.pair.arcLabel)}</span>`;
      const strength = renderStrengthBar(row.pair.affinity);
      const headlineHtml = row.freshestHeadline
        ? `<div class="headline">${row.freshestMomentId ? `<a class="moment-link" href="/moment/${encodeURIComponent(row.freshestMomentId)}">${escapeHtml(row.freshestHeadline)}</a>` : escapeHtml(row.freshestHeadline)}</div>`
        : '<div class="headline" style="color:#55556a">no shared moments yet</div>';
      const glyphsHtml = `<a class="pair-glyphs" href="/arc/${slug}" title="${escapeHtml(`${ma.name} & ${mb.name}`)}"><span class="glyph" style="background:${escapeHtml(ma.glyph.color)}"><span class="star">★</span></span><span class="amp">&amp;</span><span class="glyph" style="background:${escapeHtml(mb.glyph.color)}"><span class="star">★</span></span></a>`;
      const sharedCount = row.pair.sharedConversationCount;
      const sharedLabel = `${sharedCount} ${sharedCount === 1 ? 'conv' : 'convs'}`;
      return `<article class="row">${glyphsHtml}<div class="body"><div class="name-line"><span class="name"><a href="/arc/${slug}">${escapeHtml(ma.name)} &amp; ${escapeHtml(mb.name)}</a></span></div><div class="meta-line">${arcChip} ${strength} <span style="color:#55556a">·</span> <span>${escapeHtml(sharedLabel)}</span></div>${headlineHtml}</div></article>`;
    })
    .join('');
}

function renderStrengthBar(affinity: number): string {
  const clamped = Math.max(-1, Math.min(1, affinity));
  const sign = clamped > 0.005 ? 'pos' : clamped < -0.005 ? 'neg' : 'zero';
  const widthPct = sign === 'zero' ? 0 : Math.max(4, Math.round(Math.abs(clamped) * 50));
  const formatted = formatAffinity(clamped);
  const fillStyle = sign === 'zero' ? '' : `width:${widthPct}%`;
  return `<span class="strength-bar"><span class="track"><span class="fill" data-sign="${sign}" style="${fillStyle}"></span></span><span>${escapeHtml(formatted)}</span></span>`;
}

function formatAffinity(a: number): string {
  if (Math.abs(a) < 0.005) return '0.00';
  const sign = a > 0 ? '+' : '−';
  return `${sign}${Math.abs(a).toFixed(2)}`;
}

function firstNameSlug(p: NamedPersona): string {
  const head = p.manifest.name.split(/\s+/, 1)[0] ?? p.manifest.id;
  return head.toLowerCase();
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

/**
 * Build the OG composer input from the rows already sorted by `arc_strength`.
 * Picks the top N pairs as glyph doublets, the strongest pair's arc label as
 * the header chip, and the freshest pair-moment headline overall.
 */
function buildOgInput(sortedByStrength: ArcRow[]): {
  pairs: Array<{
    aColor: string | null;
    bColor: string | null;
    aFirst: string;
    bFirst: string;
    arcLabel: ArcLabel;
  }>;
  totalPairCount: number;
  topArcLabel: ArcLabel | null;
  freshestHeadline: string;
} {
  const top = sortedByStrength.slice(0, OG_PAIR_CAP).map((row) => ({
    aColor: row.a.manifest.glyph.color,
    bColor: row.b.manifest.glyph.color,
    aFirst: row.a.manifest.name.split(/\s+/, 1)[0] ?? row.a.manifest.id,
    bFirst: row.b.manifest.name.split(/\s+/, 1)[0] ?? row.b.manifest.id,
    arcLabel: row.pair.arcLabel,
  }));
  const topArcLabel = sortedByStrength[0]?.pair.arcLabel ?? null;
  // Pick the freshest pair-moment across all rows (not just the top N) so the
  // footer stays useful even when the strongest pairs are stale.
  let freshestSim: number | null = null;
  let freshestHeadline = '';
  for (const row of sortedByStrength) {
    if (row.freshestSimTime === null) continue;
    if (freshestSim === null || row.freshestSimTime > freshestSim) {
      freshestSim = row.freshestSimTime;
      freshestHeadline = row.freshestHeadline;
    }
  }
  return {
    pairs: top,
    totalPairCount: sortedByStrength.length,
    topArcLabel,
    freshestHeadline,
  };
}

/**
 * Build a stable disk-LRU cache key. Combines a hash of the top-arc-strength
 * snapshot (canonical slug + arc label + affinity rounded to 2dp) with the
 * freshest pair-moment id so the card refreshes whenever the leaderboard
 * shifts or a new pair-moment lands.
 */
function buildCacheKey(sortedByStrength: ArcRow[]): string {
  if (sortedByStrength.length === 0) return 'aix-empty-nofresh';
  const snapshot = sortedByStrength
    .slice(0, OG_PAIR_CAP)
    .map((r) => `${r.canonicalSlug}:${r.pair.arcLabel}:${r.pair.affinity.toFixed(2)}`)
    .join('|');
  const hash = createHash('sha256').update(snapshot).digest('hex').slice(0, 8);
  let freshestId: string | null = null;
  let freshestSim: number | null = null;
  for (const row of sortedByStrength) {
    if (row.freshestMomentId === null || row.freshestSimTime === null) continue;
    if (freshestSim === null || row.freshestSimTime > freshestSim) {
      freshestSim = row.freshestSimTime;
      freshestId = row.freshestMomentId;
    }
  }
  if (!freshestId || !/^[A-Za-z0-9_-]{1,40}$/.test(freshestId)) {
    return `aix-${hash}-nofresh`;
  }
  return `aix-${hash}-${freshestId}`;
}

function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (first) return first.split(',')[0]!.trim();
  return req.socket.remoteAddress ?? '';
}

function writeHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'public, max-age=60',
  });
  res.end(body);
}

function writePlain(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function simpleErrorPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)} — tinyhouse</title>
  <style>
    :root { color-scheme: dark; }
    html, body { margin: 0; padding: 0; background: #0f0d15; color: #e7e5ee; font-family: -apple-system, system-ui, Segoe UI, sans-serif; }
    main { max-width: 480px; margin: 0 auto; padding: 80px 20px; text-align: center; }
    h1 { font-size: 20px; color: #e7e5ee; margin: 0 0 10px; }
    p { color: #8888aa; font-size: 13px; }
    a { color: #b9b0dc; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(body)}</p>
    <p><a href="/arcs">all arcs</a> · <a href="/">back to the live sim</a></p>
  </main>
</body>
</html>`;
}

// Re-export so the OG composer can pick the same minimum cap.
export { OG_PAIR_CAP, OG_PAIR_MIN };
