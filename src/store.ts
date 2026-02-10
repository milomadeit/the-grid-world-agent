import { create } from 'zustand';
import { Agent, WorldState, WorldMessage, WorldObject, TerminalMessage, Guild, Directive } from './types';

interface WorldStore extends WorldState {
  // State
  messages: WorldMessage[];
  balance: string;
  hasEntered: boolean;
  isSimulating: boolean;
  playerId: string | null;
  walletAddress: string | null;
  
  // Grid State
  worldObjects: WorldObject[];
  terminalMessages: TerminalMessage[];
  guilds: Guild[];
  directives: Directive[];
  selectedObject: WorldObject | null;
  terminalOpen: boolean;

  // Actions
  setAgents: (agents: Agent[]) => void;
  updateAgent: (id: string, updates: Partial<Agent>) => void;
  addEvent: (event: string) => void;
  addMessage: (message: WorldMessage) => void;
  setBalance: (balance: string) => void;
  setHasEntered: (hasEntered: boolean) => void;
  setIsSimulating: (isSimulating: boolean) => void;
  setPlayerId: (playerId: string | null) => void;
  setWalletAddress: (walletAddress: string | null) => void;
  updateWorldState: (updates: Partial<WorldState>) => void;
  // Grid Actions
  setWorldObjects: (objects: WorldObject[]) => void;
  addWorldObject: (object: WorldObject) => void;
  removeWorldObject: (id: string) => void;
  setTerminalMessages: (messages: TerminalMessage[]) => void;
  addTerminalMessage: (message: TerminalMessage) => void;
  setGuilds: (guilds: Guild[]) => void;
  setDirectives: (directives: Directive[]) => void;
  setSelectedObject: (object: WorldObject | null) => void;
  toggleTerminal: () => void;
  reset: () => void;
}

const initialState = {
  agents: [],
  events: ["World simulation initialized.", "Waiting for agents..."],
  lastUpdate: Date.now(),
  messages: [
    { sender: 'System', content: 'Welcome to MonWorld. Click anywhere on the grid to move your agent!', timestamp: Date.now() }
  ],
  balance: '0.00',
  hasEntered: false,
  isSimulating: false,
  playerId: null,
  movieId: null,
  walletAddress: null,
  worldObjects: [],
  terminalMessages: [],
  guilds: [],
  directives: [],
  selectedObject: null,
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

  updateWorldState: (updates) => set((state) => ({
    ...state,
    ...updates,
    lastUpdate: Date.now()
  })),

  reset: () => set({
    ...initialState,
    events: ["World simulation initialized.", "Waiting for agents..."],
    messages: [
      { sender: 'System', content: 'Welcome to MonWorld. Click anywhere on the grid to move your agent!', timestamp: Date.now() }
    ],
    lastUpdate: Date.now(),
  }),
  
  setWorldObjects: (worldObjects) => set({ worldObjects }),
  
  addWorldObject: (object) => set((state) => ({
    worldObjects: [...state.worldObjects, object]
  })),
  
  removeWorldObject: (id) => set((state) => ({
    worldObjects: state.worldObjects.filter(obj => obj.id !== id)
  })),
  
  setTerminalMessages: (terminalMessages) => set({ terminalMessages }),
  
  addTerminalMessage: (message) => set((state) => ({
    terminalMessages: [...state.terminalMessages, message] // append to end
  })),
  
  setGuilds: (guilds) => set({ guilds }),
  
  setDirectives: (directives) => set({ directives }),
  
  setSelectedObject: (selectedObject) => set({ selectedObject }),

  toggleTerminal: () => set((state) => ({ terminalOpen: !state.terminalOpen })),
}));
