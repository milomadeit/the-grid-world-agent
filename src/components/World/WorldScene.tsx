
/// <reference types="@react-three/fiber" />
import React, { Suspense, useRef, useEffect } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Html } from '@react-three/drei';
import InfiniteGrid from './InfiniteGrid';
import AgentBlob from './AgentBlob';
import InstancedPrimitives from './InstancedPrimitives';
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
  mapView?: boolean;
}

interface CameraControlsProps {
  cameraLocked?: boolean;
  mapView?: boolean;
}


const CameraControls: React.FC<CameraControlsProps> = ({ cameraLocked, mapView }) => {
  const controlsRef = useRef<any>(null);
  const followAgentId = useWorldStore((state) => state.followAgentId);
  const agents = useWorldStore((state) => state.agents);
  const setFollowAgentId = useWorldStore((state) => state.setFollowAgentId);

  const targetAgent = agents.find(a => a.id === followAgentId);
  const targetPosition = targetAgent?.targetPosition;

  // Track currently held arrow keys
  const keysPressed = useRef<Set<string>>(new Set());

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
        keysPressed.current.add(e.key);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      keysPressed.current.delete(e.key);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  // Locked mode: Left/Right arrows cycle through agents
  useEffect(() => {
    if (!cameraLocked) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const currentAgents = useWorldStore.getState().agents;
      const currentFollow = useWorldStore.getState().followAgentId;
      if (currentAgents.length === 0) return;
      const idx = currentAgents.findIndex(a => a.id === currentFollow);
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      const nextIdx = (idx + dir + currentAgents.length) % currentAgents.length;
      setFollowAgentId(currentAgents[nextIdx].id);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [cameraLocked, setFollowAgentId]);

  useFrame(({ camera }, delta) => {
    if (controlsRef.current && cameraLocked && targetPosition) {
      const targetVec = new THREE.Vector3(targetPosition.x, 0, targetPosition.z);
      controlsRef.current.target.lerp(targetVec, 0.25);

      if (mapView) {
        // Top-down map view: camera directly above, looking straight down
        const mapCamPos = new THREE.Vector3(targetPosition.x, 200, targetPosition.z);
        camera.position.lerp(mapCamPos, 0.25);
      }

      controlsRef.current.update();
    }

    // Unlocked mode: arrow keys pan the camera
    if (controlsRef.current && !cameraLocked && keysPressed.current.size > 0) {
      const dist = camera.position.distanceTo(controlsRef.current.target);
      const speed = dist * 0.8;
      const forward = new THREE.Vector3();
      camera.getWorldDirection(forward);
      forward.y = 0;
      forward.normalize();
      const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

      const move = new THREE.Vector3();
      const fwdScale = 1.4; // boost forward/back to compensate for perspective foreshortening
      if (keysPressed.current.has('ArrowUp')) move.addScaledVector(forward, fwdScale);
      if (keysPressed.current.has('ArrowDown')) move.addScaledVector(forward, -fwdScale);
      if (keysPressed.current.has('ArrowRight')) move.add(right);
      if (keysPressed.current.has('ArrowLeft')) move.sub(right);

      if (move.lengthSq() > 0) {
        move.normalize().multiplyScalar(speed * delta);
        camera.position.add(move);
        controlsRef.current.target.add(move);
        controlsRef.current.update();
      }
    }
  });

  if (mapView) {
    // Map mode: lock rotation, force top-down
    return (
      <OrbitControls
        ref={controlsRef}
        enableDamping
        dampingFactor={0.1}
        enableRotate={false}
        enablePan={false}
        enableZoom={false}
        maxPolarAngle={0}
        minPolarAngle={0}
      />
    );
  }

  return (
    <OrbitControls
      ref={controlsRef}
      enableDamping
      dampingFactor={0.05}
      rotateSpeed={1.0}
      panSpeed={1.0}
      maxPolarAngle={Math.PI / 2.6}
      minDistance={10}
      maxDistance={1200}
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

const WorldScene: React.FC<WorldSceneProps> = ({ playerAgentId, isDarkMode, onGridClick, onAgentDoubleClick, cameraLocked, mapView }) => {
  const bgColor = isDarkMode ? COLORS.GROUND_DARK : COLORS.GROUND;

  // Read agents directly from the store — avoids re-renders from App passing new array refs
  const agents = useWorldStore((state) => state.agents);
  const selectedPrimitive = useWorldStore((state) => state.selectedPrimitive);

  return (
    <div className="w-full h-full cursor-crosshair">
      <Canvas
        shadows
        camera={{ position: [60, 60, 60], fov: 20, near: 5, far: 3000 }}
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
          mapView={mapView}
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

          <InstancedPrimitives />

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
