/**
 * OpenAI-compatible reflection synthesizer pointed at the Yesterday AI LLM
 * Gateway (llm.yester.cloud). Lets the sim swap provider/model without a code
 * change: just set LLM_GATEWAY_KEY and pick a tier alias (e.g. `cheap`,
 * `default`, `smart`). Keeps the same `ReflectionSynthesizer` contract and
 * budget/fallback behavior as `llm-reflection.ts` so it's a drop-in swap.
 */

import type { MemoryFact } from './memory.js';
import {
  type ReflectionBullet,
  type ReflectionSynthesizer,
  type SynthesisContext,
  deterministicSynthesizer,
} from './reflection.js';

export interface GatewayBudget {
  record(usd: number, note?: string): void;
  exhausted(): boolean;
}

export interface GatewaySynthesizerOptions {
  apiKey: string;
  /** Base URL of the OpenAI-compatible gateway. Default: https://llm.yester.cloud/v1 */
  baseUrl?: string;
  /** Model/tier alias (`cheap`, `default`, `smart`, `quality`, ...). Default: `default`. */
  model?: string;
  /** Hard cap on output tokens per call. Default 400. */
  maxTokens?: number;
  /** Budget guard. When `exhausted()` returns true, we fall back to deterministic. */
  budget?: GatewayBudget;
  /** Optional structured logger hook. */
  log?: (level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown>) => void;
  /** Injected fetch for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

interface TierPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

/**
 * Rough per-tier pricing pulled from the llm-gateway-client SKILL reference
 * (April 2026). The gateway itself is authoritative for dollar spend against
 * the virtual key — this table is only used to update the local budget cap so
 * the sim can self-throttle. Unknown aliases default to `default` pricing,
 * which is conservative for most non-premium tiers.
 */
const TIER_PRICING: Record<string, TierPricing> = {
  free: { inputPerMillion: 0, outputPerMillion: 0 },
  'free-eu': { inputPerMillion: 0.01, outputPerMillion: 0.01 },
  cheap: { inputPerMillion: 0.28, outputPerMillion: 0.42 },
  'cheap-eu': { inputPerMillion: 0.17, outputPerMillion: 0.66 },
  fast: { inputPerMillion: 0.3, outputPerMillion: 2.5 },
  'fast-eu': { inputPerMillion: 0.22, outputPerMillion: 0.22 },
  default: { inputPerMillion: 0.6, outputPerMillion: 2.2 },
  'default-eu': { inputPerMillion: 0.4, outputPerMillion: 2.0 },
  quality: { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  'quality-no-fb': { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  'quality-eu': { inputPerMillion: 0.5, outputPerMillion: 1.5 },
  'quality-high': { inputPerMillion: 5.0, outputPerMillion: 25.0 },
  'quality-high-no-fb': { inputPerMillion: 5.0, outputPerMillion: 25.0 },
  reasoning: { inputPerMillion: 0.28, outputPerMillion: 0.42 },
  'reasoning-high': { inputPerMillion: 30.0, outputPerMillion: 180.0 },
  code: { inputPerMillion: 1.0, outputPerMillion: 3.2 },
  'code-high': { inputPerMillion: 5.0, outputPerMillion: 25.0 },
  vision: { inputPerMillion: 0.3, outputPerMillion: 2.5 },
  'vision-high': { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  long: { inputPerMillion: 0.3, outputPerMillion: 2.5 },
  'long-high': { inputPerMillion: 2.0, outputPerMillion: 12.0 },
  // `smart` auto-routes across cheap/default/quality/reasoning — use
  // `default` pricing as a conservative-middle estimate. Exact billing is
  // tracked by the gateway.
  smart: { inputPerMillion: 0.6, outputPerMillion: 2.2 },
  'smart-eu': { inputPerMillion: 0.4, outputPerMillion: 2.0 },
};

const DEFAULT_BASE_URL = 'https://llm.yester.cloud/v1';
const DEFAULT_MODEL = 'default';

interface OpenAiChatResponse {
  choices?: Array<{
    message?: { role?: string; content?: string };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string; type?: string };
}

export function createGatewaySynthesizer(opts: GatewaySynthesizerOptions): ReflectionSynthesizer {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const model = opts.model ?? DEFAULT_MODEL;
  const maxTokens = opts.maxTokens ?? 400;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log =
    opts.log ??
    ((level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown>) => {
      const line = JSON.stringify({ level, event, ...fields });
      if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
      else process.stdout.write(`${line}\n`);
    });
  const fallback = deterministicSynthesizer();

  return {
    label: 'llm-gateway',
    async synthesize(facts, ctx) {
      if (facts.length === 0) return [];
      if (opts.budget?.exhausted()) {
        log('warn', 'reflection.gateway.budget_exhausted', {
          entity: ctx.entity,
          trigger: ctx.trigger,
        });
        return fallback.synthesize(facts, ctx);
      }

      const prompt = buildPrompt(facts, ctx);
      try {
        const res = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${opts.apiKey}`,
          },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            messages: [
              { role: 'system', content: prompt.system },
              { role: 'user', content: prompt.user },
            ],
          }),
        });

        if (!res.ok) {
          const body = await safeText(res);
          log('warn', 'reflection.gateway.http_error', {
            status: res.status,
            entity: ctx.entity,
            body: body.slice(0, 200),
          });
          return fallback.synthesize(facts, ctx);
        }

        const json = (await res.json()) as OpenAiChatResponse;
        if (json.error) {
          log('warn', 'reflection.gateway.api_error', {
            entity: ctx.entity,
            message: json.error.message,
          });
          return fallback.synthesize(facts, ctx);
        }

        const usage = json.usage;
        if (usage) {
          const cost = computeCost(model, usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0);
          opts.budget?.record(cost, `reflection:${ctx.entity}:${ctx.trigger}`);
        }

        const text = extractText(json);
        const bullets = parseBullets(text, facts);
        if (bullets.length === 0) {
          log('warn', 'reflection.gateway.parse_empty', { entity: ctx.entity });
          return fallback.synthesize(facts, ctx);
        }
        log('info', 'reflection.gateway.ok', {
          entity: ctx.entity,
          trigger: ctx.trigger,
          bullets: bullets.length,
          model,
          inputTokens: usage?.prompt_tokens,
          outputTokens: usage?.completion_tokens,
        });
        return bullets;
      } catch (err) {
        log('warn', 'reflection.gateway.failure', {
          entity: ctx.entity,
          message: err instanceof Error ? err.message : String(err),
        });
        return fallback.synthesize(facts, ctx);
      }
    },
  };
}

interface PromptPair {
  system: string;
  user: string;
}

function buildPrompt(facts: MemoryFact[], ctx: SynthesisContext): PromptPair {
  const factLines = facts
    .map((f) => `- [${f.id}] (imp=${f.importance}, cat=${f.category}) ${f.fact}`)
    .join('\n');
  const system = [
    'You are the inner voice of an AI persona in a living simulation.',
    'You consolidate a window of raw daily observations into higher-order reflections.',
    'Goals: compress long memory into tight insights, name recurring people/places,',
    'call out emotional or behavioral patterns (e.g. "anxious around <name> in the cafe",',
    '"tired of early shifts", "drawn to the park"), and cite source fact ids as evidence.',
    'Write in first-person present tense. One sentence per bullet. Be specific, not flowery.',
  ].join(' ');
  const user = [
    `Persona: ${ctx.entity}`,
    `Day: ${ctx.day}  ·  Trigger: ${ctx.trigger}`,
    '',
    'Recent raw observations (higher imp = more salient):',
    factLines,
    '',
    'Produce 2 or 3 reflection bullets. Format EXACTLY:',
    '- <reflection text> [ids: fact-1, fact-2]',
    '',
    'Rules:',
    '• 60–150 chars per bullet.',
    '• Use only fact ids listed above inside the [ids: …] tag.',
    '• If the pattern suggests avoidance or stress around a person/place, say so plainly.',
    '• Do not repeat the same insight across bullets.',
  ].join('\n');
  return { system, user };
}

function extractText(json: OpenAiChatResponse): string {
  const choice = json.choices?.[0];
  return choice?.message?.content ?? '';
}

const BULLET_LINE = /^\s*[-*•]\s*(.+?)(?:\s*\[ids?:\s*([^\]]+)\])?\s*$/i;

function parseBullets(text: string, facts: MemoryFact[]): ReflectionBullet[] {
  if (!text) return [];
  const validIds = new Set(facts.map((f) => f.id));
  const entityCounts = new Map<string, number>();
  for (const f of facts) {
    for (const e of f.related_entities) entityCounts.set(e, (entityCounts.get(e) ?? 0) + 1);
  }
  const bullets: ReflectionBullet[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(BULLET_LINE);
    if (!m) continue;
    const raw = m[1]?.trim();
    if (!raw || raw.length < 10) continue;
    const idsPart = m[2] ?? '';
    const sourceFactIds = idsPart
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && validIds.has(s));
    const lower = raw.toLowerCase();
    const entities: string[] = [];
    for (const e of entityCounts.keys()) {
      if (lower.includes(e.toLowerCase()) || lower.includes(e.replace(/-/g, ' ').toLowerCase())) {
        entities.push(e);
      }
    }
    const importance = bullets.length === 0 ? 8 : 7;
    bullets.push({
      text: raw.slice(0, 180),
      entities,
      importance,
      sourceFactIds: sourceFactIds.length > 0 ? sourceFactIds : undefined,
    });
    if (bullets.length >= 3) break;
  }
  return bullets;
}

function computeCost(model: string, inputTokens: number, outputTokens: number): number {
  const price = TIER_PRICING[model] ?? TIER_PRICING[DEFAULT_MODEL]!;
  return (
    (inputTokens / 1_000_000) * price.inputPerMillion +
    (outputTokens / 1_000_000) * price.outputPerMillion
  );
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
