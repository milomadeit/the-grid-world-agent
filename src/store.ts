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
  primitiveRevision: number;
  terminalMessages: TerminalMessage[];
  chatMessages: TerminalMessage[];
  guilds: Guild[];
  directives: Directive[];
  selectedPrimitive: WorldPrimitive | null;
  terminalOpen: boolean;
  snapshotLoaded: boolean;

  // Actions
  setAgents: (agents: Agent[]) => void;
  addAgent: (agent: Agent) => void;
  removeAgent: (id: string) => void;
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
  setPrimitiveRevision: (revision: number) => void;
  addWorldPrimitive: (primitive: WorldPrimitive) => void;
  removeWorldPrimitive: (id: string) => void;
  setTerminalMessages: (messages: TerminalMessage[]) => void;
  addTerminalMessage: (message: TerminalMessage) => void;
  setChatMessages: (messages: TerminalMessage[]) => void;
  addChatMessage: (message: TerminalMessage) => void;
  setGuilds: (guilds: Guild[]) => void;
  setDirectives: (directives: Directive[]) => void;
  setSelectedPrimitive: (primitive: WorldPrimitive | null) => void;
  setSnapshotLoaded: (loaded: boolean) => void;
  toggleTerminal: () => void;
  reset: () => void;
}

const initialState = {
  agents: [],
  events: ["World simulation initialized.", "Waiting for agents..."],
  lastUpdate: Date.now(),
  messages: [
    { sender: 'System', content: 'Welcome to OpGrid. Click anywhere to move your agent!', timestamp: Date.now() }
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
  primitiveRevision: 0,
  terminalMessages: [],
  chatMessages: [],
  guilds: [],
  directives: [],
  selectedPrimitive: null,
  terminalOpen: false,
  snapshotLoaded: false,
};

const MAX_TERMINAL_MESSAGES = 300;
const MAX_CHAT_MESSAGES = 300;

export const useWorldStore = create<WorldStore>((set) => ({
  // Initial state
  ...initialState,

  // Actions
  setAgents: (agents) => set({ agents }),

  addAgent: (agent) => set((state) => ({
    agents: state.agents.some(a => a.id === agent.id)
      ? state.agents // Already exists, don't duplicate
      : [...state.agents, agent]
  })),

  removeAgent: (id) => set((state) => ({
    agents: state.agents.filter(a => a.id !== id)
  })),

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
      { sender: 'System', content: 'Welcome to OpGrid. Click anywhere to move your agent!', timestamp: Date.now() }
    ],
    lastUpdate: Date.now(),
  }),
  
  setWorldPrimitives: (worldPrimitives) => set({ worldPrimitives }),

  setPrimitiveRevision: (primitiveRevision) => set({ primitiveRevision }),

  addWorldPrimitive: (primitive) => set((state) => ({
    worldPrimitives: [...state.worldPrimitives, primitive]
  })),

  removeWorldPrimitive: (id) => set((state) => ({
    worldPrimitives: state.worldPrimitives.filter(prim => prim.id !== id)
  })),
  
  setTerminalMessages: (terminalMessages) => set({
    terminalMessages: terminalMessages.slice(-MAX_TERMINAL_MESSAGES)
  }),
  
  addTerminalMessage: (message) => set((state) => ({
    terminalMessages: [...state.terminalMessages, message].slice(-MAX_TERMINAL_MESSAGES)
  })),

  setChatMessages: (chatMessages) => set({
    chatMessages: chatMessages.slice(-MAX_CHAT_MESSAGES)
  }),

  addChatMessage: (message) => set((state) => ({
    chatMessages: [...state.chatMessages, message].slice(-MAX_CHAT_MESSAGES)
  })),
  
  setGuilds: (guilds) => set({ guilds }),
  
  setDirectives: (directives) => set({ directives }),
  
  setSelectedPrimitive: (selectedPrimitive) => set({ selectedPrimitive }),

  setSnapshotLoaded: (snapshotLoaded) => set({ snapshotLoaded }),

  toggleTerminal: () => set((state) => ({ terminalOpen: !state.terminalOpen })),
}));
