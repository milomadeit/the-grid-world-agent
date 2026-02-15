
/// <reference types="@react-three/fiber" />
import React, { Suspense, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Html } from '@react-three/drei';
import InfiniteGrid from './InfiniteGrid';
import AgentBlob from './AgentBlob';
import WorldPrimitive from './WorldPrimitive';
import Terminal3D from './Terminal3D';
import ObjectInfoModal from '../UI/ObjectInfoModal';
import { useWorldStore } from '../../store';

import { Agent, Vector3 } from '../../types';
import { COLORS } from '../../constants';
import * as THREE from 'three';

interface WorldSceneProps {
  playerAgentId?: string;
  isDarkMode?: boolean;
  onGridClick?: (pos: Vector3) => void;
  onAgentDoubleClick?: (agent: Agent) => void;
  cameraLocked?: boolean;
}

interface CameraControlsProps {
  cameraLocked?: boolean;
}

const CameraControls: React.FC<CameraControlsProps> = ({ cameraLocked }) => {
  const controlsRef = useRef<any>(null);
  const followAgentId = useWorldStore((state) => state.followAgentId);
  const agents = useWorldStore((state) => state.agents);

  const targetAgent = agents.find(a => a.id === followAgentId);
  const targetPosition = targetAgent?.targetPosition;

  useFrame(() => {
    if (controlsRef.current && cameraLocked && targetPosition) {
      const targetVec = new THREE.Vector3(targetPosition.x, 0, targetPosition.z);
      controlsRef.current.target.lerp(targetVec, 0.25);
      controlsRef.current.update();
    }
  });

  return (
    <OrbitControls
      ref={controlsRef}
      enableDamping
      dampingFactor={0.05}
      rotateSpeed={1.0}
      panSpeed={1.0}
      maxPolarAngle={Math.PI / 2.6}
      minDistance={10}
      maxDistance={500}
      enablePan={!cameraLocked}
      screenSpacePanning={false}
      mouseButtons={{
        LEFT: THREE.MOUSE.ROTATE,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: THREE.MOUSE.PAN
      }}
    />
  );
};

const WorldScene: React.FC<WorldSceneProps> = ({ playerAgentId, isDarkMode, onGridClick, onAgentDoubleClick, cameraLocked }) => {
  const bgColor = isDarkMode ? COLORS.GROUND_DARK : COLORS.GROUND;

  // Read agents directly from the store — avoids re-renders from App passing new array refs
  const agents = useWorldStore((state) => state.agents);
  const worldPrimitives = useWorldStore((state) => state.worldPrimitives);
  const selectedPrimitive = useWorldStore((state) => state.selectedPrimitive);
  const setSelectedPrimitive = useWorldStore((state) => state.setSelectedPrimitive);

  return (
    <div className="w-full h-full cursor-crosshair">
      <Canvas
        shadows
        camera={{ position: [60, 60, 60], fov: 20, near: 5, far: 1500 }}
        gl={{
          antialias: true,
          alpha: false,
          powerPreference: "high-performance",
          stencil: false,
          depth: true
        }}
      >
        <color attach="background" args={[bgColor]} />

        {/* Even, flat lighting - no directional bias */}
        <ambientLight intensity={isDarkMode ? 0.8 : 1.0} color="#ffffff" />

        <CameraControls
          cameraLocked={cameraLocked}
        />

        <Suspense fallback={null}>
          {/* Ground plane for click events - transparent but visible for raycasting */}
          <mesh
            rotation={[-Math.PI / 2, 0, 0]}
            position={[0, -0.02, 0]}
            onDoubleClick={(e) => {
              e.stopPropagation();
              if (onGridClick && e.point) {
                onGridClick({
                  x: Math.round(e.point.x),
                  y: 0,
                  z: Math.round(e.point.z)
                });
              }
            }}
          >
            <planeGeometry args={[4000, 4000]} />
            <meshBasicMaterial color={bgColor} />
          </mesh>


          <InfiniteGrid isDarkMode={isDarkMode} />

          <Terminal3D />

          {worldPrimitives.map((prim) => (
            <WorldPrimitive
              key={prim.id}
              data={prim}
              isSelected={selectedPrimitive?.id === prim.id}
              onClick={() => setSelectedPrimitive(prim)}
            />
          ))}

          {agents.map((agent) => (
            <AgentBlob
              key={agent.id}
              agent={agent}
              isPlayer={agent.id === playerAgentId}
              isDarkMode={isDarkMode}
              onDoubleClick={onAgentDoubleClick}
            />
          ))}

          {selectedPrimitive && selectedPrimitive.id !== 'system-terminal' && (
            <Html
              position={[
                selectedPrimitive.position.x + 1.5,
                selectedPrimitive.position.y + (selectedPrimitive.scale.y / 2) + 0.5,
                selectedPrimitive.position.z
              ]}
              center
              sprite
              transform
              zIndexRange={[100, 0]}
              style={{
                pointerEvents: 'auto',
                userSelect: 'none',
              }}
            >
              <ObjectInfoModal />
            </Html>
          )}
        </Suspense>
      </Canvas>
    </div>
  );
};

export default React.memo(WorldScene);
