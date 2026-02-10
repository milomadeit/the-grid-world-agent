import React, { useState } from 'react';
import { Html } from '@react-three/drei';
import { WorldObject } from '../../types';
import { useWorldStore } from '../../store';

interface WorldSphereProps {
  object: WorldObject;
  isDarkMode?: boolean;
}

const WorldSphere: React.FC<WorldSphereProps> = ({ object, isDarkMode }) => {
  const [hovered, setHovered] = useState(false);
  const setSelectedObject = useWorldStore((state) => state.setSelectedObject);

  const handleClick = (e: any) => {
    e.stopPropagation();
    setSelectedObject(object);
  };

  const radius = object.radius || 1;

  // Spheres sit on ground, so y = radius
  const position: [number, number, number] = [object.x, object.y + radius, object.z];

  return (
    <group position={position}>
      <mesh
        onClick={handleClick}
        onPointerOver={() => setHovered(true)}
        onPointerOut={() => setHovered(false)}
      >
        <sphereGeometry args={[radius, 32, 32]} />
        <meshStandardMaterial
          color={object.color}
          transparent
          opacity={0.9}
          emissive={object.color}
          emissiveIntensity={hovered ? 0.6 : 0.2}
          roughness={0.2}
          metalness={0.8}
        />
      </mesh>
      
      {/* Label on hover */}
      {hovered && (
        <Html position={[0, radius + 1, 0]} center>
          <div className="bg-black/80 text-white px-2 py-1 rounded text-xs whitespace-nowrap pointer-events-none">
            Sphere owned by {object.ownerAgentId.slice(0, 8)}...
          </div>
        </Html>
      )}
    </group>
  );
};

export default WorldSphere;
