/// <reference types="@react-three/fiber" />
import React, { useRef, useMemo } from 'react';
import * as THREE from 'three';
import { ThreeEvent, useFrame } from '@react-three/fiber';
import { useWorldStore } from '../../store';
import { WorldPrimitive as PrimitiveType } from '../../types';

// --- Module-level shared resources ---

const geometryCache = new Map<string, THREE.BufferGeometry>();

function normalizeShape(shape: string): string {
  switch ((shape || '').toLowerCase()) {
    case 'torus-knot':
    case 'torus_knot':
    case 'torusknot':
      return 'torusKnot';
    case 'dodeca':
      return 'dodecahedron';
    case 'icosa':
      return 'icosahedron';
    case 'octa':
      return 'octahedron';
    default:
      return shape;
  }
}

function getGeometry(shape: string): THREE.BufferGeometry {
  const normalizedShape = normalizeShape(shape);
  let geo = geometryCache.get(normalizedShape);
  if (geo) return geo;

  switch (normalizedShape) {
    case 'box':          geo = new THREE.BoxGeometry(1, 1, 1); break;
    case 'sphere':       geo = new THREE.SphereGeometry(0.5, 16, 12); break;
    case 'cylinder':     geo = new THREE.CylinderGeometry(0.5, 0.5, 1, 16); break;
    case 'cone':         geo = new THREE.ConeGeometry(0.5, 1, 16); break;
    case 'plane':        geo = new THREE.PlaneGeometry(1, 1); break;
    case 'torus':        geo = new THREE.TorusGeometry(0.5, 0.2, 12, 18); break;
    case 'circle':       geo = new THREE.CircleGeometry(0.5, 24); break;
    case 'dodecahedron': geo = new THREE.DodecahedronGeometry(0.5, 0); break;
    case 'icosahedron':  geo = new THREE.IcosahedronGeometry(0.5, 0); break;
    case 'octahedron':   geo = new THREE.OctahedronGeometry(0.5, 0); break;
    case 'ring':         geo = new THREE.RingGeometry(0.25, 0.5, 24); break;
    case 'tetrahedron':  geo = new THREE.TetrahedronGeometry(0.5, 0); break;
    case 'torusKnot':    geo = new THREE.TorusKnotGeometry(0.4, 0.15, 32, 8); break;
    case 'capsule':      geo = new THREE.CapsuleGeometry(0.3, 0.5, 8, 12); break;
    default:             geo = new THREE.BoxGeometry(1, 1, 1); break;
  }

  geometryCache.set(normalizedShape, geo);
  return geo;
}

type PrimitiveMaterialType = 'standard' | 'stone' | 'metal' | 'glass' | 'crystal' | 'organic';

function normalizeMaterialType(materialType?: string | null): PrimitiveMaterialType {
  switch (materialType) {
    case 'stone':
    case 'metal':
    case 'glass':
    case 'crystal':
    case 'organic':
      return materialType;
    default:
      return 'standard';
  }
}

const MATERIAL_PRESETS: Record<PrimitiveMaterialType, THREE.MeshStandardMaterial> = {
  standard: new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0.1 }),
  stone: new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.0 }),
  metal: new THREE.MeshStandardMaterial({ roughness: 0.25, metalness: 0.85 }),
  glass: new THREE.MeshStandardMaterial({
    roughness: 0.05,
    metalness: 0.1,
    transparent: true,
    opacity: 0.6,
  }),
  crystal: new THREE.MeshStandardMaterial({
    roughness: 0.1,
    metalness: 0.2,
    emissive: new THREE.Color('#3b82f6'),
    emissiveIntensity: 0.35,
  }),
  organic: new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0.0 }),
};

// Scratch objects reused in imperative updates (avoids per-frame allocation)
const _obj = new THREE.Object3D();
const _color = new THREE.Color();
const _white = new THREE.Color(0xffffff);

// --- Components ---

/** Renders every instance of one shape type as a single draw call. */
function ShapeInstances({
  shape,
  materialType,
  primitives,
  selectedId,
  onSelect,
}: {
  shape: string;
  materialType: PrimitiveMaterialType;
  primitives: PrimitiveType[];
  selectedId: string | null;
  onSelect: (prim: PrimitiveType) => void;
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null!);
  const geometry = useMemo(() => getGeometry(shape), [shape]);
  const material = useMemo(() => MATERIAL_PRESETS[materialType], [materialType]);

  // Grow-only capacity: starts at 2x count (min 256), doubles when exceeded.
  // High minimum avoids frequent InstancedMesh recreation during blueprint building.
  const capacityRef = useRef(Math.max(primitives.length * 2, 256));
  if (primitives.length > capacityRef.current) {
    capacityRef.current = primitives.length * 2;
  }
  const capacity = capacityRef.current;

  // Track last-written state to skip redundant GPU uploads in useFrame.
  const lastWrittenRef = useRef<{
    prims: PrimitiveType[];
    selectedId: string | null;
    mesh: THREE.InstancedMesh | null;
  }>({ prims: [], selectedId: null, mesh: null });

  // Write transforms + colours in the render loop so data is guaranteed to be
  // set before Three.js draws — even when the InstancedMesh is recreated due
  // to capacity growth (eliminates the blank-frame glitch from useEffect).
  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const last = lastWrittenRef.current;
    const meshChanged = mesh !== last.mesh;
    if (!meshChanged && last.prims === primitives && last.selectedId === selectedId) return;

    last.prims = primitives;
    last.selectedId = selectedId;
    last.mesh = mesh;

    if (primitives.length === 0) {
      mesh.count = 0;
      return;
    }

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
  });

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
      args={[geometry, material, capacity]}
      onClick={handleClick}
      castShadow
      receiveShadow
      dispose={null}
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
    const map = new Map<string, { shape: string; materialType: PrimitiveMaterialType; primitives: PrimitiveType[] }>();
    for (const prim of worldPrimitives) {
      const materialType = normalizeMaterialType(prim.materialType);
      const key = `${prim.shape}__${materialType}`;
      let group = map.get(key);
      if (!group) {
        group = { shape: prim.shape, materialType, primitives: [] };
        map.set(key, group);
      }
      group.primitives.push(prim);
    }
    return map;
  }, [worldPrimitives]);

  return (
    <>
      {Array.from(groups.entries()).map(([key, group]) => (
        <ShapeInstances
          key={key}
          shape={group.shape}
          materialType={group.materialType}
          primitives={group.primitives}
          selectedId={selectedPrimitive?.id ?? null}
          onSelect={setSelectedPrimitive}
        />
      ))}
    </>
  );
}

export default React.memo(InstancedPrimitives);
