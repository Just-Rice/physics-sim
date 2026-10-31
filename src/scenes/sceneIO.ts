import * as THREE from 'three';
import type { Simulation } from '../sim/Simulation';
import type { ModelLibrary } from '../models/library';
import { safeParseModel, type ModelDef } from '../models/schema';
import type { Settings } from '../app/settings';

type V3 = [number, number, number];
type V4 = [number, number, number, number];

export interface SavedScene {
  format: 'physics-sim-scene';
  version: 1;
  savedAt: string;
  camera: { position: V3; target: V3 };
  physics: Partial<Settings['physics']>;
  render: Partial<Settings['render']>;
  ground: boolean;
  entities: {
    /** Library id for built-ins; full definition for anything else. */
    model: string | ModelDef;
    placement: { position: V3; rotation: V3 };
    parts: Record<string, { p: V3; q: V4; v: V3; w: V3; fixed: boolean }>;
  }[];
}

const r3 = (v: { x: number; y: number; z: number }): V3 => [v.x, v.y, v.z];

export function serializeScene(sim: Simulation, library: ModelLibrary, settings: Settings, camera: THREE.Camera, target: THREE.Vector3, ground: boolean): SavedScene {
  return {
    format: 'physics-sim-scene',
    version: 1,
    savedAt: new Date().toISOString(),
    camera: { position: r3(camera.position), target: r3(target) },
    physics: { gravityMode: settings.physics.gravityMode, gravity: settings.physics.gravity, gravityPreset: settings.physics.gravityPreset, G: settings.physics.G, windX: settings.physics.windX, windZ: settings.physics.windZ, airDrag: settings.physics.airDrag },
    render: { environment: settings.render.environment, sunElevation: settings.render.sunElevation, sunAzimuth: settings.render.sunAzimuth, exposure: settings.render.exposure },
    ground,
    entities: sim.entities.filter((e) => !e.locked).map((e) => {
      const builtin = library.builtin.find((m) => m.id === e.model.id);
      const parts: SavedScene['entities'][number]['parts'] = {};
      for (const p of e.parts) {
        const b = p.body;
        const q = b.rotation();
        parts[p.def.id] = { p: r3(b.translation()), q: [q.x, q.y, q.z, q.w], v: r3(b.linvel()), w: r3(b.angvel()), fixed: b.isFixed() };
      }
      return {
        model: builtin && builtin === e.model ? builtin.id : e.model,
        placement: { position: e.placement.position as V3, rotation: e.placement.rotation as V3 },
        parts,
      };
    }),
  };
}

export function resolveSavedModel(m: string | unknown, library: ModelLibrary): ModelDef | null {
  if (typeof m === 'string') return library.get(m) ?? null;
  const r = safeParseModel(m);
  return r.ok ? r.model : null;
}

export function isSavedScene(x: unknown): x is SavedScene {
  return !!x && typeof x === 'object' && (x as SavedScene).format === 'physics-sim-scene';
}
