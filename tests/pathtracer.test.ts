import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { SettingsStore } from '../src/app/settings';
import type { RasterRenderer } from '../src/render/RasterRenderer';

/**
 * A stand-in for three-gpu-pathtracer's WebGLPathTracer: no GPU, it only
 * records what the app asks of it. Like the real one, updateMaterials() and
 * updateEnvironment() throw away the accumulated samples.
 */
class FakeTracer {
  samples = 0;
  resets = 0;
  materialUploads = 0;
  tiles = { set() {} };
  minSamples = 1;
  renderDelay = 0;
  fadeDuration = 0;
  dynamicLowRes = false;
  renderScale = 1;
  pausePathTracing = false;
  bounces = 0;
  transmissiveBounces = 0;
  filterGlossyFactor = 0;
  multipleImportanceSampling = false;
  rasterizeSceneCallback = () => {};
  renderToCanvasCallback = () => {};
  /** What the next generate() reports. */
  next = { bvhChanged: false, needsMaterialIndexUpdate: false, materials: [] as THREE.Material[] };
  _materials: THREE.Material[] = [];
  _generator = {
    setObjects: () => {},
    generate: () => ({ ...this.next, bvh: {}, geometry: { attributes: {} } }),
  };
  _pathTracer = {
    material: {
      bvh: { updateFrom() {} },
      attributesArray: { updateFrom() {} },
      materialIndexAttribute: { updateFrom() {} },
    },
  };
  setScene() {
    this._materials = this.next.materials;
    this.reset();
  }
  setCamera() {}
  updateMaterials() {
    this.materialUploads++;
    this.reset();
  }
  updateEnvironment() {
    this.reset();
  }
  reset() {
    this.samples = 0;
    this.resets++;
  }
  renderSample() {
    if (!this.pausePathTracing) this.samples++;
  }
  dispose() {}
}

vi.mock('three-gpu-pathtracer', () => ({
  WebGLPathTracer: FakeTracer,
  PhysicalCamera: THREE.PerspectiveCamera,
  DenoiseMaterial: THREE.ShaderMaterial,
}));

const { PathTracer } = await import('../src/render/PathTracer');

function setup() {
  const settings = new SettingsStore();
  // Each frame is 50 ms apart, so every frame is due a BVH refit (as on a slow GPU).
  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => (clock += 50));
  const view = {
    renderer: { getContextAttributes: () => ({ premultipliedAlpha: true }) },
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
    helpers: new THREE.Group(),
    sun: new THREE.DirectionalLight(),
    env: null,
  } as unknown as RasterRenderer;
  return { settings, view };
}

const mats = [new THREE.MeshStandardMaterial(), new THREE.MeshPhysicalMaterial()];
/** What the scene generator reports after a physics step moved things. */
const moved = { bvhChanged: true, needsMaterialIndexUpdate: true, materials: mats };

describe('path tracer', () => {
  it('keeps its sample history while the simulation moves things', async () => {
    const { settings, view } = setup();
    const pt = await PathTracer.create(view, settings);
    const fake = (pt as unknown as { pt: FakeTracer }).pt;
    fake.next = moved;
    pt.render(true); // first frame: full scene upload
    for (let i = 0; i < 20; i++) {
      pt.markSceneDirty();
      pt.render(true);
    }
    // Live mode keeps a short history (3) and adds a sample per frame; it
    // must never fall back to a fresh single-sample image on every step.
    expect(fake.materialUploads).toBe(0);
    expect(fake.samples).toBeGreaterThanOrEqual(4);
  });

  it('still re-uploads materials when they really change', async () => {
    const { settings, view } = setup();
    const pt = await PathTracer.create(view, settings);
    const fake = (pt as unknown as { pt: FakeTracer }).pt;
    fake.next = moved;
    pt.render(true);

    // A new object brings a new material into the list.
    fake.next = { ...moved, materials: [...mats, new THREE.MeshBasicMaterial()] };
    pt.markSceneDirty();
    pt.render(true);
    expect(fake.materialUploads).toBe(1);

    // A colour edit on an existing material.
    pt.markMaterialsDirty();
    pt.render(true);
    expect(fake.materialUploads).toBe(2);
  });

  it('accumulates a sharp still once the sim is paused', async () => {
    const { settings, view } = setup();
    const pt = await PathTracer.create(view, settings);
    const fake = (pt as unknown as { pt: FakeTracer }).pt;
    fake.next = moved;
    for (let i = 0; i < 50; i++) pt.render(false);
    expect(fake.samples).toBe(50);
  });
});
