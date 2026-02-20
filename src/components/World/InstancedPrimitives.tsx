/// <reference types="@react-three/fiber" />
import React, { useRef, useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { ThreeEvent } from '@react-three/fiber';
import { useWorldStore } from '../../store';
import { WorldPrimitive as PrimitiveType } from '../../types';

// --- Module-level shared resources ---

const geometryCache = new Map<string, THREE.BufferGeometry>();

function getGeometry(shape: string): THREE.BufferGeometry {
  let geo = geometryCache.get(shape);
  if (geo) return geo;

  switch (shape) {
    case 'box':          geo = new THREE.BoxGeometry(1, 1, 1); break;
    case 'sphere':       geo = new THREE.SphereGeometry(0.5, 32, 32); break;
    case 'cylinder':     geo = new THREE.CylinderGeometry(0.5, 0.5, 1, 32); break;
    case 'cone':         geo = new THREE.ConeGeometry(0.5, 1, 32); break;
    case 'plane':        geo = new THREE.PlaneGeometry(1, 1); break;
    case 'torus':        geo = new THREE.TorusGeometry(0.5, 0.2, 16, 32); break;
    case 'circle':       geo = new THREE.CircleGeometry(0.5, 32); break;
    case 'dodecahedron': geo = new THREE.DodecahedronGeometry(0.5, 0); break;
    case 'icosahedron':  geo = new THREE.IcosahedronGeometry(0.5, 0); break;
    case 'octahedron':   geo = new THREE.OctahedronGeometry(0.5, 0); break;
    case 'ring':         geo = new THREE.RingGeometry(0.25, 0.5, 32); break;
    case 'tetrahedron':  geo = new THREE.TetrahedronGeometry(0.5, 0); break;
    case 'torusKnot':    geo = new THREE.TorusKnotGeometry(0.4, 0.15, 64, 16); break;
    case 'capsule':      geo = new THREE.CapsuleGeometry(0.3, 0.5, 16, 32); break;
    default:             geo = new THREE.BoxGeometry(1, 1, 1); break;
  }

  geometryCache.set(shape, geo);
  return geo;
}

// Single material shared across all instanced meshes.
// Per-instance colour via instanceColor (multiplied with material.color = white).
const sharedMaterial = new THREE.MeshStandardMaterial({
  roughness: 0.7,
  metalness: 0.1,
});

// Scratch objects reused in imperative updates (avoids per-frame allocation)
const _obj = new THREE.Object3D();
const _color = new THREE.Color();
const _white = new THREE.Color(0xffffff);

// --- Components ---

/** Renders every instance of one shape type as a single draw call. */
function ShapeInstances({
  shape,
  primitives,
  selectedId,
  onSelect,
}: {
  shape: string;
  primitives: PrimitiveType[];
  selectedId: string | null;
  onSelect: (prim: PrimitiveType) => void;
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null!);
  const geometry = useMemo(() => getGeometry(shape), [shape]);

  // Grow-only capacity: starts at 2x count (min 16), doubles when exceeded.
  // This avoids recreating the InstancedMesh on every single primitive add.
  const capacityRef = useRef(Math.max(primitives.length * 2, 16));
  if (primitives.length > capacityRef.current) {
    capacityRef.current = primitives.length * 2;
  }
  const capacity = capacityRef.current;

  // Imperatively write transforms + colours (bypasses React child diffing)
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh || primitives.length === 0) return;

    for (let i = 0; i < primitives.length; i++) {
      const p = primitives[i];

      _obj.position.set(p.position.x, p.position.y, p.position.z);
      _obj.rotation.set(p.rotation.x, p.rotation.y, p.rotation.z);
      _obj.scale.set(p.scale.x, p.scale.y, p.scale.z);
      _obj.updateMatrix();
      mesh.setMatrixAt(i, _obj.matrix);

      _color.set(p.color);
      if (p.id === selectedId) {
        _color.lerp(_white, 0.35); // brighten selected (simulates emissive)
      }
      mesh.setColorAt(i, _color);
    }

    mesh.count = primitives.length;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [primitives, selectedId, capacity]);

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (e.instanceId !== undefined && e.instanceId < primitives.length) {
      onSelect(primitives[e.instanceId]);
    }
  };

  if (primitives.length === 0) return null;

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, sharedMaterial, capacity]}
      onClick={handleClick}
      castShadow
      receiveShadow
    />
  );
}

/**
 * Replaces the per-primitive <WorldPrimitive> map in WorldScene.
 *
 * Instead of 100k React components and 100k draw calls, this groups
 * primitives by shape and renders at most 14 InstancedMeshes with
 * imperative matrix/colour updates.  Result: ~14 draw calls and zero
 * React diffing on the primitives subtree.
 */
function InstancedPrimitives() {
  const worldPrimitives = useWorldStore((s) => s.worldPrimitives);
  const selectedPrimitive = useWorldStore((s) => s.selectedPrimitive);
  const setSelectedPrimitive = useWorldStore((s) => s.setSelectedPrimitive);

  const groups = useMemo(() => {
    const map = new Map<string, PrimitiveType[]>();
    for (const prim of worldPrimitives) {
      let list = map.get(prim.shape);
      if (!list) {
        list = [];
        map.set(prim.shape, list);
      }
      list.push(prim);
    }
    return map;
  }, [worldPrimitives]);

  return (
    <>
      {Array.from(groups.entries()).map(([shape, prims]) => (
        <ShapeInstances
          key={shape}
          shape={shape}
          primitives={prims}
          selectedId={selectedPrimitive?.id ?? null}
          onSelect={setSelectedPrimitive}
        />
      ))}
    </>
  );
}

export default React.memo(InstancedPrimitives);
