
import React, { useState, useRef, useEffect } from 'react';
import { Terminal, Users, Map, Send, Wallet, Moon, Sun, Maximize2, Minimize2, Menu, X, Focus, Copy, Check, LogOut, ChevronDown } from 'lucide-react';
import { WorldState, WorldMessage } from '../../types';
import TerminalPanel from './TerminalPanel';
import ObjectInfoModal from './ObjectInfoModal';
import { useWorldStore } from '../../store';

interface OverlayProps {
  worldState: WorldState;
  messages: WorldMessage[];
  onSendMessage: (msg: string) => void;
  balance: string;
  walletAddress: string;
  onDisconnect: () => void;
  isDarkMode: boolean;
  onToggleDarkMode: () => void;
  cameraLocked?: boolean;
  onToggleCameraLock?: () => void;
}

const Overlay: React.FC<OverlayProps> = ({ worldState, messages, onSendMessage, balance, walletAddress, onDisconnect, isDarkMode, onToggleDarkMode, cameraLocked = false, onToggleCameraLock }) => {
  const [input, setInput] = useState('');
  const [isFullView, setIsFullView] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isWalletOpen, setIsWalletOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const walletDropdownRef = useRef<HTMLDivElement>(null);
  const terminalOpen = useWorldStore((state) => state.terminalOpen);

  // Close wallet dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (walletDropdownRef.current && !walletDropdownRef.current.contains(event.target as Node)) {
        setIsWalletOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const truncateAddress = (address: string) => {
    if (!address) return '';
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  };

  const copyAddress = async () => {
    if (walletAddress) {
      await navigator.clipboard.writeText(walletAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim()) {
      onSendMessage(input);
      setInput('');
      if (window.innerWidth < 1024) setIsSidebarOpen(false);
    }
  };

  const hudBg = isDarkMode
    ? 'bg-slate-950/60 border-white/10'
    : 'bg-white/70 border-slate-200/50';

  const glassEffect = 'backdrop-blur-xl border shadow-lg';
  const textPrimary = isDarkMode ? 'text-slate-100' : 'text-slate-800';
  const textMuted = isDarkMode ? 'text-slate-400' : 'text-slate-500';
  const sidebarHeader = isDarkMode ? 'text-slate-500' : 'text-slate-400 font-semibold';

  // HUD-specific styles - transparent with accent borders
  const hudSidebarBg = isDarkMode
    ? 'bg-gradient-to-b from-slate-950/40 via-slate-900/30 to-slate-950/40 border-l border-violet-500/20'
    : 'bg-gradient-to-b from-white/30 via-white/20 to-white/30 border-l border-violet-400/30';
  
  const visibilityClass = isFullView ? 'opacity-0 pointer-events-none' : 'opacity-100 pointer-events-auto';

  return (
    <div className="fixed inset-0 pointer-events-none font-sans select-none overflow-hidden z-40">
      
      {/* TOP HUD CONTROLS */}
      <div className={`absolute top-6 left-6 flex items-center gap-2 transition-all duration-500 z-50 ${visibilityClass}`}>
        {/* Wallet Balance Dropdown */}
        <div className="relative" ref={walletDropdownRef}>
          <button
            onClick={() => setIsWalletOpen(!isWalletOpen)}
            className={`flex items-center gap-2 px-3 py-2 rounded-xl ${hudBg} ${glassEffect} pointer-events-auto cursor-pointer transition-all hover:scale-[1.02] active:scale-[0.98]`}
          >
            <Wallet className="text-violet-600 w-4 h-4" />
            <span className={`font-mono text-[11px] font-black tracking-tight ${textPrimary}`}>{balance} MON</span>
            <ChevronDown size={14} className={`${textMuted} transition-transform ${isWalletOpen ? 'rotate-180' : ''}`} />
          </button>

          {/* Dropdown Menu */}
          {isWalletOpen && (
            <div className={`absolute top-full left-0 mt-2 w-56 rounded-xl ${hudBg} ${glassEffect} pointer-events-auto overflow-hidden`}>
              {/* Wallet Address */}
              <button
                onClick={copyAddress}
                className={`w-full flex items-center justify-between gap-2 px-4 py-3 transition-all ${isDarkMode ? 'hover:bg-white/5' : 'hover:bg-black/5'}`}
              >
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 bg-violet-100 rounded-lg flex items-center justify-center">
                    <span className="text-violet-600 text-[10px] font-bold">0x</span>
                  </div>
                  <span className={`font-mono text-xs ${textPrimary}`}>{truncateAddress(walletAddress)}</span>
                </div>
                {copied ? (
                  <Check size={14} className="text-emerald-500" />
                ) : (
                  <Copy size={14} className={textMuted} />
                )}
              </button>

              {/* Divider */}
              <div className={`border-t ${isDarkMode ? 'border-white/10' : 'border-black/10'}`} />

              {/* Disconnect Button */}
              <button
                onClick={() => {
                  setIsWalletOpen(false);
                  onDisconnect();
                }}
                className={`w-full flex items-center gap-2 px-4 py-3 transition-all text-red-500 ${isDarkMode ? 'hover:bg-red-500/10' : 'hover:bg-red-50'}`}
              >
                <LogOut size={14} />
                <span className="text-xs font-semibold">Disconnect</span>
              </button>
            </div>
          )}
        </div>

        <button
          onClick={onToggleDarkMode}
          className={`p-2 rounded-xl transition-all hover:bg-slate-100 dark:hover:bg-white/10 active:scale-95 cursor-pointer pointer-events-auto ${hudBg} ${glassEffect}`}
        >
          {isDarkMode ? <Moon size={16} className="text-violet-400" /> : <Sun size={16} className="text-amber-500" />}
        </button>
      </div>

      {/* MOBILE HUD TOGGLE */}
      {!isFullView && (
        <div className="absolute top-6 right-6 lg:hidden pointer-events-auto z-50">
          <button 
            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            className={`p-2 rounded-xl transition-all ${hudBg} ${glassEffect}`}
          >
            {isSidebarOpen ? <X size={20} className="text-violet-500" /> : <Menu size={20} className="text-violet-500" />}
          </button>
        </div>
      )}

      {/* HUD SIDEBAR - Transparent with accent lines */}
      <aside className={`
        fixed top-0 right-0 bottom-0
        w-64 transition-all duration-500 ease-[cubic-bezier(0.23,1,0.32,1)] z-40
        ${hudSidebarBg} backdrop-blur-sm flex flex-col pointer-events-auto
        ${isFullView ? 'translate-x-full' : (isSidebarOpen ? 'translate-x-0' : 'translate-x-full lg:translate-x-0')}
      `}>
        <div className="flex flex-col h-full px-5 py-8 gap-8">
          {/* Header with accent line */}
          <div className="flex items-center gap-3">
            <div className="w-1 h-4 bg-violet-500 rounded-full shadow-lg shadow-violet-500/50" />
            <h1 className={`text-xs font-black uppercase tracking-[0.4em] ${textPrimary}`}>MonWorld</h1>
          </div>

          {/* Live Entities Section */}
          <section className="space-y-4">
            <div className={`flex items-center justify-between text-[10px] uppercase tracking-widest ${sidebarHeader}`}>
              <span className="flex items-center gap-2">
                <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse" />
                Live Entities
              </span>
              <span className="font-mono text-violet-500 tabular-nums">{worldState.agents.length}</span>
            </div>
            <div className="space-y-2 max-h-[28vh] overflow-y-auto scrollbar-hide">
              {worldState.agents.map(agent => (
                <div
                  key={agent.id}
                  className={`flex items-center gap-3 py-2 px-3 rounded-lg group transition-all
                    ${isDarkMode ? 'hover:bg-white/5' : 'hover:bg-black/5'}`}
                >
                  <div
                    className="w-2.5 h-2.5 rounded-full flex-shrink-0 ring-1 ring-white/20 shadow-sm"
                    style={{ backgroundColor: agent.color, boxShadow: `0 0 8px ${agent.color}40` }}
                  />
                  <span className={`text-[11px] font-semibold flex-1 truncate ${textPrimary}`}>
                    {agent.name}
                  </span>
                  <span className={`text-[10px] font-mono tabular-nums flex-shrink-0 ${textMuted}`}>
                    {Math.round(agent.position.x)}, {Math.round(agent.position.z)}
                  </span>
                </div>
              ))}
            </div>
          </section>

          {/* Kernel Output Section */}
          <section className="flex-1 flex flex-col space-y-3 min-h-0">
            <div className={`text-[10px] uppercase tracking-widest flex items-center gap-2 ${sidebarHeader}`}>
              <Terminal size={12} className="text-violet-500" />
              <span>Kernel Output</span>
            </div>
            <div className={`flex-1 overflow-y-auto font-mono text-[10px] leading-relaxed space-y-3 scrollbar-hide
              border-l ${isDarkMode ? 'border-violet-500/20' : 'border-violet-400/30'} pl-4`}>
              {worldState.events.slice().reverse().map((event, i) => (
                <div key={i} className={`flex gap-2 ${i === 0 ? 'opacity-100' : 'opacity-60'}`}>
                  <span className="text-violet-500 shrink-0">&gt;</span>
                  <span className={`break-words ${isDarkMode ? 'text-slate-300' : 'text-slate-600'}`}>{event}</span>
                </div>
              ))}
            </div>
          </section>

          {/* Footer Status */}
          <div className={`pt-4 border-t ${isDarkMode ? 'border-white/5' : 'border-violet-200/30'} space-y-2`}>
            <div className="flex justify-between items-center text-[9px] font-mono uppercase tracking-wider">
              <span className={textMuted}>Status</span>
              <span className="text-emerald-500 font-bold flex items-center gap-1.5">
                <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse shadow-lg shadow-emerald-500/50" />
                Online
              </span>
            </div>
            <div className={`flex justify-between text-[9px] font-mono ${textMuted} opacity-50`}>
              <span>Build</span>
              <span>v0.2.0-beta</span>
            </div>
          </div>
        </div>
      </aside>

      {/* UTILITY BAR */}
      <div className="absolute bottom-6 left-6 pointer-events-auto z-40 flex items-center gap-2">
        <button
          onClick={() => setIsFullView(!isFullView)}
          className={`p-2.5 rounded-xl transition-all border shadow-lg hover:bg-slate-50 dark:hover:bg-white/5 ${hudBg}`}
        >
          {isFullView ? <Minimize2 size={18} className="text-violet-500" /> : <Maximize2 size={18} className={textMuted} />}
        </button>

        {/* Camera Lock Toggle */}
        <button
          onClick={onToggleCameraLock}
          className={`p-2.5 rounded-xl transition-all border shadow-lg hover:bg-slate-50 dark:hover:bg-white/5 ${hudBg} ${cameraLocked ? 'bg-violet-600/10' : ''}`}
          title={cameraLocked ? "Camera locked to player" : "Click to lock camera to player"}
        >
          <Focus size={18} className={cameraLocked ? "text-violet-500" : textMuted} />
        </button>
      </div>

      <div className={`absolute bottom-8 left-1/2 -translate-x-1/2 w-full max-w-sm px-6 pointer-events-auto z-50 transition-all duration-500`}>
        <div className={`rounded-2xl ${hudBg} ${glassEffect} overflow-hidden flex items-center min-h-[56px] px-2`}>
          <form onSubmit={handleSubmit} className="flex items-center w-full">
            <input 
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Prompt to explore..."
              className={`flex-1 bg-transparent px-4 py-4 text-[13px] font-bold tracking-tight focus:outline-none transition-all ${isDarkMode ? 'text-white placeholder-slate-700' : 'text-slate-900 placeholder-slate-400'}`}
            />
            <button 
              type="submit" 
              className={`p-2.5 rounded-xl transition-all ${
                input.trim() 
                  ? 'bg-violet-600 text-white shadow-xl shadow-violet-500/40 opacity-100 scale-100' 
                  : 'text-slate-400 opacity-0 pointer-events-none scale-90'
              }`}
              disabled={!input.trim()}
            >
              <Send size={16} />
            </button>
          </form>
        </div>
      </div>

      {/* Grid Components */}
      <ObjectInfoModal />

      {/* Terminal Panel - toggled by clicking Terminal3D in the 3D scene */}
      {!isFullView && terminalOpen && (
        <div className="pointer-events-auto z-40">
           <TerminalPanel />
        </div>
      )}

    </div>
  );
};

export default Overlay;
