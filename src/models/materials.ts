import * as THREE from 'three';
import { MaterialSpec, type MaterialRef } from './schema';

export interface MaterialPreset extends MaterialSpec {
  id: string;
  label: string;
}

const base = MaterialSpec.parse({});

function preset(id: string, label: string, spec: Partial<MaterialSpec>): MaterialPreset {
  return { ...base, ...spec, id, label };
}

/**
 * Presets carry both the look and the physics, so mass and bounce come out
 * right when you pick a material. Densities are kg/m³.
 */
export const MATERIAL_PRESETS: MaterialPreset[] = [
  preset('plastic', 'Plastic', { color: '#e8553d', roughness: 0.35, clearcoat: 0.3, density: 950, friction: 0.45, restitution: 0.45 }),
  preset('plastic-blue', 'Plastic (blue)', { color: '#2f7de1', roughness: 0.35, clearcoat: 0.3, density: 950, friction: 0.45, restitution: 0.45 }),
  preset('plastic-yellow', 'Plastic (yellow)', { color: '#f2c12e', roughness: 0.35, clearcoat: 0.3, density: 950, friction: 0.45, restitution: 0.45 }),
  preset('plastic-green', 'Plastic (green)', { color: '#3fb871', roughness: 0.35, clearcoat: 0.3, density: 950, friction: 0.45, restitution: 0.45 }),
  preset('plastic-white', 'Plastic (white)', { color: '#f2f2ee', roughness: 0.3, clearcoat: 0.3, density: 950, friction: 0.45, restitution: 0.45 }),
  preset('rubber', 'Rubber', { color: '#2b2b2b', roughness: 0.9, density: 1100, friction: 1.0, restitution: 0.82 }),
  preset('rubber-red', 'Rubber (red)', { color: '#c62f2f', roughness: 0.85, density: 1100, friction: 1.0, restitution: 0.82 }),
  preset('wood', 'Wood', { color: '#b07a45', roughness: 0.7, density: 600, friction: 0.55, restitution: 0.35 }),
  preset('wood-dark', 'Wood (dark)', { color: '#6b4426', roughness: 0.7, density: 700, friction: 0.55, restitution: 0.35 }),
  preset('steel', 'Steel', { color: '#c8ccd2', metalness: 1, roughness: 0.28, density: 7850, friction: 0.6, restitution: 0.3 }),
  preset('chrome', 'Chrome', { color: '#f4f6f8', metalness: 1, roughness: 0.03, density: 7850, friction: 0.4, restitution: 0.45 }),
  preset('gold', 'Gold', { color: '#ffc85a', metalness: 1, roughness: 0.18, density: 19300, friction: 0.5, restitution: 0.2 }),
  preset('copper', 'Copper', { color: '#e3916a', metalness: 1, roughness: 0.25, density: 8960, friction: 0.5, restitution: 0.25 }),
  preset('aluminium', 'Aluminium', { color: '#d9dde2', metalness: 1, roughness: 0.4, density: 2700, friction: 0.55, restitution: 0.3 }),
  preset('glass', 'Glass', { color: '#ffffff', roughness: 0, transmission: 1, ior: 1.5, thickness: 0.5, density: 2500, friction: 0.4, restitution: 0.4 }),
  preset('glass-tinted', 'Glass (tinted)', { color: '#7fd1c7', roughness: 0.02, transmission: 1, ior: 1.52, thickness: 0.5, density: 2500, friction: 0.4, restitution: 0.4 }),
  preset('frosted-glass', 'Frosted glass', { color: '#ffffff', roughness: 0.35, transmission: 1, ior: 1.5, thickness: 0.5, density: 2500, friction: 0.45, restitution: 0.35 }),
  preset('diamond', 'Diamond', { color: '#ffffff', roughness: 0, transmission: 1, ior: 2.42, thickness: 0.5, density: 3510, friction: 0.1, restitution: 0.3 }),
  preset('ice', 'Ice', { color: '#dff3ff', roughness: 0.08, transmission: 0.9, ior: 1.31, thickness: 0.5, density: 917, friction: 0.03, restitution: 0.1 }),
  preset('marble', 'Marble', { color: '#efece6', roughness: 0.15, clearcoat: 0.6, density: 2700, friction: 0.5, restitution: 0.3 }),
  preset('stone', 'Stone', { color: '#8d8a84', roughness: 0.85, density: 2600, friction: 0.7, restitution: 0.15 }),
  preset('brick', 'Brick', { color: '#a5523a', roughness: 0.9, density: 1900, friction: 0.7, restitution: 0.1 }),
  preset('concrete', 'Concrete', { color: '#b7b4ae', roughness: 0.95, density: 2400, friction: 0.8, restitution: 0.1 }),
  preset('foam', 'Foam', { color: '#ffd66b', roughness: 1, density: 30, friction: 0.8, restitution: 0.2 }),
  preset('fabric', 'Fabric', { color: '#c0392b', roughness: 0.9, sheen: 1, density: 300, friction: 0.8, restitution: 0.05 }),
  preset('fabric-blue', 'Fabric (blue)', { color: '#2c5aa0', roughness: 0.9, sheen: 1, density: 300, friction: 0.8, restitution: 0.05 }),
  preset('jelly', 'Jelly', { color: '#ff4f7b', roughness: 0.08, transmission: 0.75, ior: 1.36, thickness: 0.6, clearcoat: 1, density: 1050, friction: 0.7, restitution: 0.2 }),
  preset('jelly-green', 'Jelly (green)', { color: '#67e05f', roughness: 0.08, transmission: 0.75, ior: 1.36, thickness: 0.6, clearcoat: 1, density: 1050, friction: 0.7, restitution: 0.2 }),
  preset('balloon', 'Balloon', { color: '#ff3355', roughness: 0.2, clearcoat: 1, density: 50, friction: 0.6, restitution: 0.6 }),
  preset('water', 'Water', { color: '#9fd8ff', roughness: 0.02, transmission: 1, ior: 1.33, thickness: 1, density: 1000, friction: 0.0, restitution: 0 }),
  preset('neon', 'Neon light', { color: '#ffffff', emissive: '#7af0ff', emissiveIntensity: 6, roughness: 0.4, density: 1200, friction: 0.5, restitution: 0.3 }),
  preset('neon-pink', 'Neon (pink)', { color: '#ffffff', emissive: '#ff4fd8', emissiveIntensity: 6, roughness: 0.4, density: 1200, friction: 0.5, restitution: 0.3 }),
  preset('lamp', 'Warm lamp', { color: '#ffffff', emissive: '#ffd3a1', emissiveIntensity: 10, roughness: 0.4, density: 1200, friction: 0.5, restitution: 0.3 }),
  preset('sun', 'Star', { color: '#ffffff', emissive: '#ffb547', emissiveIntensity: 8, roughness: 1, density: 1400, friction: 0.5, restitution: 0.2 }),
  preset('planet-blue', 'Planet (ocean)', { color: '#3d7fd6', roughness: 0.6, density: 5500, friction: 0.5, restitution: 0.2 }),
  preset('planet-red', 'Planet (desert)', { color: '#c4643c', roughness: 0.8, density: 3900, friction: 0.5, restitution: 0.2 }),
  preset('planet-gas', 'Planet (gas)', { color: '#d9b38c', roughness: 0.7, density: 1300, friction: 0.5, restitution: 0.2 }),
  preset('original', 'Original (imported look)', { color: '#cccccc', roughness: 0.5, density: 1000, friction: 0.5, restitution: 0.3 }),
  preset('ground', 'Ground', { color: '#9a9a96', roughness: 0.92, density: 2400, friction: 0.8, restitution: 0.2 }),
];

const presetMap = new Map(MATERIAL_PRESETS.map((p) => [p.id, p]));

export function getPreset(id: string): MaterialPreset | undefined {
  return presetMap.get(id);
}

export function resolveMaterial(ref: MaterialRef | undefined, fallback: MaterialRef = 'plastic'): MaterialSpec {
  const r = ref ?? fallback;
  if (typeof r === 'string') {
    return presetMap.get(r) ?? presetMap.get(typeof fallback === 'string' ? fallback : 'plastic') ?? base;
  }
  // Inline spec, optionally layered over a named preset.
  const { preset: presetId, ...rest } = r;
  const start = presetId ? presetMap.get(presetId) ?? base : base;
  const out: MaterialSpec = { ...base };
  for (const k of Object.keys(base) as (keyof MaterialSpec)[]) {
    const v = (rest as Partial<MaterialSpec>)[k] ?? start[k];
    (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

const materialCache = new Map<string, THREE.MeshPhysicalMaterial>();

function specKey(spec: MaterialSpec, side: THREE.Side): string {
  return [spec.color, spec.metalness, spec.roughness, spec.transmission, spec.ior, spec.thickness, spec.clearcoat, spec.sheen, spec.emissive, spec.emissiveIntensity, spec.opacity, side].join('|');
}

/** Shared THREE material for a spec. Shared instances keep the path tracer's material list short. */
export function makeThreeMaterial(spec: MaterialSpec, opts: { side?: THREE.Side; unique?: boolean } = {}): THREE.MeshPhysicalMaterial {
  const side = opts.side ?? THREE.FrontSide;
  const key = specKey(spec, side);
  if (!opts.unique) {
    const cached = materialCache.get(key);
    if (cached) return cached;
  }
  const m = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(spec.color),
    metalness: spec.metalness,
    roughness: spec.roughness,
    transmission: spec.transmission,
    ior: spec.ior,
    thickness: spec.thickness,
    clearcoat: spec.clearcoat,
    clearcoatRoughness: 0.08,
    sheen: spec.sheen,
    sheenColor: new THREE.Color(spec.color).lerp(new THREE.Color('#ffffff'), 0.4),
    sheenRoughness: 0.6,
    emissive: new THREE.Color(spec.emissive),
    emissiveIntensity: spec.emissiveIntensity,
    side,
  });
  if (spec.opacity < 1) {
    m.transparent = true;
    m.opacity = spec.opacity;
  }
  if (spec.transmission > 0) {
    // Raster preview of glass: let the transmission pass do the work.
    m.attenuationColor = new THREE.Color(spec.color);
    m.attenuationDistance = 2.5;
    m.color.set('#ffffff').lerp(new THREE.Color(spec.color), 0.35);
    // Raster only: glass shouldn't hide other see-through things (water in a tank) behind it.
    if (spec.transmission > 0.5) m.depthWrite = false;
  }
  m.userData.spec = spec;
  if (!opts.unique) materialCache.set(key, m);
  return m;
}

export function materialFromRef(ref: MaterialRef | undefined, fallback: MaterialRef = 'plastic', side?: THREE.Side): THREE.MeshPhysicalMaterial {
  return makeThreeMaterial(resolveMaterial(ref, fallback), { side });
}
