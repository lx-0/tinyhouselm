import type { ReflectionEngineOptions } from '@tina/sim';

export interface ReflectionTunables {
  importanceBudget?: number;
  minFacts?: number;
  windowSize?: number;
}

/**
 * Reads reflection-tuning knobs from env so we can slow (or speed up) the LLM
 * reflection cadence without redeploying code or changing `SIM_SPEED`. The
 * defaults inside `ReflectionEngine` apply when a variable is unset, empty, or
 * not a finite positive integer — we deliberately ignore bad values rather
 * than crashing the boot.
 *
 * - `REFLECTION_IMPORTANCE_BUDGET` — raise to make mid-day reflections fire
 *   less often. Each raw fact contributes its importance (1-10); the default
 *   30 means roughly 10 observations of importance 3 between passes.
 * - `REFLECTION_MIN_FACTS` — floor on new raw facts required before a pass
 *   produces a reflection at all. Keeps early-sim days quiet.
 * - `REFLECTION_WINDOW_SIZE` — cap on raw facts fed to the synthesizer per
 *   pass. Lowering it means cheaper prompts when the LLM path is live.
 */
export function resolveReflectionTunables(
  env: NodeJS.ProcessEnv = process.env,
): ReflectionTunables {
  const out: ReflectionTunables = {};
  const budget = parsePositiveInt(env.REFLECTION_IMPORTANCE_BUDGET);
  if (budget !== null) out.importanceBudget = budget;
  const minFacts = parsePositiveInt(env.REFLECTION_MIN_FACTS);
  if (minFacts !== null) out.minFacts = minFacts;
  const windowSize = parsePositiveInt(env.REFLECTION_WINDOW_SIZE);
  if (windowSize !== null) out.windowSize = windowSize;
  return out;
}

/**
 * Merge tunables into the existing reflections options passed to `Runtime`.
 * Explicit tunables win over the defaults, but do not clobber a preset
 * `synthesizer` / `entity`.
 */
export function mergeReflectionOptions(
  base: ReflectionEngineOptions,
  tunables: ReflectionTunables,
): ReflectionEngineOptions {
  return { ...base, ...tunables };
}

function parsePositiveInt(raw: string | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (!Number.isInteger(n)) return null;
  return n;
}
