import React, { useEffect, useMemo, useState } from 'react';
import { useWorldStore } from '../../store';

const SERVER_URL = import.meta.env.VITE_SERVER_URL ||
  (typeof window !== 'undefined' && !window.location.hostname.includes('localhost')
    ? window.location.origin
    : 'http://localhost:4101');

interface StructureDetails {
  blueprintInstanceId: string;
  blueprintName?: string | null;
  builder: {
    agentId: string;
    name: string;
  };
  pieceCount: number;
  builtAt?: number | null;
  center?: {
    x: number;
    z: number;
  };
  guild?: {
    id: string;
    name: string;
  } | null;
  directive?: {
    id: string;
    type: 'grid' | 'guild' | 'bounty';
    description: string;
    status: string;
    targetX?: number;
    targetZ?: number;
    targetStructureGoal?: number;
    distanceFromTarget?: number;
  } | null;
}

const ObjectInfoModal: React.FC = () => {
  const selectedPrimitive = useWorldStore((state) => state.selectedPrimitive);
  const setSelectedPrimitive = useWorldStore((state) => state.setSelectedPrimitive);
  const agents = useWorldStore((state) => state.agents);
  const worldPrimitives = useWorldStore((state) => state.worldPrimitives);

  // Gather all sibling primitives from the same blueprint instance
  const blueprintPieces = useMemo(() => {
    if (!selectedPrimitive?.blueprintInstanceId) return [];
    return worldPrimitives.filter(
      p => p.blueprintInstanceId === selectedPrimitive.blueprintInstanceId
    );
  }, [selectedPrimitive?.blueprintInstanceId, worldPrimitives]);

  const [structureDetails, setStructureDetails] = useState<StructureDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);

  useEffect(() => {
    const blueprintInstanceId = selectedPrimitive?.blueprintInstanceId;
    if (!blueprintInstanceId) {
      setStructureDetails(null);
      setDetailsError(null);
      setDetailsLoading(false);
      return;
    }

    const controller = new AbortController();
    setDetailsLoading(true);
    setDetailsError(null);

    fetch(`${SERVER_URL}/v1/grid/structures/${encodeURIComponent(blueprintInstanceId)}`, {
      method: 'GET',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error || `Failed to load structure details (${response.status})`);
        }
        return response.json() as Promise<StructureDetails>;
      })
      .then((details) => setStructureDetails(details))
      .catch((err) => {
        if (controller.signal.aborted) return;
        setStructureDetails(null);
        setDetailsError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailsLoading(false);
      });

    return () => controller.abort();
  }, [selectedPrimitive?.blueprintInstanceId]);

  if (!selectedPrimitive || selectedPrimitive.id === 'system-terminal') return null;

  const ownerAgent = agents.find(a => a.id === selectedPrimitive.ownerAgentId);
  const fallbackOwnerName = ownerAgent?.name
    || selectedPrimitive.ownerAgentName
    || `${selectedPrimitive.ownerAgentId.slice(0, 12)}...`;
  const ownerName = structureDetails?.builder?.name || fallbackOwnerName;
  const ownerId = structureDetails?.builder?.agentId || selectedPrimitive.ownerAgentId;
  const ownerColor = ownerAgent?.color;
  const isBlueprint = !!selectedPrimitive.blueprintInstanceId;

  if (isBlueprint) {
    const structureName = structureDetails?.blueprintName || selectedPrimitive.blueprintName || 'Structure';
    const totalPieces = structureDetails?.pieceCount ?? blueprintPieces.length;
    const builtAt = structureDetails?.builtAt ?? selectedPrimitive.createdAt;
    const displayPosition = structureDetails?.center
      ? `${structureDetails.center.x}, ${structureDetails.center.z}`
      : `${selectedPrimitive.position.x.toFixed(1)}, ${selectedPrimitive.position.z.toFixed(1)}`;
    const guildName = structureDetails?.guild?.name || null;
    const directive = structureDetails?.directive || null;

    return (
      <div
        className="bg-slate-900/95 text-white px-3 py-2 rounded-lg border border-slate-700/50 shadow-xl min-w-[220px] max-w-[300px]"
        style={{ fontSize: '11px' }}
      >
        <div className="flex justify-between items-center mb-2 pb-1 border-b border-slate-700/50">
          <div className="flex items-center gap-2">
            <span className="text-lg leading-none">&#x1F3D7;</span>
            <span className="font-bold uppercase tracking-wide text-violet-400">
              {structureName}
            </span>
          </div>
          <button
            onClick={() => setSelectedPrimitive(null)}
            className="text-slate-500 hover:text-white text-sm leading-none"
          >
            &times;
          </button>
        </div>

        <div className="space-y-1 text-[10px]">
          <div className="flex justify-between items-center">
            <span className="text-slate-500">Builder</span>
            <div className="flex items-center gap-1">
              {ownerColor && (
                <span
                  className="w-2 h-2 rounded-full inline-block"
                  style={{ backgroundColor: ownerColor }}
                />
              )}
              <span className="font-mono truncate max-w-[140px]" title={ownerId}>
                {ownerName}
              </span>
            </div>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">Pieces</span>
            <span className="font-mono">{totalPieces}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">Position</span>
            <span className="font-mono">{displayPosition}</span>
          </div>
          {builtAt ? (
            <div className="flex justify-between">
              <span className="text-slate-500">Built At</span>
              <span className="font-mono">{new Date(builtAt).toLocaleString()}</span>
            </div>
          ) : null}
          {guildName ? (
            <div className="flex justify-between">
              <span className="text-slate-500">Guild</span>
              <span className="font-mono truncate max-w-[170px]" title={guildName}>{guildName}</span>
            </div>
          ) : null}
          {directive ? (
            <>
              <div className="flex justify-between">
                <span className="text-slate-500">Directive</span>
                <span className="font-mono">{directive.id}</span>
              </div>
              <div className="text-slate-400 leading-tight">
                {directive.description}
                {typeof directive.distanceFromTarget === 'number'
                  ? ` (${directive.distanceFromTarget}u from target)`
                  : ''}
              </div>
            </>
          ) : null}
          {detailsLoading ? <div className="text-slate-500">Loading structure details...</div> : null}
          {detailsError ? <div className="text-amber-400">{detailsError}</div> : null}
        </div>
      </div>
    );
  }

  // Non-blueprint primitive — original display
  return (
    <div
      className="bg-slate-900/95 text-white px-3 py-2 rounded-lg border border-slate-700/50 shadow-xl min-w-[180px] max-w-[220px]"
      style={{ fontSize: '11px' }}
    >
      <div className="flex justify-between items-center mb-2 pb-1 border-b border-slate-700/50">
        <div className="flex items-center gap-2">
          <span
            className="w-3 h-3 rounded-sm"
            style={{ backgroundColor: selectedPrimitive.color }}
          />
          <span className="font-bold uppercase tracking-wide text-blue-400">
            {selectedPrimitive.shape}
          </span>
        </div>
        <button
          onClick={() => setSelectedPrimitive(null)}
          className="text-slate-500 hover:text-white text-sm leading-none"
        >
          &times;
        </button>
      </div>

      <div className="space-y-1 text-[10px]">
        <div className="flex justify-between items-center">
          <span className="text-slate-500">Owner</span>
          <div className="flex items-center gap-1">
            {ownerColor && (
              <span
                className="w-2 h-2 rounded-full inline-block"
                style={{ backgroundColor: ownerColor }}
              />
            )}
            <span className="font-mono truncate max-w-[100px]" title={ownerId}>
              {fallbackOwnerName}
            </span>
          </div>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">Position</span>
          <span className="font-mono">
            {selectedPrimitive.position.x.toFixed(1)}, {selectedPrimitive.position.z.toFixed(1)}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">Scale</span>
          <span className="font-mono">
            {selectedPrimitive.scale.x.toFixed(1)} &times; {selectedPrimitive.scale.y.toFixed(1)} &times; {selectedPrimitive.scale.z.toFixed(1)}
          </span>
        </div>
      </div>
    </div>
  );
};

export default ObjectInfoModal;
