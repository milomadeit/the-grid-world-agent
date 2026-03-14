import React, { useEffect, useMemo, useState, useCallback } from 'react';

interface LeaderboardEntry {
  agentId: string;
  agentName: string;
  certsAttempted?: number;
  totalRuns: number;
  passCount: number;
  failCount: number;
  passRate: number;
  bestScore?: number;
  avgScore?: number;
}

interface CertificationPanelProps {
  isDarkMode: boolean;
}

function apiBaseUrl(): string {
  if (import.meta.env.VITE_SERVER_URL) {
    return import.meta.env.VITE_SERVER_URL as string;
  }
  if (typeof window !== 'undefined') {
    return window.location.origin;
  }
  return 'http://localhost:4101';
}

const POLL_INTERVAL_MS = 30_000;
const TOP_N = 3;

/* ─── Medal badges ─── */
const MEDALS = ['🥇', '🥈', '🥉'];

/* ─── Leaderboard row ─── */
function LeaderboardRow({
  entry,
  index,
  isDarkMode,
  compact = false,
}: {
  entry: LeaderboardEntry;
  index: number;
  isDarkMode: boolean;
  compact?: boolean;
}) {
  const textPrimary = isDarkMode ? 'text-slate-100' : 'text-slate-900';
  const textMuted = isDarkMode ? 'text-slate-400' : 'text-slate-600';
  const rowHover = isDarkMode ? 'hover:bg-white/5' : 'hover:bg-black/5';

  return (
    <div
      className={`grid grid-cols-[22px_1fr_44px_42px_40px] gap-1.5 px-3 ${compact ? 'py-1.5' : 'py-2'} text-[11px] transition-colors ${rowHover}`}
      title={`${entry.passRate.toFixed(1)}% pass rate · avg ${entry.avgScore ?? 0}/100 · ${entry.certsAttempted ?? 1} cert${(entry.certsAttempted ?? 1) > 1 ? 's' : ''}`}
    >
      <span className="font-mono text-[12px] leading-tight">
        {index < 3 ? MEDALS[index] : <span className={textMuted}>{index + 1}</span>}
      </span>
      <div className="min-w-0">
        <div className={`truncate font-semibold ${textPrimary}`}>{entry.agentName}</div>
        <div className={`truncate text-[9px] uppercase tracking-wide ${textMuted}`}>
          {entry.passCount} pass{entry.passCount !== 1 ? 'es' : ''} · {entry.totalRuns} run{entry.totalRuns !== 1 ? 's' : ''}
        </div>
      </div>
      <span className={`text-right font-mono ${entry.bestScore && entry.bestScore >= 70 ? 'text-emerald-400' : textPrimary}`}>
        {entry.bestScore ?? '—'}
      </span>
      <span className={`text-right font-mono ${textPrimary}`}>{entry.passCount}</span>
      <span className={`text-right font-mono ${textPrimary}`}>{entry.totalRuns}</span>
    </div>
  );
}

/* ─── Full leaderboard modal ─── */
function LeaderboardModal({
  rows,
  isDarkMode,
  onClose,
}: {
  rows: LeaderboardEntry[];
  isDarkMode: boolean;
  onClose: () => void;
}) {
  const textPrimary = isDarkMode ? 'text-slate-100' : 'text-slate-900';
  const textMuted = isDarkMode ? 'text-slate-400' : 'text-slate-600';

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      onClick={onClose}
    >
      {/* backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      {/* modal */}
      <div
        className={`relative w-full max-w-md mx-4 rounded-xl border shadow-2xl overflow-hidden ${
          isDarkMode
            ? 'border-white/10 bg-slate-900/95'
            : 'border-slate-200 bg-white/95'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <span className={`text-xs uppercase tracking-widest font-semibold ${textMuted}`}>
            Certification Leaderboard
          </span>
          <button
            onClick={onClose}
            className={`text-xs px-2 py-1 rounded transition-colors ${
              isDarkMode ? 'hover:bg-white/10 text-slate-400' : 'hover:bg-black/10 text-slate-500'
            }`}
          >
            ✕
          </button>
        </div>

        {/* column headers */}
        <div className={`grid grid-cols-[22px_1fr_44px_42px_40px] gap-1.5 px-3 py-2 text-[9px] uppercase tracking-widest ${textMuted}`}>
          <span>#</span>
          <span>Agent</span>
          <span className="text-right">Best</span>
          <span className="text-right">Pass</span>
          <span className="text-right">Runs</span>
        </div>
        <div className={`border-t ${isDarkMode ? 'border-white/10' : 'border-slate-200/70'}`} />

        {/* rows */}
        <div className="max-h-[60vh] overflow-y-auto">
          {rows.length === 0 ? (
            <div className={`px-3 py-4 text-[11px] text-center ${textMuted}`}>No certifications yet.</div>
          ) : (
            rows.map((entry, index) => (
              <LeaderboardRow
                key={entry.agentId}
                entry={entry}
                index={index}
                isDarkMode={isDarkMode}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Main panel ─── */
const CertificationPanel: React.FC<CertificationPanelProps> = ({ isDarkMode }) => {
  const [rows, setRows] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const response = await fetch(`${apiBaseUrl()}/v1/certify/leaderboard?limit=20`);
        if (!response.ok) {
          throw new Error(`Leaderboard request failed (${response.status})`);
        }
        const payload = await response.json() as { leaderboard?: LeaderboardEntry[] };
        if (!cancelled) {
          setRows(Array.isArray(payload.leaderboard) ? payload.leaderboard : []);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load leaderboard');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void load();
    const timer = setInterval(() => {
      void load();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const topRows = useMemo(() => rows.slice(0, TOP_N), [rows]);
  const hasMore = rows.length > TOP_N;

  const handleOpenModal = useCallback(() => setShowModal(true), []);
  const handleCloseModal = useCallback(() => setShowModal(false), []);

  const textMuted = isDarkMode ? 'text-slate-400' : 'text-slate-600';

  return (
    <>
      <section className="space-y-3">
        <div className={`flex items-center justify-between text-[10px] uppercase tracking-widest ${textMuted}`}>
          <span>Certification</span>
          {hasMore ? (
            <button
              onClick={handleOpenModal}
              className="font-mono text-violet-500 hover:text-violet-400 transition-colors cursor-pointer"
            >
              See All
            </button>
          ) : (
            <span className="font-mono text-violet-500">Top {topRows.length || 0}</span>
          )}
        </div>

        <div className={`rounded-lg border overflow-hidden ${isDarkMode ? 'border-white/10 bg-slate-900/40' : 'border-slate-200/70 bg-white/70'}`}>
          <div className={`grid grid-cols-[22px_1fr_44px_42px_40px] gap-1.5 px-3 py-2 text-[9px] uppercase tracking-widest ${textMuted}`}>
            <span>#</span>
            <span>Agent</span>
            <span className="text-right">Best</span>
            <span className="text-right">Pass</span>
            <span className="text-right">Runs</span>
          </div>
          <div className={`border-t ${isDarkMode ? 'border-white/10' : 'border-slate-200/70'}`} />

          {loading ? (
            <div className={`px-3 py-3 text-[11px] ${textMuted}`}>Loading leaderboard...</div>
          ) : error ? (
            <div className={`px-3 py-3 text-[11px] text-rose-400`}>{error}</div>
          ) : topRows.length === 0 ? (
            <div className={`px-3 py-3 text-[11px] ${textMuted}`}>No certifications yet.</div>
          ) : (
            topRows.map((entry, index) => (
              <LeaderboardRow
                key={entry.agentId}
                entry={entry}
                index={index}
                isDarkMode={isDarkMode}
              />
            ))
          )}
        </div>
      </section>

      {showModal && (
        <LeaderboardModal
          rows={rows}
          isDarkMode={isDarkMode}
          onClose={handleCloseModal}
        />
      )}
    </>
  );
};

export default CertificationPanel;
