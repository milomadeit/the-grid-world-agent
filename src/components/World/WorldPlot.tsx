import React, { useState } from 'react';
import { Vector3 } from 'three';
import { Html } from '@react-three/drei';
import { WorldObject } from '../../types';
import { useWorldStore } from '../../store';

interface WorldPlotProps {
  object: WorldObject;
  isDarkMode?: boolean;
}

const WorldPlot: React.FC<WorldPlotProps> = ({ object, isDarkMode }) => {
  const [hovered, setHovered] = useState(false);
  const setSelectedObject = useWorldStore((state) => state.setSelectedObject);

  const handleClick = (e: any) => {
    e.stopPropagation();
    setSelectedObject(object);
  };

  const width = object.width || 10;
  const length = object.length || 10;
  const height = object.height || 0.1;

  // Center the plot (origin is usually corner for plots but let's assume centered for now)
  // Or if plots are defined by center x/z, then we are good.
  const position: [number, number, number] = [object.x, object.y + height / 2, object.z];

  return (
    <group position={position} rotation={[0, object.rotation || 0, 0]}>
      <mesh
        onClick={handleClick}
        onPointerOver={() => setHovered(true)}
        onPointerOut={() => setHovered(false)}
      >
        <boxGeometry args={[width, height, length]} />
        <meshStandardMaterial
          color={object.color}
          transparent
          opacity={0.8}
          emissive={object.color}
          emissiveIntensity={hovered ? 0.5 : 0.1}
        />
      </mesh>
      
      {/* Label on hover */}
      {hovered && (
        <Html position={[0, height + 1, 0]} center>
          <div className="bg-black/80 text-white px-2 py-1 rounded text-xs whitespace-nowrap pointer-events-none">
            Plot owned by {object.ownerAgentId.slice(0, 8)}...
          </div>
        </Html>
      )}
    </group>
  );
};

export default WorldPlot;
