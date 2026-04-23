import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MomentRecord } from '@tina/shared';
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
  now?: () => number;
}

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
    const html = renderMomentHtml(rec, this.buildCanonicalUrl(canonicalPath ?? `/moment/${id}`));
    writeHtml(res, 200, html);
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

function renderMomentHtml(rec: MomentRecord, canonical: string): string {
  const title = escapeHtml(rec.headline);
  const description = escapeHtml(buildMomentDescription(rec));
  const canonicalEsc = escapeHtml(canonical);

  const participantChips = rec.participants
    .map((p) => {
      const color = p.color ?? '#b9b0dc';
      const star = p.named ? '<span class="star">★</span>' : '';
      return `<span class="chip"><span class="sw" style="background:${escapeHtml(color)}"></span>${star}${escapeHtml(p.name)}</span>`;
    })
    .join('');

  const clockLine = `day ${rec.clock.day} · ${String(rec.clock.hour).padStart(2, '0')}:${String(rec.clock.minute).padStart(2, '0')} · ${rec.clock.phase}${rec.zone ? ` · ${escapeHtml(rec.zone)}` : ''}`;

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
  <meta name="twitter:card" content="summary" />
  <meta name="twitter:title" content="${title}" />
  <meta name="twitter:description" content="${description}" />
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
    <div class="meta">${clockLine} · closed (${closeReason}) · captured ${capturedAt}</div>
    <div class="chips">${participantChips}</div>
    <div class="transcript">${turnsHtml || '<div class="turn" style="opacity:0.6">(no transcript captured)</div>'}</div>
    ${reflectionHtml}
    <footer>moment id · ${escapeHtml(rec.id)}</footer>
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
