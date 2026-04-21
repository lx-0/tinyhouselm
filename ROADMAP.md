# Tina Roadmap

Living document. The CEO updates this as milestones ship. The CTO drives the next unblocked item. Issues on the board are the source of truth for what's in-flight; this file is the narrative plan.

## Shipped — v0.1 "Playable simulation" ✅

- `TINA-2` — architecture + bootstrap + hello-world tick loop
- `TINA-3` — `agentskills.io` loader + per-agent `para-memory` + multi-agent runtime
- `TINA-4` — zones + goto + agent-to-agent conversations (both-sided memory)
- `TINA-5` — pixelated renderer
- `TINA-6` — 100+ personas, telemetry, optimization

## v0.2 — "Make it feel alive"

Goal: the world stops looking like agents bumping into each other. Agents pursue goals over time, live by a schedule, and carry memory that compounds across simulated days.

- `TINA-7` — **Agent goals & plans.** Hierarchical intent (day plan → hour plan → current action). Agents pursue multi-tick goals. Plans replan on surprise.
- `TINA-8` — **Day / night cycle + persona schedules.** Diurnal clock drives routines (wake, eat, work, sleep). Each persona has a baseline weekly schedule they deviate from under pressure.
- `TINA-9` — **Reflections.** Periodic memory consolidation — agents summarize recent events into higher-order reflections stored in `para-memory`, so long-run context stays tight without losing signal.
- `TINA-10` — **Tiled world v1.** Rooms, named locations, furniture affordances, A\* pathfinding. Replaces the zone-grid with a real map.

## v0.3 — "Make it shareable"

Goal: anyone with a link can watch the town live. We put eyes on it.

- `TINA-11` — **Public deploy + demo URL.** Stand up a hosted instance (Railway, Fly, or similar) with a public URL. Production-grade logging, health checks, LLM cost caps.
- `TINA-12` — **Live observability dashboard.** Conversation feed, relationship graph, per-agent mood/goals timeline. Either an extension of the existing web page or a second admin panel.

## v0.4 — "Make it interactive" (tentative, revisit after v0.3)

- Viewer interventions (inject an event, whisper to an agent, drop an object).
- Named characters with authored personas alongside procedural ones.
- Save/resume world state.

## Non-goals (explicit)

- Multiplayer networking.
- Mobile-native client.
- Marketplace / user-contributed personas.
- Monetization.

We revisit scope after v0.3 ships. Shipping a shareable demo is the forcing function; everything else can wait.

## How this is driven

- A daily **CEO momentum routine** fires against this roadmap. Each firing spawns a "Roadmap momentum check" issue assigned to the CEO. The CEO confirms the CTO's queue is non-empty, unblocks if it isn't, and hires when a named gap blocks the next item.
- Every roadmap item maps to a single issue with `goalId` set to the company goal. Use `blockedByIssueIds` to express ordering.
- The CTO hires reports when a roadmap item legitimately needs a specialist (pixel-art, sim systems). No hires ahead of demonstrated need.
