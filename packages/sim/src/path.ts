import type { Vec2 } from '@tina/shared';

export type Walkable = (x: number, y: number) => boolean;

export interface FindPathOptions {
  /** Hard cap on nodes expanded; bail out and return null past this. */
  maxNodes?: number;
  /**
   * Treat the goal as walkable even if `walkable(goal)` is false. Useful when
   * pathing *up to* a doorway or wall-mounted location anchor.
   */
  goalAlwaysReachable?: boolean;
}

const DIRS: Vec2[] = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];

interface Node {
  x: number;
  y: number;
  g: number;
  f: number;
  parent: number;
}

function manhattan(a: Vec2, b: Vec2): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/**
 * 4-direction A* on a grid. Returns the path from start (exclusive) to goal
 * (inclusive), or null if no path exists or the search is bailed.
 *
 * Tie-breaks are deterministic: we order the open set by (f asc, h asc, x asc,
 * y asc), so two equivalent paths produce identical output.
 */
export function findPath(
  start: Vec2,
  goal: Vec2,
  walkable: Walkable,
  bounds: { width: number; height: number },
  opts: FindPathOptions = {},
): Vec2[] | null {
  const maxNodes = opts.maxNodes ?? 4096;
  if (start.x === goal.x && start.y === goal.y) return [];
  if (
    !opts.goalAlwaysReachable &&
    !walkable(goal.x, goal.y) &&
    !(start.x === goal.x && start.y === goal.y)
  ) {
    return null;
  }

  const nodes: Node[] = [];
  const indexByCell = new Map<number, number>();
  const cellKey = (x: number, y: number) => y * bounds.width + x;

  const startIdx = nodes.length;
  nodes.push({ x: start.x, y: start.y, g: 0, f: manhattan(start, goal), parent: -1 });
  indexByCell.set(cellKey(start.x, start.y), startIdx);

  // Open set kept as an array we re-scan each pop. n=4096 max with cheap
  // comparisons; a real binary heap is overkill at our grid size and harder
  // to make deterministic.
  const open: number[] = [startIdx];
  const closed = new Set<number>();
  let expanded = 0;

  while (open.length > 0) {
    let bestPos = 0;
    {
      const bn = nodes[open[0]!]!;
      let bestKey = bn.f * 1e6 + (bn.f - bn.g) * 1e3 + bn.x;
      for (let i = 1; i < open.length; i++) {
        const n = nodes[open[i]!]!;
        const key = n.f * 1e6 + (n.f - n.g) * 1e3 + n.x + n.y * 0.0001;
        if (key < bestKey) {
          bestKey = key;
          bestPos = i;
        }
      }
    }
    const currentIdx = open[bestPos]!;
    open.splice(bestPos, 1);
    const current = nodes[currentIdx]!;

    if (current.x === goal.x && current.y === goal.y) {
      const path: Vec2[] = [];
      let walker: Node | null = current;
      while (walker && walker.parent !== -1) {
        path.push({ x: walker.x, y: walker.y });
        walker = nodes[walker.parent] ?? null;
      }
      return path.reverse();
    }

    closed.add(cellKey(current.x, current.y));
    expanded += 1;
    if (expanded > maxNodes) return null;

    for (const d of DIRS) {
      const nx = current.x + d.x;
      const ny = current.y + d.y;
      if (nx < 0 || ny < 0 || nx >= bounds.width || ny >= bounds.height) continue;
      const isGoal = nx === goal.x && ny === goal.y;
      if (!isGoal && !walkable(nx, ny)) continue;
      const key = cellKey(nx, ny);
      if (closed.has(key)) continue;

      const tentativeG = current.g + 1;
      const existingIdx = indexByCell.get(key);
      if (existingIdx === undefined) {
        const idx = nodes.length;
        nodes.push({
          x: nx,
          y: ny,
          g: tentativeG,
          f: tentativeG + manhattan({ x: nx, y: ny }, goal),
          parent: currentIdx,
        });
        indexByCell.set(key, idx);
        open.push(idx);
      } else {
        const existing = nodes[existingIdx]!;
        if (tentativeG < existing.g) {
          existing.g = tentativeG;
          existing.f = tentativeG + manhattan({ x: nx, y: ny }, goal);
          existing.parent = currentIdx;
          if (!open.includes(existingIdx)) open.push(existingIdx);
        }
      }
    }
  }
  return null;
}
