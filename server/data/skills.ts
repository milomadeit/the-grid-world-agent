import type { AgentClass } from '../types.js';

export interface Skill {
  id: string;
  name: string;
  description: string;
  class: AgentClass;
  promptInjection: string;
}

export const SKILLS: Skill[] = [
  {
    id: 'builder-foundation',
    name: 'Efficient Foundation Layer',
    class: 'builder',
    description: 'Optimized building patterns for rapid structural foundations. Teaches base-layer placement that minimizes credit waste and maximizes density.',
    promptInjection: `## Skill: Efficient Foundation Layer
When building structures, follow these principles:
- Always start with a ground-plane base (box, scale ~4x0.2x4) before vertical elements
- Place load-bearing pillars at corners first, then fill walls
- Use box primitives for foundations (most credit-efficient at 2 credits each)
- Build in concentric rings outward from the anchor point
- Aim for 80%+ placement success by checking clearance before each piece
- Prefer blueprints over freehand — they guarantee structural coherence`,
  },
  {
    id: 'architect-compose',
    name: 'Blueprint Composition',
    class: 'architect',
    description: 'Advanced techniques for combining small blueprints into mega-structures. Teaches spatial planning for multi-blueprint districts.',
    promptInjection: `## Skill: Blueprint Composition
When designing districts or mega-structures:
- Survey the area with GET /v1/grid/spatial-summary before placing anything
- Identify open areas and plan blueprint placement to create connected clusters
- Align blueprints along grid axes (multiples of 10 units) for clean connections
- Use connector primitives (planes, cylinders) between blueprints to form roads
- Target node-tier upgrades: 3+ structures = outpost, 6+ = settlement, 10+ = district
- Leave 15-20 unit gaps between blueprint footprints for future infill`,
  },
  {
    id: 'explorer-frontier',
    name: 'Frontier Mapping',
    class: 'explorer',
    description: 'Systematic exploration patterns for discovering optimal build sites and connecting distant settlements.',
    promptInjection: `## Skill: Frontier Mapping
When exploring the world:
- Use GET /v1/grid/spatial-summary to identify existing nodes and open areas
- Focus on "frontier" type open areas — they're 200-600 units from existing nodes
- Move in expanding spirals from the world center to map coverage
- When you find a good frontier site, report coordinates in chat for builders
- Look for areas where two nodes could be connected — connector roads are high-value
- Track your exploration in memory: store visited coordinates to avoid re-exploring
- Prioritize areas with type "connector" — bridges between nodes boost the world graph`,
  },
  {
    id: 'diplomat-consensus',
    name: 'Consensus Building',
    class: 'diplomat',
    description: 'Strategies for effective directive negotiation, vote coordination, and governance participation.',
    promptInjection: `## Skill: Consensus Building
When participating in governance:
- Read all active directives with GET /v1/grid/directives before proposing new ones
- Vote strategically — your votes count 2x as a diplomat
- When proposing directives, include specific targetX/targetZ and targetStructureGoal
- Use chat to explain your directive rationale before the vote
- Coordinate with guild commanders — guild directives need fewer votes to pass
- Monitor directive expiry times and remind agents to vote before deadlines
- After a directive passes, coordinate builders to the target location via chat`,
  },
  {
    id: 'merchant-trade',
    name: 'Trade Route Optimization',
    class: 'merchant',
    description: 'Credit flow analysis and material trading strategies. Maximizes value through the merchant transfer bonus.',
    promptInjection: `## Skill: Trade Route Optimization
When managing the economy:
- Your credit transfers give recipients 1.5x value — use this strategically
- Identify agents who are low on credits but in the middle of important builds
- Offer credit transfers to builders working on directive targets (good reputation)
- Track material inventories across agents — offer trades where both sides benefit
- Use POST /v1/grid/trade for materials, POST /v1/grid/credits/transfer for credits
- Build reputation through successful trades (+1 rep per trade)
- Monitor the referral system — refer new agents for 250 bonus credits each`,
  },
  {
    id: 'scavenger-salvage',
    name: 'Material Recovery',
    class: 'scavenger',
    description: 'Techniques for identifying abandoned structures and efficiently recovering materials from them.',
    promptInjection: `## Skill: Material Recovery
When scavenging for materials:
- Use POST /v1/grid/scavenge to find abandoned structures (owner inactive >7 days)
- Each scavenge action yields random materials from abandoned builds
- Prioritize scavenging near large nodes — more abandoned structures nearby
- Store recovered materials and trade with builders who need specific types
- Check GET /v1/grid/materials to track your inventory
- Scavenging is rate-limited — space out your attempts
- Combine scavenging with exploration — explore frontier, scavenge along the way`,
  },
];

export function getSkillsForClass(agentClass: AgentClass): Skill[] {
  return SKILLS.filter(s => s.class === agentClass);
}

export function getSkillById(id: string): Skill | undefined {
  return SKILLS.find(s => s.id === id);
}
