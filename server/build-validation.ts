export interface ValidationResult {
  valid: boolean;
  correctedY?: number;
  error?: string;
}

export const EXEMPT_SHAPES = new Set(['plane', 'circle']);
export const SNAP_TOLERANCE = 0.25;
export const OVERLAP_TOLERANCE = 0.05; // allow touching but not intersecting

type Vec3 = { x: number; y: number; z: number };
type Scale3 = { x: number; y: number; z: number };

type PrimitiveLike = {
  position: Vec3;
  scale: Scale3;
  shape: string;
};

/** Check if two axis-aligned bounding boxes overlap (with tolerance). */
export function boxesOverlap(a: Vec3, aScale: Scale3, b: Vec3, bScale: Scale3): boolean {
  const overlapX = Math.abs(a.x - b.x) < (aScale.x / 2 + bScale.x / 2 - OVERLAP_TOLERANCE);
  const overlapY = Math.abs(a.y - b.y) < (aScale.y / 2 + bScale.y / 2 - OVERLAP_TOLERANCE);
  const overlapZ = Math.abs(a.z - b.z) < (aScale.z / 2 + bScale.z / 2 - OVERLAP_TOLERANCE);
  return overlapX && overlapY && overlapZ;
}

function overlapXZ(aPos: Vec3, aScale: Scale3, bPos: Vec3, bScale: Scale3): boolean {
  const overlapX = Math.abs(aPos.x - bPos.x) < (aScale.x / 2 + bScale.x / 2);
  const overlapZ = Math.abs(aPos.z - bPos.z) < (aScale.z / 2 + bScale.z / 2);
  return overlapX && overlapZ;
}

function findFirstOverlap(
  position: Vec3,
  scale: Scale3,
  existingPrimitives: PrimitiveLike[],
): PrimitiveLike | null {
  for (const existing of existingPrimitives) {
    if (EXEMPT_SHAPES.has(existing.shape)) continue;
    if (boxesOverlap(position, scale, existing.position, existing.scale)) {
      return existing;
    }
  }
  return null;
}

export function validateBuildPosition(
  shape: string,
  position: Vec3,
  scale: Scale3,
  existingPrimitives: PrimitiveLike[]
): ValidationResult {
  // Exempt shapes skip validation (roofs, signs, decorative planes)
  if (EXEMPT_SHAPES.has(shape)) {
    return { valid: true };
  }

  const requestedCenterY = position.y;
  const requestedBottomEdge = position.y - scale.y / 2;

  // Candidate support surfaces near the requested bottom edge.
  const candidates: Array<{ surfaceY: number; kind: 'ground' | 'primitive'; prim?: PrimitiveLike }> = [];

  // Ground surface at y=0 (only if within snap tolerance).
  if (Math.abs(requestedBottomEdge - 0) <= SNAP_TOLERANCE) {
    candidates.push({ surfaceY: 0, kind: 'ground' });
  }

  // Top surfaces of XZ-overlapping primitives (only if within snap tolerance).
  for (const existing of existingPrimitives) {
    if (EXEMPT_SHAPES.has(existing.shape)) continue;
    const topY = existing.position.y + existing.scale.y / 2;
    if (Math.abs(requestedBottomEdge - topY) > SNAP_TOLERANCE) continue;
    if (!overlapXZ(position, scale, existing.position, existing.scale)) continue;
    candidates.push({ surfaceY: topY, kind: 'primitive', prim: existing });
  }

  // Evaluate candidates: snap to each, reject those that would overlap any existing primitive.
  const validCandidates: Array<{ correctedY: number; support: string }> = [];
  const rejectedOverlap: PrimitiveLike[] = [];

  for (const candidate of candidates) {
    const correctedY = candidate.surfaceY + scale.y / 2;
    const correctedPos = { x: position.x, y: correctedY, z: position.z };
    const overlapped = findFirstOverlap(correctedPos, scale, existingPrimitives);
    if (overlapped) {
      rejectedOverlap.push(overlapped);
      continue;
    }
    validCandidates.push({
      correctedY,
      support: candidate.kind === 'ground' ? 'ground' : 'top of existing shape',
    });
  }

  if (validCandidates.length > 0) {
    // Prefer the snapped Y closest to the requested center Y.
    let best = validCandidates[0]!;
    let bestDelta = Math.abs(best.correctedY - requestedCenterY);
    for (let i = 1; i < validCandidates.length; i++) {
      const cand = validCandidates[i]!;
      const delta = Math.abs(cand.correctedY - requestedCenterY);
      if (delta < bestDelta) {
        best = cand;
        bestDelta = delta;
      }
    }
    return { valid: true, correctedY: best.correctedY };
  }

  // No non-overlapping candidate surface within tolerance.
  // Provide a suggestedY pointing at the nearest plausible support surface.
  let suggestedSurfaceY = 0; // ground
  let suggestedY = scale.y / 2;
  let bestDelta = Math.abs(suggestedY - requestedCenterY);

  for (const existing of existingPrimitives) {
    if (EXEMPT_SHAPES.has(existing.shape)) continue;
    if (!overlapXZ(position, scale, existing.position, existing.scale)) continue;
    const topY = existing.position.y + existing.scale.y / 2;
    const candY = topY + scale.y / 2;
    const delta = Math.abs(candY - requestedCenterY);
    if (delta < bestDelta) {
      suggestedSurfaceY = topY;
      suggestedY = candY;
      bestDelta = delta;
    }
  }

  if (candidates.length === 0) {
    return {
      valid: false,
      correctedY: suggestedY,
      error: `Shape would float at y=${requestedCenterY.toFixed(2)} (bottomEdge=${requestedBottomEdge.toFixed(2)}). Nearest support y=${suggestedY.toFixed(2)} (ground or top of overlapping shape).`,
    };
  }

  // Candidates existed but all overlapped at their snapped Y.
  const overlap = rejectedOverlap[0] || findFirstOverlap({ x: position.x, y: suggestedY, z: position.z }, scale, existingPrimitives);
  const overlapMsg = overlap
    ? `Overlaps existing ${overlap.shape} at (${overlap.position.x.toFixed(1)}, ${overlap.position.y.toFixed(1)}, ${overlap.position.z.toFixed(1)}).`
    : 'Overlaps existing geometry.';

  const supportLabel = suggestedSurfaceY === 0 ? 'ground' : 'top of existing shape';
  return {
    valid: false,
    correctedY: suggestedY,
    error: `${overlapMsg} Try moving in X/Z. Nearest plausible support is ${supportLabel} (suggested y=${suggestedY.toFixed(2)}).`,
  };
}

