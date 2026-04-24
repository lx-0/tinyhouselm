import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Delta, InterventionKind, Vec2 } from '@tina/shared';
import type { Runtime } from '@tina/sim';

export interface InterventionHandlerOptions {
  runtime: Runtime;
  /** Broadcast a Delta to SSE subscribers. */
  broadcast: (delta: Delta) => void;
  /** Optional per-kind observability/budget hook. */
  onAdmit?: (kind: InterventionKind) => void;
  /** Shared secret. When unset, only localhost (127.0.0.1 / ::1) is admitted. */
  adminToken?: string | null;
  /** Per-IP requests per minute. Default 30. */
  perIpRatePerMin?: number;
  /** Global requests per minute. Default 120. */
  globalRatePerMin?: number;
  /** Max JSON body size in bytes. Default 4 KB. */
  maxBodyBytes?: number;
  /** Clock source (ms since epoch) — swappable in tests. */
  now?: () => number;
}

interface Bucket {
  count: number;
  windowStart: number;
}

export class InterventionHandlers {
  private readonly runtime: Runtime;
  private readonly broadcast: (delta: Delta) => void;
  private readonly onAdmit?: (kind: InterventionKind) => void;
  private readonly adminToken: string | null;
  private readonly perIpRate: number;
  private readonly globalRate: number;
  private readonly maxBodyBytes: number;
  private readonly now: () => number;
  private readonly perIp = new Map<string, Bucket>();
  private readonly globalBucket: Bucket = { count: 0, windowStart: 0 };
  private static readonly WINDOW_MS = 60_000;

  constructor(opts: InterventionHandlerOptions) {
    this.runtime = opts.runtime;
    this.broadcast = opts.broadcast;
    this.onAdmit = opts.onAdmit;
    this.adminToken = opts.adminToken ?? null;
    this.perIpRate = opts.perIpRatePerMin ?? 30;
    this.globalRate = opts.globalRatePerMin ?? 120;
    this.maxBodyBytes = opts.maxBodyBytes ?? 4 * 1024;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Try to handle an /api/admin/intervention/* POST. Returns true if the route
   * matched (in which case the response has been written), false otherwise.
   */
  async tryHandle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    if (req.method !== 'POST') return false;
    if (!pathname.startsWith('/api/admin/intervention/')) return false;

    const kind = pathname.slice('/api/admin/intervention/'.length) as
      | 'whisper'
      | 'event'
      | 'object'
      | 'nudge';
    if (!['whisper', 'event', 'object', 'nudge'].includes(kind)) return false;

    const authResult = this.checkAuth(req);
    if (!authResult.ok) {
      writeJson(res, authResult.status, { error: authResult.error });
      return true;
    }
    const ip = clientIp(req);
    const rate = this.checkRate(ip);
    if (!rate.ok) {
      res.setHeader('retry-after', String(Math.ceil(rate.retryAfterMs / 1000)));
      writeJson(res, 429, { error: 'rate limited' });
      return true;
    }
    let body: unknown;
    try {
      body = await readJson(req, this.maxBodyBytes);
    } catch (err) {
      writeJson(res, 400, { error: (err as Error).message });
      return true;
    }

    try {
      if (kind === 'whisper') {
        await this.handleWhisper(res, body);
      } else if (kind === 'event') {
        await this.handleEvent(res, body);
      } else if (kind === 'nudge') {
        await this.handleNudge(res, body);
      } else {
        await this.handleObject(res, body);
      }
    } catch (err) {
      writeJson(res, 400, { error: (err as Error).message });
    }
    return true;
  }

  private async handleWhisper(res: ServerResponse, body: unknown): Promise<void> {
    const input = body as { agentId?: unknown; text?: unknown };
    const agentId = expectString(input.agentId, 'agentId');
    const text = expectString(input.text, 'text', { max: 400 });
    const result = this.runtime.injectWhisper({ agentId, text });
    this.onAdmit?.('whisper');
    this.broadcast({
      kind: 'intervention',
      type: 'whisper',
      summary: text,
      target: agentId,
      zone: null,
      affected: result.affected,
      simTime: result.simTime,
    });
    writeJson(res, 200, { ok: true, ...result });
  }

  private async handleEvent(res: ServerResponse, body: unknown): Promise<void> {
    const input = body as { text?: unknown; zone?: unknown; agentIds?: unknown };
    const text = expectString(input.text, 'text', { max: 400 });
    const zone = input.zone == null ? null : expectString(input.zone, 'zone', { max: 120 });
    const agentIds =
      input.agentIds == null
        ? undefined
        : expectStringArray(input.agentIds, 'agentIds', { maxItems: 256, maxLen: 200 });
    const result = this.runtime.injectWorldEvent({ text, zone, agentIds });
    this.onAdmit?.('world_event');
    this.broadcast({
      kind: 'intervention',
      type: 'world_event',
      summary: text,
      target: null,
      zone,
      affected: result.affected,
      simTime: result.simTime,
    });
    writeJson(res, 200, { ok: true, ...result });
  }

  private async handleObject(res: ServerResponse, body: unknown): Promise<void> {
    const input = body as {
      op?: unknown;
      id?: unknown;
      label?: unknown;
      pos?: unknown;
      zone?: unknown;
    };
    const op = expectString(input.op, 'op');
    if (op === 'drop') {
      const label = expectString(input.label, 'label', { max: 120 });
      const zone = input.zone == null ? null : expectString(input.zone, 'zone', { max: 120 });
      const pos = input.pos == null ? undefined : expectVec2(input.pos, 'pos');
      const id = input.id == null ? undefined : expectString(input.id, 'id', { max: 120 });
      const result = this.runtime.dropObject({ id, label, pos, zone });
      this.onAdmit?.('object_drop');
      this.broadcast({
        kind: 'intervention',
        type: 'object_drop',
        summary: result.summary,
        target: null,
        zone: result.object.zone,
        affected: result.affected,
        simTime: result.simTime,
      });
      writeJson(res, 200, { ok: true, ...result });
      return;
    }
    if (op === 'remove') {
      const id = expectString(input.id, 'id', { max: 120 });
      const result = this.runtime.removeObject({ id });
      this.onAdmit?.('object_remove');
      this.broadcast({
        kind: 'intervention',
        type: 'object_remove',
        summary: result.summary,
        target: null,
        zone: null,
        affected: result.affected,
        simTime: result.simTime,
      });
      writeJson(res, 200, { ok: true, ...result });
      return;
    }
    throw new Error(`unknown op: ${op}`);
  }

  private async handleNudge(res: ServerResponse, body: unknown): Promise<void> {
    const input = body as { a?: unknown; b?: unknown; direction?: unknown };
    const a = expectString(input.a, 'a', { max: 120 });
    const b = expectString(input.b, 'b', { max: 120 });
    const direction = expectString(input.direction, 'direction', { max: 16 });
    if (direction !== 'spark' && direction !== 'tension' && direction !== 'reconcile') {
      throw new Error('direction must be spark | tension | reconcile');
    }
    const result = this.runtime.queueRelationshipNudge({ a, b, direction });
    this.onAdmit?.('relationship_nudge');
    this.broadcast({
      kind: 'intervention',
      type: 'relationship_nudge',
      summary: result.summary,
      target: null,
      zone: null,
      affected: result.affected,
      simTime: result.simTime,
    });
    writeJson(res, 200, { ok: true, ...result });
  }

  private checkAuth(
    req: IncomingMessage,
  ): { ok: true } | { ok: false; status: number; error: string } {
    if (this.adminToken) {
      const provided = headerString(req.headers['x-admin-token']);
      if (provided && timingSafeEqual(provided, this.adminToken)) return { ok: true };
      return { ok: false, status: 401, error: 'admin token required' };
    }
    // No token configured — fall back to localhost-only (dev).
    const ip = clientIp(req);
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return { ok: true };
    return { ok: false, status: 401, error: 'admin token required' };
  }

  private checkRate(ip: string): { ok: true } | { ok: false; retryAfterMs: number } {
    const now = this.now();
    const g = this.globalBucket;
    if (now - g.windowStart >= InterventionHandlers.WINDOW_MS) {
      g.windowStart = now;
      g.count = 0;
    }
    if (g.count >= this.globalRate) {
      return { ok: false, retryAfterMs: InterventionHandlers.WINDOW_MS - (now - g.windowStart) };
    }
    let bucket = this.perIp.get(ip);
    if (!bucket || now - bucket.windowStart >= InterventionHandlers.WINDOW_MS) {
      bucket = { count: 0, windowStart: now };
      this.perIp.set(ip, bucket);
    }
    if (bucket.count >= this.perIpRate) {
      return {
        ok: false,
        retryAfterMs: InterventionHandlers.WINDOW_MS - (now - bucket.windowStart),
      };
    }
    bucket.count += 1;
    g.count += 1;
    return { ok: true };
  }
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
  const forwarded = headerString(req.headers['x-forwarded-for']);
  if (forwarded) return forwarded.split(',')[0]!.trim();
  const addr = req.socket.remoteAddress ?? '';
  return addr;
}

function headerString(h: string | string[] | undefined): string | null {
  if (!h) return null;
  return Array.isArray(h) ? (h[0] ?? null) : h;
}

function expectString(value: unknown, name: string, opts?: { max?: number }): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${name} must be non-empty`);
  if (opts?.max && trimmed.length > opts.max) {
    throw new Error(`${name} exceeds ${opts.max} chars`);
  }
  return trimmed;
}

function expectStringArray(
  value: unknown,
  name: string,
  opts: { maxItems: number; maxLen: number },
): string[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  if (value.length > opts.maxItems) {
    throw new Error(`${name} exceeds ${opts.maxItems} items`);
  }
  return value.map((v, i) => expectString(v, `${name}[${i}]`, { max: opts.maxLen }));
}

function expectVec2(value: unknown, name: string): Vec2 {
  if (!value || typeof value !== 'object') throw new Error(`${name} must be an object`);
  const obj = value as { x?: unknown; y?: unknown };
  const x = expectInt(obj.x, `${name}.x`);
  const y = expectInt(obj.y, `${name}.y`);
  return { x, y };
}

function expectInt(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`${name} must be an integer`);
  }
  return value;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
