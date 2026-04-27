import type { IncomingMessage, ServerResponse } from 'node:http';
import { type MomentRecord, type SimTime, deriveWorldClock } from '@tina/shared';
import { type ArcLabel, type NamedPersona, type RelationshipStore, simDay } from '@tina/sim';
import { buildNamedResolver } from './character-routes.js';
import type { MomentStore } from './moments.js';
import { composeMomentsIndexOg } from './og-image.js';
import type { OgCache } from './og-routes.js';

export interface MomentsIndexRouteOptions {
  named: NamedPersona[];
  moments: MomentStore;
  /** Optional relationship store — used to label single-pair arcs in rows. */
  relationships?: RelationshipStore | null;
  simSpeed: number;
  publicBaseUrl?: string | null;
  /** Per-IP page hits per minute. Default 60 — matches `/character/:name`. */
  perIpPerMin?: number;
  /** Global ceiling per minute. Default 600. */
  globalPerMin?: number;
  /** Records per page. Default 25 — see TINA-544 spec. */
  pageSize?: number;
  /**
   * Disk-backed OG image cache (TINA-1092). When provided, the route exposes
   * `/moments/og.png` and references the rendered image from the index page's
   * `og:image` meta. Pass `null`/omit to fall back to the meta-only behavior
   * shipped with TINA-544.
   */
  ogCache?: OgCache | null;
  /**
   * Bumped after a 200 OG render — drives `momentsIndexOgRenders` sticky
   * metric. Receives the requesting visitor-or-IP so the caller can dedup per
   * (IP-or-visitor) per UTC day. The index has a single global cache key, so
   * unlike `/character/:name/og.png` there is no per-resource id to scope on.
   */
  onOgRender?: (visitorOrIp: string) => void;
  /** Logger — same shape as the rest of the route handlers. */
  log?: (level: 'info' | 'warn' | 'error', event: string, fields?: Record<string, unknown>) => void;
  now?: () => number;
}

export interface MomentsIndexOutcome {
  status: number;
  /**
   * Canonical filter key written to the sticky-metrics dedup set on a 200.
   * Empty string means the unfiltered index. `null` for non-200 responses.
   */
  filterKey: string | null;
  rateLimited: boolean;
}

interface Bucket {
  count: number;
  windowStart: number;
}

const WINDOW_MS = 60_000;
/** Validates a single zone or character token. Same shape as `/character/:name`. */
const TOKEN_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** Validates a cursor — positive integer simTime, up to 12 digits. */
const CURSOR_PATTERN = /^\d{1,12}$/;
const ALLOWED_VARIANTS = new Set<MomentRecord['variant']>(['conversation', 'group']);

const ARC_GLYPHS: Record<ArcLabel, string> = {
  new: '🌀',
  warming: '🌱',
  cooling: '🥶',
  estranged: '🔕',
  steady: '💤',
};

interface ResolvedFilters {
  /** Canonicalized filter-key for sticky-metrics dedup (empty = unfiltered). */
  filterKey: string;
  /** Persona ids the row must contain. AND-matched. */
  characterIds: string[];
  /** Display name for each resolved character, parallel to ids. */
  characterNames: string[];
  /** Zone exact match, or null. */
  zone: string | null;
  /** Variant filter, or null for both. */
  variant: MomentRecord['variant'] | null;
  /** Cursor (descending sim-time). */
  cursorBefore: SimTime | null;
}

interface RowData {
  rec: MomentRecord;
  /** Pre-rendered "day N · HH:MM" line. */
  dayLine: string;
  /** Per-pair arc label when this is a single-pair conversation. */
  arc: { label: ArcLabel; glyph: string } | null;
  /** Convenience flag — group co-presence variant. */
  isGroup: boolean;
}

/** Window of newest records the OG image considers when picking participants. */
const INDEX_OG_WINDOW = 50;
/** Cap on glyph-row participants drawn into the OG image. */
const INDEX_OG_PARTICIPANT_CAP = 8;
/** Cache key when the moments LRU is empty — keeps the cold-start card stable. */
const INDEX_OG_EMPTY_KEY = 'empty';

export class MomentsIndexRoutes {
  private readonly named: NamedPersona[];
  private readonly moments: MomentStore;
  private readonly relationships: RelationshipStore | null;
  private readonly simSpeed: number;
  private readonly publicBaseUrl: string | null;
  private readonly perIpRate: number;
  private readonly globalRate: number;
  private readonly pageSize: number;
  private readonly ogCache: OgCache | null;
  private readonly onOgRender?: (visitorOrIp: string) => void;
  private readonly log: (
    level: 'info' | 'warn' | 'error',
    event: string,
    fields?: Record<string, unknown>,
  ) => void;
  private readonly now: () => number;
  private readonly byKey: Map<string, NamedPersona>;
  private readonly perIp = new Map<string, Bucket>();
  private readonly globalBucket: Bucket = { count: 0, windowStart: 0 };

  constructor(opts: MomentsIndexRouteOptions) {
    this.named = opts.named;
    this.moments = opts.moments;
    this.relationships = opts.relationships ?? null;
    this.simSpeed = opts.simSpeed;
    this.publicBaseUrl = (opts.publicBaseUrl ?? null)?.replace(/\/+$/, '') ?? null;
    this.perIpRate = opts.perIpPerMin ?? 60;
    this.globalRate = opts.globalPerMin ?? 600;
    this.pageSize = Math.max(1, opts.pageSize ?? 25);
    this.ogCache = opts.ogCache ?? null;
    this.onOgRender = opts.onOgRender;
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? (() => Date.now());
    this.byKey = buildNamedResolver(this.named);
  }

  /** Whether the OG image route is wired (TINA-1092). */
  hasOgImage(): boolean {
    return this.ogCache !== null;
  }

  /**
   * GET /moments — render the paginated moments index. Returns:
   *   - 200 + HTML on a successful render (filtered or not)
   *   - 400 + HTML when a filter token is malformed
   *   - 429 + small HTML body when the IP/global rate is exceeded
   * Counter / cookie work happens server-side based on `outcome.filterKey`.
   */
  handleIndexPage(
    req: IncomingMessage,
    res: ServerResponse,
    query: URLSearchParams,
  ): MomentsIndexOutcome {
    const ip = clientIp(req);
    const rate = this.checkRate(ip);
    if (!rate.ok) {
      res.setHeader('retry-after', String(Math.ceil(rate.retryAfterMs / 1000)));
      writeHtml(
        res,
        429,
        simpleErrorPage('slow down', 'Too many moments-index lookups from this IP.'),
      );
      return { status: 429, filterKey: null, rateLimited: true };
    }
    const parsed = this.parseFilters(query);
    if (!parsed.ok) {
      writeHtml(res, 400, simpleErrorPage('bad filter', parsed.error));
      return { status: 400, filterKey: null, rateLimited: false };
    }
    const filters = parsed.value;
    const page = this.collectPage(filters);
    const html = this.renderHtml(filters, page);
    writeHtml(res, 200, html);
    return { status: 200, filterKey: filters.filterKey, rateLimited: false };
  }

  /**
   * GET /moments/og.png. Public. 200 PNG always (renders an empty fallback
   * card when no moments have landed yet), 429 on rate-limit. Shares the
   * per-IP / global limiter with `handleIndexPage` so a noisy crawler hammering
   * both routes still gets bounded — same shape as `/character/:name/og.png`.
   *
   * Cache key encodes the freshest moment id so the image regenerates
   * automatically whenever the index changes. The disk-LRU is small (default
   * 32) since there is functionally one cache key at a time — older keys age
   * out within an hour of normal sim activity.
   */
  async handleMomentsIndexOgImage(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
    const input = this.collectIndexOgInput();
    const cacheKey = freshestCacheKey(input.freshestId);
    let png: Buffer;
    let cacheHit = false;
    const t0 = this.now();
    const cached = await this.ogCache.get(cacheKey);
    if (cached) {
      png = cached;
      cacheHit = true;
    } else {
      png = composeMomentsIndexOg({
        participants: input.participants,
        headline: input.headline,
        simDay: input.simDayValue,
        momentsCount: input.momentsCount,
        totalParticipantCount: input.totalNamedParticipantCount,
      });
      // Fire-and-forget — never block the response on the cache write. Same
      // pattern as character/zone/arc OG routes.
      void this.ogCache.set(cacheKey, png).catch((err) => {
        this.log('warn', 'moments_index.og.cache.set.error', {
          key: cacheKey,
          message: err instanceof Error ? err.message : String(err),
        });
      });
    }
    res.writeHead(200, {
      'content-type': 'image/png',
      'content-length': String(png.length),
      // Index OG drifts as new moments land — one-minute browser cache is
      // enough to spare crawlers without freezing stale state. Mirrors
      // /character/:name/og.png.
      'cache-control': 'public, max-age=60',
      'x-og-cache': cacheHit ? 'hit' : 'miss',
    });
    res.end(png);
    this.log('info', 'moments_index.og.render', {
      key: cacheKey,
      cacheHit,
      bytes: png.length,
      ms: this.now() - t0,
    });
    this.onOgRender?.(ip);
  }

  /**
   * Walk the freshest window of MomentRecords once, building the input the
   * OG renderer needs. Newest-first dedup of named participants caps at 8;
   * the freshest moment provides the headline, sim-day, and cache-key id.
   */
  private collectIndexOgInput(): {
    participants: Array<{ name: string; color: string | null }>;
    headline: string;
    simDayValue: number;
    momentsCount: number;
    /** Distinct named participants in the freshest window — pre-cap. */
    totalNamedParticipantCount: number;
    /** Id of the freshest record, or null when the LRU is empty. */
    freshestId: string | null;
  } {
    const all = this.moments.list();
    const start = Math.max(0, all.length - INDEX_OG_WINDOW);
    const window = all.slice(start);
    const seen = new Map<string, { name: string; color: string | null }>();
    // Walk newest → oldest so the freshest named faces win the cap. Stop only
    // when we run out of records — the *count* of distinct named participants
    // is reported separately so the renderer can decide whether to draw the
    // overflow pill.
    for (let i = window.length - 1; i >= 0; i--) {
      const rec = window[i]!;
      for (const p of rec.participants) {
        if (!p.named) continue;
        if (seen.has(p.id)) continue;
        seen.set(p.id, { name: p.name, color: p.color });
      }
    }
    const freshest = window[window.length - 1] ?? null;
    const all8 = [...seen.values()].slice(0, INDEX_OG_PARTICIPANT_CAP);
    return {
      participants: all8,
      headline: freshest?.headline ?? '',
      simDayValue: freshest ? simDay(freshest.simTime) : 0,
      momentsCount: this.moments.count(),
      totalNamedParticipantCount: seen.size,
      freshestId: freshest?.id ?? null,
    };
  }

  private parseFilters(
    query: URLSearchParams,
  ): { ok: true; value: ResolvedFilters } | { ok: false; error: string } {
    const characterIds: string[] = [];
    const characterNames: string[] = [];
    const charRaw = query.get('character');
    if (charRaw) {
      // Split on comma so AND-joining feels obvious in the URL.
      for (const piece of charRaw.split(',')) {
        const tok = piece.trim();
        if (!tok) continue;
        if (!TOKEN_PATTERN.test(tok)) return { ok: false, error: `bad character token: ${tok}` };
        const persona = this.byKey.get(tok.toLowerCase());
        if (!persona) return { ok: false, error: `unknown character: ${tok}` };
        // Echo back the canonical id so URL keys are stable across slug variants.
        const id = persona.manifest.id;
        if (characterIds.includes(id)) continue;
        characterIds.push(id);
        characterNames.push(persona.manifest.name);
      }
    }
    let zone: string | null = null;
    const zoneRaw = query.get('zone');
    if (zoneRaw) {
      const tok = zoneRaw.trim();
      if (!TOKEN_PATTERN.test(tok)) return { ok: false, error: `bad zone: ${tok}` };
      zone = tok;
    }
    let variant: MomentRecord['variant'] | null = null;
    const variantRaw = query.get('variant');
    if (variantRaw) {
      const tok = variantRaw.trim() as MomentRecord['variant'];
      if (!ALLOWED_VARIANTS.has(tok)) return { ok: false, error: `bad variant: ${variantRaw}` };
      variant = tok;
    }
    let cursorBefore: SimTime | null = null;
    const cursorRaw = query.get('cursor');
    if (cursorRaw) {
      if (!CURSOR_PATTERN.test(cursorRaw)) return { ok: false, error: `bad cursor: ${cursorRaw}` };
      cursorBefore = Number(cursorRaw);
    }
    return {
      ok: true,
      value: {
        filterKey: buildFilterKey({ characterIds, zone, variant }),
        characterIds,
        characterNames,
        zone,
        variant,
        cursorBefore,
      },
    };
  }

  /**
   * Walk the LRU once in reverse insertion order (newest first), apply the
   * filter set, and return up to `pageSize+1` matching rows so we know
   * whether there's a next page worth linking. Pre-renders per-row helper
   * fields so the HTML template stays declarative.
   */
  private collectPage(filters: ResolvedFilters): { rows: RowData[]; nextCursor: SimTime | null } {
    const all = this.moments.list();
    const rows: RowData[] = [];
    const limit = this.pageSize;
    // Walk newest → oldest; bail out the moment we have one row beyond the
    // page so we can emit a `?cursor=` link without re-scanning.
    for (let i = all.length - 1; i >= 0; i--) {
      const rec = all[i]!;
      if (!matchesFilters(rec, filters)) continue;
      if (filters.cursorBefore !== null && rec.simTime >= filters.cursorBefore) continue;
      rows.push(this.buildRow(rec));
      if (rows.length > limit) break;
    }
    let nextCursor: SimTime | null = null;
    if (rows.length > limit) {
      // The +1 row tells us another page exists. Keep `pageSize` rows in the
      // page; the last kept row's simTime becomes the next cursor.
      const dropped = rows.pop();
      void dropped;
      const last = rows[rows.length - 1];
      if (last) nextCursor = last.rec.simTime;
    }
    return { rows, nextCursor };
  }

  private buildRow(rec: MomentRecord): RowData {
    const day = simDay(rec.simTime);
    const clock = rec.clock ?? deriveWorldClock(rec.simTime, this.simSpeed);
    const dayLine = `day ${day} · ${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`;
    const isGroup = rec.variant === 'group';
    let arc: RowData['arc'] = null;
    if (this.relationships && !isGroup && rec.participants.length === 2) {
      const [p1, p2] = rec.participants;
      if (p1?.named && p2?.named) {
        const pair = this.relationships.getPair(p1.id, p2.id);
        if (pair) arc = { label: pair.arcLabel, glyph: ARC_GLYPHS[pair.arcLabel] };
      }
    }
    return { rec, dayLine, arc, isGroup };
  }

  private renderHtml(
    filters: ResolvedFilters,
    page: { rows: RowData[]; nextCursor: SimTime | null },
  ): string {
    const canonical = this.buildCanonical(filters, /*includeCursor*/ true);
    const ogTitle = buildIndexOgTitle(filters);
    const ogDescription = buildIndexOgDescription(filters, page.rows.length);
    const filterChips = this.renderFilterChips(filters);
    const rowsHtml = this.renderRows(page.rows);
    const pager = this.renderPager(filters, page.nextCursor);
    const heading = filters.filterKey === '' ? 'All moments' : 'Filtered moments';
    // TINA-1092: when the OG image cache is wired, point unfurlers at the
    // generic `/moments/og.png` regardless of filter. The card is global —
    // filtered views all read from the same image rather than minting a
    // per-filter card (deferred to a follow-up if data justifies it).
    const ogImageUrl = this.ogCache ? this.buildOgImageUrl() : null;
    const ogImageMeta = ogImageUrl
      ? `<meta property="og:image" content="${escapeHtml(ogImageUrl)}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:type" content="image/png" />
  <meta name="twitter:image" content="${escapeHtml(ogImageUrl)}" />`
      : '';
    const twitterCard = ogImageUrl ? 'summary_large_image' : 'summary';
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
    .filters { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 24px; font-size: 12px; }
    .chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; background: rgba(185,176,220,0.10); color: #d6d0e6; }
    .chip[data-kind="character"] { background: rgba(245, 201, 122, 0.14); color: #f0d8a8; }
    .chip[data-kind="zone"] { background: rgba(150, 210, 180, 0.14); color: #c8e8cf; }
    .chip[data-kind="variant"] { background: rgba(150, 180, 230, 0.14); color: #cddaf0; }
    .chip a.x { color: inherit; opacity: 0.6; padding-left: 4px; font-weight: 600; }
    .chip a.x:hover { opacity: 1; text-decoration: none; }
    .chip.add { background: rgba(255,255,255,0.04); color: #8888aa; }
    .chip.clear { background: transparent; color: #8888aa; padding-left: 0; padding-right: 0; }
    .row { display: flex; gap: 12px; align-items: baseline; padding: 12px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
    .row:last-child { border-bottom: none; }
    .row .day { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #8888aa; flex-shrink: 0; min-width: 78px; }
    .row .body { flex: 1; }
    .row .headline { font-size: 14px; line-height: 1.4; color: #e7e5ee; }
    .row .meta-line { font-size: 11px; color: #8888aa; margin-top: 4px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .row .meta-line a { color: #b9b0dc; }
    .row .badge { font-size: 9px; padding: 1px 6px; border-radius: 999px; background: rgba(185,176,220,0.18); color: #d6d0e6; letter-spacing: 0.06em; text-transform: uppercase; }
    .row .badge[data-kind="group"] { background: rgba(185,176,220,0.28); color: #efe6ff; }
    .row .badge[data-kind="nudged"] { background: rgba(245, 201, 122, 0.18); color: #f6e0b0; }
    .row .arc { font-size: 11px; color: #d6d0e6; padding: 1px 7px; border-radius: 999px; background: rgba(185,176,220,0.10); }
    .row .arc[data-arc="warming"] { background: rgba(140, 200, 150, 0.14); color: #c8e8cf; }
    .row .arc[data-arc="cooling"] { background: rgba(150, 180, 230, 0.14); color: #cddaf0; }
    .row .arc[data-arc="estranged"] { background: rgba(220, 140, 140, 0.14); color: #f0c7c7; }
    .row .arc[data-arc="steady"] { background: rgba(200, 200, 200, 0.10); color: #cccccc; }
    .row .arc[data-arc="new"] { background: rgba(245, 201, 122, 0.14); color: #f0d8a8; }
    .pager { display: flex; justify-content: space-between; align-items: center; margin-top: 24px; font-size: 12px; color: #8888aa; }
    .empty { padding: 40px 0 20px; text-align: center; color: #8888aa; font-size: 13px; line-height: 1.5; font-style: italic; }
    footer { margin-top: 40px; font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #55556a; }
  </style>
</head>
<body>
  <main>
    <header class="top">
      <span>tinyhouse · moments</span>
      <a href="/">live sim →</a>
    </header>
    <h1>${escapeHtml(heading)}</h1>
    ${filterChips}
    ${rowsHtml}
    ${pager}
    <footer>moments retained by the in-memory LRU · share any row to keep it · <a href="/characters">cast →</a> · <a href="/arcs">arcs →</a></footer>
  </main>
</body>
</html>`;
  }

  private renderFilterChips(filters: ResolvedFilters): string {
    const chips: string[] = [];
    for (let i = 0; i < filters.characterIds.length; i++) {
      const id = filters.characterIds[i]!;
      const name = filters.characterNames[i] ?? id;
      const without = this.buildUrlWithoutCharacter(filters, id);
      chips.push(
        `<span class="chip" data-kind="character"><a href="/character/${escapeHtml(id)}">${escapeHtml(name)}</a><a class="x" href="${escapeHtml(without)}" title="remove filter">×</a></span>`,
      );
    }
    if (filters.zone) {
      const without = this.buildUrlWithoutZone(filters);
      chips.push(
        `<span class="chip" data-kind="zone">zone · ${escapeHtml(filters.zone)}<a class="x" href="${escapeHtml(without)}" title="remove filter">×</a></span>`,
      );
    }
    if (filters.variant) {
      const without = this.buildUrlWithoutVariant(filters);
      chips.push(
        `<span class="chip" data-kind="variant">${escapeHtml(filters.variant)}<a class="x" href="${escapeHtml(without)}" title="remove filter">×</a></span>`,
      );
    }
    if (filters.filterKey === '') {
      // Suggest the two cheapest variant filters from the unfiltered view —
      // mirrors how `/character/:name` surfaces the named roster on a 404.
      chips.push(
        `<span class="chip add"><a href="/moments?variant=conversation">conversations only</a></span>`,
      );
      chips.push(`<span class="chip add"><a href="/moments?variant=group">group only</a></span>`);
    } else {
      chips.push(`<span class="chip clear"><a href="/moments">clear filters</a></span>`);
    }
    return `<div class="filters">${chips.join('')}</div>`;
  }

  private renderRows(rows: RowData[]): string {
    if (rows.length === 0) {
      return '<div class="empty">No moments matched these filters yet — try widening the search or removing a chip.</div>';
    }
    return rows
      .map((row) => {
        const rec = row.rec;
        const link = `/moment/${encodeURIComponent(rec.id)}`;
        const headline = escapeHtml(rec.headline);
        const participantHtml = rec.participants
          .map((p) =>
            p.named
              ? `<a href="/character/${escapeHtml(p.id)}">${escapeHtml(p.name)}</a>`
              : escapeHtml(p.name),
          )
          .join(', ');
        const badges: string[] = [];
        if (row.isGroup) {
          badges.push('<span class="badge" data-kind="group">group</span>');
        }
        if (row.arc) {
          badges.push(
            `<span class="arc" data-arc="${escapeHtml(row.arc.label)}">${escapeHtml(row.arc.glyph)} ${escapeHtml(row.arc.label)}</span>`,
          );
        }
        const zoneHtml = rec.zone
          ? ` · <a href="/moments?zone=${encodeURIComponent(rec.zone)}">${escapeHtml(rec.zone)}</a>`
          : '';
        return `<article class="row"><span class="day">${escapeHtml(row.dayLine)}</span><div class="body"><div class="headline"><a href="${escapeHtml(link)}">${headline}</a></div><div class="meta-line">${participantHtml}${zoneHtml}${badges.length ? ` · ${badges.join(' ')}` : ''}</div></div></article>`;
      })
      .join('');
  }

  private renderPager(filters: ResolvedFilters, nextCursor: SimTime | null): string {
    if (nextCursor === null) return '';
    const url = this.buildCanonical({ ...filters, cursorBefore: nextCursor }, true);
    return `<div class="pager"><span></span><a href="${escapeHtml(url)}">older →</a></div>`;
  }

  private buildOgImageUrl(): string {
    if (this.publicBaseUrl) return `${this.publicBaseUrl}/moments/og.png`;
    return '/moments/og.png';
  }

  private buildCanonical(filters: ResolvedFilters, includeCursor: boolean): string {
    // Hand-rolled rather than `URLSearchParams.toString()` so the comma in the
    // character list stays literal — `?character=mei,hiro` is the canonical
    // shareable form and reads better in the wild than `%2C`.
    const parts: string[] = [];
    if (filters.characterIds.length > 0) {
      const ids = filters.characterIds.map((id) => encodeURIComponent(id)).join(',');
      parts.push(`character=${ids}`);
    }
    if (filters.zone) parts.push(`zone=${encodeURIComponent(filters.zone)}`);
    if (filters.variant) parts.push(`variant=${encodeURIComponent(filters.variant)}`);
    if (includeCursor && filters.cursorBefore !== null) {
      parts.push(`cursor=${filters.cursorBefore}`);
    }
    const qs = parts.join('&');
    const path = qs ? `/moments?${qs}` : '/moments';
    if (this.publicBaseUrl) return `${this.publicBaseUrl}${path}`;
    return path;
  }

  private buildUrlWithoutCharacter(filters: ResolvedFilters, removeId: string): string {
    const next: ResolvedFilters = {
      ...filters,
      characterIds: filters.characterIds.filter((id) => id !== removeId),
      characterNames: filters.characterNames.filter((_, i) => filters.characterIds[i] !== removeId),
      cursorBefore: null,
    };
    return this.buildCanonical(next, false);
  }

  private buildUrlWithoutZone(filters: ResolvedFilters): string {
    return this.buildCanonical({ ...filters, zone: null, cursorBefore: null }, false);
  }

  private buildUrlWithoutVariant(filters: ResolvedFilters): string {
    return this.buildCanonical({ ...filters, variant: null, cursorBefore: null }, false);
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

function matchesFilters(rec: MomentRecord, filters: ResolvedFilters): boolean {
  if (filters.variant) {
    const v = rec.variant ?? 'conversation';
    if (v !== filters.variant) return false;
  }
  if (filters.zone && rec.zone !== filters.zone) return false;
  if (filters.characterIds.length > 0) {
    const ids = new Set(rec.participants.map((p) => p.id));
    for (const id of filters.characterIds) {
      if (!ids.has(id)) return false;
    }
  }
  return true;
}

/**
 * Canonical filter key used by the sticky-metrics dedup set. Sorted by
 * field name so URL parameter order can't fork the bucket. Characters are
 * sorted alphabetically too — admins linking to "?character=mei,hiro" and
 * "?character=hiro,mei" should land on the same dedup bucket.
 */
export function buildFilterKey(input: {
  characterIds: string[];
  zone: string | null;
  variant: MomentRecord['variant'] | null;
}): string {
  const parts: string[] = [];
  if (input.characterIds.length > 0) {
    const sorted = [...input.characterIds].sort();
    parts.push(`character=${sorted.join(',')}`);
  }
  if (input.variant) parts.push(`variant=${input.variant}`);
  if (input.zone) parts.push(`zone=${input.zone}`);
  return parts.join('&');
}

/**
 * Build the OG title. Generic on the unfiltered index, dominant character/
 * zone first when filtered. Spec says single-character filtered views
 * should read like "Mei Tanaka — moments · TinyHouse", so we lead with
 * names then fall back to zone if no characters were picked.
 */
export function buildIndexOgTitle(filters: ResolvedFilters): string {
  if (filters.filterKey === '') return 'Moments — TinyHouse';
  const headParts: string[] = [];
  if (filters.characterNames.length === 1) headParts.push(filters.characterNames[0]!);
  else if (filters.characterNames.length > 1) headParts.push(filters.characterNames.join(' & '));
  else if (filters.zone) headParts.push(filters.zone);
  const trail = filters.variant === 'group' ? 'group moments' : 'moments';
  if (headParts.length === 0) return `${trail} — TinyHouse`;
  return `${headParts.join(' · ')} — ${trail} · TinyHouse`;
}

/**
 * Short OG description summarising what the visitor will see. Uses the
 * page count so empty filtered views still surface a sensible blurb.
 */
export function buildIndexOgDescription(filters: ResolvedFilters, rowsOnPage: number): string {
  if (filters.filterKey === '') {
    return 'Recent shareable moments from TinyHouse — conversations and group co-presence captured by the live sim.';
  }
  const head: string[] = [];
  if (filters.characterNames.length > 0) head.push(filters.characterNames.join(' & '));
  if (filters.zone) head.push(`in ${filters.zone}`);
  if (filters.variant === 'group') head.push('group only');
  if (filters.variant === 'conversation') head.push('conversations only');
  const blurb = head.length ? head.join(' · ') : 'filtered view';
  if (rowsOnPage === 0) return `${blurb} — no recent moments yet.`;
  return `${blurb} — recent shareable moments captured by the live sim.`;
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

/**
 * Build a stable disk-LRU cache key for the freshest moment. Index OG cards
 * regenerate whenever the freshest record changes — this is the contract the
 * disk LRU relies on for invalidation. Falls back to a sentinel for the
 * cold-start (no moments yet) case so even an empty sim caches its fallback.
 */
function freshestCacheKey(freshestId: string | null): string {
  if (!freshestId) return INDEX_OG_EMPTY_KEY;
  // OgCache enforces `^[A-Za-z0-9_-]{1,64}$`. Sanitize hard rather than
  // trust the moment id format — bail to the empty key on garbage so a
  // surprise pattern never tanks the route.
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(freshestId)) return INDEX_OG_EMPTY_KEY;
  return `idx-${freshestId}`;
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
    <p><a href="/moments">all moments</a> · <a href="/">back to the live sim</a></p>
  </main>
</body>
</html>`;
}
