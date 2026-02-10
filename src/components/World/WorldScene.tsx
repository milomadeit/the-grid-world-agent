
/// <reference types="@react-three/fiber" />
import React, { Suspense, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import InfiniteGrid from './InfiniteGrid';
import AgentBlob from './AgentBlob';
import WorldPlot from './WorldPlot';
import WorldSphere from './WorldSphere';
import Terminal3D from './Terminal3D';
import { useWorldStore } from '../../store';

import { Agent, Vector3 } from '../../types';
import { COLORS } from '../../constants';
import * as THREE from 'three';

interface WorldSceneProps {
  agents: Agent[];
  playerAgentId?: string;
  isDarkMode?: boolean;
  onGridClick?: (pos: Vector3) => void;
  onAgentDoubleClick?: (agent: Agent) => void;
  cameraLocked?: boolean;
}

interface CameraControlsProps {
  playerPosition?: Vector3;
  cameraLocked?: boolean;
}

const CameraControls: React.FC<CameraControlsProps> = ({ playerPosition, cameraLocked }) => {
  const controlsRef = useRef<any>(null);

  useFrame(() => {
    if (controlsRef.current && cameraLocked && playerPosition) {
      const targetVec = new THREE.Vector3(playerPosition.x, 0, playerPosition.z);
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

const WorldScene: React.FC<WorldSceneProps> = ({ agents, playerAgentId, isDarkMode, onGridClick, onAgentDoubleClick, cameraLocked }) => {
  const bgColor = isDarkMode ? COLORS.GROUND_DARK : COLORS.GROUND;

  const worldObjects = useWorldStore((state) => state.worldObjects);
  const toggleTerminal = useWorldStore((state) => state.toggleTerminal);

  const playerAgent = agents.find(a => a.id === playerAgentId);
  const playerPosition = playerAgent?.targetPosition;

  return (
    <div className="w-full h-full cursor-crosshair">
      <Canvas
        shadows
        camera={{ position: [60, 60, 60], fov: 20, near: 1, far: 2000 }}
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
          playerPosition={playerPosition}
          cameraLocked={cameraLocked}
        />

        <Suspense fallback={null}>
          {/* Ground plane for click events - matches background exactly */}
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

          <Terminal3D onTerminalClick={toggleTerminal} />

          {worldObjects.map((obj) => {
            if (obj.type === 'plot') {
              return <WorldPlot key={obj.id} object={obj} isDarkMode={isDarkMode} />;
            } else if (obj.type === 'sphere') {
              return <WorldSphere key={obj.id} object={obj} isDarkMode={isDarkMode} />;
            }
            return null;
          })}



          {agents.map((agent) => (
            <AgentBlob
              key={agent.id}
              agent={agent}
              isPlayer={agent.id === playerAgentId}
              isDarkMode={isDarkMode}
              onDoubleClick={onAgentDoubleClick}
            />
          ))}
        </Suspense>
      </Canvas>
    </div>
  );
};

export default WorldScene;
