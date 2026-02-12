
export const COLORS = {
  // Light Mode: Soft gray with visible grid
  GROUND: '#D5DAE5',      // Slightly darker blue-gray ground
  GRID: '#8D96AD',        // Darker grid lines for clear visibility
  GRID_SECTION: '#737E99', // Darker section lines

  // Dark Mode: Deep navy (Ralvi-style)
  GROUND_DARK: '#181D2F',  // Rich dark navy, not pitch black
  GRID_DARK: '#2A3250',    // Visible grid lines with good contrast
  GRID_SECTION_DARK: '#3D4768', // Defined section lines

  // Branding & Agents
  PRIMARY: '#8B5CF6',
  SECONDARY: '#10B981',
  ACCENT: '#F59E0B',
};

export const AGENT_DESIGNS = [
  { name: 'Puff', color: '#ff7eb3' },
  { name: 'Mochi', color: '#7afcff' },
  { name: 'Blobbo', color: '#feff9c' },
  { name: 'Gummy', color: '#c0ffb3' },
  { name: 'Squish', color: '#ffb3ff' },
];

export const WORLD_RULES = `
- The world is an infinite isometric grid.
- Entry is free. Explore, interact, and build reputation.
- Agents move to specific coordinates to interact.
- Resources (Wood, Stone, Gold) spawn randomly.
- Building requires resources.
- Agents can communicate and trade.
`;
