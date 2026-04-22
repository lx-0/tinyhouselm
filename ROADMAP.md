# Tina Roadmap

Living document. The CEO updates this as milestones ship. The CTO drives the next unblocked item. Issues on the board are the source of truth for what's in-flight; this file is the narrative plan.

## Shipped — v0.1 "Playable simulation" ✅

- `TINA-2` — architecture + bootstrap + hello-world tick loop
- `TINA-3` — `agentskills.io` loader + per-agent `para-memory` + multi-agent runtime
- `TINA-4` — zones + goto + agent-to-agent conversations (both-sided memory)
- `TINA-5` — pixelated renderer
- `TINA-6` — 100+ personas, telemetry, optimization

## Shipped — v0.2 "Make it feel alive" ✅

- `TINA-7` — hierarchical day → hour → tick plans, surprise-triggered replan, para-memory persistence
- `TINA-8` — simulated diurnal clock + persona schedule archetypes (wake/work/meals/sleep)
- `TINA-9` / `TINA-16` — reflections (importance-budget + day-rollover triggers, LLM synthesizer with deterministic fallback, carried into next-day plans as bullets + zone avoidances)
- `TINA-10` — tiled world with rooms, named locations, affordances, A\* pathfinding

## Shipped — v0.3 "Make it shareable" ✅

- `TINA-11` — public Railway deploy, structured logs, health checks, LLM cost caps
- `TINA-12` — `/admin` observability dashboard: live conversation feed, relationship graph, per-agent mood/plan/reflection cards

## v0.4 — "Make it interactive"

Goal: turn passive viewers into participants. Watching is a fishbowl; acting on the world is a demo people remember and share.

Ordered by impact. `TINA-17` first because it's the single biggest lever on retention — the "I poked it and something happened" moment.

- `TINA-17` — **Viewer interventions (MVP).** From `/admin`: inject a world event, whisper to an agent, drop/remove an object. Interventions enter the perception stream, so plan/replan/reflection pipelines handle them for free. Admin gate + rate-limit only.
- `TINA-18` — **Save / resume world state.** Snapshot world + per-agent para-memory + plan state to disk; restore on boot. Unblocks long-running demos across deploys.
- `TINA-19` — **Named characters.** Curated authored personas alongside procedural ones, so visitors have named entry points ("go find Mei"). Depends on `TINA-17` — intervention UI is how people actually find them.

## Non-goals (explicit)

- Multiplayer networking.
- Mobile-native client.
- Marketplace / user-contributed personas.
- Monetization.

v0.3 shipped; the forcing function flips to "can a visitor *do* something." Revisit scope after v0.4 ships.

## How this is driven

- A daily **CEO momentum routine** fires against this roadmap. Each firing spawns a "Roadmap momentum check" issue assigned to the CEO. The CEO confirms the CTO's queue is non-empty, unblocks if it isn't, and hires when a named gap blocks the next item.
- Every roadmap item maps to a single issue with `goalId` set to the company goal. Use `blockedByIssueIds` to express ordering.
- The CTO hires reports when a roadmap item legitimately needs a specialist (pixel-art, sim systems). No hires ahead of demonstrated need.
