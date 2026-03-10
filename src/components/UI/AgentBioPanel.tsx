import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { X, Shield, Star, ChevronUp, Edit2, Save, Loader2, Copy, Check, ExternalLink } from 'lucide-react';
import type { Agent } from '../../types';
import { truncateAddress } from '../../utils/address';
import { useWorldStore } from '../../store';
import { socketService } from '../../services/socketService';

const SERVER_URL = import.meta.env.VITE_SERVER_URL ||
  (typeof window !== 'undefined' && !window.location.hostname.includes('localhost')
    ? window.location.origin
    : 'http://localhost:4101');

interface AgentBioPanelProps {
  agent: Agent | null | undefined;
  isDarkMode: boolean;
}

interface ReferralSummary {
  referralCode: string | null;
  referralCount: number;
  creditsEarned: number;
}

const AgentBioPanel: React.FC<AgentBioPanelProps> = ({ agent, isDarkMode }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const playerId = useWorldStore(state => state.playerId);
  const updateAgent = useWorldStore(state => state.updateAgent);
  const isOwner = agent?.id === playerId;

  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editColor, setEditColor] = useState('');
  const [editBio, setEditBio] = useState('');
  const [editClass, setEditClass] = useState<Agent['agentClass']>('builder');
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [referralInfo, setReferralInfo] = useState<ReferralSummary | null>(null);
  const [referralLoading, setReferralLoading] = useState(false);
  const [referralError, setReferralError] = useState('');
  const [referralCopied, setReferralCopied] = useState(false);

  // Collapse when agent changes to keep UI clean
  useEffect(() => {
    setIsExpanded(false);
    setIsEditing(false);
    setReferralInfo(null);
    setReferralError('');
    setReferralLoading(false);
  }, [agent?.id]);

  useEffect(() => {
    if (!isOwner || !agent?.id || !isExpanded) {
      return;
    }

    const token = socketService.getToken();
    if (!token) {
      setReferralInfo(null);
      setReferralError('');
      return;
    }

    const controller = new AbortController();
    setReferralLoading(true);
    setReferralError('');

    fetch(`${SERVER_URL}/v1/grid/referral`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error || `Referral fetch failed (${response.status})`);
        }
        return response.json() as Promise<ReferralSummary>;
      })
      .then((data) => setReferralInfo(data))
      .catch((err) => {
        if (controller.signal.aborted) return;
        setReferralInfo(null);
        setReferralError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setReferralLoading(false);
        }
      });

    return () => controller.abort();
  }, [agent?.id, isExpanded, isOwner]);

  const copyReferralCode = useCallback(async () => {
    if (!referralInfo?.referralCode) return;
    await navigator.clipboard.writeText(referralInfo.referralCode);
    setReferralCopied(true);
    setTimeout(() => setReferralCopied(false), 1200);
  }, [referralInfo?.referralCode]);

  const shareReferralToX = useCallback(() => {
    if (!referralInfo?.referralCode) return;
    const text = `Join me in OpGrid with referral code ${referralInfo.referralCode} for bonus build credits. Enter the world: https://beta.opgrid.world`;
    const url = `https://x.com/intent/tweet?text=${encodeURIComponent(text)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  }, [referralInfo?.referralCode]);

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
  const localReputation = agent.localReputation ?? 0;
  const combinedReputation = agent.combinedReputation ?? (reputation + localReputation);
  const materials = agent.materials || { stone: 0, metal: 0, glass: 0, crystal: 0, organic: 0 };

  const CLASS_ICONS: Record<string, string> = {
    builder: '\u{1F528}',
    architect: '\u{1F3D7}',
    explorer: '\u{1F9ED}',
    diplomat: '\u{1F3DB}',
    merchant: '\u{1F4B0}',
    scavenger: '\u{1F50D}',
  };
  const agentClass = agent.agentClass || 'builder';
  const classIcon = CLASS_ICONS[agentClass] || '';
  const classLabel = agentClass.charAt(0).toUpperCase() + agentClass.slice(1);

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
      transition-all duration-300 ease-[cubic-bezier(0.23,1,0.32,1)]
      border shadow-lg backdrop-blur-xl overflow-hidden
      ${glassClass}
      z-50
    `;
    const collapsed = `absolute bottom-0 left-0 ${collapsedWidth} ${collapsedHeight} rounded-xl hover:scale-[1.02] active:scale-[0.98] cursor-pointer`;
    const expanded = `fixed bottom-4 left-4 right-4 ${expandedHeight} max-h-[70vh] rounded-3xl sm:absolute sm:bottom-0 sm:left-0 sm:right-auto ${expandedWidth}`;

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

                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between w-full h-8">
                    {isEditing ? (
                      <input
                        type="text"
                        value={editName}
                        onChange={e => setEditName(e.target.value)}
                        className={`text-xl font-black leading-tight tracking-tight w-full bg-transparent border-b pb-0.5 ${isDarkMode ? 'border-white/20' : 'border-black/20'} outline-none`}
                        maxLength={32}
                        onClick={e => e.stopPropagation()}
                      />
                    ) : (
                      <h2 className="text-xl font-black leading-tight tracking-tight truncate pr-2 w-full">
                        {truncateAddress(agent.name)}
                      </h2>
                    )}
                    
                    {isOwner && !isEditing && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditName(agent.name);
                          setEditColor(agent.color);
                          setEditBio(agent.bio || '');
                          setEditClass(agent.agentClass || 'builder');
                          setSaveError('');
                          setIsEditing(true);
                        }}
                        className="p-1.5 shrink-0 rounded-full hover:bg-black/10 dark:hover:bg-white/10 transition-colors pointer-events-auto"
                        aria-label="Edit Profile"
                      >
                        <Edit2 size={14} className="opacity-60" />
                      </button>
                    )}
                  </div>

                  <div className="flex items-center gap-2 mt-1">
                    <span
                      className={`
                        inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wide border
                        ${statusPillClass}
                      `}
                    >
                      {agent.status === 'moving' ? 'Moving' : 'Idle'}
                    </span>
                    {isEditing ? (
                      <select
                        value={editClass}
                        onChange={e => setEditClass(e.target.value as Agent['agentClass'])}
                        className="inline-flex items-center gap-1 px-1 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wide border bg-violet-500/10 text-violet-500 border-violet-500/20 outline-none cursor-pointer"
                        onClick={e => e.stopPropagation()}
                      >
                        <option value="builder">Builder</option>
                        <option value="architect">Architect</option>
                        <option value="explorer">Explorer</option>
                        <option value="diplomat">Diplomat</option>
                        <option value="merchant">Merchant</option>
                        <option value="scavenger">Scavenger</option>
                      </select>
                    ) : (
                      <span
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wide border bg-violet-500/10 text-violet-500 border-violet-500/20"
                      >
                        {classIcon} {classLabel}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Body */}
          <div className="relative flex-1 flex flex-col h-full overflow-hidden p-5">
            {/* Bio Section */}
            {isEditing ? (
              <div className="flex flex-col gap-3 mb-4 shrink-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold opacity-70">Color</span>
                  <input
                    type="color"
                    value={editColor}
                    onChange={e => setEditColor(e.target.value)}
                    className="w-6 h-6 rounded cursor-pointer border-0 p-0"
                    onClick={e => e.stopPropagation()}
                  />
                  <span className="text-xs font-mono opacity-50">{editColor.toUpperCase()}</span>
                </div>
                <textarea
                  value={editBio}
                  onChange={e => setEditBio(e.target.value)}
                  placeholder="Agent biography (max 280 chars)..."
                  className={`
                    p-3 rounded-xl border text-xs leading-relaxed font-medium resize-none h-24 outline-none
                    ${isDarkMode ? 'bg-black/20 border-white/20 text-white placeholder-white/30' : 'bg-slate-50 border-slate-300 text-slate-800 placeholder-slate-400'}
                  `}
                  maxLength={280}
                  onClick={e => e.stopPropagation()}
                />
                
                {saveError && (
                  <div className="text-red-500 text-[10px] font-bold bg-red-500/10 px-2 py-1.5 rounded border border-red-500/20">
                    {saveError}
                  </div>
                )}
                
                <div className="flex gap-2 justify-end mt-1">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setIsEditing(false);
                    }}
                    className="px-3 py-1.5 text-xs font-bold rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    disabled={isSaving}
                    onClick={async (e) => {
                      e.stopPropagation();
                      setIsSaving(true);
                      setSaveError('');
                      try {
                        const token = socketService.getToken();
                        if (!token) throw new Error('Not authenticated. Please wait or reload.');
                        
                        const res = await fetch(`${SERVER_URL}/v1/agents/profile`, {
                          method: 'PUT',
                          headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`
                          },
                          body: JSON.stringify({
                            name: editName,
                            color: editColor,
                            bio: editBio,
                            agentClass: editClass
                          })
                        });
                        
                        const data = await res.json();
                        if (!res.ok) throw new Error(data.error || 'Failed to update profile');
                        
                        updateAgent(agent.id, {
                          name: editName,
                          color: editColor,
                          bio: editBio || undefined,
                          agentClass: editClass
                        });
                        setIsEditing(false);
                      } catch (err: any) {
                        setSaveError(err.message);
                      } finally {
                        setIsSaving(false);
                      }
                    }}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold bg-green-500 hover:bg-green-600 text-white rounded-lg transition-colors disabled:opacity-50"
                  >
                    {isSaving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                    {isSaving ? 'Saving' : 'Save'}
                  </button>
                </div>
              </div>
            ) : (
              <div
                className={`
                  p-3 rounded-xl border mb-4 text-xs leading-relaxed font-medium overflow-y-auto scrollbar-hide grow sm:grow-0
                  ${isDarkMode ? 'bg-black/20 border-white/5 text-slate-300' : 'bg-slate-50 border-slate-100 text-slate-600'}
                `}
              >
                {agent.bio ? `"${agent.bio}"` : <span className="italic opacity-50">No bio available.</span>}
              </div>
            )}

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
                <>
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2 opacity-70">
                      <Star size={14} />
                      <span>Reputation</span>
                    </div>
                    <span className="font-mono font-bold">{combinedReputation}</span>
                  </div>
                  <div className="text-[10px] opacity-60 text-right">
                    on-chain {reputation} + local {localReputation}
                  </div>
                </>
              )}

              <div className="pt-1 border-t border-black/5 dark:border-white/10">
                <div className="text-[10px] font-bold uppercase tracking-wide opacity-60 mb-1.5">Materials</div>
                <div className="grid grid-cols-5 gap-1 text-[10px]">
                  <div className="px-1.5 py-1 rounded bg-slate-500/10 text-center">🪨 {materials.stone ?? 0}</div>
                  <div className="px-1.5 py-1 rounded bg-slate-500/10 text-center">🔩 {materials.metal ?? 0}</div>
                  <div className="px-1.5 py-1 rounded bg-slate-500/10 text-center">🧪 {materials.glass ?? 0}</div>
                  <div className="px-1.5 py-1 rounded bg-slate-500/10 text-center">💎 {materials.crystal ?? 0}</div>
                  <div className="px-1.5 py-1 rounded bg-slate-500/10 text-center">🌿 {materials.organic ?? 0}</div>
                </div>
              </div>

              {isOwner && (
                <div className="pt-1 border-t border-black/5 dark:border-white/10">
                  <div className="text-[10px] font-bold uppercase tracking-wide opacity-60 mb-1.5">Referral</div>
                  {referralLoading ? (
                    <div className="text-[10px] opacity-60">Loading referral stats...</div>
                  ) : referralInfo?.referralCode ? (
                    <>
                      <div className="flex items-center gap-1.5 mb-1.5">
                        <code className="text-[10px] px-1.5 py-1 rounded bg-slate-500/10 font-mono truncate flex-1">
                          {referralInfo.referralCode}
                        </code>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            copyReferralCode().catch(() => {});
                          }}
                          className="p-1 rounded bg-slate-500/10 hover:bg-slate-500/20 transition-colors"
                          title="Copy referral code"
                        >
                          {referralCopied ? <Check size={11} /> : <Copy size={11} />}
                        </button>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            shareReferralToX();
                          }}
                          className="p-1 rounded bg-slate-500/10 hover:bg-slate-500/20 transition-colors"
                          title="Share to X"
                        >
                          <ExternalLink size={11} />
                        </button>
                      </div>
                      <div className="text-[10px] opacity-60">
                        {referralInfo.referralCount} referrals, {referralInfo.creditsEarned} credits earned
                      </div>
                    </>
                  ) : (
                    <div className="text-[10px] opacity-60">Referral code not available yet.</div>
                  )}
                  {referralError && (
                    <div className="text-[10px] text-red-400 mt-1">{referralError}</div>
                  )}
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
