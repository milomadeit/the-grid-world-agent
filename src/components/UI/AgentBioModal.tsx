import React from 'react';
import { X, Shield, Star } from 'lucide-react';
import type { Agent } from '../../types';
import { truncateAddress } from '../../utils/address';

interface AgentBioModalProps {
  agent: Agent;
  onClose: () => void;
}

const AgentBioModal: React.FC<AgentBioModalProps> = ({ agent, onClose }) => {
  const hasIdentity = !!agent.erc8004AgentId;
  const reputation = agent.reputationScore ?? 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-white w-full max-w-xs rounded-2xl shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header with agent color */}
        <div
          className="p-5 text-center relative"
          style={{ backgroundColor: agent.color + '20' }}
        >
          <button
            onClick={onClose}
            className="absolute top-3 right-3 text-gray-400 hover:text-gray-600 transition-colors"
          >
            <X size={16} />
          </button>

          {/* Agent avatar */}
          <div
            className="w-14 h-14 rounded-full mx-auto mb-3 border-4 border-white shadow-lg"
            style={{ backgroundColor: agent.color }}
          />

          <h3 className="text-sm font-bold text-gray-900">
            {truncateAddress(agent.name)}
          </h3>

          <p className="text-[11px] text-gray-500 mt-0.5">
            {agent.status === 'moving' ? 'On the move' : agent.status === 'acting' ? 'Busy' : 'Idle'}
          </p>
        </div>

        <div className="px-5 pb-5 space-y-3">
          {/* Bio */}
          {agent.bio ? (
            <p className="text-xs text-gray-600 leading-relaxed">{agent.bio}</p>
          ) : (
            <p className="text-xs text-gray-400 italic">No bio set</p>
          )}

          {/* ERC-8004 Status */}
          <div className="flex items-center gap-2 p-2.5 rounded-xl bg-gray-50">
            <Shield size={14} className={hasIdentity ? 'text-amber-500' : 'text-gray-300'} />
            <span className={`text-xs font-medium ${hasIdentity ? 'text-amber-700' : 'text-gray-400'}`}>
              {hasIdentity ? `Verified on Monad (Agent #${agent.erc8004AgentId})` : 'Unregistered'}
            </span>
          </div>

          {/* Reputation */}
          {hasIdentity && (
            <div className="flex items-center gap-2 p-2.5 rounded-xl bg-gray-50">
              <Star size={14} className="text-violet-500" />
              <span className="text-xs text-gray-600">
                Reputation: <span className="font-medium">{reputation}</span>
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default AgentBioModal;
