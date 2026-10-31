import * as THREE from 'three';
import { MarchingCubes } from 'three/addons/objects/MarchingCubes.js';
import { FLAG_FLUID, type ParticleWorld } from '../physics/particles/ParticleWorld';
import type { FluidRenderMode } from '../app/settings';
import { makeThreeMaterial, resolveMaterial } from '../models/materials';

/**
 * Renders all fluid particles either as a smooth marching-cubes surface or as
 * instanced spheres. The path tracer cannot read the marching-cubes buffers
 * (they are oversized with a draw range) or instanced meshes, so a compact
 * copy of the surface is kept for tracing.
 */
export class FluidRenderer {
  readonly group = new THREE.Group();
  private mc: MarchingCubes;
  private resolution = 48;
  private spheres: THREE.InstancedMesh;
  private sphereCap = 0;
  private traced: THREE.Mesh;
  private material: THREE.MeshPhysicalMaterial;
  private dummy = new THREE.Object3D();
  mode: FluidRenderMode = 'surface';

  constructor() {
    this.group.name = 'fluid';
    this.material = makeThreeMaterial(resolveMaterial('water'), { unique: true });
    // Water absorbs red light with depth: tint by thickness so shallow water stays clear.
    this.material.color.set('#ffffff');
    this.material.attenuationColor.set('#2b8fd1');
    this.material.attenuationDistance = 0.7;
    this.material.thickness = 0.3;
    this.material.depthWrite = true;
    this.material.roughness = 0.03;
    this.mc = new MarchingCubes(this.resolution, this.material, false, false, 160000);
    this.mc.isolation = 80;
    this.mc.userData.rasterOnly = true;
    this.mc.castShadow = true;
    this.mc.receiveShadow = true;
    this.mc.visible = false;
    this.mc.frustumCulled = false;
    this.mc.renderOrder = 2;

    this.traced = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.traced.visible = false;
    this.traced.userData.traceOnly = true;
    this.traced.frustumCulled = false;

    const sphereMat = new THREE.MeshPhysicalMaterial({ color: '#3d9be0', roughness: 0.08, clearcoat: 1, metalness: 0 });
    this.spheres = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), sphereMat, 1);
    this.spheres.count = 0;
    this.spheres.visible = false;
    this.spheres.userData.rasterOnly = true;
    this.spheres.castShadow = true;
    this.spheres.frustumCulled = false;
    this.group.add(this.mc, this.traced, this.spheres);
  }

  update(world: ParticleWorld, traceActive: boolean): void {
    const n = world.fluidCount;
    if (n === 0) {
      this.mc.visible = this.spheres.visible = false;
      this.traced.visible = false;
      this.traced.userData.traceOnly = false;
      return;
    }
    if (this.mode === 'spheres' && !traceActive) {
      this.mc.visible = false;
      this.traced.userData.traceOnly = false;
      this.updateSpheres(world);
      return;
    }
    this.spheres.visible = false;
    this.updateSurface(world, traceActive);
  }

  private updateSpheres(world: ParticleWorld): void {
    const n = world.fluidCount;
    if (n > this.sphereCap) {
      this.sphereCap = Math.ceil(n * 1.5);
      const mesh = new THREE.InstancedMesh(this.spheres.geometry, this.spheres.material, this.sphereCap);
      mesh.userData.rasterOnly = true;
      mesh.castShadow = true;
      mesh.frustumCulled = false;
      this.group.remove(this.spheres);
      this.spheres = mesh;
      this.group.add(mesh);
    }
    const r = world.fluidRadius * 1.15;
    let k = 0;
    for (let i = 0; i < world.count; i++) {
      if (!(world.flags[i] & FLAG_FLUID)) continue;
      this.dummy.position.set(world.pos[i * 3], world.pos[i * 3 + 1], world.pos[i * 3 + 2]);
      this.dummy.scale.setScalar(r);
      this.dummy.updateMatrix();
      this.spheres.setMatrixAt(k++, this.dummy.matrix);
    }
    this.spheres.count = k;
    this.spheres.instanceMatrix.needsUpdate = true;
    this.spheres.visible = true;
  }

  private updateSurface(world: ParticleWorld, traceActive: boolean): void {
    const p = world.pos;
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < world.count; i++) {
      if (!(world.flags[i] & FLAG_FLUID)) continue;
      const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const r = world.fluidRadius;
    const margin = r * 4;
    const half = Math.max(maxX - minX, maxY - minY, maxZ - minZ) / 2 + margin;
    // Resolution follows the domain size so blobs keep roughly particle-sized detail.
    const want = THREE.MathUtils.clamp(Math.ceil((2 * half) / (r * 1.1) / 8) * 8, 24, 80);
    if (want !== this.resolution) {
      this.resolution = want;
      this.mc.init(want);
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
    this.mc.position.set(cx, cy, cz);
    this.mc.scale.setScalar(half);
    this.mc.updateMatrixWorld();
    this.mc.reset();

    // Splat particles straight into the field (faster than addBall).
    const size = this.mc.size, size2 = size * size, field = this.mc.field as Float32Array;
    const rn = (r / (2 * half)); // particle radius in normalised [0,1] units
    const subtract = 12;
    const strength = (80 + subtract) * (1.45 * rn) * (1.45 * rn);
    const reach = Math.sqrt(strength / subtract); // normalised influence radius
    const cellReach = Math.ceil(reach * size);
    for (let i = 0; i < world.count; i++) {
      if (!(world.flags[i] & FLAG_FLUID)) continue;
      const u = (p[i * 3] - cx) / (2 * half) + 0.5;
      const v = (p[i * 3 + 1] - cy) / (2 * half) + 0.5;
      const w = (p[i * 3 + 2] - cz) / (2 * half) + 0.5;
      const xs = u * size, ys = v * size, zs = w * size;
      const x0 = Math.max(1, Math.floor(xs - cellReach)), x1 = Math.min(size - 1, Math.floor(xs + cellReach));
      const y0 = Math.max(1, Math.floor(ys - cellReach)), y1 = Math.min(size - 1, Math.floor(ys + cellReach));
      const z0 = Math.max(1, Math.floor(zs - cellReach)), z1 = Math.min(size - 1, Math.floor(zs + cellReach));
      for (let z = z0; z < z1; z++) {
        const fz = z / size - w, fz2 = fz * fz, zo = size2 * z;
        for (let y = y0; y < y1; y++) {
          const fy = y / size - v, fy2 = fz2 + fy * fy, yo = zo + size * y;
          for (let x = x0; x < x1; x++) {
            const fx = x / size - u;
            const val = strength / (0.000001 + fx * fx + fy2) - subtract;
            if (val > 0) field[yo + x] += val;
          }
        }
      }
    }
    this.mc.update();
    this.mc.visible = true;

    if (traceActive) {
      const src = this.mc.geometry;
      const count = this.mc.count;
      const g = this.traced.geometry;
      const pa = src.getAttribute('position').array as Float32Array;
      const na = src.getAttribute('normal').array as Float32Array;
      let pos = g.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (!pos || pos.count !== count) {
        g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
        g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
        pos = g.getAttribute('position') as THREE.BufferAttribute;
      }
      (pos.array as Float32Array).set(pa.subarray(0, count * 3));
      (g.getAttribute('normal').array as Float32Array).set(na.subarray(0, count * 3));
      pos.needsUpdate = true;
      g.getAttribute('normal').needsUpdate = true;
      g.computeBoundingSphere();
      this.traced.position.copy(this.mc.position);
      this.traced.scale.copy(this.mc.scale);
      this.traced.userData.traceOnly = count > 0;
    } else {
      this.traced.userData.traceOnly = false;
    }
  }

  setMaterial(mat: THREE.MeshPhysicalMaterial): void {
    this.material = mat;
    this.mc.material = mat;
    this.traced.material = mat;
  }
}
