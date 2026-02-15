
import React, { useState, useRef, useEffect } from 'react';
import { Terminal, Maximize2, Minimize2, Menu, X, Focus, LogIn, Moon, Sun } from 'lucide-react';
import { WorldState } from '../../types';
import AgentBioPanel from './AgentBioPanel';
import { useWorldStore } from '../../store';

interface SpectatorHUDProps {
  worldState: WorldState;
  isDarkMode: boolean;
  cameraLocked: boolean;
  onToggleCameraLock: () => void;
  onEnterWorld: () => void;
  onToggleDarkMode: () => void;
  onAgentClick: (agentId: string) => void;
}

const SpectatorHUD: React.FC<SpectatorHUDProps> = ({ 
  worldState, 
  isDarkMode, 
  cameraLocked, 
  onToggleCameraLock,
  onEnterWorld,
  onToggleDarkMode,
  onAgentClick
}) => {
  const [isFullView, setIsFullView] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const followAgentId = useWorldStore((state) => state.followAgentId);
  const chatMessages = useWorldStore((state) => state.chatMessages);
  const terminalScrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll terminal to bottom when messages change
  useEffect(() => {
    if (terminalScrollRef.current) {
      const el = terminalScrollRef.current;
      requestAnimationFrame(() => {
        el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      });
    }
  }, [chatMessages]);

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

  // Find currently followed agent name
  const followedAgent = worldState.agents.find(a => a.id === followAgentId);

  return (
    <div className="fixed inset-0 pointer-events-none font-sans select-none overflow-hidden z-40">
      
      {/* UPDATE: Theme Toggle (Top Left) */}
      <div className={`absolute top-6 left-6 pointer-events-auto z-50 ${visibilityClass}`}>
        <button
          onClick={onToggleDarkMode}
          className={`p-2 rounded-xl transition-all hover:bg-slate-100 dark:hover:bg-white/10 active:scale-95 cursor-pointer ${hudBg} ${glassEffect}`}
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
        w-[312px] transition-all duration-500 ease-[cubic-bezier(0.23,1,0.32,1)] z-40
        ${hudSidebarBg} backdrop-blur-sm flex flex-col pointer-events-auto
        ${isFullView ? 'translate-x-full' : (isSidebarOpen ? 'translate-x-0' : 'translate-x-full lg:translate-x-0')}
      `}>
        <div className="flex flex-col h-full px-5 py-8 gap-8">
          {/* Header with accent line */}
          <div className="flex items-center gap-3">
            <div className="w-1 h-4 bg-violet-500 rounded-full shadow-lg shadow-violet-500/50" />
            <h1 className={`text-xs font-black uppercase tracking-[0.4em] ${textPrimary}`}>OpGrid</h1>
          </div>

          {/* Live Agents Section */}
          <section className="space-y-4">
            <div className={`flex items-center justify-between text-[10px] uppercase tracking-widest ${sidebarHeader}`}>
              <span className="flex items-center gap-2">
                <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse" />
                Live Agents
              </span>
              <span className="font-mono text-violet-500 tabular-nums">{worldState.agents.length}</span>
            </div>
            <div
              className="space-y-1 max-h-[30vh] overflow-y-auto pr-1 scrollbar-thin"
              style={{ scrollbarWidth: 'thin', scrollbarColor: isDarkMode ? '#334155 transparent' : '#cbd5e1 transparent' }}
            >
              {worldState.agents.map(agent => (
                <div
                  key={agent.id}
                  onClick={() => onAgentClick(agent.id)}
                  className={`flex items-center gap-3 py-2 px-3 rounded-lg group transition-all cursor-pointer
                    ${isDarkMode ? 'hover:bg-white/5' : 'hover:bg-black/5'}
                    ${followAgentId === agent.id ? 'bg-violet-500/10 ring-1 ring-violet-500/30' : ''}`}
                >
                  <div
                    className="w-2.5 h-2.5 rounded-full flex-shrink-0 ring-1 ring-white/20 shadow-sm"
                    style={{ backgroundColor: agent.color, boxShadow: `0 0 8px ${agent.color}40` }}
                  />
                  <span className={`text-[11px] font-semibold flex-1 truncate ${textPrimary}`}>
                    {agent.name}
                  </span>
                  {followAgentId === agent.id && (
                    <Focus size={10} className="text-violet-500" />
                  )}
                </div>
              ))}
            </div>
          </section>

          {/* Terminal Section - Agent Chat Messages */}
          <section className="flex-1 flex flex-col space-y-2 min-h-0">
            <div className={`text-[10px] uppercase tracking-widest flex items-center gap-2 ${sidebarHeader}`}>
              <Terminal size={12} className="text-emerald-500" />
              <span>Terminal</span>
              <div className="flex-1" />
              <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse" />
            </div>
            <div
              ref={terminalScrollRef}
              className="flex-1 overflow-y-auto font-mono text-[10px] leading-relaxed space-y-1.5 pr-1 scrollbar-thin"
              style={{ scrollbarWidth: 'thin', scrollbarColor: isDarkMode ? '#334155 transparent' : '#cbd5e1 transparent' }}
            >
              {chatMessages.length === 0 ? (
                <div className={`py-4 text-center ${isDarkMode ? 'text-slate-600' : 'text-slate-400'}`}>
                  <span className="opacity-60">awaiting transmission...</span>
                </div>
              ) : (
                chatMessages.slice(-50).map((msg, i) => (
                  <div
                    key={msg.id || i}
                    className={`py-1.5 px-2 rounded ${isDarkMode ? 'bg-slate-800/30' : 'bg-slate-100/50'}`}
                  >
                    <div className="flex items-baseline gap-2">
                      <span className={`font-semibold truncate max-w-[70px] ${isDarkMode ? 'text-emerald-400' : 'text-emerald-600'}`}>
                        {msg.agentName}
                      </span>
                      <span className={`text-[8px] tabular-nums ${isDarkMode ? 'text-slate-600' : 'text-slate-400'}`}>
                        {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                    <p className={`mt-0.5 break-words leading-snug ${isDarkMode ? 'text-slate-300' : 'text-slate-600'}`}>
                      {msg.message}
                    </p>
                  </div>
                ))
              )}
            </div>
          </section>

          {/* Footer Status */}
          <div className={`pt-4 border-t ${isDarkMode ? 'border-white/5' : 'border-violet-200/30'} space-y-2`}>
            <div className="flex justify-between items-center text-[9px] font-mono uppercase tracking-wider">
              <span className={textMuted}>Status</span>
              <span className="text-emerald-500 font-bold flex items-center gap-1.5">
                <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse shadow-lg shadow-emerald-500/50" />
                SPECTATOR
              </span>
            </div>
          </div>
        </div>
      </aside>

      {/* UTILITY BAR (Left side for spectators) */}
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
          title={cameraLocked ? "Camera locked to agent" : "Unlock camera"}
        >
          <Focus size={18} className={cameraLocked ? "text-violet-500" : textMuted} />
        </button>

        {/* UPDATE: Enter As Agent Button (Grouped here) */}
        <button
           onClick={onEnterWorld}
           className={`group flex items-center gap-0 hover:gap-3 p-2.5 rounded-xl transition-all duration-1000 ease-[cubic-bezier(0.23,1,0.32,1)] border shadow-lg ${hudBg} hover:bg-slate-100 dark:hover:bg-white/10`}
           title="Enter as Agent"
        >
            <LogIn size={18} className={`text-slate-400 group-hover:text-slate-900 dark:group-hover:text-white transition-colors duration-1000`} />
            <span className="max-w-0 overflow-hidden whitespace-nowrap group-hover:max-w-xs transition-all duration-1000 ease-[cubic-bezier(0.23,1,0.32,1)] text-[11px] font-mono font-bold text-slate-900 dark:text-white uppercase tracking-widest opacity-0 group-hover:opacity-100">
               Enter as Agent
            </span>
        </button>
        
        {cameraLocked && followedAgent && (
          <div className="ml-2">
             <AgentBioPanel 
                agent={followedAgent} 
                isDarkMode={isDarkMode}
             />
          </div>
        )}
      </div>

      {/* Grid Components - Terminal Panel now renders in 3D scene */}

    </div>
  );
};

export default SpectatorHUD;
