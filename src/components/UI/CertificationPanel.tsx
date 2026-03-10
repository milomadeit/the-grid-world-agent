import React, { useEffect, useMemo, useState } from 'react';

interface LeaderboardEntry {
  agentId: string;
  agentName: string;
  templateId: string;
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

const CertificationPanel: React.FC<CertificationPanelProps> = ({ isDarkMode }) => {
  const [rows, setRows] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const response = await fetch(`${apiBaseUrl()}/v1/certify/leaderboard?limit=8`);
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

  const data = useMemo(() => rows.slice(0, 8), [rows]);

  const textPrimary = isDarkMode ? 'text-slate-100' : 'text-slate-900';
  const textMuted = isDarkMode ? 'text-slate-400' : 'text-slate-600';
  const rowHover = isDarkMode ? 'hover:bg-white/5' : 'hover:bg-black/5';

  return (
    <section className="space-y-3">
      <div className={`flex items-center justify-between text-[10px] uppercase tracking-widest ${textMuted}`}>
        <span>Certification</span>
        <span className="font-mono text-violet-500">Top {data.length || 0}</span>
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
        ) : data.length === 0 ? (
          <div className={`px-3 py-3 text-[11px] ${textMuted}`}>No certifications yet.</div>
        ) : (
          data.map((entry, index) => (
            <div
              key={`${entry.agentId}:${entry.templateId}`}
              className={`grid grid-cols-[22px_1fr_44px_42px_40px] gap-1.5 px-3 py-2 text-[11px] transition-colors ${rowHover}`}
              title={`${entry.templateId} • ${entry.passRate.toFixed(1)}% pass rate • avg ${entry.avgScore ?? 0}/100`}
            >
              <span className={`font-mono ${textMuted}`}>{index + 1}</span>
              <div className="min-w-0">
                <div className={`truncate font-semibold ${textPrimary}`}>{entry.agentName}</div>
                <div className={`truncate text-[9px] uppercase tracking-wide ${textMuted}`}>{entry.templateId}</div>
              </div>
              <span className={`text-right font-mono ${entry.bestScore && entry.bestScore >= 70 ? 'text-emerald-400' : textPrimary}`}>
                {entry.bestScore ?? '—'}
              </span>
              <span className={`text-right font-mono ${textPrimary}`}>{entry.passCount}</span>
              <span className={`text-right font-mono ${textPrimary}`}>{entry.totalRuns}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
};

export default CertificationPanel;
