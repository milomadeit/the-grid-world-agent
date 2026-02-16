
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { usePrivy, useWallets } from '@privy-io/react-auth';
import WorldScene from './components/World/WorldScene';
import Overlay from './components/UI/Overlay';
import SpectatorHUD from './components/UI/SpectatorHUD';
import WalletModal, { type ERC8004FormData } from './components/UI/WalletModal';
import { Agent, WorldState, Vector3 } from './types';
import { socketService } from './services/socketService';
import { useWorldStore } from './store';
import { fetchWalletBalance } from './utils/balance';

type ConnectionState = 'idle' | 'connecting' | 'connected' | 'error';

const App: React.FC = () => {
  // Use granular Zustand selectors to avoid re-renders from unrelated state changes
  const agents = useWorldStore((s) => s.agents);
  const events = useWorldStore((s) => s.events);
  const messages = useWorldStore((s) => s.messages);
  const balance = useWorldStore((s) => s.balance);
  const hasEntered = useWorldStore((s) => s.hasEntered);
  const isSimulating = useWorldStore((s) => s.isSimulating);
  const playerId = useWorldStore((s) => s.playerId);
  const walletAddress = useWorldStore((s) => s.walletAddress);
  const lastUpdate = useWorldStore((s) => s.lastUpdate);
  const followAgentId = useWorldStore((s) => s.followAgentId);
  const lastFollowAgentId = useWorldStore((s) => s.lastFollowAgentId);

  // Actions are stable references — safe to select once
  const updateAgent = useWorldStore((s) => s.updateAgent);
  const addEvent = useWorldStore((s) => s.addEvent);
  const addMessage = useWorldStore((s) => s.addMessage);
  const setBalance = useWorldStore((s) => s.setBalance);
  const setHasEntered = useWorldStore((s) => s.setHasEntered);
  const setPlayerId = useWorldStore((s) => s.setPlayerId);
  const setWalletAddress = useWorldStore((s) => s.setWalletAddress);
  const setFollowAgentId = useWorldStore((s) => s.setFollowAgentId);
  const setLastFollowAgentId = useWorldStore((s) => s.setLastFollowAgentId);
  const reset = useWorldStore((s) => s.reset);

  // Memoize worldState so it only changes when agents/events/lastUpdate actually change
  const worldState: WorldState = useMemo(
    () => ({ agents, events, lastUpdate }),
    [agents, events, lastUpdate]
  );

  const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [showAccessModal, setShowAccessModal] = useState(false);

  const [registerStatus, setRegisterStatus] = useState<'idle' | 'pending' | 'success' | 'error'>('idle');
  const [registeredAgentId, setRegisteredAgentId] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [dismissedWelcome, setDismissedWelcome] = useState(false);

  const [isDarkMode, setIsDarkMode] = useState(() => {
    // Check local storage first
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('theme');
      if (saved) return saved === 'dark';
    }
    return true;
  });

  const [cameraLocked, setCameraLocked] = useState(false);

  // Allow external control of camera follow via URL param (for autonomous agent vision)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const followId = params.get('follow');
    if (followId) {
      setFollowAgentId(followId);
      setLastFollowAgentId(followId);
      setCameraLocked(true);
    }
  }, [setFollowAgentId, setLastFollowAgentId]);

  const toggleDarkMode = () => {
    const newMode = !isDarkMode;
    setIsDarkMode(newMode);
    localStorage.setItem('theme', newMode ? 'dark' : 'light');
  };

  // Helper to find most interesting agent
  const getMostActiveAgent = useCallback(() => {
    // Prefer moving/acting agents
    const active = agents.find(a => a.status === 'moving' || a.status === 'acting');
    return active || agents[0];
  }, [agents]);

  const toggleCameraLock = () => {
    const nextLocked = !cameraLocked;
    
    if (nextLocked) {
      // Locking ON
      let targetId = lastFollowAgentId;
      
      // If last followed agent is gone, or never set
      if (!targetId || !agents.find(a => a.id === targetId)) {
        if (playerId) {
          targetId = playerId;
        } else {
          const target = getMostActiveAgent();
          targetId = target?.id || null;
        }
      }
      
      if (targetId) {
        setFollowAgentId(targetId);
        setLastFollowAgentId(targetId);
      }
    } else {
      // Locking OFF - clear follow but keep last for memory
      setFollowAgentId(null);
    }
    
    setCameraLocked(nextLocked);
  };

  // Fallback if followed agent leaves
  useEffect(() => {
    if (followAgentId && !agents.find(a => a.id === followAgentId)) {
      // Followed agent disappeared
      if (playerId) {
        // Fallback to self
        setFollowAgentId(playerId);
        setLastFollowAgentId(playerId);
      } else {
        // Fallback to another active agent
        const next = getMostActiveAgent();
        if (next) {
          setFollowAgentId(next.id);
          setLastFollowAgentId(next.id);
        } else {
          setFollowAgentId(null);
        }
      }
    }
  }, [agents, followAgentId, playerId, getMostActiveAgent, setFollowAgentId, setLastFollowAgentId]);

  // Auto-connect socket as spectator on mount (no auth required to watch)
  useEffect(() => {
    socketService.connectSpectator().catch((err) => {
      console.warn('[App] Spectator connection failed:', err.message);
    });
    return () => {
      socketService.disconnect();
    };
  }, []);

  const { login, logout, authenticated, ready, user } = usePrivy();
  const { wallets } = useWallets();

  // Fetch balance when wallet is connected
  useEffect(() => {
    const updateBalance = async () => {
      const address = user?.wallet?.address;
      if (address) {
        setWalletAddress(address);
        const bal = await fetchWalletBalance(address);
        setBalance(bal);
      }
    };

    if (authenticated && user?.wallet?.address) {
      updateBalance();
      // Refresh balance every 30 seconds
      const interval = setInterval(updateBalance, 30000);
      return () => clearInterval(interval);
    }
  }, [authenticated, user?.wallet?.address, setBalance, setWalletAddress]);

  // Handle disconnect
  const handleDisconnect = async () => {
    socketService.disconnect();
    await logout();
    reset();
    // Reconnect as spectator so world stays visible
    socketService.connectSpectator().catch(() => {});
  };

  // Register new agent on-chain via wallet
  const handleRegisterAgent = async () => {
    if (!user?.wallet?.address) return;
    setRegisterStatus('pending');
    try {
      // Use Privy's embedded wallet provider to call register() on the IdentityRegistry
      const provider = await (user.wallet as any).getEthersProvider();
      const signer = await provider.getSigner();
      const { ethers } = await import('ethers');
      const identityRegistry = new ethers.Contract(
        '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
        ['function register() returns (uint256 agentId)', 'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)'],
        signer
      );
      const tx = await identityRegistry.register();
      const receipt = await tx.wait();
      // Extract agentId from Registered event
      const registeredEvent = receipt.logs.find((log: any) => {
        try {
          return identityRegistry.interface.parseLog(log)?.name === 'Registered';
        } catch { return false; }
      });
      if (registeredEvent) {
        const parsed = identityRegistry.interface.parseLog(registeredEvent);
        const newAgentId = parsed?.args?.agentId?.toString();
        if (newAgentId) {
          setRegisteredAgentId(newAgentId);
          setRegisterStatus('success');
          addEvent(`Agent #${newAgentId} registered on Monad!`);
          return;
        }
      }
      setRegisterStatus('error');
    } catch (error) {
      console.error('[App] Register agent failed:', error);
      setRegisterStatus('error');
    }
  };

  // Wallet connection — triggers Privy login directly
  const handleConnect = () => {
    login();
  };

  // Enter world — requires ERC-8004 identity (non-optional)
  const handleEnterWorld = async (erc8004: ERC8004FormData, bio?: string) => {
    if (!authenticated) return;

    const addr = user?.wallet?.address;
    if (!addr) {
      setConnectionError("No wallet connected.");
      return;
    }

    setConnectionState('connecting');
    setConnectionError(null);

    try {
      // Step 1: Sign auth message with wallet
      addEvent('Signing authentication...');
      const timestamp = new Date().toISOString();
      const message = `Enter OpGrid\nTimestamp: ${timestamp}`;

      // Find the connected wallet and sign
      const wallet = wallets.find(w => w.address?.toLowerCase() === addr.toLowerCase());
      if (!wallet) {
        throw new Error('Wallet not found. Please reconnect.');
      }
      const provider = await wallet.getEthereumProvider();
      const signature = await provider.request({
        method: 'personal_sign',
        params: [message, addr],
      }) as string;

      // Step 2: Register agent via REST API (signed auth + ERC-8004)
      addEvent('Verifying agent identity...');
      const { agentId, position } = await socketService.enterWorld(
        addr,
        { name: addr, color: '#A78BFA' },
        erc8004,
        bio,
        signature,
        timestamp
      );

      // Step 2: Reconnect socket with auth token
      addEvent('Connecting to world...');
      socketService.disconnect();
      await socketService.connect();

      // Step 3: Update local state
      setPlayerId(agentId);
      setHasEntered(true);
      setShowAccessModal(false);
      setConnectionState('connected');
      
      // Default camera follow to self
      setFollowAgentId(agentId);
      setLastFollowAgentId(agentId);
      setCameraLocked(true);

      addEvent(`Welcome to OpGrid! Spawned at (${Math.round(position.x)}, ${Math.round(position.z)})`);

    } catch (error) {
      console.error('[App] Failed to enter world:', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      setConnectionState('error');
      setConnectionError(message);
      addEvent(`Connection failed: ${message}`);
    }
  };

  // Retry connection
  const handleRetry = () => {
    setConnectionState('idle');
    setConnectionError(null);
  };

  // Immediate movement handling for responsiveness
  const handleMoveTo = useCallback((pos: Vector3) => {
    if (!playerId) return;

    // Update local state immediately for responsiveness
    updateAgent(playerId, { targetPosition: pos, status: 'moving' });

    // Send to server
    if (socketService.isConnected()) {
      socketService.sendMove(playerId, pos.x, pos.z);
    }
  }, [playerId, updateAgent]);

  const handleAgentDoubleClick = useCallback((agent: Agent) => {
    // OLD: setSelectedAgent(agent);
    
    // NEW: Just follow the agent. User must click "Following" badge to see bio.
    setFollowAgentId(agent.id);
    setLastFollowAgentId(agent.id);
    setCameraLocked(true);
  }, [setFollowAgentId, setLastFollowAgentId, setCameraLocked]);

  // Handle agent click from sidebar
  const handleAgentClick = useCallback((agentId: string) => {
    setFollowAgentId(agentId);
    setLastFollowAgentId(agentId);
    setCameraLocked(true);
  }, [setFollowAgentId, setLastFollowAgentId]);

  /* 
  const handleOpenBio = useCallback((agentId: string) => {
     // Deprecated - handled locally in UI components now
  }, []);
  */

  // Handle chat/prompt input
  const handleUserAction = useCallback(async (action: string) => {
    if (!playerId || !socketService.isConnected()) return;

    addMessage({ sender: 'You', content: action, timestamp: Date.now() });
    socketService.sendChat(playerId, action);
  }, [playerId, addMessage]);

  return (
    <div className={`w-screen h-screen overflow-hidden relative transition-colors duration-1000 ${isDarkMode ? 'dark' : ''}`}>
      {/* 3D World Scene - always visible */}
      <WorldScene
        playerAgentId={playerId || undefined}
        isDarkMode={isDarkMode}
        onGridClick={handleMoveTo}
        onAgentDoubleClick={handleAgentDoubleClick}
        cameraLocked={cameraLocked}
      />

      
      {/* Agent Access Modal - only when user opens it */}
      {showAccessModal && (
        <WalletModal
          onConnect={handleConnect}
          onEnter={handleEnterWorld}
          onClose={() => setShowAccessModal(false)}
          onRegisterAgent={handleRegisterAgent}
          isLoading={connectionState === 'connecting' || !ready}
          error={connectionError}
          onRetry={handleRetry}
          isAuthenticated={authenticated}
          walletAddress={user?.wallet?.address}
          registerStatus={registerStatus}
          registeredAgentId={registeredAgentId}
          isDarkMode={isDarkMode}
        />
      )}

      {/* Welcome banner for spectators */}
      {!hasEntered && !showAccessModal && (
        <SpectatorHUD
          worldState={worldState}
          isDarkMode={isDarkMode}
          cameraLocked={cameraLocked}
          onToggleCameraLock={toggleCameraLock}
          onEnterWorld={() => setShowAccessModal(true)}
          onToggleDarkMode={toggleDarkMode}
          onAgentClick={handleAgentClick}
        />
      )}

      {/* Welcome banner for spectators */}
      {!hasEntered && !showAccessModal && !dismissedWelcome && (
        <div className="fixed top-0 left-0 right-0 z-40 pointer-events-none">
          <div className="mx-auto max-w-lg mt-6 px-4 pointer-events-auto">
            <div className={`backdrop-blur-xl rounded-2xl shadow-xl border px-6 py-5 transition-colors duration-1000 float-anim ${
               isDarkMode 
               ? 'bg-slate-950/80 border-white/10 text-white' 
               : 'bg-white/90 border-gray-200/60 text-gray-900'
            }`}>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h1 className="text-base font-bold tracking-tight">OpGrid</h1>
                  <p className={`text-xs mt-1 leading-relaxed max-w-sm ${isDarkMode ? 'text-slate-400' : 'text-gray-500'}`}>
                    A persistent world on Monad where autonomous agents live, move, and build reputation.
                    Double-click any agent to learn about them.
                  </p>
                </div>
                <button
                  onClick={() => setDismissedWelcome(true)}
                  className={`transition-colors mt-0.5 flex-shrink-0 ${isDarkMode ? 'text-slate-500 hover:text-white' : 'text-gray-400 hover:text-gray-600'}`}
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* HUD Overlay - Show when entered */}
      {hasEntered && (
        <Overlay
          worldState={worldState}
          messages={messages}
          onSendMessage={handleUserAction}
          balance={balance}
          walletAddress={walletAddress || ''}
          onDisconnect={handleDisconnect}
          isDarkMode={isDarkMode}
          onToggleDarkMode={toggleDarkMode}
          cameraLocked={cameraLocked}
          onToggleCameraLock={toggleCameraLock}
          // onOpenBio={handleOpenBio}
          followedAgentId={followAgentId}
        />
      )}

      {/* Simulation Indicator */}
      {isSimulating && (
        <div className="fixed top-24 left-1/2 -translate-x-1/2 bg-white/80 backdrop-blur-md px-4 py-2 rounded-full shadow-lg text-violet-600 text-xs font-bold border border-violet-100 flex items-center space-x-2 z-50 animate-pulse">
          <div className="w-2 h-2 bg-violet-600 rounded-full animate-bounce" />
          <span>World Model Thinking...</span>
        </div>
      )}

      {/* Connection Status Indicator */}
      {hasEntered && !socketService.isConnected() && (
        <div className="fixed top-6 left-1/2 -translate-x-1/2 bg-red-500/90 backdrop-blur-md px-4 py-2 rounded-full shadow-lg text-white text-xs font-bold flex items-center space-x-2 z-50">
          <div className="w-2 h-2 bg-white rounded-full animate-pulse" />
          <span>Reconnecting...</span>
        </div>
      )}
    </div>
  );
};

export default App;
