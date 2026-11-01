export type GravityMode = 'uniform' | 'nbody' | 'attractors';
export type EnvironmentPreset = 'day' | 'golden' | 'studio' | 'night';
export type FluidRenderMode = 'surface' | 'spheres';

export const GRAVITY_PRESETS: Record<string, number> = {
  Earth: 9.81,
  Moon: 1.62,
  Mars: 3.71,
  Jupiter: 24.79,
  'Zero-G': 0,
};

export type RtQuality = 'fast' | 'balanced' | 'best';

/** Ray-tracing quality presets offered in Quick settings and on the RT badge. */
export const RT_PRESETS: Record<RtQuality, { label: string; bounces: number; transmissiveBounces: number; renderScale: number; liveRenderScale: number; maxSamples: number }> = {
  fast: { label: 'Fast', bounces: 3, transmissiveBounces: 6, renderScale: 0.75, liveRenderScale: 0.35, maxSamples: 256 },
  balanced: { label: 'Balanced', bounces: 6, transmissiveBounces: 10, renderScale: 1, liveRenderScale: 0.5, maxSamples: 2000 },
  best: { label: 'Best', bounces: 12, transmissiveBounces: 20, renderScale: 1.25, liveRenderScale: 0.6, maxSamples: 8000 },
};

/** Which preset the current ray-tracing settings match, if any. */
export function currentRtQuality(s: Settings): RtQuality | null {
  for (const [k, p] of Object.entries(RT_PRESETS) as [RtQuality, (typeof RT_PRESETS)[RtQuality]][]) {
    const r = s.raytracing;
    if (r.bounces === p.bounces && r.renderScale === p.renderScale && r.maxSamples === p.maxSamples) return k;
  }
  return null;
}

export interface Settings {
  physics: {
    paused: boolean;
    timeScale: number;
    gravityMode: GravityMode;
    gravityPreset: string;
    gravity: number;
    /** Newton's constant multiplier for n-body / attractors (sandbox units). */
    G: number;
    windX: number;
    windZ: number;
    windGust: number;
    airDrag: boolean;
    airDensity: number;
    solverIterations: number;
  };
  particles: {
    substeps: number;
    fluidIterations: number;
    /** Fluid particle radius in metres (smaller = more particles). */
    fluidRadius: number;
    maxParticles: number;
    fluidRender: FluidRenderMode;
    /** 0 = auto (hardware threads - 1) */
    threads: number;
  };
  render: {
    environment: EnvironmentPreset;
    sunElevation: number;
    sunAzimuth: number;
    exposure: number;
    shadows: boolean;
    trails: boolean;
    showGrid: boolean;
  };
  raytracing: {
    enabled: boolean;
    bounces: number;
    transmissiveBounces: number;
    renderScale: number;
    liveRenderScale: number;
    maxSamples: number;
    filterGlossy: number;
    denoise: boolean;
    denoiseStrength: number;
    dof: boolean;
    fStop: number;
    focusDistance: number;
    apertureBlades: number;
    /** Max BVH refresh rate while the sim runs (Hz). */
    liveUpdateRate: number;
  };
  tools: {
    cannonSpeed: number;
    cannonModel: string;
    explodeStrength: number;
    explodeRadius: number;
    attractStrength: number;
    grabStrength: number;
    spawnHeight: number;
  };
}

export const defaultSettings = (): Settings => ({
  physics: {
    paused: false,
    timeScale: 1,
    gravityMode: 'uniform',
    gravityPreset: 'Earth',
    gravity: 9.81,
    G: 1,
    windX: 0,
    windZ: 0,
    windGust: 0.3,
    airDrag: true,
    airDensity: 1.225,
    solverIterations: 4,
  },
  particles: {
    substeps: 2,
    fluidIterations: 2,
    fluidRadius: 0.04,
    maxParticles: 6000,
    fluidRender: 'surface',
    threads: 0,
  },
  render: {
    environment: 'day',
    sunElevation: 38,
    sunAzimuth: 135,
    exposure: 0.7,
    shadows: true,
    trails: false,
    showGrid: true,
  },
  raytracing: {
    enabled: false,
    bounces: 6,
    transmissiveBounces: 10,
    renderScale: 1,
    liveRenderScale: 0.5,
    maxSamples: 2000,
    filterGlossy: 0.5,
    denoise: true,
    denoiseStrength: 1,
    dof: false,
    fStop: 2.8,
    focusDistance: 8,
    apertureBlades: 6,
    liveUpdateRate: 30,
  },
  tools: {
    cannonSpeed: 25,
    cannonModel: 'steel-ball',
    explodeStrength: 40,
    explodeRadius: 4,
    attractStrength: 60,
    grabStrength: 1,
    spawnHeight: 0.5,
  },
});

type Listener = (path: string) => void;

/** Tiny observable wrapper: UI writes through `set`, systems listen by path prefix. */
export class SettingsStore {
  readonly data: Settings;
  private listeners: Listener[] = [];

  constructor(initial: Settings = defaultSettings()) {
    this.data = initial;
  }

  on(fn: Listener): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  emit(path: string): void {
    for (const l of this.listeners) l(path);
  }

  set<K extends keyof Settings, F extends keyof Settings[K]>(group: K, field: F, value: Settings[K][F]): void {
    if (this.data[group][field] === value) return;
    this.data[group][field] = value;
    this.emit(`${String(group)}.${String(field)}`);
  }

  applyRtQuality(q: RtQuality): void {
    const p = RT_PRESETS[q];
    this.set('raytracing', 'bounces', p.bounces);
    this.set('raytracing', 'transmissiveBounces', p.transmissiveBounces);
    this.set('raytracing', 'renderScale', p.renderScale);
    this.set('raytracing', 'liveRenderScale', p.liveRenderScale);
    this.set('raytracing', 'maxSamples', p.maxSamples);
  }
}
