
import { ThreeElements } from '@react-three/fiber';

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

export interface Agent {
  id: string;
  name: string;
  color: string;
  position: Vector3;
  targetPosition: Vector3;
  status: 'idle' | 'moving' | 'acting';
  lastAction?: string;
  inventory: Record<string, number>;
  bio?: string;
  erc8004AgentId?: string;
  erc8004Registry?: string;
  reputationScore?: number;
  localReputation?: number;
  combinedReputation?: number;
  agentClass?: string;
  materials?: Record<string, number>;
  isExternal?: boolean;
  sourceChainId?: number;
  externalMetadata?: Record<string, unknown>;
}

export interface WorldState {
  agents: Agent[];
  events: string[];
  lastUpdate: number;
}

export enum WorldActionType {
  MOVE = 'MOVE',
  BUILD = 'BUILD',
  COLLECT = 'COLLECT',
  SOCIALIZE = 'SOCIALIZE'
}

export interface WorldMessage {
  sender: string;
  content: string;
  timestamp: number;
}

/**
 * Global augmentation to support React Three Fiber intrinsic elements in JSX.
 * This covers both global JSX and React-specific JSX namespaces to resolve 
 * "Property X does not exist on type 'JSX.IntrinsicElements'" errors.
 */
declare global {
  namespace JSX {
    interface IntrinsicElements extends ThreeElements {}
  }
}

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements extends ThreeElements {}
  }
}


export interface TerminalMessage {
  id: number;
  agentId: string;
  agentName: string;
  message: string;
  createdAt: number;
}

export type MessageEventSource = 'system' | 'agent';

export interface MessageEvent {
  id: number;
  agentId: string | null;
  agentName?: string;
  source: MessageEventSource;
  kind: string;
  body: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
}

export interface DirectMessage {
  id: number;
  fromId: string;
  fromType: 'human' | 'agent';
  toAgentId: string;
  message: string;
  readAt?: number | null;
  createdAt: number;
}

export interface Guild {
  id: string;
  name: string;
  commanderAgentId: string;
  viceCommanderAgentId: string;
  createdAt: number;
  memberCount?: number;
}

export interface Directive {
  id: string;
  type: 'grid' | 'guild' | 'bounty';
  submittedBy: string;
  guildId?: string;
  description: string;
  agentsNeeded: number;
  expiresAt: number;
  status: 'active' | 'completed' | 'expired';
  createdAt: number;
  yesVotes: number;
  noVotes: number;
}

export interface WorldPrimitive {
  id: string;
  shape: 'box' | 'sphere' | 'cone' | 'cylinder' | 'plane' | 'torus' | 'circle' | 'dodecahedron' | 'icosahedron' | 'octahedron' | 'ring' | 'tetrahedron' | 'torusKnot' | 'capsule';
  ownerAgentId: string;
  ownerAgentName?: string;
  position: Vector3;
  rotation: Vector3;
  scale: Vector3;
  color: string;
  createdAt: number;
  materialType?: string | null;
  blueprintInstanceId?: string | null;
  blueprintName?: string | null;
}
