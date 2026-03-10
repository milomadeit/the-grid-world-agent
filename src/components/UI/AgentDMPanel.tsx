import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useWorldStore } from '../../store';
import { socketService } from '../../services/socketService';
import type { DirectMessage } from '../../types';

const SERVER_URL = import.meta.env.VITE_SERVER_URL ||
  (typeof window !== 'undefined' && !window.location.hostname.includes('localhost')
    ? window.location.origin
    : 'http://localhost:4101');

interface AgentDMPanelProps {
  isDarkMode: boolean;
}

const AgentDMPanel: React.FC<AgentDMPanelProps> = ({ isDarkMode }) => {
  const isAgentOwner = useWorldStore((state) => state.isAgentOwner);
  const ownedAgentId = useWorldStore((state) => state.ownedAgentId);
  const agents = useWorldStore((state) => state.agents);
  const dmMessages = useWorldStore((state) => state.dmMessages);
  const setDMMessages = useWorldStore((state) => state.setDMMessages);
  const addDMMessage = useWorldStore((state) => state.addDMMessage);

  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [toAgentId, setToAgentId] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);

  const targetAgents = useMemo(
    () => agents.filter((agent) => agent.id !== ownedAgentId),
    [agents, ownedAgentId]
  );

  useEffect(() => {
    if (!toAgentId && targetAgents.length > 0) {
      setToAgentId(targetAgents[0].id);
    }
    if (toAgentId && !targetAgents.some((agent) => agent.id === toAgentId)) {
      setToAgentId(targetAgents[0]?.id || '');
    }
  }, [targetAgents, toAgentId]);

  const authHeaders = useCallback((): HeadersInit => {
    const token = socketService.getToken();
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }, []);

  const fetchInbox = useCallback(async (unread = unreadOnly) => {
    setLoading(true);
    setError(null);
    try {
      const token = socketService.getToken();
      if (!token) throw new Error('Missing auth token');

      const query = unread ? '?unread=true' : '';
      const response = await fetch(`${SERVER_URL}/v1/grid/dm/inbox${query}`, {
        method: 'GET',
        headers: authHeaders(),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Inbox request failed (${response.status})`);
      }

      const data = await response.json() as { messages?: DirectMessage[] };
      const next = [...(data.messages || [])].sort((a, b) => b.createdAt - a.createdAt);
      setDMMessages(next);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [authHeaders, setDMMessages, unreadOnly]);

  const handleMarkRead = useCallback(async () => {
    if (!ownedAgentId) return;
    const unreadIds = dmMessages
      .filter((dm) => dm.toAgentId === ownedAgentId && !dm.readAt)
      .map((dm) => dm.id);

    if (unreadIds.length === 0) return;

    try {
      const response = await fetch(`${SERVER_URL}/v1/grid/dm/mark-read`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ messageIds: unreadIds }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Mark-read failed (${response.status})`);
      }

      await fetchInbox(unreadOnly);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    }
  }, [authHeaders, dmMessages, fetchInbox, ownedAgentId, unreadOnly]);

  const handleSend = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    const content = message.trim();
    if (!toAgentId || !content) return;

    setSending(true);
    setError(null);
    try {
      const response = await fetch(`${SERVER_URL}/v1/grid/dm`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ toAgentId, message: content }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `DM send failed (${response.status})`);
      }

      const saved = await response.json() as DirectMessage;
      addDMMessage(saved);
      setMessage('');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setSending(false);
    }
  }, [addDMMessage, authHeaders, message, toAgentId]);

  useEffect(() => {
    if (!open) return;
    fetchInbox(unreadOnly);
    const interval = setInterval(() => fetchInbox(unreadOnly), 15000);
    return () => clearInterval(interval);
  }, [open, fetchInbox, unreadOnly]);

  if (!isAgentOwner || !ownedAgentId) return null;

  const panelBg = isDarkMode ? 'bg-slate-950/85 border-white/15 text-slate-100' : 'bg-white/90 border-slate-200 text-slate-900';
  const muted = isDarkMode ? 'text-slate-400' : 'text-slate-600';
  const inputBg = isDarkMode ? 'bg-slate-900/80 border-white/10 text-slate-100' : 'bg-slate-50 border-slate-300 text-slate-900';
  const unreadCount = dmMessages.filter((dm) => dm.toAgentId === ownedAgentId && !dm.readAt).length;

  return (
    <>
      <button
        onClick={() => setOpen((prev) => !prev)}
        className={`fixed bottom-6 left-6 z-50 pointer-events-auto rounded-xl border px-3 py-2 text-xs font-semibold backdrop-blur ${panelBg}`}
      >
        DMs {unreadCount > 0 ? `(${unreadCount})` : ''}
      </button>

      {open && (
        <div className={`fixed bottom-20 left-6 z-50 pointer-events-auto w-[360px] max-w-[calc(100vw-3rem)] rounded-2xl border p-4 backdrop-blur-xl shadow-xl ${panelBg}`}>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-bold">Direct Messages</h3>
            <div className="flex items-center gap-2">
              <button
                onClick={() => fetchInbox(unreadOnly)}
                className={`text-[11px] ${muted} hover:opacity-80`}
                disabled={loading}
              >
                Refresh
              </button>
              <button
                onClick={handleMarkRead}
                className={`text-[11px] ${muted} hover:opacity-80`}
              >
                Mark Read
              </button>
            </div>
          </div>

          <label className={`flex items-center gap-2 mb-3 text-[11px] ${muted}`}>
            <input
              type="checkbox"
              checked={unreadOnly}
              onChange={(event) => setUnreadOnly(event.target.checked)}
            />
            Show unread only
          </label>

          <form onSubmit={handleSend} className="space-y-2 mb-3">
            <select
              value={toAgentId}
              onChange={(event) => setToAgentId(event.target.value)}
              className={`w-full rounded-lg border px-2 py-1.5 text-xs ${inputBg}`}
            >
              {targetAgents.length === 0 && <option value="">No target agents online</option>}
              {targetAgents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name} ({agent.id.slice(0, 8)}...)
                </option>
              ))}
            </select>

            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Write a DM (max 500 chars)"
              maxLength={500}
              rows={3}
              className={`w-full resize-none rounded-lg border px-2 py-1.5 text-xs ${inputBg}`}
            />

            <button
              type="submit"
              disabled={sending || !toAgentId || !message.trim()}
              className="w-full rounded-lg bg-violet-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
            >
              {sending ? 'Sending...' : 'Send DM'}
            </button>
          </form>

          {error && <p className="text-[11px] text-red-400 mb-2">{error}</p>}

          <div className={`max-h-48 overflow-y-auto space-y-2 text-xs pr-1 ${muted}`}>
            {loading && <p>Loading inbox...</p>}
            {!loading && dmMessages.length === 0 && <p>No messages.</p>}
            {!loading && dmMessages.map((dm) => {
              const incoming = dm.toAgentId === ownedAgentId;
              const label = incoming ? `from ${dm.fromId}` : `to ${dm.toAgentId}`;
              return (
                <div key={dm.id} className={`rounded-lg border p-2 ${isDarkMode ? 'border-white/10 bg-slate-900/50' : 'border-slate-200 bg-slate-50'}`}>
                  <div className="flex items-center justify-between text-[10px] mb-1">
                    <span>{label}</span>
                    <span>{new Date(dm.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                  <p className={isDarkMode ? 'text-slate-200' : 'text-slate-800'}>{dm.message}</p>
                  {incoming && !dm.readAt && (
                    <p className="text-[10px] text-amber-400 mt-1">Unread</p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
};

export default AgentDMPanel;
