import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MomentRecord } from '@tina/shared';
import { type ArcLabel, type NudgeDirection, type RelationshipStore, simDay } from '@tina/sim';
import type { MomentStore } from './moments.js';

export interface MomentRouteOptions {
  store: MomentStore;
  /**
   * Public base URL used to build `https://host/moment/:id` links returned to
   * the admin. When unset, the server falls back to same-origin relative URLs
   * (good for local dev). In prod this is the Railway public URL.
   */
  publicBaseUrl?: string | null;
  /** Admin gate for the share endpoint. Same semantics as intervention routes. */
  checkAdmin: (req: IncomingMessage) => { ok: true } | { ok: false; status: number; error: string };
  /** Fires `onAdmit` after a successful share — used for telemetry/budget. */
  onShare?: () => void;
  /** Per-IP share rate limit per minute. Default 20. */
  perIpSharePerMin?: number;
  /** Global share rate limit per minute. Default 120. */
  globalSharePerMin?: number;
  /**
   * Optional relationship store (TINA-207). When present and both moment
   * participants are named, the share page surfaces the *current* arc label
   * — so a link sent 3 days ago reads differently today.
   */
  relationships?: RelationshipStore | null;
  /**
   * Render-time lookup for "was this session nudged?" (TINA-275). Returns
   * the direction of the nudge that a named×named close consumed, or null
   * if no nudge was ever applied to this session. Deliberately render-time
   * only — never persisted into MomentRecord — so evicting the tracker
   * just hides the pill without rewriting records.
   */
  isSessionNudged?: ((sessionId: string) => NudgeDirection | null) | null;
  now?: () => number;
}

export interface ArcTag {
  label: ArcLabel;
  headline: string;
  glyph: string;
}

export interface NudgeTag {
  direction: NudgeDirection;
  label: string;
  glyph: string;
}

const ARC_GLYPHS: Record<ArcLabel, string> = {
  new: '🌀',
  warming: '🌱',
  cooling: '🥶',
  estranged: '🔕',
  steady: '💤',
};

const NUDGE_GLYPHS: Record<NudgeDirection, string> = {
  spark: '✨',
  tension: '⚡',
  reconcile: '🤝',
};

const NUDGE_LABELS: Record<NudgeDirection, string> = {
  spark: 'viewer-nudged · spark',
  tension: 'viewer-nudged · tension',
  reconcile: 'viewer-nudged · reconcile',
};

interface Bucket {
  count: number;
  windowStart: number;
}

const WINDOW_MS = 60_000;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export class MomentRoutes {
  private readonly store: MomentStore;
  private readonly publicBaseUrl: string | null;
  private readonly checkAdmin: MomentRouteOptions['checkAdmin'];
  private readonly onShare?: () => void;
  private readonly perIpRate: number;
  private readonly globalRate: number;
  private readonly relationships: RelationshipStore | null;
  private readonly isSessionNudged: ((sessionId: string) => NudgeDirection | null) | null;
  private readonly now: () => number;
  private readonly perIp = new Map<string, Bucket>();
  private readonly globalBucket: Bucket = { count: 0, windowStart: 0 };

  constructor(opts: MomentRouteOptions) {
    this.store = opts.store;
    this.publicBaseUrl = (opts.publicBaseUrl ?? null)?.replace(/\/+$/, '') ?? null;
    this.checkAdmin = opts.checkAdmin;
    this.onShare = opts.onShare;
    this.perIpRate = opts.perIpSharePerMin ?? 20;
    this.globalRate = opts.globalSharePerMin ?? 120;
    this.relationships = opts.relationships ?? null;
    this.isSessionNudged = opts.isSessionNudged ?? null;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * GET /moment/:id — render a read-only HTML page with OG meta tags. Public,
   * no auth. 404 when the id is unknown.
   */
  handleMomentPage(res: ServerResponse, id: string, canonicalPath?: string): void {
    if (!ID_PATTERN.test(id)) {
      writeHtml(res, 404, notFoundPage());
      return;
    }
    const rec = this.store.get(id);
    if (!rec) {
      writeHtml(res, 404, notFoundPage());
      return;
    }
    const arc = this.resolveArc(rec);
    const nudge = this.resolveNudge(rec);
    const groupArcs = this.resolveGroupArcs(rec);
    const html = renderMomentHtml(
      rec,
      this.buildCanonicalUrl(canonicalPath ?? `/moment/${id}`),
      this.buildCanonicalUrl(`/moment/${id}/og.png`),
      arc,
      nudge,
      groupArcs,
    );
    writeHtml(res, 200, html);
  }

  /**
   * Render-time check for whether a viewer nudge was consumed by the close
   * that produced this moment (TINA-275). Only returns a tag when both
   * participants are named (nudges only apply to named×named) and the
   * session id is known to the live tracker. Never persisted.
   */
  private resolveNudge(rec: MomentRecord): NudgeTag | null {
    if (!this.isSessionNudged) return null;
    if (rec.participants.length !== 2) return null;
    const [p1, p2] = rec.participants as [
      MomentRecord['participants'][number],
      MomentRecord['participants'][number],
    ];
    if (!p1.named || !p2.named) return null;
    const direction = this.isSessionNudged(rec.sessionId);
    if (!direction) return null;
    return {
      direction,
      label: NUDGE_LABELS[direction],
      glyph: NUDGE_GLYPHS[direction],
    };
  }

  /**
   * Look up the current arc label for a moment whose participants are both
   * named. Returns null when relationships aren't configured, either
   * participant is procedural, or the pair has no recorded history yet.
   * Read at page-render time on purpose — a link shared days ago surfaces
   * today's label, which is the v0.5 returner payoff for TINA-207.
   */
  private resolveArc(rec: MomentRecord): ArcTag | null {
    if (!this.relationships) return null;
    if (rec.participants.length !== 2) return null;
    const [p1, p2] = rec.participants as [
      MomentRecord['participants'][number],
      MomentRecord['participants'][number],
    ];
    if (!p1.named || !p2.named) return null;
    const state = this.relationships.getPair(p1.id, p2.id);
    if (!state) return null;
    const headline = `${p1.name} & ${p2.name} — ${state.arcLabel}`;
    return { label: state.arcLabel, headline, glyph: ARC_GLYPHS[state.arcLabel] };
  }

  /**
   * Per-pair arc tags for a group moment (TINA-345). Reads the current arc
   * label for every named×named pair in the record, so a link shared days
   * ago surfaces today's labels alongside the co-presence headline. Skips
   * pairs with no recorded history (procedural × named, or first meeting).
   */
  private resolveGroupArcs(rec: MomentRecord): ArcTag[] {
    if (!this.relationships) return [];
    if (rec.variant !== 'group') return [];
    const tags: ArcTag[] = [];
    const parts = rec.participants;
    for (let i = 0; i < parts.length; i++) {
      for (let j = i + 1; j < parts.length; j++) {
        const p1 = parts[i]!;
        const p2 = parts[j]!;
        if (!p1.named || !p2.named) continue;
        const state = this.relationships.getPair(p1.id, p2.id);
        if (!state) continue;
        tags.push({
          label: state.arcLabel,
          headline: `${p1.name} & ${p2.name} — ${state.arcLabel}`,
          glyph: ARC_GLYPHS[state.arcLabel],
        });
      }
    }
    return tags;
  }

  /**
   * GET /api/moments/:id — raw JSON. Public. 404 when unknown.
   */
  handleMomentJson(res: ServerResponse, id: string): void {
    if (!ID_PATTERN.test(id)) {
      writeJson(res, 404, { error: 'not found' });
      return;
    }
    const rec = this.store.get(id);
    if (!rec) {
      writeJson(res, 404, { error: 'not found' });
      return;
    }
    writeJson(res, 200, rec);
  }

  /**
   * POST /api/admin/moment/share — admin-gated retrieve (or 404) of a moment
   * by sessionId. Returns { id, url }.
   */
  async handleShare(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = this.checkAdmin(req);
    if (!auth.ok) {
      writeJson(res, auth.status, { error: auth.error });
      return;
    }
    const ip = clientIp(req);
    const rate = this.checkRate(ip);
    if (!rate.ok) {
      res.setHeader('retry-after', String(Math.ceil(rate.retryAfterMs / 1000)));
      writeJson(res, 429, { error: 'rate limited' });
      return;
    }
    let body: unknown;
    try {
      body = await readJson(req, 2048);
    } catch (err) {
      writeJson(res, 400, { error: (err as Error).message });
      return;
    }
    const input = (body ?? {}) as { sessionId?: unknown };
    if (typeof input.sessionId !== 'string' || input.sessionId.length === 0) {
      writeJson(res, 400, { error: 'sessionId required' });
      return;
    }
    const rec = this.store.getBySession(input.sessionId);
    if (!rec) {
      writeJson(res, 404, { error: 'no moment for that session yet' });
      return;
    }
    this.onShare?.();
    writeJson(res, 200, {
      ok: true,
      id: rec.id,
      url: this.buildCanonicalUrl(`/moment/${rec.id}`),
      headline: rec.headline,
    });
  }

  private buildCanonicalUrl(path: string): string {
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

function writeHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'public, max-age=60',
  });
  res.end(body);
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req as AsyncIterable<Buffer | string>) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    total += buf.length;
    if (total > maxBytes) throw new Error(`body exceeds ${maxBytes} bytes`);
    chunks.push(buf);
  }
  if (total === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('invalid JSON body');
  }
}

function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (first) return first.split(',')[0]!.trim();
  return req.socket.remoteAddress ?? '';
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/** Build an OG description from the transcript — first few turns, capped. */
export function buildMomentDescription(rec: MomentRecord, max = 160): string {
  const lines: string[] = [];
  const nameById = new Map(rec.participants.map((p) => [p.id, p.name]));
  for (const turn of rec.transcript) {
    const name = nameById.get(turn.speakerId) ?? turn.speakerId;
    lines.push(`${name}: ${turn.text}`);
    if (lines.join(' · ').length >= max) break;
  }
  if (lines.length === 0) return rec.headline;
  return truncate(lines.join(' · '), max);
}

function renderMomentHtml(
  rec: MomentRecord,
  canonical: string,
  ogImageUrl: string,
  arc: ArcTag | null,
  nudge: NudgeTag | null,
  groupArcs: ArcTag[] = [],
): string {
  const title = escapeHtml(rec.headline);
  const description = escapeHtml(buildMomentDescription(rec));
  const canonicalEsc = escapeHtml(canonical);
  const ogImageEsc = escapeHtml(ogImageUrl);
  const isGroup = rec.variant === 'group';

  const participantChips = rec.participants
    .map((p) => {
      const color = p.color ?? '#b9b0dc';
      const star = p.named ? '<span class="star">★</span>' : '';
      return `<span class="chip"><span class="sw" style="background:${escapeHtml(color)}"></span>${star}${escapeHtml(p.name)}</span>`;
    })
    .join('');

  const zoneLink = rec.zone
    ? ` · <a href="/zone/${escapeHtml(encodeURIComponent(rec.zone.toLowerCase()))}">${escapeHtml(rec.zone)}</a>`
    : '';
  const clockLine = `day ${rec.clock.day} · ${String(rec.clock.hour).padStart(2, '0')}:${String(rec.clock.minute).padStart(2, '0')} · ${rec.clock.phase}${zoneLink}`;

  const turnsHtml = rec.transcript
    .map((t) => {
      const nameById = new Map(rec.participants.map((p) => [p.id, p.name]));
      const name = escapeHtml(nameById.get(t.speakerId) ?? t.speakerId);
      const text = escapeHtml(t.text);
      return `<div class="turn"><span class="name">${name}</span>: ${text}</div>`;
    })
    .join('');

  const reflectionHtml = rec.reflection
    ? `<section class="reflection"><h3>Reflection</h3><p>${escapeHtml(rec.reflection.summary)}</p><div class="meta">${escapeHtml(rec.reflection.trigger.replace('_', ' · '))} · ${rec.reflection.sourceCount} facts</div></section>`
    : '';

  const capturedAt = escapeHtml(rec.capturedAt);
  const closeReason = escapeHtml(rec.closeReason);
  const arcHtml = arc
    ? `<div class="arc" data-arc="${escapeHtml(arc.label)}"><span class="glyph">${escapeHtml(arc.glyph)}</span><span>${escapeHtml(arc.headline)}</span></div>`
    : '';
  const nudgeHtml = nudge
    ? `<div class="nudge" data-nudge="${escapeHtml(nudge.direction)}"><span class="glyph">${escapeHtml(nudge.glyph)}</span><span>${escapeHtml(nudge.label)}</span></div>`
    : '';
  const groupBadgeHtml = isGroup
    ? `<div class="group-badge"><span class="glyph">👥</span><span>group moment · ${rec.participants.length} named</span></div>`
    : '';
  const groupArcsHtml = groupArcs.length
    ? `<div class="group-arcs">${groupArcs
        .map(
          (t) =>
            `<span class="arc" data-arc="${escapeHtml(t.label)}"><span class="glyph">${escapeHtml(t.glyph)}</span><span>${escapeHtml(t.headline)}</span></span>`,
        )
        .join('')}</div>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${title} — tina</title>
  <meta name="description" content="${description}" />
  <meta property="og:type" content="article" />
  <meta property="og:title" content="${title}" />
  <meta property="og:description" content="${description}" />
  <meta property="og:url" content="${canonicalEsc}" />
  <meta property="og:site_name" content="tina" />
  <meta property="og:image" content="${ogImageEsc}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:type" content="image/png" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${title}" />
  <meta name="twitter:description" content="${description}" />
  <meta name="twitter:image" content="${ogImageEsc}" />
  <link rel="canonical" href="${canonicalEsc}" />
  <style>
    :root { color-scheme: dark; }
    html, body { margin: 0; padding: 0; background: #0f0d15; color: #e7e5ee; font-family: -apple-system, system-ui, Segoe UI, sans-serif; }
    main { max-width: 640px; margin: 0 auto; padding: 32px 20px 80px; }
    a { color: #b9b0dc; }
    header.top { display: flex; justify-content: space-between; align-items: center; font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; color: #8888aa; margin-bottom: 18px; }
    h1 { font-size: 20px; line-height: 1.3; margin: 0 0 10px; color: #e7e5ee; }
    .meta { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #8888aa; margin-bottom: 18px; }
    .chips { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 20px; }
    .chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; background: rgba(255,255,255,0.05); font-size: 12px; }
    .chip .sw { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
    .chip .star { color: #f5c97a; margin-right: 2px; }
    .arc { display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 999px; font-size: 12px; letter-spacing: 0.04em; margin-bottom: 16px; background: rgba(185,176,220,0.12); color: #d6d0e6; text-transform: capitalize; }
    .arc[data-arc="warming"] { background: rgba(140, 200, 150, 0.14); color: #c8e8cf; }
    .arc[data-arc="cooling"] { background: rgba(150, 180, 230, 0.14); color: #cddaf0; }
    .arc[data-arc="estranged"] { background: rgba(220, 140, 140, 0.14); color: #f0c7c7; }
    .arc[data-arc="steady"] { background: rgba(200, 200, 200, 0.10); color: #cccccc; }
    .arc[data-arc="new"] { background: rgba(245, 201, 122, 0.14); color: #f0d8a8; }
    .arc .glyph { font-size: 14px; }
    .nudge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; font-size: 11px; letter-spacing: 0.04em; margin: 0 0 16px 8px; background: rgba(245, 201, 122, 0.14); color: #f0d8a8; }
    .nudge[data-nudge="spark"] { background: rgba(245, 201, 122, 0.18); color: #f6e0b0; }
    .nudge[data-nudge="tension"] { background: rgba(230, 150, 150, 0.18); color: #f2c3c3; }
    .nudge[data-nudge="reconcile"] { background: rgba(150, 210, 180, 0.18); color: #c9e9d6; }
    .nudge .glyph { font-size: 12px; }
    .group-badge { display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 999px; font-size: 12px; letter-spacing: 0.04em; margin-bottom: 16px; background: rgba(185,176,220,0.18); color: #e2d8f3; text-transform: capitalize; }
    .group-badge .glyph { font-size: 14px; }
    .group-arcs { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 18px; }
    .group-arcs .arc { margin-bottom: 0; }
    .group-empty { border: 1px dashed rgba(255,255,255,0.12); border-radius: 8px; padding: 14px 16px; font-size: 13px; line-height: 1.55; color: #9a93b8; background: rgba(255,255,255,0.02); }
    .transcript { border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 14px 16px; background: rgba(255,255,255,0.02); }
    .turn { font-size: 13px; line-height: 1.55; margin: 4px 0; word-break: break-word; }
    .turn .name { color: #b9b0dc; font-weight: 500; margin-right: 2px; }
    .reflection { margin-top: 22px; padding: 14px 16px; border: 1px solid rgba(185,176,220,0.25); border-radius: 8px; background: rgba(185,176,220,0.06); }
    .reflection h3 { margin: 0 0 6px; font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: #b9b0dc; }
    .reflection p { margin: 0; font-size: 13px; line-height: 1.55; color: #d6d0e6; }
    footer { margin-top: 32px; font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #55556a; }
  </style>
</head>
<body>
  <main>
    <header class="top">
      <span>tina · moment</span>
      <a href="/">live sim →</a>
    </header>
    <h1>${title}</h1>
    <div class="meta">${clockLine} · ${isGroup ? 'co-presence' : `closed (${closeReason})`} · captured ${capturedAt}</div>
    ${groupBadgeHtml}${arcHtml}${nudgeHtml}
    <div class="chips">${participantChips}</div>
    ${groupArcsHtml}
    ${
      isGroup
        ? '<div class="group-empty">No transcript — this is a co-presence record. Named characters shared the same zone long enough to count as a group moment.</div>'
        : `<div class="transcript">${turnsHtml || '<div class="turn" style="opacity:0.6">(no transcript captured)</div>'}</div>`
    }
    ${reflectionHtml}
    <footer>moment id · ${escapeHtml(rec.id)} · <a href="/digest/sd-${simDay(rec.simTime)}">← back to sim-day ${simDay(rec.simTime)} digest</a></footer>
  </main>
</body>
</html>`;
}

function notFoundPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>moment not found — tina</title>
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
    <h1>moment not found</h1>
    <p>That link has expired or never existed. Moments are kept for a limited history.</p>
    <p><a href="/">back to the live sim</a></p>
  </main>
</body>
</html>`;
}
