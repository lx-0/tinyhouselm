import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MomentRecord } from '@tina/shared';
import type { ArcLabel, NamedPersona, RelationshipStore } from '@tina/sim';
import type { MomentStore } from './moments.js';
import { composeCharactersIndexOg } from './og-image.js';
import type { OgCache } from './og-routes.js';

/**
 * `/characters` index page + OG image (TINA-1162).
 *
 * Closes the named-entity index gap: every per-:slug surface (`/character/:id`,
 * `/zone/:name`, `/arc/:slug`, `/digest/:date`, `/moment/:id`) had a public
 * page, but only `/moments` and `/digest/today` were *index* surfaces. Named
 * characters are the strongest direct-return handle on this product (people
 * remember "Mei", not `moment-3a91…`), so a public `/characters` page funnels
 * cold visitors into every existing per-character page.
 *
 * - Single global page, deterministic display-name order.
 * - Empty-state safe — "no cast yet" copy when the named roster is empty.
 * - Pure read-side aggregation over `RelationshipStore` + `MomentRecord` LRU
 *   + the named-character registry. No new persistence. No LLM. No sim
 *   hot-path.
 * - Per-IP rate limit shared between page + image (60/min, mirrors TINA-744 /
 *   TINA-813 / TINA-882 / TINA-1092).
 */

export type CharactersIndexLogger = (
  level: 'info' | 'warn' | 'error',
  event: string,
  fields?: Record<string, unknown>,
) => void;

const noopLog: CharactersIndexLogger = () => {};

const WINDOW_MS = 60_000;

const ARC_GLYPHS: Record<ArcLabel, string> = {
  new: '🌀',
  warming: '🌱',
  cooling: '🥶',
  estranged: '🔕',
  steady: '💤',
};

export interface CharactersIndexRouteOptions {
  /** Authored named-persona roster — drives the index. */
  named: NamedPersona[];
  /** Recent moments source — provides per-character freshest headlines. */
  moments: MomentStore;
  /** Optional relationships store — drives the strongest-arc chip. */
  relationships?: RelationshipStore | null;
  /** Public base URL for canonical / og:url meta. Falls back to relative paths. */
  publicBaseUrl?: string | null;
  /** Per-IP page hits per minute. Default 60 — matches `/moments`. */
  perIpPerMin?: number;
  /** Global ceiling per minute. Default 600. */
  globalPerMin?: number;
  /**
   * Disk-backed OG image cache. Keyed on the cast-set hash combined with the
   * freshest moment id so the card refreshes whenever new moments land or
   * the roster changes. Pass `null` to disable the OG route.
   */
  ogCache?: OgCache | null;
  /** Bumped after a 200 OG render — drives `charactersIndexOgRenders`. */
  onOgRender?: (visitorOrIp: string) => void;
  log?: CharactersIndexLogger;
  now?: () => number;
}

export interface CharactersIndexOutcome {
  status: number;
  rateLimited: boolean;
}

interface Bucket {
  count: number;
  windowStart: number;
}

interface CharacterRow {
  persona: NamedPersona;
  /** First-name slug (lowercased) for the abbreviation row in the OG. */
  firstName: string;
  /** Strongest current arc with a named counterparty, or null. */
  arc: { label: ArcLabel; glyph: string; otherName: string; otherId: string } | null;
  /** Freshest moment headline (truncated to one line by the renderer). */
  freshestHeadline: string;
  /** Freshest moment id, for the cache key + the row's "moment →" link. */
  freshestMomentId: string | null;
}

/** Cap on glyph-row characters drawn into the OG card. */
const OG_GLYPH_CAP = 10;

export class CharactersIndexRoutes {
  private readonly named: NamedPersona[];
  private readonly moments: MomentStore;
  private readonly relationships: RelationshipStore | null;
  private readonly publicBaseUrl: string | null;
  private readonly perIpRate: number;
  private readonly globalRate: number;
  private readonly ogCache: OgCache | null;
  private readonly onOgRender?: (visitorOrIp: string) => void;
  private readonly log: CharactersIndexLogger;
  private readonly now: () => number;
  private readonly perIp = new Map<string, Bucket>();
  private readonly globalBucket: Bucket = { count: 0, windowStart: 0 };
  /**
   * Stable hash of the named-character set, computed once at construction.
   * The roster is loaded at boot and never mutated, so caching this avoids
   * re-hashing on every render.
   */
  private readonly castHash: string;

  constructor(opts: CharactersIndexRouteOptions) {
    // Display-name asc, ties broken by id asc (TINA-1162 spec).
    this.named = [...opts.named].sort((a, b) => {
      const cmp = a.manifest.name.localeCompare(b.manifest.name);
      if (cmp !== 0) return cmp;
      return a.manifest.id.localeCompare(b.manifest.id);
    });
    this.moments = opts.moments;
    this.relationships = opts.relationships ?? null;
    this.publicBaseUrl = (opts.publicBaseUrl ?? null)?.replace(/\/+$/, '') ?? null;
    this.perIpRate = opts.perIpPerMin ?? 60;
    this.globalRate = opts.globalPerMin ?? 600;
    this.ogCache = opts.ogCache ?? null;
    this.onOgRender = opts.onOgRender;
    this.log = opts.log ?? noopLog;
    this.now = opts.now ?? (() => Date.now());
    this.castHash = computeCastHash(this.named);
  }

  /** Whether the OG image route is wired. */
  hasOgImage(): boolean {
    return this.ogCache !== null;
  }

  /**
   * GET /characters. Public, no auth. 200 + HTML on success, 429 on rate
   * limit. The server bumps `charactersIndexViews` after a 200.
   */
  handleIndexPage(req: IncomingMessage, res: ServerResponse): CharactersIndexOutcome {
    const ip = clientIp(req);
    const rate = this.checkRate(ip);
    if (!rate.ok) {
      res.setHeader('retry-after', String(Math.ceil(rate.retryAfterMs / 1000)));
      writeHtml(
        res,
        429,
        simpleErrorPage('slow down', 'Too many characters-index lookups from this IP.'),
      );
      return { status: 429, rateLimited: true };
    }
    const rows = this.buildRows();
    const html = this.renderHtml(rows);
    writeHtml(res, 200, html);
    return { status: 200, rateLimited: false };
  }

  /**
   * GET /characters/og.png. Public. 200 PNG always (renders an empty cast
   * card when no named personas are loaded), 429 on rate-limit. Shares the
   * per-IP / global limiter with `handleIndexPage` so noisy crawlers
   * hammering both routes still get bounded.
   *
   * Cache key combines the cast hash with the freshest moment id so the
   * card refreshes whenever new moments land or the roster changes. The
   * disk-LRU is small (default 16) since `cast` is stable across a boot —
   * older `freshest` keys age out within minutes of normal sim activity.
   */
  async handleCharactersIndexOgImage(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
    const input = this.collectOgInput();
    const cacheKey = buildCacheKey(this.castHash, input.freshestMomentId);
    let png: Buffer;
    let cacheHit = false;
    const t0 = this.now();
    const cached = await this.ogCache.get(cacheKey);
    if (cached) {
      png = cached;
      cacheHit = true;
    } else {
      png = composeCharactersIndexOg({
        characters: input.characters,
        headline: input.headline,
        totalCharacterCount: this.named.length,
      });
      // Fire-and-forget — never block the response on the cache write. Same
      // pattern as character/zone/arc/moments-index OG routes.
      void this.ogCache.set(cacheKey, png).catch((err) => {
        this.log('warn', 'characters_index.og.cache.set.error', {
          key: cacheKey,
          message: err instanceof Error ? err.message : String(err),
        });
      });
    }
    res.writeHead(200, {
      'content-type': 'image/png',
      'content-length': String(png.length),
      // Index OG drifts as new moments land — one-minute browser cache mirrors
      // /moments/og.png and /character/:name/og.png.
      'cache-control': 'public, max-age=60',
      'x-og-cache': cacheHit ? 'hit' : 'miss',
    });
    res.end(png);
    this.log('info', 'characters_index.og.render', {
      key: cacheKey,
      cacheHit,
      bytes: png.length,
      ms: this.now() - t0,
    });
    this.onOgRender?.(ip);
  }

  /** Build per-row data for HTML rendering. */
  private buildRows(): CharacterRow[] {
    const rows: CharacterRow[] = [];
    for (const persona of this.named) {
      const id = persona.manifest.id;
      const freshest = freshestMomentForCharacter(this.moments.list(), id);
      const arc = this.strongestArc(persona);
      rows.push({
        persona,
        firstName: persona.manifest.name.split(/\s+/, 1)[0] ?? persona.manifest.name,
        arc,
        freshestHeadline: freshest?.headline ?? '',
        freshestMomentId: freshest?.id ?? null,
      });
    }
    return rows;
  }

  /**
   * Walk the freshest record in the LRU once to pick a "what's hot" headline
   * and the OG cache key. Build the OG glyph row from the (already sorted)
   * named roster — keeps the cast layout deterministic across renders.
   */
  private collectOgInput(): {
    characters: Array<{ name: string; color: string | null }>;
    headline: string;
    freshestMomentId: string | null;
  } {
    const all = this.moments.list();
    let freshestNamed: MomentRecord | null = null;
    for (let i = all.length - 1; i >= 0; i--) {
      const rec = all[i]!;
      if (rec.participants.some((p) => p.named)) {
        freshestNamed = rec;
        break;
      }
    }
    const characters = this.named.slice(0, OG_GLYPH_CAP).map((p) => ({
      name: p.manifest.name,
      color: p.manifest.glyph.color,
    }));
    return {
      characters,
      headline: freshestNamed?.headline ?? '',
      freshestMomentId: freshestNamed?.id ?? null,
    };
  }

  /**
   * Strongest current arc with another named character — same ranking as the
   * `/character/:name` page (absolute affinity, then shared close count, then
   * recency). Returns null when the character has no tracked named-pair arcs.
   */
  private strongestArc(persona: NamedPersona): CharacterRow['arc'] {
    if (!this.relationships) return null;
    const id = persona.manifest.id;
    const namedIds = new Set(this.named.map((p) => p.manifest.id));
    let best: {
      label: ArcLabel;
      glyph: string;
      otherName: string;
      otherId: string;
      affinity: number;
      sharedConversationCount: number;
      lastInteractionSim: number;
    } | null = null;
    for (const pair of this.relationships.list()) {
      if (pair.a !== id && pair.b !== id) continue;
      const otherId = pair.a === id ? pair.b : pair.a;
      if (!namedIds.has(otherId)) continue;
      const other = this.named.find((p) => p.manifest.id === otherId);
      if (!other) continue;
      if (
        !best ||
        Math.abs(pair.affinity) > Math.abs(best.affinity) ||
        (Math.abs(pair.affinity) === Math.abs(best.affinity) &&
          pair.sharedConversationCount > best.sharedConversationCount) ||
        (Math.abs(pair.affinity) === Math.abs(best.affinity) &&
          pair.sharedConversationCount === best.sharedConversationCount &&
          pair.lastInteractionSim > best.lastInteractionSim)
      ) {
        best = {
          label: pair.arcLabel,
          glyph: ARC_GLYPHS[pair.arcLabel],
          otherName: other.manifest.name,
          otherId: other.manifest.id,
          affinity: pair.affinity,
          sharedConversationCount: pair.sharedConversationCount,
          lastInteractionSim: pair.lastInteractionSim,
        };
      }
    }
    return best
      ? { label: best.label, glyph: best.glyph, otherName: best.otherName, otherId: best.otherId }
      : null;
  }

  private renderHtml(rows: CharacterRow[]): string {
    const canonical = this.buildCanonical();
    const ogTitle = 'Characters — TinyHouse';
    const ogDescription =
      rows.length === 0
        ? 'TinyHouse — no named cast yet.'
        : `Meet the ${rows.length}-person cast of TinyHouse — every named character with their strongest current arc and freshest moment.`;
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
    p.lead { font-size: 13px; line-height: 1.55; color: #8888aa; margin: 0 0 24px; }
    .row { display: flex; gap: 16px; align-items: flex-start; padding: 14px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
    .row:last-child { border-bottom: none; }
    .glyph { width: 44px; height: 44px; border-radius: 50%; flex-shrink: 0; position: relative; box-shadow: 0 0 0 3px #f5c97a; }
    .glyph .star { position: absolute; top: -4px; right: -4px; color: #f5c97a; font-size: 12px; }
    .row .body { flex: 1; min-width: 0; }
    .row .name-line { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
    .row .name { font-size: 16px; font-weight: 600; color: #e7e5ee; }
    .row .name a { color: inherit; }
    .row .name a:hover { color: #f5c97a; text-decoration: underline; }
    .row .bio { font-size: 12px; color: #b9b0dc; margin-top: 4px; line-height: 1.45; font-style: italic; }
    .row .meta-line { font-size: 11px; color: #8888aa; margin-top: 6px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .arc-chip { display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border-radius: 999px; font-size: 11px; background: rgba(185,176,220,0.10); color: #d6d0e6; }
    .arc-chip[data-arc="warming"] { background: rgba(140, 200, 150, 0.14); color: #c8e8cf; }
    .arc-chip[data-arc="cooling"] { background: rgba(150, 180, 230, 0.14); color: #cddaf0; }
    .arc-chip[data-arc="estranged"] { background: rgba(220, 140, 140, 0.14); color: #f0c7c7; }
    .arc-chip[data-arc="steady"] { background: rgba(200, 200, 200, 0.10); color: #cccccc; }
    .arc-chip[data-arc="new"] { background: rgba(245, 201, 122, 0.14); color: #f0d8a8; }
    .arc-chip a { color: inherit; }
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
      <span>tinyhouse · characters</span>
      <a href="/">live sim →</a>
    </header>
    <h1>Meet the cast</h1>
    <p class="lead">Every named character in TinyHouse — with their strongest current arc and freshest moment. Tap a name to land on their public profile.</p>
    ${rowsHtml}
    <footer>
      <span>${rows.length === 1 ? '1 character' : `${rows.length} characters`}</span>
      <span><a href="/arcs">arcs →</a> · <a href="/moments">all moments →</a></span>
    </footer>
  </main>
</body>
</html>`;
  }

  private buildOgImageUrl(): string {
    if (this.publicBaseUrl) return `${this.publicBaseUrl}/characters/og.png`;
    return '/characters/og.png';
  }

  private buildCanonical(): string {
    if (this.publicBaseUrl) return `${this.publicBaseUrl}/characters`;
    return '/characters';
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

/** Pick the freshest MomentRecord that includes the given named character. */
function freshestMomentForCharacter(all: MomentRecord[], id: string): MomentRecord | null {
  for (let i = all.length - 1; i >= 0; i--) {
    const rec = all[i]!;
    if (rec.participants.some((p) => p.id === id)) return rec;
  }
  return null;
}

function renderRowsHtml(rows: CharacterRow[]): string {
  if (rows.length === 0) {
    return '<div class="empty">No cast yet — named personas will appear here once their manifests load.</div>';
  }
  return rows
    .map((row) => {
      const m = row.persona.manifest;
      const id = encodeURIComponent(m.id);
      const subtitleParts: string[] = [];
      if (m.occupation) subtitleParts.push(m.occupation);
      if (m.age !== undefined) subtitleParts.push(`age ${m.age}`);
      const subtitleHtml =
        subtitleParts.length > 0
          ? `<span style="font-size:11px;color:#8888aa;letter-spacing:0.05em;text-transform:lowercase">${escapeHtml(subtitleParts.join(' · '))}</span>`
          : '';
      const bioHtml = m.bio ? `<div class="bio">${escapeHtml(m.bio)}</div>` : '';
      const arcChip = row.arc
        ? `<span class="arc-chip" data-arc="${escapeHtml(row.arc.label)}">${escapeHtml(row.arc.glyph)} ${escapeHtml(row.arc.label)} with <a href="/character/${encodeURIComponent(row.arc.otherId)}">${escapeHtml(row.arc.otherName)}</a></span>`
        : '<span class="arc-chip" data-arc="new">no arcs yet</span>';
      const momentsLink = `<a href="/moments?character=${id}">moments →</a>`;
      const headlineHtml = row.freshestHeadline
        ? `<div class="headline">${row.freshestMomentId ? `<a class="moment-link" href="/moment/${encodeURIComponent(row.freshestMomentId)}">${escapeHtml(row.freshestHeadline)}</a>` : escapeHtml(row.freshestHeadline)}</div>`
        : '<div class="headline" style="color:#55556a">no recent moments</div>';
      const bodyColor = escapeHtml(m.glyph.color);
      return `<article class="row"><div class="glyph" style="background:${bodyColor}"><span class="star">★</span></div><div class="body"><div class="name-line"><span class="name"><a href="/character/${id}">${escapeHtml(m.name)}</a></span>${subtitleHtml}</div>${bioHtml}<div class="meta-line">${arcChip} · ${momentsLink}</div>${headlineHtml}</div></article>`;
    })
    .join('');
}

/**
 * Stable, short hash of the named-character id set in canonical (sorted) order.
 * Sanitized to fit the OgCache key pattern (`^[A-Za-z0-9_-]{1,64}$`). Used as
 * a prefix in the OG cache key so a roster change never reuses a stale PNG.
 */
function computeCastHash(named: NamedPersona[]): string {
  const ids = named
    .map((p) => p.manifest.id.toLowerCase())
    .sort()
    .join('|');
  // 8 hex chars is plenty: there are only ever a handful of distinct rosters
  // in play across a deployment, so collision risk is negligible.
  return createHash('sha256').update(ids).digest('hex').slice(0, 8);
}

/**
 * Build a stable disk-LRU cache key. Combines the cast hash with the freshest
 * moment id so the card refreshes whenever new moments land or the roster
 * changes. Falls back to `nofresh` when the LRU is empty so even a freshly
 * booted sim caches its empty-state card.
 */
function buildCacheKey(castHash: string, freshestId: string | null): string {
  if (!freshestId) return `cix-${castHash}-nofresh`;
  // OgCache enforces `^[A-Za-z0-9_-]{1,64}$`. Sanitize hard rather than trust
  // the moment id format — bail to the nofresh key on garbage so a surprise
  // pattern never tanks the route.
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(freshestId)) return `cix-${castHash}-nofresh`;
  return `cix-${castHash}-${freshestId}`;
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
    <p><a href="/characters">all characters</a> · <a href="/">back to the live sim</a></p>
  </main>
</body>
</html>`;
}
