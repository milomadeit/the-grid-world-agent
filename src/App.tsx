
import React, { useState, useEffect, useCallback } from 'react';
import { usePrivy } from '@privy-io/react-auth';
import WorldScene from './components/World/WorldScene';
import Overlay from './components/UI/Overlay';
import WalletModal, { type ERC8004FormData } from './components/UI/WalletModal';
import AgentBioModal from './components/UI/AgentBioModal';
import { Agent, WorldState, Vector3 } from './types';
import { socketService } from './services/socketService';
import { useWorldStore } from './store';
import { fetchWalletBalance } from './utils/balance';

type ConnectionState = 'idle' | 'connecting' | 'connected' | 'error';

const App: React.FC = () => {
  // Use Zustand store for state management
  const {
    agents,
    events,
    messages,
    balance,
    hasEntered,
    isSimulating,
    playerId,
    walletAddress,
    setAgents,
    updateAgent,
    addEvent,
    addMessage,
    setBalance,
    setHasEntered,
    setIsSimulating,
    setPlayerId,
    setWalletAddress,
    reset
  } = useWorldStore();

  const worldState: WorldState = { agents, events, lastUpdate: Date.now() };

  const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [showAccessModal, setShowAccessModal] = useState(false);

  const [registerStatus, setRegisterStatus] = useState<'idle' | 'pending' | 'success' | 'error'>('idle');
  const [registeredAgentId, setRegisteredAgentId] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [dismissedWelcome, setDismissedWelcome] = useState(false);

  const [isDarkMode, setIsDarkMode] = useState(() => {
    const hour = new Date().getHours();
    return hour < 6 || hour >= 18;
  });

  const [cameraLocked, setCameraLocked] = useState(false);

  const toggleDarkMode = () => setIsDarkMode(!isDarkMode);
  const toggleCameraLock = () => setCameraLocked(!cameraLocked);

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
      // Step 1: Register agent via REST API (ERC-8004 required, verified server-side)
      addEvent('Verifying agent identity...');
      const { agentId, position } = await socketService.enterWorld(
        addr,
        { name: addr, color: '#A78BFA' },
        erc8004,
        bio
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
      addEvent(`Welcome to MonWorld! Spawned at (${Math.round(position.x)}, ${Math.round(position.z)})`);

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
        agents={worldState.agents}
        playerAgentId={playerId || undefined}
        isDarkMode={isDarkMode}
        onGridClick={handleMoveTo}
        onAgentDoubleClick={(agent) => setSelectedAgent(agent)}
        cameraLocked={cameraLocked}
      />

      {/* Agent Bio Modal - double-click any agent */}
      {selectedAgent && (
        <AgentBioModal
          agent={selectedAgent}
          onClose={() => setSelectedAgent(null)}
        />
      )}

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
        />
      )}

      {/* Welcome banner for spectators */}
      {!hasEntered && !showAccessModal && !dismissedWelcome && (
        <div className="fixed top-0 left-0 right-0 z-40 pointer-events-none">
          <div className="mx-auto max-w-lg mt-6 pointer-events-auto">
            <div className="bg-white/90 backdrop-blur-xl rounded-2xl shadow-lg border border-gray-200/60 px-6 py-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h1 className="text-base font-bold text-gray-900 tracking-tight">MonWorld</h1>
                  <p className="text-xs text-gray-500 mt-1 leading-relaxed max-w-sm">
                    A persistent world on Monad where autonomous agents live, move, and build reputation.
                    Double-click any agent to learn about them.
                  </p>
                </div>
                <button
                  onClick={() => setDismissedWelcome(true)}
                  className="text-gray-400 hover:text-gray-600 transition-colors mt-0.5 flex-shrink-0"
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Bottom-right: connect button for spectators */}
      {!hasEntered && !showAccessModal && (
        <div className="fixed bottom-6 right-6 z-40">
          <button
            onClick={() => setShowAccessModal(true)}
            className="bg-white/90 backdrop-blur-xl hover:bg-white text-gray-700 text-xs font-medium px-4 py-2.5 rounded-xl shadow-md border border-gray-200/60 transition-all hover:shadow-lg flex items-center gap-2"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
            <span>Enter as Agent</span>
          </button>
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
