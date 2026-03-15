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

// Starcraft-style territory colors — higher tiers glow brighter
const TIER_STYLES: Record<string, TierStyle> = {
  'server-node':      { color: '#38bdf8', opacity: 0.18 },  // sky blue
  'forest-node':      { color: '#34d399', opacity: 0.22 },  // emerald
  'city-node':        { color: '#fbbf24', opacity: 0.30 },  // amber
  'metropolis-node':  { color: '#a78bfa', opacity: 0.38 },  // violet
  'megaopolis-node':  { color: '#f59e0b', opacity: 0.45 },  // gold
};

const DEFAULT_STYLE: TierStyle = { color: '#6b7280', opacity: 0.15 };

// Minimum tier to render — skip settlement-node (too many, too small)
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

// --- Single node boundary ring ---

interface NodeRingProps {
  center: { x: number; z: number };
  radius: number;
  name: string;
  tier: string;
}

const RING_SEGMENTS = 96;
const PULSE_SPEED = 0.8;
const PULSE_AMPLITUDE = 0.06;

const NodeRing: React.FC<NodeRingProps> = React.memo(({ center, radius, name, tier }) => {
  const style = getTierStyle(tier);
  const materialRef = useRef<THREE.ShaderMaterial>(null);
  const tierRank = TIER_RANK[tier] ?? 0;

  // Ring width scales with node size — bigger nodes get thicker rings
  const ringWidth = Math.max(1.0, Math.min(3.5, radius * 0.04));
  const innerRadius = Math.max(0.5, radius - ringWidth / 2);
  const outerRadius = radius + ringWidth / 2;

  // Custom shader for soft glowing ring with radial falloff
  const shaderArgs = useMemo(() => {
    const baseColor = new THREE.Color(style.color);
    return {
      uniforms: {
        uColor: { value: baseColor },
        uOpacity: { value: style.opacity },
        uTime: { value: 0 },
        uInnerRadius: { value: innerRadius },
        uOuterRadius: { value: outerRadius },
      },
      vertexShader: /* glsl */ `
        varying float vRadius;
        void main() {
          vRadius = length(position.xz);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uOpacity;
        uniform float uTime;
        uniform float uInnerRadius;
        uniform float uOuterRadius;

        varying float vRadius;

        void main() {
          float mid = (uInnerRadius + uOuterRadius) * 0.5;
          float halfWidth = (uOuterRadius - uInnerRadius) * 0.5;
          float dist = abs(vRadius - mid) / halfWidth;
          // Sharper edge, softer falloff for Starcraft territory look
          float alpha = smoothstep(1.0, 0.15, dist);

          // Subtle pulse
          float pulse = sin(uTime) * ${PULSE_AMPLITUDE.toFixed(4)};

          float finalAlpha = alpha * (uOpacity + pulse);
          gl_FragColor = vec4(uColor, finalAlpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    };
  }, [style.color, style.opacity, innerRadius, outerRadius]);

  // Animate pulse
  useFrame((_, delta) => {
    if (materialRef.current) {
      materialRef.current.uniforms.uTime.value += delta * PULSE_SPEED;
    }
  });

  // Label scales with tier importance
  const labelFontSize = Math.max(1.5, Math.min(4.0, 1.2 + tierRank * 0.5));
  const labelHeight = Math.max(3, Math.min(8, 2 + tierRank));
  const label = `${name} · ${formatTier(tier)}`;

  // Inner fill opacity scales with tier
  const fillOpacity = style.opacity * 0.12;

  return (
    <group position={[center.x, 0.05, center.z]}>
      {/* Glowing ring */}
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[innerRadius, outerRadius, RING_SEGMENTS]} />
        <shaderMaterial ref={materialRef} args={[shaderArgs]} />
      </mesh>

      {/* Inner territory fill — faint tint */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]}>
        <circleGeometry args={[innerRadius, RING_SEGMENTS]} />
        <meshBasicMaterial
          color={style.color}
          transparent
          opacity={fillOpacity}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Text label floating above center */}
      <Text
        position={[0, labelHeight, 0]}
        fontSize={labelFontSize}
        color={style.color}
        anchorX="center"
        anchorY="middle"
        fillOpacity={0.6}
        outlineWidth={0.06}
        outlineColor="#000000"
        outlineOpacity={0.5}
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

  // Filter: only render nodes above settlement tier
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
