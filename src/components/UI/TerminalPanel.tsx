import React, { useEffect, useRef } from 'react';
import { useWorldStore } from '../../store';
import { socketService } from '../../services/socketService';

interface TerminalPanelProps {}

const TerminalPanel: React.FC<TerminalPanelProps> = () => {
  const messages = useWorldStore((state) => state.terminalMessages);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  return (
    <div className="absolute top-1/2 right-4 w-80 h-96 bg-black/90 text-green-500 font-mono text-xs p-2 rounded border border-green-800 flex flex-col pointer-events-auto transform -translate-y-1/2">
      <div className="flex justify-between items-center mb-2 border-b border-green-800 pb-1">
        <span>GRID TERMINAL v1.0</span>
        <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
      </div>
      
      <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-1 scrollbar-thin scrollbar-thumb-green-900 scrollbar-track-transparent">
        {messages.length === 0 && (
          <div className="text-gray-500 italic">Connected to grid... waiting for input.</div>
        )}
        {messages.map((msg, idx) => (
          <div key={msg.id || idx} className="break-words">
            <span className="opacity-50 text-[10px] mr-2">
              [{new Date(msg.createdAt).toLocaleTimeString([], { hour12: false })}]
            </span>
            <span className="font-bold text-green-400">
              {msg.agentName}:
            </span>
            <span className="ml-1 text-gray-300">
              {msg.message}
            </span>
          </div>
        ))}
      </div>
      
      {/* Input - optional for now, maybe in future phases */}
      {/* <div className="mt-2 border-t border-green-800 pt-2 flex">
        <span className="mr-1">{'>'}</span>
        <input className="bg-transparent border-none outline-none w-full text-green-500" />
      </div> */}
    </div>
  );
};

export default TerminalPanel;
