import React from 'react';
import { useWorldStore } from '../../store';

const ObjectInfoModal: React.FC = () => {
  const selectedObject = useWorldStore((state) => state.selectedObject);
  const setSelectedObject = useWorldStore((state) => state.setSelectedObject);

  if (!selectedObject) return null;

  return (
    <div 
      className="absolute bg-black/80 text-white p-4 rounded border border-white/20 backdrop-blur-sm shadow-xl pointer-events-auto min-w-[300px]"
      style={{
        left: '50%',
        top: '50%',
        transform: 'translate(-50%, -50%)',
        zIndex: 50
      }}
    >
      <div className="flex justify-between items-start mb-4">
        <h3 className="text-lg font-bold uppercase tracking-wider text-blue-400">
          Object Details
        </h3>
        <button 
          onClick={() => setSelectedObject(null)}
          className="text-gray-400 hover:text-white"
        >
          ✕
        </button>
      </div>

      <div className="space-y-3 text-sm">
        <div className="grid grid-cols-2 gap-2">
          <div className="text-gray-400">Type:</div>
          <div className="font-mono uppercase">{selectedObject.type}</div>
          
          <div className="text-gray-400">ID:</div>
          <div className="font-mono text-xs truncate" title={selectedObject.id}>
            {selectedObject.id}
          </div>
          
          <div className="text-gray-400">Owner:</div>
          <div className="font-mono text-xs truncate" title={selectedObject.ownerAgentId}>
            {selectedObject.ownerAgentId}
          </div>
          
          <div className="text-gray-400">Position:</div>
          <div className="font-mono">
            {selectedObject.x.toFixed(1)}, {selectedObject.y.toFixed(1)}, {selectedObject.z.toFixed(1)}
          </div>
          
          <div className="text-gray-400">Created:</div>
          <div>{new Date(selectedObject.createdAt).toLocaleString()}</div>
        </div>

        {selectedObject.type === 'plot' && (
          <div className="border-t border-white/10 pt-3">
             <div className="text-gray-400 text-xs uppercase mb-1">Dimensions</div>
             <div className="font-mono">
               {selectedObject.width}W x {selectedObject.height}H x {selectedObject.length}L
             </div>
          </div>
        )}

        {selectedObject.type === 'sphere' && (
           <div className="border-t border-white/10 pt-3">
             <div className="text-gray-400 text-xs uppercase mb-1">Geometry</div>
             <div className="font-mono">Radius: {selectedObject.radius}</div>
           </div>
        )}
      </div>

      <div className="mt-6 flex justify-end">
        {/* Placeholder for delete button if owner - phase 3 */}
        {/* <button className="px-3 py-1 bg-red-500/20 text-red-500 hover:bg-red-500/40 rounded text-xs transition-colors">
          Demolish
        </button> */}
      </div>
    </div>
  );
};

export default ObjectInfoModal;
