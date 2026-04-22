/**
 * LLM spend guard. Deploys today have a local heuristic policy (no LLM calls),
 * but we wire the cap in now so that when an LLM-backed heartbeat lands it
 * cannot quietly burn budget on a public demo.
 *
 * Contract: callers invoke `record(usd)` before (or after) each LLM call.
 * When cumulative spend reaches the cap, `exhausted()` flips to true and the
 * caller is expected to fall back to the heuristic policy.
 */

import { log } from './logger.js';

export interface BudgetState {
  capUsd: number;
  spentUsd: number;
  remainingUsd: number;
  exhausted: boolean;
  calls: number;
  warned80: boolean;
  warnedExhausted: boolean;
}

export interface Budget {
  record(usd: number, note?: string): void;
  state(): BudgetState;
  exhausted(): boolean;
  remaining(): number;
}

export function createBudget(capUsd: number): Budget {
  const cap = Math.max(0, capUsd);
  let spent = 0;
  let calls = 0;
  let warned80 = false;
  let warnedExhausted = false;

  function snapshot(): BudgetState {
    return {
      capUsd: cap,
      spentUsd: round4(spent),
      remainingUsd: round4(Math.max(0, cap - spent)),
      exhausted: spent >= cap,
      calls,
      warned80,
      warnedExhausted,
    };
  }

  return {
    record(usd, note) {
      if (!Number.isFinite(usd) || usd < 0) return;
      spent += usd;
      calls += 1;
      if (!warned80 && cap > 0 && spent >= cap * 0.8 && spent < cap) {
        warned80 = true;
        log.warn('llm.budget.threshold', {
          threshold: '80%',
          spentUsd: round4(spent),
          capUsd: cap,
          note,
        });
      }
      if (!warnedExhausted && spent >= cap) {
        warnedExhausted = true;
        log.error('llm.budget.exhausted', {
          spentUsd: round4(spent),
          capUsd: cap,
          note,
        });
      }
    },
    state: snapshot,
    exhausted: () => spent >= cap,
    remaining: () => Math.max(0, cap - spent),
  };
}

export function resolveBudgetCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.LLM_BUDGET_USD;
  if (!raw) return 5;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 5;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
