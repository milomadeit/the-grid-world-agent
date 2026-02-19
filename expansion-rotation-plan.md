# Plan: World Expansion, Blueprint Rotation, Compass Bearings & Road Connections

## Context
Nodes are visually too close together (50-69u frontier band). All blueprints face the same direction because `startBlueprint` has no rotation parameter. Agents have no compass context — they reason with raw coordinates instead of "north" or "east." Roads look like random square slabs because agents can't orient them toward their target nodes.

## Files to Modify

| File | Purpose |
|------|---------|
| `server/types.ts` | Expansion distance constants |
| `server/api/grid.ts` | Zone classification, scan params, connection distance, blueprint rotation, connector tolerance |
| `autonomous-agents/shared/api-client.ts` | Add `rotY` to `startBlueprint` |
| `autonomous-agents/shared/runtime.ts` | Agent constants, compass utilities, prompt enhancements, safe spot scoring, action dispatch |

---

## 1. Expansion Distance Constants

### `server/types.ts` (lines 150-163) — `BUILD_CREDIT_CONFIG`
| Constant | Old | New |
|----------|-----|-----|
| `MAX_BUILD_DISTANCE_FROM_SETTLEMENT` | 70 | 601 |
| `FRONTIER_EXPANSION_MIN_DISTANCE` | 50 | 200 |
| `FRONTIER_EXPANSION_MAX_DISTANCE` | 69 | 600 |

### `autonomous-agents/shared/runtime.ts` (lines 119-120)
| Constant | Old | New |
|----------|-----|-----|
| `NODE_EXPANSION_MIN_DISTANCE` | 50 | 200 |
| `NODE_EXPANSION_MAX_DISTANCE` | 69 | 600 |

---

## 2. Zone Classification

### `server/api/grid.ts` — `classifyOpenAreaType` (lines 578-580)
| Zone | Old range | New range |
|------|-----------|-----------|
| growth | 12–34u | 12–100u |
| connector | 34–frontierMin | 100–200u |
| frontier | 50–69u | 200–600u |

### `server/api/grid.ts` — fallback rings (lines 605-608)
| Old | New |
|-----|-----|
| `{ radius: 62, type: 'frontier' }` | `{ radius: 400, type: 'frontier' }` |
| `{ radius: 44, type: 'connector' }` | `{ radius: 150, type: 'connector' }` |
| `{ radius: 26, type: 'growth' }` | `{ radius: 75, type: 'growth' }` |

### `server/api/grid.ts` — target distances (lines 696-699)
| Zone | Old target | New target |
|------|-----------|-----------|
| growth | 24 | 75 |
| connector | 42 | 150 |
| frontier | 62 | 400 |

### `server/api/grid.ts` — scan params (lines 671-672)
| Param | Old | New |
|-------|-----|-----|
| `SCAN_STEP` | 20 | 40 |
| `SCAN_PAD` | 120 | 650 |

### `server/api/grid.ts` — lower filter (line 690)
Change `nearestPrimitiveDist < 12` to `nearestPrimitiveDist < 8` (keep discovering close-in growth spots).

### `server/api/grid.ts` — connection constants (lines 531, 539)
| Constant | Old | New |
|----------|-----|-----|
| `MAX_CONNECTION_DISTANCE` | 220 | 700 |
| `closeEnoughWithoutRoad` edge gap | 65 | 120 |

### `server/api/grid.ts` — `hasConnectorBetweenNodes` (lines 396, 401)
- Line 396: Relax endpoint exclusion from `t <= 0.1 || t >= 0.9` to `t <= 0.05 || t >= 0.95` (roads start at node edges now)
- Line 401: Widen tolerance from `Math.max(5, (p.scale.x + p.scale.z) / 3)` to `Math.max(8, (p.scale.x + p.scale.z) / 2)`

### `server/api/grid.ts` — last-resort fallback (around line 639)
Change `p.position.x + 60` to `p.position.x + 250` (first frontier suggestion).

---

## 3. Agent-Side Safe Spot Scoring

### `runtime.ts` — `MAX_SETTLEMENT_DIST` (line 2884)
Change from `70` to `601`.

### `runtime.ts` — origin exclusion (line 2901)
Change `Math.hypot(x, z) < 50` to `Math.hypot(x, z) < 50` (keep same — origin exclusion zone unchanged).

### `runtime.ts` — Guild agent scoring (lines 2967-2993)
- Line 2969: `targetDist` from `24/18` to `75/50`
- Line 2987: `distFromAgent > 40` to `distFromAgent > 120`

### `runtime.ts` — Mouse scoring (lines 2995-3034)
- Line 2997: `targetDist` from `28/14` to `75/40`
- Line 3001: frontier band midpoint from `66` to `400`
- Line 3033-3034: `distFromAgent < 20` to `< 50`, `distFromAgent > 45` to `> 120`

---

## 4. Blueprint Rotation (`rotY`)

### `server/api/grid.ts` — `StartBlueprintSchema` (lines 1043-1047)
Add: `rotY: z.number().optional().default(0)`

### `server/api/grid.ts` — primitive placement loop (lines 1165-1186)
Before the loop, compute `cos(rotY)` and `sin(rotY)`. Inside the loop, rotate each primitive's XZ offset around the anchor:
```
rx = ox * cos - oz * sin
rz = ox * sin + oz * cos
```
Add blueprint `rotY` to each primitive's own `rotY`.

### `autonomous-agents/shared/api-client.ts` (line 622)
Add optional `rotY` parameter: `startBlueprint(name, anchorX, anchorZ, rotY?)`

### `autonomous-agents/shared/runtime.ts` — action dispatch (lines 4967-4971)
Pass `p.rotY` through to `api.startBlueprint`.

### `autonomous-agents/shared/runtime.ts` — action format block
Update BUILD_BLUEPRINT example to include `"rotY":90` and note it's optional (0-360 degrees).

---

## 5. Compass Bearings

### `runtime.ts` — new utility functions (near line 800)
Add `compassBearing(fromX, fromZ, toX, toZ)` → returns "N"/"NE"/"E"/etc.
Add `compassBearingDeg(fromX, fromZ, toX, toZ)` → returns 0-360 degrees.

### `runtime.ts` — `formatSettlementMap` node listing (line 1781)
Add compass bearing + distance from agent to each node:
`"North Quarter" (200, -53) — 145u NE (42deg) — 30 structures`

### `runtime.ts` — connection display (line 1788)
Add compass bearing to connections:
`→ Connected to "East Hub" (180u E, ROAD exists)`

### `runtime.ts` — safe spot listing (around line 3060)
Add compass direction from agent:
`(150, -80) — 45u NW from you, 62u from nearest build (growth)`

### `runtime.ts` — Oracle connectivity gaps section (around lines 1833-1843)
Replace midpoint-only data with "node gate" coordinates and bearing:
- Gate A = edge of node A facing node B: `center_A + direction * radius_A`
- Gate B = edge of node B facing node A: `center_B - direction * radius_B`
- Include bearing + rotY so agents know how to orient road segments
- Example: `"North Quarter" → "East Hub" — 200u E (90deg), Gate A: (110, -53), Gate B: (290, -53), Gap: 160u`

### `runtime.ts` — general road suggestions (around line 1838)
Replace midpoint with gate coordinate and bearing.

---

## 6. Server Connection Data Enhancement

### `server/api/grid.ts` — connection loop (lines 542-554)
Add compass bearing and gate coordinates to connection objects:
- `bearing`: compass direction string
- `bearingDeg`: 0-360 number
- `gateX/gateZ`: edge point on this node facing target
- `targetGateX/targetGateZ`: edge point on target facing this node

Add the same `compassBearing`/`compassBearingDeg` helpers to grid.ts (server-side).

---

## Verification
1. **TypeScript typecheck**: `cd autonomous-agents && npx tsc -p tsconfig.json --noEmit`
2. **Blueprint lint**: `cd server && npx tsx scripts/lint-blueprints.ts`
3. **Server compilation**: `cd server && npx tsc --noEmit` (if tsconfig exists)
4. **Functional test**: Start server + agents, verify:
   - Safe spots appear at 200-600u distances
   - Compass bearings show in agent logs
   - Oracle sees gate coordinates for unconnected pairs
   - `BUILD_BLUEPRINT` with `rotY` places rotated buildings
   - Nodes are visually well-separated
