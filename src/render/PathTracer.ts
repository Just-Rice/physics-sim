import * as THREE from 'three';
import type { WebGLPathTracer, PhysicalCamera } from 'three-gpu-pathtracer';
import type { RasterRenderer } from './RasterRenderer';
import type { SettingsStore } from '../app/settings';

type PTModule = typeof import('three-gpu-pathtracer');

/** Reasons the GPU can't run the path tracer, or null if it can. */
export function pathTracingUnsupportedReason(renderer: THREE.WebGLRenderer): string | null {
  const gl = renderer.getContext();
  if (!(gl instanceof WebGL2RenderingContext)) return 'Ray tracing needs WebGL 2.';
  if (!renderer.extensions.has('EXT_color_buffer_float')) return 'Ray tracing needs float render targets (EXT_color_buffer_float), which this GPU/browser does not expose.';
  return null;
}

/**
 * Progressive GPU path tracer (three-gpu-pathtracer) that renders the same
 * scene as the raster view. While the simulation runs it refits the BVH at a
 * capped rate and keeps a short sample history (a soft motion blur that hides
 * noise); when everything is still it accumulates to a converged image.
 */
export class PathTracer {
  private pt: WebGLPathTracer;
  private camera: PhysicalCamera;
  private lastCamMatrix = new THREE.Matrix4();
  private lastProj = new THREE.Matrix4();
  private sceneDirty = true;
  private materialsDirty = true;
  private envDirty = true;
  private lastGeometryUpdate = 0;
  private initialised = false;
  private live = false;
  /** When true, the next frames accumulate without being capped (photo mode). */
  photoMode = false;

  static async create(view: RasterRenderer, settings: SettingsStore): Promise<PathTracer> {
    const mod: PTModule = await import('three-gpu-pathtracer');
    return new PathTracer(mod, view, settings);
  }

  private constructor(mod: PTModule, private view: RasterRenderer, private settings: SettingsStore) {
    // The library logs a deprecation notice in favour of its WebGPU variant; the WebGL one is what we need here.
    const warn = console.warn;
    console.warn = () => {};
    this.pt = new mod.WebGLPathTracer(view.renderer);
    console.warn = warn;
    this.camera = new mod.PhysicalCamera();
    this.pt.tiles.set(1, 1);
    this.pt.minSamples = 1;
    this.pt.renderDelay = 0;
    this.pt.fadeDuration = 0;
    this.pt.dynamicLowRes = false;
    this.pt.rasterizeSceneCallback = (scene, cam) => {
      // Raster fallback while shaders compile: show the sun light again for that pass.
      const sunVisible = this.view.sun.visible;
      this.view.sun.visible = (this.view.env?.sunIntensity ?? 0) > 0.01;
      this.view.renderer.render(scene, cam);
      this.view.sun.visible = sunVisible;
    };
    this.applySettings();
    settings.on((p) => {
      if (p.startsWith('raytracing.')) this.applySettings();
      if (p.startsWith('raytracing.dof') || p.startsWith('raytracing.fStop') || p.startsWith('raytracing.focus') || p.startsWith('raytracing.aperture')) this.syncCamera(true);
      if (p.startsWith('raytracing.bounces') || p.startsWith('raytracing.transmissive') || p.startsWith('raytracing.filterGlossy')) this.pt.reset();
    });
  }

  private applySettings(): void {
    const r = this.settings.data.raytracing;
    this.pt.bounces = r.bounces;
    this.pt.transmissiveBounces = r.transmissiveBounces;
    this.pt.filterGlossyFactor = r.filterGlossy;
    this.pt.multipleImportanceSampling = true;
  }

  get samples(): number {
    return this.pt.samples;
  }

  get compiling(): boolean {
    return Boolean((this.pt as unknown as { isCompiling?: boolean }).isCompiling);
  }

  markSceneDirty(): void {
    this.sceneDirty = true;
  }
  markMaterialsDirty(): void {
    this.materialsDirty = true;
  }
  markEnvironmentDirty(): void {
    this.envDirty = true;
  }

  reset(): void {
    this.pt.reset();
  }

  /** Hide helpers and raster-only objects while the path tracer reads the scene. */
  private withTraceVisibility<T>(fn: () => T): T {
    const v = this.view;
    const helpers = v.helpers.visible;
    const sun = v.sun.visible;
    v.helpers.visible = false;
    v.sun.visible = false;
    const hidden: THREE.Object3D[] = [];
    v.scene.traverse((o) => {
      if (o.userData.rasterOnly && o.visible) {
        hidden.push(o);
        o.visible = false;
      }
    });
    const traceOnly: THREE.Object3D[] = [];
    v.scene.traverse((o) => {
      if (o.userData.traceOnly && !o.visible) {
        traceOnly.push(o);
        o.visible = true;
      }
    });
    try {
      return fn();
    } finally {
      v.helpers.visible = helpers;
      v.sun.visible = sun;
      for (const o of hidden) o.visible = true;
      for (const o of traceOnly) o.visible = false;
    }
  }

  private syncCamera(force = false): boolean {
    const src = this.view.camera;
    src.updateMatrixWorld();
    const r = this.settings.data.raytracing;
    const moved = force || !this.lastCamMatrix.equals(src.matrixWorld) || !this.lastProj.equals(src.projectionMatrix);
    if (!moved) return false;
    this.lastCamMatrix.copy(src.matrixWorld);
    this.lastProj.copy(src.projectionMatrix);
    this.camera.position.copy(src.position);
    this.camera.quaternion.copy(src.quaternion);
    this.camera.fov = src.fov;
    this.camera.aspect = src.aspect;
    this.camera.near = src.near;
    this.camera.far = src.far;
    this.camera.fStop = r.dof ? r.fStop : 1e6;
    this.camera.focusDistance = r.focusDistance;
    this.camera.apertureBlades = r.apertureBlades;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    if (this.initialised) this.pt.setCamera(this.camera);
    return true;
  }

  /** Full scene upload (first use, or when the scene graph changed a lot). */
  private fullSync(): void {
    this.withTraceVisibility(() => {
      this.view.scene.updateMatrixWorld(true);
      this.pt.setScene(this.view.scene, this.camera);
    });
    this.initialised = true;
    this.sceneDirty = this.materialsDirty = this.envDirty = false;
    this.lastGeometryUpdate = performance.now();
  }

  /** Incremental update: BVH refit/rebuild and material index only. */
  private geometrySync(): void {
    // Internals of WebGLPathTracer: generate() refits the BVH when only transforms/vertices changed.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inner = this.pt as any;
    const generator = inner._generator;
    const material = inner._pathTracer?.material;
    if (!generator || !material) {
      this.fullSync();
      return;
    }
    this.withTraceVisibility(() => {
      this.view.scene.updateMatrixWorld(true);
      generator.setObjects(this.view.scene);
      const result = generator.generate();
      inner._materials = result.materials;
      if (result.bvhChanged) {
        material.bvh.updateFrom(result.bvh);
        const a = result.geometry.attributes;
        material.attributesArray.updateFrom(a.normal, a.tangent, a.uv, a.color);
      }
      if (result.needsMaterialIndexUpdate) {
        material.materialIndexAttribute.updateFrom(result.geometry.attributes.materialIndex);
        this.pt.updateMaterials();
      } else if (this.materialsDirty) {
        this.pt.updateMaterials();
      }
      if (this.envDirty) this.pt.updateEnvironment();
    });
    this.sceneDirty = this.materialsDirty = this.envDirty = false;
    this.lastGeometryUpdate = performance.now();
  }

  /**
   * Render one frame. `simRunning` selects live mode (lower resolution, short
   * history) versus still mode (full resolution, accumulate up to maxSamples).
   */
  render(simRunning: boolean): void {
    const r = this.settings.data.raytracing;
    const live = simRunning && !this.photoMode;
    if (live !== this.live) {
      this.live = live;
      this.pt.reset();
    }
    this.pt.renderScale = live ? r.liveRenderScale : r.renderScale;

    const camMoved = this.syncCamera();
    if (!this.initialised) {
      this.fullSync();
    } else if (this.sceneDirty || this.materialsDirty || this.envDirty) {
      const now = performance.now();
      const interval = 1000 / Math.max(1, r.liveUpdateRate);
      if (!live || now - this.lastGeometryUpdate >= interval || this.materialsDirty || this.envDirty) {
        this.geometrySync();
        if (live) {
          // Keep a few samples of history: smooths noise at the cost of slight motion blur.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const inner = (this.pt as any)._pathTracer;
          if (inner && inner.samples > 3) inner.samples = 3;
        } else {
          this.pt.reset();
        }
      }
    }
    if (camMoved && this.initialised) this.pt.reset();

    this.pt.pausePathTracing = !this.photoMode && this.pt.samples >= r.maxSamples;
    this.pt.renderSample();
  }

  dispose(): void {
    this.pt.dispose();
  }
}
