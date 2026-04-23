import type { AgentAction, AgentSnap, SimTime, Vec2 } from '@tina/shared';

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  body: string;
  metadata: Record<string, string>;
  /** Hand-authored named character flag (TINA-27). */
  named?: boolean;
  /** Hex body color for the renderer when this agent is named. */
  color?: string | null;
  /** Hex accent for the named-persona halo / ring. */
  accent?: string | null;
  /** One-line bio shown in /admin for named personas. */
  bio?: string | null;
}

export interface AgentState {
  position: Vec2;
  facing: 'N' | 'S' | 'E' | 'W';
  currentAction: string;
  lastHeartbeatAt: SimTime;
  gotoTarget: Vec2 | null;
  gotoLabel: string | null;
  zone: string | null;
  path: Vec2[];
  /** Tick the current cached path was computed at, for debugging / replan rate-limits. */
  pathPlannedAtTick: number;
}

export class Agent {
  readonly def: AgentDefinition;
  state: AgentState;

  constructor(def: AgentDefinition, initial: Partial<AgentState> = {}) {
    this.def = def;
    this.state = {
      position: initial.position ?? { x: 0, y: 0 },
      facing: initial.facing ?? 'S',
      currentAction: initial.currentAction ?? 'idle',
      lastHeartbeatAt: initial.lastHeartbeatAt ?? 0,
      gotoTarget: initial.gotoTarget ?? null,
      gotoLabel: initial.gotoLabel ?? null,
      zone: initial.zone ?? null,
      path: initial.path ?? [],
      pathPlannedAtTick: initial.pathPlannedAtTick ?? -1,
    };
  }

  snapshot(): AgentSnap {
    const snap: AgentSnap = {
      id: this.def.id,
      name: this.def.name,
      position: { ...this.state.position },
      facing: this.state.facing,
      currentAction: this.state.currentAction,
      zone: this.state.zone,
      gotoTarget: this.state.gotoTarget ? { ...this.state.gotoTarget } : null,
    };
    if (this.def.named) snap.named = true;
    if (this.def.color) snap.color = this.def.color;
    if (this.def.accent) snap.accent = this.def.accent;
    if (this.def.bio) snap.bio = this.def.bio;
    return snap;
  }

  apply(action: AgentAction): void {
    switch (action.kind) {
      case 'move_to':
        this.state.position = { ...action.to };
        this.state.currentAction = `moving to (${action.to.x},${action.to.y})`;
        break;
      case 'goto':
        this.state.gotoTarget = { ...action.target };
        this.state.gotoLabel = action.label ?? null;
        // Drop any stale cached path; the runtime will replan next tick.
        this.state.path = [];
        this.state.pathPlannedAtTick = -1;
        this.state.currentAction = action.label
          ? `heading to ${action.label}`
          : `heading to (${action.target.x},${action.target.y})`;
        break;
      case 'speak':
        this.state.currentAction = `speaking: "${action.text.slice(0, 40)}"`;
        break;
      case 'wait':
        this.state.currentAction = `waiting ${action.seconds}s`;
        break;
      case 'set_goal':
        this.state.currentAction = `goal: ${action.goal}`;
        break;
      case 'remember':
        break;
    }
  }
}
