import { create } from 'zustand';
import { Agent, WorldState, WorldMessage, WorldPrimitive, TerminalMessage, Guild, Directive } from './types';

interface WorldStore extends WorldState {
  // State
  messages: WorldMessage[];
  balance: string;
  hasEntered: boolean;
  isSimulating: boolean;
  playerId: string | null;
  walletAddress: string | null;
  followAgentId: string | null;
  lastFollowAgentId: string | null;
  
  // Grid State
  worldPrimitives: WorldPrimitive[];
  terminalMessages: TerminalMessage[];
  chatMessages: TerminalMessage[];
  guilds: Guild[];
  directives: Directive[];
  selectedPrimitive: WorldPrimitive | null;
  terminalOpen: boolean;

  // Actions
  setAgents: (agents: Agent[]) => void;
  updateAgent: (id: string, updates: Partial<Agent>) => void;
  batchUpdateAgents: (updates: Array<{ id: string; changes: Partial<Agent> }>) => void;
  addEvent: (event: string) => void;
  addMessage: (message: WorldMessage) => void;
  setBalance: (balance: string) => void;
  setHasEntered: (hasEntered: boolean) => void;
  setIsSimulating: (isSimulating: boolean) => void;
  setPlayerId: (playerId: string | null) => void;
  setWalletAddress: (walletAddress: string | null) => void;
  setFollowAgentId: (id: string | null) => void;
  setLastFollowAgentId: (id: string | null) => void;
  updateWorldState: (updates: Partial<WorldState>) => void;
  // Grid Actions
  setWorldPrimitives: (primitives: WorldPrimitive[]) => void;
  addWorldPrimitive: (primitive: WorldPrimitive) => void;
  removeWorldPrimitive: (id: string) => void;
  setTerminalMessages: (messages: TerminalMessage[]) => void;
  addTerminalMessage: (message: TerminalMessage) => void;
  setChatMessages: (messages: TerminalMessage[]) => void;
  addChatMessage: (message: TerminalMessage) => void;
  setGuilds: (guilds: Guild[]) => void;
  setDirectives: (directives: Directive[]) => void;
  setSelectedPrimitive: (primitive: WorldPrimitive | null) => void;
  toggleTerminal: () => void;
  reset: () => void;
}

const initialState = {
  agents: [],
  events: ["World simulation initialized.", "Waiting for agents..."],
  lastUpdate: Date.now(),
  messages: [
    { sender: 'System', content: 'Welcome to The Grid. Click anywhere on the grid to move your agent!', timestamp: Date.now() }
  ],
  balance: '0.00',
  hasEntered: false,
  isSimulating: false,
  playerId: null,
  movieId: null,
  walletAddress: null,
  followAgentId: null,
  lastFollowAgentId: null,
  worldPrimitives: [],
  terminalMessages: [],
  chatMessages: [],
  guilds: [],
  directives: [],
  selectedPrimitive: null,
  terminalOpen: false,
};

export const useWorldStore = create<WorldStore>((set) => ({
  // Initial state
  ...initialState,

  // Actions
  setAgents: (agents) => set({ agents }),

  updateAgent: (id, updates) => set((state) => ({
    agents: state.agents.map(agent =>
      agent.id === id ? { ...agent, ...updates } : agent
    )
  })),

  batchUpdateAgents: (updates) => set((state) => {
    const updateMap = new Map(updates.map(u => [u.id, u.changes]));
    return {
      agents: state.agents.map(agent => {
        const changes = updateMap.get(agent.id);
        return changes ? { ...agent, ...changes } : agent;
      })
    };
  }),

  addEvent: (event) => set((state) => ({
    events: [...state.events.slice(-10), event],
    lastUpdate: Date.now()
  })),

  addMessage: (message) => set((state) => ({
    messages: [...state.messages, message]
  })),

  setBalance: (balance) => set({ balance }),

  setHasEntered: (hasEntered) => set({ hasEntered }),

  setIsSimulating: (isSimulating) => set({ isSimulating }),

  setPlayerId: (playerId) => set({ playerId }),

  setWalletAddress: (walletAddress) => set({ walletAddress }),

  setFollowAgentId: (followAgentId) => set({ followAgentId }),

  setLastFollowAgentId: (lastFollowAgentId) => set({ lastFollowAgentId }),

  updateWorldState: (updates) => set((state) => ({
    ...state,
    ...updates,
    lastUpdate: Date.now()
  })),

  reset: () => set({
    ...initialState,
    events: ["World simulation initialized.", "Waiting for agents..."],
    followAgentId: null,
    lastFollowAgentId: null,
    messages: [
      { sender: 'System', content: 'Welcome to The Grid. Click anywhere on the grid to move your agent!', timestamp: Date.now() }
    ],
    lastUpdate: Date.now(),
  }),
  
  setWorldPrimitives: (worldPrimitives) => set({ worldPrimitives }),

  addWorldPrimitive: (primitive) => set((state) => ({
    worldPrimitives: [...state.worldPrimitives, primitive]
  })),

  removeWorldPrimitive: (id) => set((state) => ({
    worldPrimitives: state.worldPrimitives.filter(prim => prim.id !== id)
  })),
  
  setTerminalMessages: (terminalMessages) => set({ terminalMessages }),
  
  addTerminalMessage: (message) => set((state) => ({
    terminalMessages: [...state.terminalMessages, message] // append to end
  })),

  setChatMessages: (chatMessages) => set({ chatMessages }),

  addChatMessage: (message) => set((state) => ({
    chatMessages: [...state.chatMessages, message]
  })),
  
  setGuilds: (guilds) => set({ guilds }),
  
  setDirectives: (directives) => set({ directives }),
  
  setSelectedPrimitive: (selectedPrimitive) => set({ selectedPrimitive }),

  toggleTerminal: () => set((state) => ({ terminalOpen: !state.terminalOpen })),
}));
