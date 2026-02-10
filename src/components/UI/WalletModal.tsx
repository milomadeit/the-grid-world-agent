
import React, { useState } from 'react';
import { Loader2, AlertCircle, RefreshCw, ChevronDown, ChevronUp, Link2, X, Info, Check, Zap, Wallet, ArrowRight } from 'lucide-react';

export interface ERC8004FormData {
  agentId: string;
  agentRegistry: string;
}

interface WalletModalProps {
  onConnect: () => void;
  onEnter: (erc8004: ERC8004FormData, bio?: string) => void;
  onClose: () => void;
  onRegisterAgent?: () => void;
  isLoading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  isAuthenticated?: boolean;
  walletAddress?: string;
  registerStatus?: 'idle' | 'pending' | 'success' | 'error';
  registeredAgentId?: string | null;
}

const DEFAULT_REGISTRY = 'eip155:143:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const IDENTITY_REGISTRY_ADDRESS = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';

const WalletModal: React.FC<WalletModalProps> = ({
  onConnect,
  onEnter,
  onClose,
  onRegisterAgent,
  isLoading = false,
  error = null,
  onRetry,
  isAuthenticated = false,
  walletAddress,
  registerStatus = 'idle',
  registeredAgentId = null
}) => {
  const [erc8004Tab, setErc8004Tab] = useState<'existing' | 'register'>('existing');
  const [erc8004AgentId, setErc8004AgentId] = useState('');
  const [bio, setBio] = useState('');
  const [showInfo, setShowInfo] = useState(false);

  // Auto-fill agentId when registration succeeds
  React.useEffect(() => {
    if (registeredAgentId) {
      setErc8004AgentId(registeredAgentId);
      setErc8004Tab('existing');
    }
  }, [registeredAgentId]);

  const handleEnter = () => {
    if (!erc8004AgentId.trim()) return;
    const erc8004: ERC8004FormData = {
      agentId: erc8004AgentId.trim(),
      agentRegistry: DEFAULT_REGISTRY
    };
    const bioText = bio.trim() || undefined;
    onEnter(erc8004, bioText);
  };

  const canEnter = isAuthenticated && erc8004AgentId.trim().length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-6" onClick={onClose}>
      <div className="bg-white w-full max-w-md rounded-3xl shadow-2xl overflow-hidden float-anim" onClick={(e) => e.stopPropagation()}>
        <div className="p-6 pb-0 relative">
          <button
            onClick={onClose}
            className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 transition-colors"
          >
            <X size={18} />
          </button>
          <h2 className="text-lg font-bold text-gray-900">Enter MonWorld</h2>
          <p className="text-xs text-gray-500 mt-1.5 leading-relaxed max-w-xs">
            MonWorld is the virtual world for on-chain agents. Connect your wallet and link your ERC-8004 agent identity to enter.
          </p>
        </div>

        <div className="p-6 space-y-4">

          {/* Error State */}
          {error && (
            <div className="flex items-start gap-3 p-4 bg-red-50 border border-red-100 rounded-2xl">
              <AlertCircle className="text-red-500 flex-shrink-0 mt-0.5" size={18} />
              <div className="flex-1">
                <p className="text-sm font-semibold text-red-700">Connection Failed</p>
                <p className="text-xs text-red-600 mt-1">{error}</p>
              </div>
            </div>
          )}

          {/* ─── STEP 1: Connect Wallet ─── */}
          <div className="border border-gray-100 rounded-2xl overflow-hidden">
            <div className="flex items-center gap-3 px-4 py-3">
              <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold ${
                isAuthenticated
                  ? 'bg-green-100 text-green-600'
                  : 'bg-violet-100 text-violet-600'
              }`}>
                {isAuthenticated ? <Check size={12} /> : '1'}
              </div>
              <div className="flex-1">
                <p className="text-xs font-semibold text-gray-700">Connect Wallet</p>
                {isAuthenticated && walletAddress ? (
                  <p className="text-[10px] text-green-600 font-mono mt-0.5">
                    {walletAddress.slice(0, 6)}...{walletAddress.slice(-4)}
                  </p>
                ) : (
                  <p className="text-[10px] text-gray-400 mt-0.5">Required to verify agent ownership</p>
                )}
              </div>
              {!isAuthenticated && (
                <button
                  onClick={onConnect}
                  className="px-3 py-1.5 bg-violet-600 hover:bg-violet-700 text-white text-xs font-medium rounded-lg transition-colors flex items-center gap-1.5"
                >
                  <Wallet size={12} />
                  Connect
                </button>
              )}
            </div>
          </div>

          {/* ─── STEP 2: Link Agent Identity ─── */}
          <div className={`border rounded-2xl overflow-hidden transition-opacity ${
            isAuthenticated ? 'border-gray-100 opacity-100' : 'border-gray-50 opacity-40 pointer-events-none'
          }`}>
            <div className="flex items-center gap-3 px-4 py-3">
              <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold ${
                erc8004AgentId.trim()
                  ? 'bg-green-100 text-green-600'
                  : 'bg-violet-100 text-violet-600'
              }`}>
                {erc8004AgentId.trim() ? <Check size={12} /> : '2'}
              </div>
              <div className="flex-1">
                <span className="flex items-center gap-1.5">
                  <p className="text-xs font-semibold text-gray-700">Agent Identity</p>
                  <button
                    onClick={() => setShowInfo(!showInfo)}
                    className="text-gray-400 hover:text-violet-500"
                  >
                    <Info size={11} />
                  </button>
                </span>
                <p className="text-[10px] text-gray-400 mt-0.5">ERC-8004 agent required to enter</p>
              </div>
            </div>

            {/* Info tooltip */}
            {showInfo && (
              <div className="mx-4 mb-3 p-3 bg-violet-50 border border-violet-100 rounded-xl text-[11px] text-violet-700 leading-relaxed">
                ERC-8004 is an on-chain agent registry on Monad. Your agent gets a verified identity and portable reputation that works across platforms.
                <a href="https://www.8004.org/learn" target="_blank" rel="noopener noreferrer" className="text-violet-600 underline ml-1">Learn more</a>
              </div>
            )}

            {isAuthenticated && (
              <div className="px-4 pb-4 space-y-3">
                {/* Two tabs */}
                <div className="flex rounded-xl overflow-hidden border border-gray-200">
                  <button
                    onClick={() => setErc8004Tab('existing')}
                    className={`flex-1 py-2 text-xs font-medium transition-colors ${
                      erc8004Tab === 'existing'
                        ? 'bg-violet-600 text-white'
                        : 'bg-white text-gray-500 hover:bg-gray-50'
                    }`}
                  >
                    I have an Agent ID
                  </button>
                  <button
                    onClick={() => setErc8004Tab('register')}
                    className={`flex-1 py-2 text-xs font-medium transition-colors ${
                      erc8004Tab === 'register'
                        ? 'bg-violet-600 text-white'
                        : 'bg-white text-gray-500 hover:bg-gray-50'
                    }`}
                  >
                    Register New
                  </button>
                </div>

                {erc8004Tab === 'existing' ? (
                  <div className="space-y-2">
                    <div>
                      <label className="text-xs text-gray-500 mb-1 block">Agent Token ID</label>
                      <input
                        type="text"
                        value={erc8004AgentId}
                        onChange={(e) => setErc8004AgentId(e.target.value)}
                        placeholder="e.g. 42"
                        className="w-full px-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-violet-400 focus:ring-1 focus:ring-violet-400"
                      />
                    </div>
                    <p className="text-[10px] text-gray-400 leading-relaxed">
                      Enter your ERC-8004 token ID. Server will verify your wallet owns this agent on Monad.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <p className="text-xs text-gray-500 leading-relaxed">
                      Mint a new agent identity on the Monad IdentityRegistry. This creates an ERC-721 NFT that represents your agent on-chain.
                    </p>

                    {registerStatus === 'success' && registeredAgentId ? (
                      <div className="flex items-center gap-2 p-3 bg-green-50 border border-green-100 rounded-xl">
                        <Check size={16} className="text-green-600" />
                        <span className="text-xs text-green-700 font-medium">
                          Agent #{registeredAgentId} registered on Monad
                        </span>
                      </div>
                    ) : registerStatus === 'error' ? (
                      <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-100 rounded-xl">
                        <AlertCircle size={16} className="text-red-500" />
                        <span className="text-xs text-red-600">Registration failed. Please try again.</span>
                      </div>
                    ) : (
                      <button
                        onClick={onRegisterAgent}
                        disabled={registerStatus === 'pending'}
                        className={`w-full py-3 rounded-xl text-sm font-medium flex items-center justify-center gap-2 transition-all
                          ${registerStatus === 'pending'
                            ? 'bg-amber-100 text-amber-700 cursor-not-allowed'
                            : 'bg-amber-500 hover:bg-amber-600 text-white hover:scale-[1.02] active:scale-[0.98]'
                          }`}
                      >
                        {registerStatus === 'pending' ? (
                          <>
                            <Loader2 size={16} className="animate-spin" />
                            Confirming on Monad...
                          </>
                        ) : (
                          <>
                            <Zap size={16} />
                            Register Agent on Monad
                          </>
                        )}
                      </button>
                    )}

                    <p className="text-[10px] text-gray-400 leading-relaxed">
                      Contract: <span className="font-mono">{IDENTITY_REGISTRY_ADDRESS.slice(0, 10)}...{IDENTITY_REGISTRY_ADDRESS.slice(-6)}</span> on Monad Mainnet
                    </p>
                  </div>
                )}

                {/* Bio input */}
                <div className="pt-1">
                  <label className="text-xs text-gray-500 mb-1 block">Bio (optional, 280 chars)</label>
                  <textarea
                    value={bio}
                    onChange={(e) => setBio(e.target.value.slice(0, 280))}
                    placeholder="Describe your agent..."
                    rows={2}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-violet-400 focus:ring-1 focus:ring-violet-400 resize-none"
                  />
                  <p className="text-[10px] text-gray-400 text-right">{bio.length}/280</p>
                </div>
              </div>
            )}
          </div>

          {/* ─── STEP 3: Enter World ─── */}
          {error ? (
            <button
              onClick={onRetry}
              className="w-full bg-gray-100 hover:bg-gray-200 text-gray-700 font-bold py-4 rounded-2xl transition-all transform hover:scale-[1.02] active:scale-[0.98] flex items-center justify-center gap-2"
            >
              <RefreshCw size={18} />
              <span>Try Again</span>
            </button>
          ) : (
            <button
              onClick={handleEnter}
              disabled={!canEnter || isLoading}
              className={`w-full font-bold py-4 rounded-2xl shadow-lg transition-all transform flex items-center justify-center gap-2
                ${!canEnter
                  ? 'bg-gray-100 text-gray-400 cursor-not-allowed shadow-none'
                  : isLoading
                    ? 'bg-violet-400 text-white cursor-not-allowed'
                    : 'bg-violet-600 hover:bg-violet-700 text-white shadow-violet-200 hover:scale-[1.02] active:scale-[0.98]'
                }`}
            >
              {isLoading ? (
                <>
                  <Loader2 size={18} className="animate-spin" />
                  <span>Verifying & Entering...</span>
                </>
              ) : (
                <>
                  <ArrowRight size={18} />
                  <span>Enter World</span>
                </>
              )}
            </button>
          )}

          <p className="text-center text-[10px] text-gray-400">
            Built on <a href="https://monad.xyz" target="_blank" rel="noopener noreferrer" className="hover:text-violet-500 underline">Monad</a>
            {' · '}
            <a href="https://www.8004.org" target="_blank" rel="noopener noreferrer" className="hover:text-violet-500 underline">ERC-8004</a>
          </p>
        </div>
      </div>
    </div>
  );
};

export default WalletModal;
