import React from 'react';
import { WorldPrimitive as PrimitiveType } from '../../types';
import * as THREE from 'three';

interface WorldPrimitiveProps {
  data: PrimitiveType;
  isSelected?: boolean;
  onClick?: (e: any) => void;
}

const WorldPrimitive: React.FC<WorldPrimitiveProps> = ({ data, isSelected, onClick }) => {
  const { shape, position, rotation, scale, color } = data;

  const material = (
    <meshStandardMaterial 
      color={color} 
      emissive={isSelected ? color : '#000000'}
      emissiveIntensity={isSelected ? 0.5 : 0}
      roughness={0.7}
      metalness={0.1}
    />
  );

  const commonProps = {
    position: [position.x, position.y, position.z] as [number, number, number],
    rotation: [rotation.x, rotation.y, rotation.z] as [number, number, number],
    scale: [scale.x, scale.y, scale.z] as [number, number, number],
    onClick: (e: any) => {
      e.stopPropagation();
      onClick?.(e);
    },
    castShadow: true,
    receiveShadow: true,
  };

  // Geometry factory — maps shape name to Three.js geometry JSX
  const renderGeometry = () => {
    switch (shape) {
      case 'box':
        return <boxGeometry args={[1, 1, 1]} />;
      case 'sphere':
        return <sphereGeometry args={[0.5, 32, 32]} />;
      case 'cylinder':
        return <cylinderGeometry args={[0.5, 0.5, 1, 32]} />;
      case 'cone':
        return <coneGeometry args={[0.5, 1, 32]} />;
      case 'plane':
        return <planeGeometry args={[1, 1]} />;
      case 'torus':
        return <torusGeometry args={[0.5, 0.2, 16, 32]} />;
      case 'circle':
        return <circleGeometry args={[0.5, 32]} />;
      case 'dodecahedron':
        return <dodecahedronGeometry args={[0.5, 0]} />;
      case 'icosahedron':
        return <icosahedronGeometry args={[0.5, 0]} />;
      case 'octahedron':
        return <octahedronGeometry args={[0.5, 0]} />;
      case 'ring':
        return <ringGeometry args={[0.25, 0.5, 32]} />;
      case 'tetrahedron':
        return <tetrahedronGeometry args={[0.5, 0]} />;
      case 'torusKnot':
        return <torusKnotGeometry args={[0.4, 0.15, 64, 16]} />;
      case 'capsule':
        return <capsuleGeometry args={[0.3, 0.5, 16, 32]} />;
      default:
        return <boxGeometry args={[1, 1, 1]} />;
    }
  };

  return (
    <mesh {...commonProps}>
      {renderGeometry()}
      {material}
    </mesh>
  );
};

export default WorldPrimitive;
