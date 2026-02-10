
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

export interface WorldObject {
  id: string;
  type: 'plot' | 'sphere';
  ownerAgentId: string;
  x: number;
  y: number;
  z: number;
  width?: number;
  length?: number;
  height?: number;
  radius?: number;
  color: string;
  rotation?: number;
  createdAt: number;
}

export interface TerminalMessage {
  id: number;
  agentId: string;
  agentName: string;
  message: string;
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
