import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { X, Shield, Star, ChevronUp } from 'lucide-react';
import type { Agent } from '../../types';
import { truncateAddress } from '../../utils/address';

interface AgentBioPanelProps {
  agent: Agent | null | undefined;
  isDarkMode: boolean;
}

const AgentBioPanel: React.FC<AgentBioPanelProps> = ({ agent, isDarkMode }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Collapse when agent changes to keep UI clean
  useEffect(() => {
    setIsExpanded(false);
  }, [agent?.id]);

  const close = useCallback(() => setIsExpanded(false), []);
  const open = useCallback(() => setIsExpanded(true), []);

  // Close on outside click
  useEffect(() => {
    if (!isExpanded) return;

    const handlePointerDown = (event: PointerEvent) => {
      const el = containerRef.current;
      if (!el) return;
      if (!el.contains(event.target as Node)) close();
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [isExpanded, close]);

  // Close on Escape
  useEffect(() => {
    if (!isExpanded) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isExpanded, close]);

  if (!agent) return null;

  const hasIdentity = !!agent.erc8004AgentId;
  const reputation = agent.reputationScore ?? 0;

  const glassClass = useMemo(
    () =>
      isDarkMode
        ? 'bg-slate-950/90 border-white/10 text-white'
        : 'bg-white/90 border-slate-200/60 text-slate-800',
    [isDarkMode]
  );

  const statusPillClass =
    agent.status === 'moving'
      ? 'bg-indigo-500/10 text-indigo-500 border-indigo-500/20'
      : 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20';

  // Animation constants
  const collapsedWidth = 'w-[180px]';
  const expandedWidth = 'w-80';
  const collapsedHeight = 'h-[46px]';
  const expandedHeight = 'h-96';

  const panelClassName = useMemo(() => {
    const base = `
      absolute bottom-0 left-0
      transition-all duration-300 ease-[cubic-bezier(0.23,1,0.32,1)]
      border shadow-lg backdrop-blur-xl overflow-hidden
      ${glassClass}
      z-50
    `;
    const expanded = `${expandedWidth} ${expandedHeight} rounded-3xl`;
    const collapsed = `${collapsedWidth} ${collapsedHeight} rounded-xl hover:scale-[1.02] active:scale-[0.98] cursor-pointer`;

    return `${base} ${isExpanded ? expanded : collapsed}`;
  }, [glassClass, isExpanded]);

  const panelStyle = useMemo(() => {
    if (!isExpanded) return undefined;
    return { boxShadow: '0 20px 40px -10px rgba(0,0,0,0.3)' } as React.CSSProperties;
  }, [isExpanded]);

  return (
    <div className="relative" ref={containerRef}>
      {/* Invisible placeholder to keep the row layout stable */}
      <div
        className={`transition-all duration-300 ${collapsedHeight} ${collapsedWidth} opacity-0 pointer-events-none`}
      />

      {/* Animated Panel */}
      <div className={panelClassName} style={panelStyle}>
        {/* COLLAPSED CONTENT (Badge) */}
        <button
          type="button"
          onClick={() => !isExpanded && open()}
          className={`
            absolute inset-0 flex items-center gap-3 px-4 py-3 text-left
            transition-opacity duration-200
            ${isExpanded ? 'opacity-0 pointer-events-none' : 'opacity-100'}
          `}
          aria-label="Open agent panel"
        >
          <div className="relative shrink-0">
            <div
              className="w-2.5 h-2.5 rounded-full ring-2 ring-white/20 shadow-[0_0_10px_rgba(0,0,0,0.2)]"
              style={{ backgroundColor: agent.color, boxShadow: `0 0 12px ${agent.color}80` }}
            />
            <div
              className="absolute inset-0 rounded-full animate-ping opacity-20"
              style={{ backgroundColor: agent.color }}
            />
          </div>

          <div className="flex flex-col items-start min-w-0">
            <span className="text-[10px] font-bold uppercase tracking-wider opacity-60 leading-none mb-0.5">
              Following
            </span>
            <span className="text-sm font-bold leading-none truncate w-full">
              {truncateAddress(agent.name)}
            </span>
          </div>

          <div className="ml-auto opacity-40" aria-hidden="true">
            <ChevronUp size={14} />
          </div>
        </button>

        {/* EXPANDED CONTENT (Card) */}
        <div
          className={`
            absolute inset-0 flex flex-col
            transition-all duration-300 delay-100
            ${isExpanded ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4 pointer-events-none'}
          `}
        >
          {/* Close Button */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              close();
            }}
            className="absolute top-3 right-3 p-1.5 rounded-full hover:bg-black/10 dark:hover:bg-white/10 transition-colors z-20 cursor-pointer"
            aria-label="Close agent panel"
          >
            <X size={16} className="opacity-60" />
          </button>

          {/* Header (REAL layout container so content can be vertically centered) */}
          <div className="relative shrink-0">
            {/* Header Color Bar */}
            <div
              className="absolute inset-x-0 top-0 h-24 opacity-20 pointer-events-none rounded-t-[inherit]"
              style={{ backgroundColor: agent.color }}
            />

            {/* Header Content */}
            <div className="relative h-24 flex items-center px-6 pr-14">
              <div className="flex items-center gap-4 min-w-0">
                <div
                  className="w-16 h-16 rounded-2xl shadow-xl flex items-center justify-center text-3xl font-black text-white shrink-0 border-4 border-white/20"
                  style={{ backgroundColor: agent.color, textShadow: '0 2px 4px rgba(0,0,0,0.2)' }}
                >
                  {agent.name.charAt(0).toUpperCase()}
                </div>

                <div className="min-w-0">
                  <h2 className="text-xl font-black leading-tight tracking-tight truncate">
                    {truncateAddress(agent.name)}
                  </h2>

                  <div className="flex items-center gap-2 mt-1">
                    <span
                      className={`
                        inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wide border
                        ${statusPillClass}
                      `}
                    >
                      {agent.status === 'moving' ? 'Moving' : 'Idle'}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Body */}
          <div className="relative flex-1 flex flex-col h-full overflow-hidden p-5">
            {/* Bio Section */}
            <div
              className={`
                p-3 rounded-xl border mb-4 text-xs leading-relaxed font-medium overflow-y-auto scrollbar-hide grow sm:grow-0
                ${isDarkMode ? 'bg-black/20 border-white/5 text-slate-300' : 'bg-slate-50 border-slate-100 text-slate-600'}
              `}
            >
              {agent.bio ? `"${agent.bio}"` : <span className="italic opacity-50">No bio available.</span>}
            </div>

            {/* Stats / Info */}
            <div className="space-y-2 mt-auto shrink-0">
              {/* Identity Status */}
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2 opacity-70">
                  <Shield size={14} />
                  <span>Identity</span>
                </div>

                {hasIdentity ? (
                  <span className="flex items-center gap-1.5 text-amber-500 font-bold">
                    Verified{' '}
                    <span className="px-1 py-px rounded bg-amber-500/10 border border-amber-500/20 text-[9px]">
                      #{agent.erc8004AgentId}
                    </span>
                  </span>
                ) : (
                  <span className="opacity-50">Unverified</span>
                )}
              </div>

              {/* Reputation */}
              {hasIdentity && (
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2 opacity-70">
                    <Star size={14} />
                    <span>Reputation</span>
                  </div>
                  <span className="font-mono font-bold">{reputation}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AgentBioPanel;
