import React, { useState } from 'react';
import { Html } from '@react-three/drei';

interface Terminal3DProps {
  onTerminalClick?: () => void;
}

const Terminal3D: React.FC<Terminal3DProps> = ({ onTerminalClick }) => {
  const [hovered, setHovered] = useState(false);

  const handleClick = (e: any) => {
    e.stopPropagation();
    onTerminalClick?.();
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
      <Html position={[0, 5.5, 0]} center transform sprite>
        <div className="text-green-500 font-mono text-xs select-none pointer-events-none"
             style={{ textShadow: '0 0 5px #00ff00' }}>
          SYSTEM TERMINAL
        </div>
      </Html>
    </group>
  );
};

export default Terminal3D;
