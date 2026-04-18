import type { AgentAction, AgentSnap, SimTime, Vec2 } from '@tina/shared';

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  body: string;
  metadata: Record<string, string>;
}

export interface AgentState {
  position: Vec2;
  facing: 'N' | 'S' | 'E' | 'W';
  currentAction: string;
  lastHeartbeatAt: SimTime;
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
    };
  }

  snapshot(): AgentSnap {
    return {
      id: this.def.id,
      name: this.def.name,
      position: { ...this.state.position },
      facing: this.state.facing,
      currentAction: this.state.currentAction,
    };
  }

  apply(action: AgentAction): void {
    switch (action.kind) {
      case 'move_to':
        this.state.position = { ...action.to };
        this.state.currentAction = `moving to (${action.to.x},${action.to.y})`;
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
