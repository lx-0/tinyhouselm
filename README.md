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
world/
  agents/<id>/SKILL.md     # personas in agentskills.io format
  agents/<id>/memory/      # para-memory per agent (gitignored content)
  maps/                    # world maps (later)
```

## Quick start

```bash
pnpm install
pnpm hello          # run the hello-world tick loop
pnpm test           # vitest
pnpm typecheck
pnpm lint
```

Hello-world advances 20 ticks of simulated time, prints one agent's status each tick, and emits delta events (spawn, move, speech).

## Architecture

See the [TINA-2 plan document](./docs/architecture.md) — or open the issue in the Tina workspace. Short version:

- Central `SimulationClock` drives time; ticks at 10 Hz.
- Each tick: synchronous perception + async per-agent heartbeats (LLM-backed, throttled).
- Agents are `agentskills.io` directories. Memory is a per-agent para-memory tree.
- The simulation publishes a typed event stream; renderers subscribe.

## Milestones

- `TINA-2` — architecture + bootstrap + hello-world tick loop ✅
- `TINA-3` — `agentskills.io` loader + per-agent memory + 50-tick multi-agent demo
- `TINA-4` — perception + conversation (two agents meet and talk)
- `TINA-5` — pixelated renderer
- `TINA-6` — 100+ personas, telemetry, optimization
