import { describe, expect, test } from 'vitest';
import { createBudget, resolveBudgetCap } from './budget.js';

describe('createBudget', () => {
  test('tracks cumulative spend and flips exhausted at the cap', () => {
    const b = createBudget(1);
    expect(b.exhausted()).toBe(false);
    b.record(0.3);
    b.record(0.4);
    expect(b.exhausted()).toBe(false);
    expect(b.remaining()).toBeCloseTo(0.3, 4);
    b.record(0.5);
    expect(b.exhausted()).toBe(true);
    expect(b.state().calls).toBe(3);
    expect(b.state().spentUsd).toBeCloseTo(1.2, 4);
  });

  test('ignores negative or NaN deltas', () => {
    const b = createBudget(1);
    b.record(-0.5);
    b.record(Number.NaN);
    expect(b.state().spentUsd).toBe(0);
    expect(b.state().calls).toBe(0);
  });

  test('reports capUsd=0 as always exhausted', () => {
    const b = createBudget(0);
    expect(b.exhausted()).toBe(true);
  });
});

describe('resolveBudgetCap', () => {
  test('defaults to 5 when unset', () => {
    expect(resolveBudgetCap({})).toBe(5);
  });

  test('parses LLM_BUDGET_USD from env', () => {
    expect(resolveBudgetCap({ LLM_BUDGET_USD: '2.5' })).toBe(2.5);
    expect(resolveBudgetCap({ LLM_BUDGET_USD: '0' })).toBe(0);
  });

  test('rejects negative / non-numeric values by falling back to 5', () => {
    expect(resolveBudgetCap({ LLM_BUDGET_USD: '-1' })).toBe(5);
    expect(resolveBudgetCap({ LLM_BUDGET_USD: 'abc' })).toBe(5);
  });
});
