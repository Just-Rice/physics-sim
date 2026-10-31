import * as THREE from 'three';
import type { ModelDef } from './schema';
import { makeThreeMaterial, resolveMaterial } from './materials';
import { primitiveGeometry, quatFromDeg } from './geometry';
import { cloneAssetNode } from './assets';
import { generateEnvironment } from '../render/environment';

const SIZE = 128;

/** Visual-only preview of a model (no physics), used for thumbnails and the import dialog. */
export function buildPreview(model: ModelDef): THREE.Group {
  const root = new THREE.Group();
  for (const part of model.parts) {
    const g = new THREE.Group();
    g.position.set(...part.position);
    g.quaternion.copy(quatFromDeg(part.rotation));
    const spec = resolveMaterial(part.material);
    for (const s of part.shapes) {
      if (!s.visible) continue;
      let obj: THREE.Object3D | null = null;
      const sSpec = s.material ? resolveMaterial(s.material) : spec;
      if (s.type === 'mesh') {
        obj = cloneAssetNode(s.asset, s.node);
        if (obj) {
          obj.scale.set(...s.scale);
          const keep = (s.material ?? part.material) === 'original' && !s.asset.startsWith('proc:');
          if (!keep) obj.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.material = makeThreeMaterial(sSpec); });
        }
      } else {
        obj = new THREE.Mesh(primitiveGeometry(s), makeThreeMaterial(sSpec));
      }
      if (!obj) continue;
      obj.position.set(...s.position);
      obj.quaternion.copy(quatFromDeg(s.rotation));
      g.add(obj);
    }
    root.add(g);
  }
  for (const sp of model.softParts) {
    const mat = makeThreeMaterial(resolveMaterial(sp.material), { side: THREE.DoubleSide });
    let geo: THREE.BufferGeometry;
    if (sp.type === 'cloth') geo = new THREE.PlaneGeometry(sp.size[0], sp.size[1], 8, 8);
    else if (sp.type === 'softbody') {
      geo = sp.shape === 'box' ? new THREE.BoxGeometry(...sp.size) : sp.shape === 'torus' ? new THREE.TorusGeometry(sp.size[0], sp.size[1], 16, 32) : new THREE.SphereGeometry(1, 32, 16).scale(...sp.size);
    } else geo = new THREE.BoxGeometry(...sp.size);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(...sp.position);
    if (sp.type !== 'fluid') m.quaternion.copy(quatFromDeg(sp.rotation));
    if (sp.type === 'cloth' && sp.pins === 'none' && sp.rotation[0] === -90) {
      // Draped sheet looks better in a thumbnail as a gentle wave
      const pos = geo.getAttribute('position');
      for (let i = 0; i < pos.count; i++) pos.setZ(i, Math.sin(pos.getX(i) * 3) * 0.08);
      geo.computeVertexNormals();
    }
    root.add(m);
  }
  return root;
}

export class ThumbnailRenderer {
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 1, 0.01, 200);
  private target = new THREE.WebGLRenderTarget(SIZE, SIZE, { samples: 4, colorSpace: THREE.SRGBColorSpace });
  private buffer = new Uint8Array(SIZE * SIZE * 4);
  private canvas = document.createElement('canvas');
  private cache = new Map<string, string>();
  private queue: { model: ModelDef; resolve: (url: string) => void }[] = [];
  private busy = false;

  constructor(private renderer: THREE.WebGLRenderer) {
    this.canvas.width = this.canvas.height = SIZE;
    const env = generateEnvironment('studio', 40, 135);
    this.scene.environment = env.texture;
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(3, 5, 4);
    this.scene.add(key);
    this.scene.background = new THREE.Color('#1a2030');
  }

  get(model: ModelDef): Promise<string> {
    const c = this.cache.get(model.id);
    if (c) return Promise.resolve(c);
    return new Promise((resolve) => {
      this.queue.push({ model, resolve });
      this.pump();
    });
  }

  invalidate(id: string): void {
    this.cache.delete(id);
  }

  private pump(): void {
    if (this.busy) return;
    this.busy = true;
    const step = () => {
      const job = this.queue.shift();
      if (!job) {
        this.busy = false;
        return;
      }
      try {
        job.resolve(this.render(job.model));
      } catch (err) {
        console.warn('thumbnail failed', job.model.id, err);
        job.resolve('');
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  private render(model: ModelDef): string {
    const obj = buildPreview(model);
    this.scene.add(obj);
    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(0.1, size.length() / 2);
    const dist = radius / Math.sin((this.camera.fov * Math.PI) / 360) * 1.02;
    const dir = new THREE.Vector3(1, 0.75, 1.25).normalize();
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.camera.near = dist / 50;
    this.camera.far = dist * 4;
    this.camera.lookAt(center);
    this.camera.updateProjectionMatrix();

    const prevTarget = this.renderer.getRenderTarget();
    const prevTone = this.renderer.toneMapping;
    this.renderer.setRenderTarget(this.target);
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.render(this.scene, this.camera);
    this.renderer.readRenderTargetPixels(this.target, 0, 0, SIZE, SIZE, this.buffer);
    this.renderer.setRenderTarget(prevTarget);
    this.renderer.toneMapping = prevTone;
    this.scene.remove(obj);

    const g = this.canvas.getContext('2d')!;
    const img = g.createImageData(SIZE, SIZE);
    // Flip Y while copying
    for (let y = 0; y < SIZE; y++) {
      img.data.set(this.buffer.subarray((SIZE - 1 - y) * SIZE * 4, (SIZE - y) * SIZE * 4), y * SIZE * 4);
    }
    g.putImageData(img, 0, 0);
    const url = this.canvas.toDataURL('image/png');
    this.cache.set(model.id, url);
    return url;
  }
}
