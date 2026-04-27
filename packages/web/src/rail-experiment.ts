import type { MomentRecord } from '@tina/shared';
import type { RelationshipStore } from '@tina/sim';

/**
 * Rail-ranking experiment (TINA-1020). Variants ride behind the existing
 * tier order from TINA-952 — only the inner-tier sort comparator changes.
 */
export type RailVariant = 'freshest' | 'arc_strength';

export const RAIL_VARIANTS: readonly RailVariant[] = ['freshest', 'arc_strength'];

export function isRailVariant(v: unknown): v is RailVariant {
  return v === 'freshest' || v === 'arc_strength';
}

/**
 * FNV-1a 32-bit hash. Tiny, fast, deterministic — all we need for a 50/50
 * cohort split keyed on the visitor cookie or fallback IP.
 */
function fnv1a32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Assign a stable variant to a visitor. The cookie is good for 1 year, so the
 * same visitor sees the same variant indefinitely. Until the cookie is
 * stamped, the IP fallback gives the same hash for the same client. When the
 * experiment is off, every visitor gets `freshest` so the rail behavior is
 * identical to the pre-experiment baseline.
 */
export function assignRailVariant(visitorOrIp: string, experimentEnabled: boolean): RailVariant {
  if (!experimentEnabled) return 'freshest';
  if (!visitorOrIp) return 'freshest';
  return fnv1a32(visitorOrIp) & 1 ? 'arc_strength' : 'freshest';
}

/**
 * Sum of pairwise affinity between source named-participants and candidate
 * named-participants. Self-pairs (the same id on both sides) score 0 because
 * `getPair(a, a)` returns null. Procedural participants are skipped — only
 * named×named has a recorded relationship.
 */
export function arcStrengthScore(
  source: MomentRecord,
  candidate: MomentRecord,
  relationships: RelationshipStore | null,
): number {
  if (!relationships) return 0;
  const sourceNamed = source.participants.filter((p) => p.named).map((p) => p.id);
  const candNamed = candidate.participants.filter((p) => p.named).map((p) => p.id);
  if (sourceNamed.length === 0 || candNamed.length === 0) return 0;
  let sum = 0;
  for (const sId of sourceNamed) {
    for (const cId of candNamed) {
      if (sId === cId) continue;
      const state = relationships.getPair(sId, cId);
      if (state) sum += state.affinity;
    }
  }
  return sum;
}
