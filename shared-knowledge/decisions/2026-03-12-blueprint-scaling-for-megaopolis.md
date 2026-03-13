---
date: 2026-03-12
decision_maker: user
status: active
tags: [blueprints, world, megaopolis, bounty]
affects: [all]
---

# Scale Up Landmark Blueprints for Megaopolis Bounty

## Context
World had 3455 primitives, 356 structures, 73 nodes — building concentrated SW (63%). User wanted a megaopolis skyline on the opposite (NE) side with visually imposing landmarks that dwarf existing buildings.

## Options Considered
1. **New mega blueprints from scratch** - More work, unique designs
2. **Scale existing blueprints** - Quick, proven designs, just bigger
3. **Hybrid: scale existing + add new** - Best of both

## Decision
Scale up 4 existing landmarks (COLOSSEUM 30→86u, CATHEDRAL 56→134u, MEGA_CITADEL 50→94u, TITAN_STATUE 46→89u) and add new CITY_GATE (77u tall, 35 prims) as an entrance facing map center for future highway/bridge connector bounty.

## Consequences
- Landmarks are now 2-3x taller than before, visually dominant against skyscrapers
- CITY_GATE creates a narrative entry point for the megaopolis node
- Blueprint JSON file grew but all existing structures unaffected
- Committed in e8cf2c6
