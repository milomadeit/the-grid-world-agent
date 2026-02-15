import React from 'react';
import { useWorldStore } from '../../store';

const ObjectInfoModal: React.FC = () => {
  const selectedPrimitive = useWorldStore((state) => state.selectedPrimitive);
  const setSelectedPrimitive = useWorldStore((state) => state.setSelectedPrimitive);
  const agents = useWorldStore((state) => state.agents);

  if (!selectedPrimitive || selectedPrimitive.id === 'system-terminal') return null;

  const ownerAgent = agents.find(a => a.id === selectedPrimitive.ownerAgentId);
  const ownerName = ownerAgent?.name || selectedPrimitive.ownerAgentId.slice(0, 12) + '...';
  const ownerColor = ownerAgent?.color;

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
          ×
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
            <span className="font-mono truncate max-w-[100px]" title={selectedPrimitive.ownerAgentId}>
              {ownerName}
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
            {selectedPrimitive.scale.x.toFixed(1)} × {selectedPrimitive.scale.y.toFixed(1)} × {selectedPrimitive.scale.z.toFixed(1)}
          </span>
        </div>
      </div>
    </div>
  );
};

export default ObjectInfoModal;
