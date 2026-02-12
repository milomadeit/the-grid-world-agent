import React, { useState } from 'react';
import { Html } from '@react-three/drei';
import { useWorldStore } from '../../store';

const Terminal3D: React.FC = () => {
  const [hovered, setHovered] = useState(false);
  const setSelectedPrimitive = useWorldStore((state) => state.setSelectedPrimitive);

  const handleClick = (e: any) => {
    e.stopPropagation();
    // Create a virtual primitive object for the terminal info display
    setSelectedPrimitive({
      id: 'system-terminal',
      shape: 'box',
      ownerAgentId: 'SYSTEM',
      position: { x: 0, y: 2, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 4, y: 5, z: 2 },
      color: '#00ff00',
      createdAt: 0, // Genesis
    });
  };

  return (
    <group position={[0, 0, 0]}>
      {/* Base */}
      <mesh position={[0, 1, 0]}>
        <cylinderGeometry args={[2, 2.5, 2, 8]} />
        <meshStandardMaterial color="#333" roughness={0.5} metalness={0.8} />
      </mesh>

      {/* Screen Monitor */}
      <mesh position={[0, 3.5, 0]} onClick={handleClick}
        onPointerOver={() => setHovered(true)}
        onPointerOut={() => setHovered(false)}
      >
        <boxGeometry args={[4, 3, 0.5]} />
        <meshStandardMaterial color="#111" />
      </mesh>

      {/* Screen Glow */}
      <mesh position={[0, 3.5, 0.26]}>
        <planeGeometry args={[3.8, 2.8]} />
        <meshBasicMaterial color={hovered ? "#00ff00" : "#004400"} />
      </mesh>

      {/* Holographic Text */}
      {/* Holographic Text */}
      <Html position={[0, 5.5, 0]} center distanceFactor={12}>
        <div className="bg-black/60 backdrop-blur-md border border-green-500/50 rounded-lg px-4 py-2 shadow-[0_0_15px_rgba(0,255,0,0.3)]">
          <div className="text-green-400 font-mono text-[10px] tracking-[0.2em] font-bold select-none whitespace-nowrap flex items-center gap-2">
            <div className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse" />
            SYSTEM TERMINAL
          </div>
        </div>
      </Html>
    </group>
  );
};

export default Terminal3D;
