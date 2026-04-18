# Tina

Live simulation of hundreds of AI personas with a pixelated UI. Agents are defined in [agentskills.io](https://agentskills.io) format and keep durable memory via `para-memory`.

Reference: [joonspk-research/generative_agents](https://github.com/joonspk-research/generative_agents).

## Stack

- **TypeScript** on **Node 20+**
- **pnpm** workspaces
- **vitest** for tests
- **Biome** for lint + format
- GitHub Actions CI

## Layout

```
packages/
  sim/        # simulation engine (tick loop, world, agents)
  shared/     # shared types for sim <-> renderer
  web/        # live browser renderer (HTTP + SSE, canvas client)
world/
  agents/<id>/SKILL.md     # personas in agentskills.io format
  agents/<id>/memory/      # para-memory per agent (gitignored content)
  maps/                    # world maps (later)
```

## Quick start

```bash
pnpm install
pnpm hello          # one-agent hello-world tick loop
pnpm sim            # load every persona in world/agents and tick the runtime
pnpm web            # live browser view at http://localhost:5173
pnpm test           # vitest
pnpm typecheck
pnpm lint
```

- `pnpm hello` advances 20 ticks and prints one agent's status each tick.
- `pnpm sim [--ticks N] [--agents a,b,c] [--seed N] [--json]` loads every
  persona under `world/agents/` (agentskills.io format), wires a per-agent
  `para-memory` tree, ticks the runtime, and prints an event log. Use
  `--help` for the full flag list.
- `pnpm web` boots an HTTP server that runs the simulation in-process and
  streams snapshots + deltas over Server-Sent Events to a canvas client.
  Config via env: `PORT`, `SIM_SPEED`, `TICK_MS`, `SEED`, `WORLD_W`,
  `WORLD_H`.

## Architecture

See the [TINA-2 plan document](./docs/architecture.md) — or open the issue in the Tina workspace. Short version:

- Central `SimulationClock` drives time; ticks at 10 Hz.
- Each tick: synchronous perception + async per-agent heartbeats (LLM-backed, throttled).
- Agents are `agentskills.io` directories. Memory is a per-agent para-memory tree.
- The simulation publishes a typed event stream; renderers subscribe.

## Milestones

- `TINA-2` — architecture + bootstrap + hello-world tick loop ✅
- `TINA-3` — `agentskills.io` loader + per-agent memory + multi-agent runtime ✅
- `TINA-4` — zones + goto + agent-to-agent conversations (with both-sided memory) ✅
- `TINA-5` — pixelated renderer ✅
- `TINA-6` — 100+ personas, telemetry, optimization
