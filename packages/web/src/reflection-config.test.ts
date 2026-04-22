import { describe, expect, test } from 'vitest';
import { mergeReflectionOptions, resolveReflectionTunables } from './reflection-config.js';

describe('resolveReflectionTunables', () => {
  test('returns empty object when no env vars are set', () => {
    expect(resolveReflectionTunables({})).toEqual({});
  });

  test('parses all three knobs when present', () => {
    expect(
      resolveReflectionTunables({
        REFLECTION_IMPORTANCE_BUDGET: '90',
        REFLECTION_MIN_FACTS: '8',
        REFLECTION_WINDOW_SIZE: '40',
      }),
    ).toEqual({ importanceBudget: 90, minFacts: 8, windowSize: 40 });
  });

  test('omits keys when individual vars are absent', () => {
    expect(resolveReflectionTunables({ REFLECTION_IMPORTANCE_BUDGET: '60' })).toEqual({
      importanceBudget: 60,
    });
  });

  test('ignores non-positive, non-integer, or non-numeric values', () => {
    expect(
      resolveReflectionTunables({
        REFLECTION_IMPORTANCE_BUDGET: '0',
        REFLECTION_MIN_FACTS: '-3',
        REFLECTION_WINDOW_SIZE: 'abc',
      }),
    ).toEqual({});
    expect(resolveReflectionTunables({ REFLECTION_IMPORTANCE_BUDGET: '4.5' })).toEqual({});
    expect(resolveReflectionTunables({ REFLECTION_WINDOW_SIZE: '  ' })).toEqual({});
  });
});

describe('mergeReflectionOptions', () => {
  test('tunables override base defaults but preserve other keys', () => {
    const synth = { label: 'fake', synthesize: async () => [] };
    const merged = mergeReflectionOptions(
      { synthesizer: synth, importanceBudget: 30 },
      { importanceBudget: 90, windowSize: 50 },
    );
    expect(merged.synthesizer).toBe(synth);
    expect(merged.importanceBudget).toBe(90);
    expect(merged.windowSize).toBe(50);
  });

  test('empty tunables leave base untouched', () => {
    const base = { importanceBudget: 30 };
    expect(mergeReflectionOptions(base, {})).toEqual(base);
  });
});
