import { readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { validateBuildPosition } from '../build-validation.js';

type PrimitiveLike = {
  shape: string;
  position: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
};

type BlueprintPrimitiveDef = {
  shape: string;
  x?: number;
  y?: number;
  z?: number;
  rotX?: number;
  rotY?: number;
  rotZ?: number;
  scaleX?: number;
  scaleY?: number;
  scaleZ?: number;
  color?: string;
};

type BlueprintDef = {
  description?: string;
  phases: Array<{
    name: string;
    primitives: BlueprintPrimitiveDef[];
  }>;
};

function toPlacedPrimitive(def: BlueprintPrimitiveDef): PrimitiveLike {
  return {
    shape: def.shape,
    position: {
      x: def.x ?? 0,
      y: def.y ?? 0,
      z: def.z ?? 0,
    },
    scale: {
      x: def.scaleX ?? 1,
      y: def.scaleY ?? 1,
      z: def.scaleZ ?? 1,
    },
  };
}

async function main(): Promise<void> {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const blueprintsPath = join(__dirname, '..', 'blueprints.json');
  const raw = await readFile(blueprintsPath, 'utf-8');
  const blueprints = JSON.parse(raw) as Record<string, BlueprintDef>;

  const failures: Array<{
    blueprint: string;
    index: number;
    error: string;
    suggestedY?: number;
    primitive: PrimitiveLike;
  }> = [];

  const names = Object.keys(blueprints).sort();
  for (const name of names) {
    const bp = blueprints[name];
    if (!bp || !Array.isArray(bp.phases)) {
      failures.push({
        blueprint: name,
        index: -1,
        error: 'Invalid blueprint structure (missing phases array)',
        primitive: { shape: 'box', position: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
      });
      continue;
    }

    const placed: PrimitiveLike[] = [];
    const flat: PrimitiveLike[] = [];
    for (const phase of bp.phases) {
      for (const prim of phase.primitives || []) {
        flat.push(toPlacedPrimitive(prim));
      }
    }

    for (let i = 0; i < flat.length; i++) {
      const prim = flat[i]!;
      const position = { ...prim.position };

      let validation = validateBuildPosition(prim.shape, position, prim.scale, placed);
      if (!validation.valid && validation.correctedY !== undefined) {
        position.y = validation.correctedY;
        validation = validateBuildPosition(prim.shape, position, prim.scale, placed);
      }

      if (!validation.valid) {
        failures.push({
          blueprint: name,
          index: i,
          error: validation.error || 'Invalid build position',
          suggestedY: validation.correctedY,
          primitive: { ...prim, position },
        });
        break; // blueprint failed deterministically; stop simulating this one
      }

      if (validation.correctedY !== undefined) {
        position.y = validation.correctedY;
      }

      placed.push({
        shape: prim.shape,
        position,
        scale: prim.scale,
      });
    }
  }

  if (failures.length > 0) {
    console.error(`[lint-blueprints] FAILED: ${failures.length} blueprint(s) are not fully placeable in an empty world.`);
    for (const fail of failures) {
      const pos = fail.primitive.position;
      const scale = fail.primitive.scale;
      const yHint = fail.suggestedY !== undefined ? ` suggestedY=${fail.suggestedY.toFixed(2)}` : '';
      console.error(
        `- ${fail.blueprint} @ primitive[${fail.index}]: ${fail.error} (shape=${fail.primitive.shape} pos=(${pos.x},${pos.y},${pos.z}) scale=(${scale.x},${scale.y},${scale.z}))${yHint}`
      );
    }
    process.exit(1);
  }

  console.log(`[lint-blueprints] OK: ${names.length} blueprint(s) fully placeable in an empty world.`);
}

main().catch((err) => {
  console.error('[lint-blueprints] fatal:', err);
  process.exit(1);
});

