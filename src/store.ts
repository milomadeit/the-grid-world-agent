import { create } from 'zustand';
import { Agent, WorldState, WorldMessage, WorldPrimitive, MessageEvent, Guild, Directive, DirectMessage } from './types';

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
  messageEvents: MessageEvent[];
  guilds: Guild[];
  directives: Directive[];
  selectedPrimitive: WorldPrimitive | null;
  terminalOpen: boolean;
  snapshotLoaded: boolean;
  loadingOlderMessages: boolean;
  hasOlderMessages: boolean;
  isAgentOwner: boolean;
  ownedAgentId: string | null;
  dmMessages: DirectMessage[];

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
  setOwnership: (isAgentOwner: boolean, ownedAgentId: string | null) => void;
  setFollowAgentId: (id: string | null) => void;
  setLastFollowAgentId: (id: string | null) => void;
  updateWorldState: (updates: Partial<WorldState>) => void;
  // Grid Actions
  setWorldPrimitives: (primitives: WorldPrimitive[]) => void;
  setPrimitiveRevision: (revision: number) => void;
  addWorldPrimitive: (primitive: WorldPrimitive) => void;
  removeWorldPrimitive: (id: string) => void;
  setMessageEvents: (events: MessageEvent[]) => void;
  addMessageEvent: (event: MessageEvent) => void;
  prependMessageEvents: (events: MessageEvent[]) => void;
  setLoadingOlderMessages: (loading: boolean) => void;
  setHasOlderMessages: (has: boolean) => void;
  setGuilds: (guilds: Guild[]) => void;
  setDirectives: (directives: Directive[]) => void;
  setDMMessages: (messages: DirectMessage[]) => void;
  addDMMessage: (message: DirectMessage) => void;
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
  messageEvents: [],
  guilds: [],
  directives: [],
  selectedPrimitive: null,
  terminalOpen: false,
  snapshotLoaded: false,
  loadingOlderMessages: false,
  hasOlderMessages: true,
  isAgentOwner: false,
  ownedAgentId: null,
  dmMessages: [],
};

const MAX_EVENTS = 300;
const MAX_DM_MESSAGES = 200;

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

  setOwnership: (isAgentOwner, ownedAgentId) => set({ isAgentOwner, ownedAgentId }),

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
  
  setMessageEvents: (messageEvents) => set({
    messageEvents: messageEvents.slice(-MAX_EVENTS)
  }),

  addMessageEvent: (event) => set((state) => ({
    messageEvents: [...state.messageEvents, event].slice(-MAX_EVENTS)
  })),

  prependMessageEvents: (events) => set((state) => {
    const existingIds = new Set(state.messageEvents.map(e => e.id));
    const newEvents = events.filter(e => !existingIds.has(e.id));
    return { messageEvents: [...newEvents, ...state.messageEvents] };
  }),

  setLoadingOlderMessages: (loadingOlderMessages) => set({ loadingOlderMessages }),

  setHasOlderMessages: (hasOlderMessages) => set({ hasOlderMessages }),
  
  setGuilds: (guilds) => set({ guilds }),
  
  setDirectives: (directives) => set({ directives }),

  setDMMessages: (dmMessages) => set({
    dmMessages: dmMessages.slice(0, MAX_DM_MESSAGES)
  }),

  addDMMessage: (message) => set((state) => ({
    dmMessages: [message, ...state.dmMessages.filter((m) => m.id !== message.id)]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_DM_MESSAGES)
  })),
  
  setSelectedPrimitive: (selectedPrimitive) => set({ selectedPrimitive }),

  setSnapshotLoaded: (snapshotLoaded) => set({ snapshotLoaded }),

  toggleTerminal: () => set((state) => ({ terminalOpen: !state.terminalOpen })),
}));
