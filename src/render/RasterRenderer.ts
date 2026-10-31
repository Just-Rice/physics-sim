import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { generateEnvironment, type EnvironmentResult } from './environment';
import type { SettingsStore } from '../app/settings';

function makeGridTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#8c8c87';
  g.fillRect(0, 0, size, size);
  // subtle concrete-like noise
  const img = g.getImageData(0, 0, size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 10;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  g.strokeStyle = 'rgba(40,40,40,0.35)';
  g.lineWidth = 3;
  g.strokeRect(0, 0, size, size);
  g.strokeStyle = 'rgba(40,40,40,0.14)';
  g.lineWidth = 1.5;
  for (let k = 1; k < 4; k++) {
    const p = (k * size) / 4;
    g.beginPath(); g.moveTo(p, 0); g.lineTo(p, size); g.stroke();
    g.beginPath(); g.moveTo(0, p); g.lineTo(size, p); g.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/**
 * Owns the WebGL renderer, camera, controls, lights, environment and ground.
 * The path tracer reuses the same renderer, scene and camera.
 */
export class RasterRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly ground: THREE.Mesh;
  /** Objects that are UI helpers (gizmos, trails) and must be hidden from the path tracer. */
  readonly helpers = new THREE.Group();
  env: EnvironmentResult | null = null;
  private plainGroundMat: THREE.MeshPhysicalMaterial;
  private gridGroundMat: THREE.MeshPhysicalMaterial;

  constructor(readonly container: HTMLElement, private settings: SettingsStore) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = settings.data.render.exposure;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = settings.data.render.shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.05, 2000);
    this.camera.position.set(7, 5, 9);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 1, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.update();

    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.sun.shadow.radius = 3;
    const sc = this.sun.shadow.camera;
    sc.left = -15; sc.right = 15; sc.top = 15; sc.bottom = -15; sc.near = 0.5; sc.far = 120;
    this.scene.add(this.sun, this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xbfd6ff, 0x3a3530, 0.0);
    this.scene.add(this.hemi);

    const gridTex = makeGridTexture();
    gridTex.repeat.set(500, 500);
    this.gridGroundMat = new THREE.MeshPhysicalMaterial({ map: gridTex, roughness: 0.92, metalness: 0 });
    this.plainGroundMat = new THREE.MeshPhysicalMaterial({ color: '#83837f', roughness: 0.92, metalness: 0 });
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1000, 1000), this.gridGroundMat);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.ground.name = 'Ground';
    this.scene.add(this.ground);

    this.helpers.name = '__helpers';
    this.scene.add(this.helpers);

    this.applyEnvironment();
    this.applyGrid();

    window.addEventListener('resize', () => this.resize());
    settings.on((path) => {
      if (path === 'render.environment' || path === 'render.sunElevation' || path === 'render.sunAzimuth') this.applyEnvironment();
      if (path === 'render.exposure') this.renderer.toneMappingExposure = settings.data.render.exposure;
      if (path === 'render.shadows') {
        this.renderer.shadowMap.enabled = settings.data.render.shadows;
        this.scene.traverse((o) => {
          const m = (o as THREE.Mesh).material as THREE.Material | undefined;
          if (m) m.needsUpdate = true;
        });
      }
      if (path === 'render.showGrid') this.applyGrid();
    });
  }

  applyGrid(): void {
    this.ground.material = this.settings.data.render.showGrid ? this.gridGroundMat : this.plainGroundMat;
  }

  applyEnvironment(): void {
    const r = this.settings.data.render;
    const old = this.env?.texture;
    this.env = generateEnvironment(r.environment, r.sunElevation, r.sunAzimuth);
    this.scene.background = this.env.texture;
    this.scene.environment = this.env.texture;
    this.scene.environmentIntensity = 1;
    this.scene.backgroundIntensity = 1;
    // Directional light reproduces the sun for raster shadows.
    this.sun.color.copy(this.env.sunColor);
    this.sun.intensity = this.env.sunIntensity * 0.38;
    this.sun.visible = this.env.sunIntensity > 0.01;
    this.updateSunPosition();
    old?.dispose();
    this.onEnvironmentChange?.();
  }

  onEnvironmentChange?: () => void;

  /** Keep the shadow frustum centred where the user is looking. */
  updateSunPosition(): void {
    if (!this.env) return;
    const t = this.controls.target;
    const dist = Math.min(80, Math.max(12, this.camera.position.distanceTo(t) * 1.5));
    const sc = this.sun.shadow.camera;
    if (sc.right !== dist) {
      sc.left = -dist; sc.right = dist; sc.top = dist; sc.bottom = -dist;
      sc.far = dist * 6;
      sc.updateProjectionMatrix();
    }
    this.sun.target.position.copy(t);
    this.sun.position.copy(t).addScaledVector(this.env.sunDirection, dist * 2.5);
  }

  resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  render(): void {
    this.updateSunPosition();
    this.renderer.render(this.scene, this.camera);
  }
}
