
/// <reference types="@react-three/fiber" />
import React, { useRef, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import { Sphere, Text, Billboard } from '@react-three/drei';
import * as THREE from 'three';
import { Agent } from '../../types';
import { useWorldStore } from '../../store';
import { truncateAddress } from '../../utils/address';

interface AgentBlobProps {
  agent: Agent;
  isPlayer?: boolean;
  isDarkMode?: boolean;
  onDoubleClick?: (agent: Agent) => void;
}

const AgentBlob: React.FC<AgentBlobProps> = ({ agent, isPlayer, isDarkMode, onDoubleClick }) => {
  const groupRef = useRef<THREE.Group>(null);
  const meshRef = useRef<THREE.Mesh>(null);
  const glowRef = useRef<THREE.Mesh>(null);
  const updateAgent = useWorldStore(state => state.updateAgent);

  useEffect(() => {
    if (groupRef.current) {
      groupRef.current.position.set(agent.position.x, 0, agent.position.z);
    }
  }, []);

  useFrame((state) => {
    if (groupRef.current && meshRef.current) {
      const targetX = agent.targetPosition.x;
      const targetZ = agent.targetPosition.z;

      groupRef.current.position.x = THREE.MathUtils.lerp(groupRef.current.position.x, targetX, 0.15);
      groupRef.current.position.z = THREE.MathUtils.lerp(groupRef.current.position.z, targetZ, 0.15);

      const dx = targetX - groupRef.current.position.x;
      const dz = targetZ - groupRef.current.position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const isMoving = dist > 0.05;

      // Physics-based bobbing
      const bobFreq = isMoving ? 12 : 2.0;
      const bobAmp = isMoving ? 0.06 : 0.01;
      const bob = Math.abs(Math.sin(state.clock.elapsedTime * bobFreq)) * bobAmp;

      meshRef.current.position.y = 0.4 + bob;

      // Squash & Stretch
      const stretch = 1 + (isMoving ? bob * 1.5 : bob * 0.5);
      meshRef.current.scale.set(1/Math.sqrt(stretch), stretch, 1/Math.sqrt(stretch));

      // Rotation into movement
      if (isMoving) {
        meshRef.current.rotation.z = THREE.MathUtils.lerp(meshRef.current.rotation.z, -dx * 0.5, 0.2);
        meshRef.current.rotation.x = THREE.MathUtils.lerp(meshRef.current.rotation.x, dz * 0.5, 0.2);
      } else {
        meshRef.current.rotation.z = THREE.MathUtils.lerp(meshRef.current.rotation.z, 0, 0.1);
        meshRef.current.rotation.x = THREE.MathUtils.lerp(meshRef.current.rotation.x, 0, 0.1);
      }

      // Subtle glow ring pulse
      if (glowRef.current) {
        const pulse = 0.5 + Math.sin(state.clock.elapsedTime * 2) * 0.15;
        const mat = glowRef.current.material as THREE.MeshBasicMaterial;
        mat.opacity = pulse;
      }
    }
  });

  const hasIdentity = !!agent.erc8004AgentId;

  return (
    <group ref={groupRef} onDoubleClick={(e) => { e.stopPropagation(); onDoubleClick?.(agent); }}>
      {/* ERC-8004 identity ring - outer golden ring for verified agents */}
      {hasIdentity && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]} renderOrder={2}>
          <torusGeometry args={[0.62, 0.03, 16, 48]} />
          <meshBasicMaterial
            color="#F59E0B"
            transparent
            opacity={0.85}
            depthWrite={false}
          />
        </mesh>
      )}

      {/* Glow ring at feet - like Ralvi reference */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]} renderOrder={1}>
        <torusGeometry args={[0.5, 0.04, 16, 48]} />
        <meshBasicMaterial
          color={agent.color}
          transparent
          opacity={0.7}
          depthWrite={false}
        />
      </mesh>

      {/* Soft glow spill under agent */}
      <mesh ref={glowRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]} renderOrder={0}>
        <circleGeometry args={[0.55, 32]} />
        <meshBasicMaterial
          color={agent.color}
          transparent
          opacity={0.15}
          depthWrite={false}
        />
      </mesh>

      <mesh ref={meshRef}>
        <sphereGeometry args={[0.4, 32, 32]} />
        <meshBasicMaterial color={agent.color} />

        {/* Simple Face */}
        <group position={[0, 0.05, 0.35]}>
          <Sphere args={[0.045, 16, 16]} position={[-0.15, 0, 0]}>
            <meshBasicMaterial color="#0a0a0a" />
          </Sphere>
          <Sphere args={[0.045, 16, 16]} position={[0.15, 0, 0]}>
            <meshBasicMaterial color="#0a0a0a" />
          </Sphere>
        </group>
      </mesh>

      <Billboard
        follow={true}
        lockX={false}
        lockY={false}
        lockZ={false}
      >
        <Text
          position={[0, 1.35, 0]}
          fontSize={0.28}
          color={isDarkMode ? "#cbd5e1" : "#0f172a"}
          anchorX="center"
          anchorY="middle"
          renderOrder={100}
          font="https://fonts.gstatic.com/s/inter/v12/UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMw2boKoduKmMEVuLyfMZhrib2Bg-4.ttf"
        >
          {truncateAddress(agent.name)} {isPlayer ? '•' : ''}
        </Text>
      </Billboard>
    </group>
  );
};

export default AgentBlob;
