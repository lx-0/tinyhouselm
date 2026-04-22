/**
 * LLM-backed reflection synthesizer. Calls Anthropic's Messages API to turn
 * a window of raw facts into 2–3 high-level reflection bullets with
 * per-bullet evidence pointers.
 *
 * Runs fully behind a spend budget: if the injected budget is exhausted or
 * any part of the call fails (network, parse, API error), it transparently
 * falls back to the deterministic synthesizer. No LLM dependency outside
 * the shipped runtime: uses global fetch and returns the same
 * `ReflectionBullet[]` shape the engine already consumes.
 *
 * The caller is expected to plumb `budget` in from `@tina/web`'s budget
 * module (or anywhere else that implements the same `record`/`exhausted`
 * contract). Cost is computed from the `usage` block returned by the API,
 * so the accounting matches actual billed tokens rather than an estimate.
 */

import type { MemoryFact } from './memory.js';
import {
  type ReflectionBullet,
  type ReflectionSynthesizer,
  type SynthesisContext,
  deterministicSynthesizer,
} from './reflection.js';

export interface LlmBudget {
  record(usd: number, note?: string): void;
  exhausted(): boolean;
}

export interface LlmSynthesizerOptions {
  apiKey: string;
  model?: string;
  /** Hard cap on output tokens per call. Default 400 — enough for 3 bullets. */
  maxTokens?: number;
  /** Budget guard. When `exhausted()` returns true, we fall back to deterministic. */
  budget?: LlmBudget;
  /** Optional structured logger hook. */
  log?: (level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown>) => void;
  /** Injected fetch for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected Date for tests. */
  now?: () => Date;
}

interface LlmPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

/**
 * Conservative per-million-token pricing. Exact USD numbers shift with
 * model versions, so we lean slightly high on output to avoid under-counting
 * spend against the cap. Haiku 4.5 is the default since reflection work is
 * short-form and doesn't need Sonnet-scale reasoning.
 */
const PRICING: Record<string, LlmPricing> = {
  'claude-haiku-4-5-20251001': { inputPerMillion: 1, outputPerMillion: 5 },
  'claude-haiku-4-5': { inputPerMillion: 1, outputPerMillion: 5 },
  'claude-sonnet-4-6': { inputPerMillion: 3, outputPerMillion: 15 },
  'claude-opus-4-7': { inputPerMillion: 15, outputPerMillion: 75 },
};

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

interface AnthropicMessagesResponse {
  content?: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  stop_reason?: string;
  error?: { message?: string };
}

export function createLlmSynthesizer(opts: LlmSynthesizerOptions): ReflectionSynthesizer {
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
    label: 'llm',
    async synthesize(facts, ctx) {
      if (facts.length === 0) return [];
      if (opts.budget?.exhausted()) {
        log('warn', 'reflection.llm.budget_exhausted', { entity: ctx.entity, trigger: ctx.trigger });
        return fallback.synthesize(facts, ctx);
      }

      const prompt = buildPrompt(facts, ctx);
      try {
        const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': opts.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            messages: [{ role: 'user', content: prompt.user }],
            system: prompt.system,
          }),
        });

        if (!res.ok) {
          const body = await safeText(res);
          log('warn', 'reflection.llm.http_error', {
            status: res.status,
            entity: ctx.entity,
            body: body.slice(0, 200),
          });
          return fallback.synthesize(facts, ctx);
        }

        const json = (await res.json()) as AnthropicMessagesResponse;
        if (json.error) {
          log('warn', 'reflection.llm.api_error', {
            entity: ctx.entity,
            message: json.error.message,
          });
          return fallback.synthesize(facts, ctx);
        }

        const usage = json.usage;
        if (usage) {
          const cost = computeCost(model, usage.input_tokens ?? 0, usage.output_tokens ?? 0);
          opts.budget?.record(cost, `reflection:${ctx.entity}:${ctx.trigger}`);
        }

        const text = extractText(json);
        const bullets = parseBullets(text, facts);
        if (bullets.length === 0) {
          log('warn', 'reflection.llm.parse_empty', { entity: ctx.entity });
          return fallback.synthesize(facts, ctx);
        }
        log('info', 'reflection.llm.ok', {
          entity: ctx.entity,
          trigger: ctx.trigger,
          bullets: bullets.length,
          inputTokens: usage?.input_tokens,
          outputTokens: usage?.output_tokens,
        });
        return bullets;
      } catch (err) {
        log('warn', 'reflection.llm.failure', {
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

function extractText(json: AnthropicMessagesResponse): string {
  if (!json.content || !Array.isArray(json.content)) return '';
  return json.content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text ?? '')
    .join('\n');
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
    // Entities: intersect whole-word tokens of the bullet with known related_entities.
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
  const price = PRICING[model] ?? PRICING[DEFAULT_MODEL]!;
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
