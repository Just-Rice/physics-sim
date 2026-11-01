import * as THREE from 'three';
import type { PartInstance } from '../sim/types';

/**
 * Tints the part under the cursor with a translucent overlay. Overlays share
 * the part's geometry, are hidden from the path tracer and ignore raycasts,
 * so they never change what you click or what the render looks like.
 */
export class Highlighter {
  private part: PartInstance | null = null;
  private color = 0;
  private overlays: THREE.Mesh[] = [];
  private materials = new Map<number, THREE.MeshBasicMaterial>();

  private material(color: number): THREE.MeshBasicMaterial {
    let m = this.materials.get(color);
    if (!m) {
      m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
      this.materials.set(color, m);
    }
    return m;
  }

  set(part: PartInstance | null, color = 0x40c4ff): void {
    if (part === this.part && color === this.color) return;
    this.clear();
    if (!part || !part.body.isValid()) return;
    this.part = part;
    this.color = color;
    const mat = this.material(color);
    const meshes: THREE.Mesh[] = [];
    part.object.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && !m.userData.overlay && m.visible) meshes.push(m);
    });
    for (const m of meshes) {
      const ov = new THREE.Mesh(m.geometry, mat);
      ov.userData.overlay = true;
      ov.userData.rasterOnly = true;
      ov.raycast = () => {};
      ov.renderOrder = 5;
      m.add(ov);
      this.overlays.push(ov);
    }
  }

  get current(): PartInstance | null {
    return this.part;
  }

  clear(): void {
    for (const ov of this.overlays) ov.removeFromParent();
    this.overlays = [];
    this.part = null;
  }
}
