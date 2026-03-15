import { useEffect, useRef } from 'react';
import { useWorldStore } from '../store';

const SERVER_URL =
  import.meta.env.VITE_SERVER_URL ||
  (typeof window !== 'undefined' && !window.location.hostname.includes('localhost')
    ? window.location.origin
    : 'http://localhost:4101');

const POLL_INTERVAL_MS = 30_000;

/**
 * Polls GET /v1/grid/nodes every 30 seconds once the world snapshot has loaded.
 * Uses ETag / If-None-Match to avoid re-parsing unchanged data.
 */
export function useNodePolling(): void {
  const snapshotLoaded = useWorldStore((s) => s.snapshotLoaded);
  const setNodes = useWorldStore((s) => s.setNodes);
  const etagRef = useRef<string | null>(null);

  useEffect(() => {
    if (!snapshotLoaded) return;

    let cancelled = false;

    const fetchNodes = async () => {
      try {
        const headers: Record<string, string> = {};
        if (etagRef.current) {
          headers['If-None-Match'] = etagRef.current;
        }

        const res = await fetch(`${SERVER_URL}/v1/grid/nodes`, { headers });

        if (res.status === 304 || cancelled) return; // unchanged

        if (!res.ok) {
          console.warn('[useNodePolling] fetch failed:', res.status);
          return;
        }

        const etag = res.headers.get('ETag');
        if (etag) etagRef.current = etag;

        const data = await res.json();
        if (!cancelled && Array.isArray(data.nodes)) {
          setNodes(data.nodes);
        }
      } catch (err) {
        // Silently swallow — node boundaries are non-critical
      }
    };

    // Fetch immediately, then poll
    fetchNodes();
    const timer = setInterval(fetchNodes, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [snapshotLoaded, setNodes]);
}
