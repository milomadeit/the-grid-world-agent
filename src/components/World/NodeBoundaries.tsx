/// <reference types="@react-three/fiber" />
import React, { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import * as THREE from 'three';
import { useWorldStore } from '../../store';
import '../../types';

// --- Tier visual config ---

interface TierStyle {
  color: string;
  opacity: number;
}

const TIER_STYLES: Record<string, TierStyle> = {
  'server-node':      { color: '#38bdf8', opacity: 0.35 },
  'forest-node':      { color: '#34d399', opacity: 0.40 },
  'city-node':        { color: '#a78bfa', opacity: 0.50 },
  'metropolis-node':  { color: '#a78bfa', opacity: 0.55 },
  'megaopolis-node':  { color: '#f59e0b', opacity: 0.60 },
};

const DEFAULT_STYLE: TierStyle = { color: '#6b7280', opacity: 0.25 };

const MIN_RENDER_TIER = 'server-node';
const TIER_RANK: Record<string, number> = {
  'settlement-node': 0,
  'server-node': 1,
  'forest-node': 2,
  'city-node': 3,
  'metropolis-node': 4,
  'megaopolis-node': 5,
};

function getTierStyle(tier: string): TierStyle {
  return TIER_STYLES[tier] || DEFAULT_STYLE;
}

function formatTier(tier: string): string {
  return tier.replace(/-node$/, '');
}

function shouldRender(tier: string): boolean {
  return (TIER_RANK[tier] ?? 0) >= (TIER_RANK[MIN_RENDER_TIER] ?? 1);
}

// --- Thin ring boundary ---

interface NodeRingProps {
  center: { x: number; z: number };
  radius: number;
  name: string;
  tier: string;
}

const RING_SEGMENTS = 128;
const PULSE_SPEED = 0.4;

const NodeRing: React.FC<NodeRingProps> = React.memo(({ center, radius, name, tier }) => {
  const style = getTierStyle(tier);
  const ringMatRef = useRef<THREE.ShaderMaterial>(null);
  const fillMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const tierRank = TIER_RANK[tier] ?? 0;

  // Thin stroke — 1px-feeling line at world scale
  const strokeWidth = Math.max(0.4, Math.min(1.2, radius * 0.005));
  const innerR = radius - strokeWidth * 0.5;
  const outerR = radius + strokeWidth * 0.5;

  // Ring shader — thin crisp line with very subtle outer softness
  const ringShader = useMemo(() => {
    const col = new THREE.Color(style.color);
    return {
      uniforms: {
        uColor: { value: col },
        uOpacity: { value: style.opacity },
        uTime: { value: 0 },
        uInner: { value: innerR },
        uOuter: { value: outerR },
      },
      vertexShader: /* glsl */ `
        varying float vDist;
        void main() {
          vDist = length(position.xy);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uOpacity;
        uniform float uTime;
        uniform float uInner;
        uniform float uOuter;
        varying float vDist;

        void main() {
          float mid = (uInner + uOuter) * 0.5;
          float hw = (uOuter - uInner) * 0.5;
          float d = abs(vDist - mid) / hw;

          // Sharp core + soft 1-pixel anti-alias fade
          float alpha = smoothstep(1.0, 0.6, d);

          // Soft outer bloom
          float bloom = exp(-1.5 * d * d) * 0.25;

          float pulse = 1.0 + sin(uTime) * 0.05;

          float final_a = (alpha + bloom) * uOpacity * pulse;
          gl_FragColor = vec4(uColor, final_a);
        }
      `,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    };
  }, [style.color, style.opacity, innerR, outerR]);

  // Animate
  useFrame((_, delta) => {
    if (ringMatRef.current) {
      ringMatRef.current.uniforms.uTime.value += delta * PULSE_SPEED;
    }
  });

  const labelFontSize = Math.max(1.5, Math.min(3.5, 1.0 + tierRank * 0.45));
  const labelHeight = Math.max(2, Math.min(6, 1.5 + tierRank));
  const label = `${name} · ${formatTier(tier)}`;

  // Very faint interior tint
  const fillOpacity = style.opacity * 0.04;

  return (
    <group position={[center.x, 0.05, center.z]}>
      {/* Thin stroke ring */}
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[innerR - strokeWidth, outerR + strokeWidth, RING_SEGMENTS]} />
        <shaderMaterial ref={ringMatRef} args={[ringShader]} />
      </mesh>

      {/* Barely-there interior fill */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]}>
        <circleGeometry args={[innerR, RING_SEGMENTS]} />
        <meshBasicMaterial
          ref={fillMatRef}
          color={style.color}
          transparent
          opacity={fillOpacity}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Label */}
      <Text
        position={[0, labelHeight, 0]}
        fontSize={labelFontSize}
        color={style.color}
        anchorX="center"
        anchorY="middle"
        fillOpacity={0.5}
        outlineWidth={0.04}
        outlineColor="#000000"
        outlineOpacity={0.4}
        maxWidth={radius * 1.8}
        font={undefined}
      >
        {label}
      </Text>
    </group>
  );
});

NodeRing.displayName = 'NodeRing';

// --- Main component ---

const NodeBoundaries: React.FC = () => {
  const nodes = useWorldStore((s) => s.nodes);

  const visibleNodes = useMemo(() => {
    if (!nodes || nodes.length === 0) return [];
    return nodes.filter(n => shouldRender(n.tier));
  }, [nodes]);

  if (visibleNodes.length === 0) return null;

  return (
    <group>
      {visibleNodes.map((node) => (
        <NodeRing
          key={node.id}
          center={node.center}
          radius={node.radius}
          name={node.name}
          tier={node.tier}
        />
      ))}
    </group>
  );
};

export default React.memo(NodeBoundaries);
