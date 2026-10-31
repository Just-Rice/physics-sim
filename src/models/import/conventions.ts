import * as THREE from 'three';
import { parseModel, type JointInput, type ModelDef, type PartInput, type ShapeInput, type SoftPartInput } from '../schema';
import { degFromQuat } from '../geometry';

/**
 * Converts a loaded scene (GLB from Blender, OBJ, STL, or our own GLB export)
 * into a ModelDef. Pure: no I/O, no Rapier; unit-tested.
 *
 * Conventions (see docs/BLENDER.md):
 * - Objects named `COL_*` or `*_col` are invisible collision shapes.
 * - Custom properties (glTF extras) on objects:
 *   ps_body (dynamic|fixed), ps_material (preset id), ps_density, ps_friction,
 *   ps_restitution, ps_collider (hull|box|sphere|trimesh),
 *   ps_kind (rigid|cloth|softbody|fluid), ps_pinned ([[x,y,z], ...]), ps_attach (object name).
 * - Empties named `JOINT_*` carry ps_joint = { type, a, b, limits, motor, ... };
 *   the empty's position is the anchor and its local +Z is the axis.
 */

export type ColliderChoice = 'auto' | 'hull' | 'box' | 'sphere' | 'trimesh';

export interface ImportOptions {
  /** Asset id the mesh shapes will reference. */
  assetId: string;
  name: string;
  /** 'single' = one rigid body, 'per-object' = one body per top-level object. */
  mode: 'single' | 'per-object';
  collider: ColliderChoice;
  /** Material preset id, or 'original' to keep the file's look. */
  material: string;
  body: 'dynamic' | 'fixed';
  /** Uniform scale applied to the whole import. */
  scale: number;
  /** Rotate Z-up files (typical for OBJ/STL) to Y-up. */
  zUp: boolean;
}

export const defaultImportOptions = (assetId: string, name: string): ImportOptions => ({
  assetId,
  name,
  mode: 'single',
  collider: 'auto',
  material: 'original',
  body: 'dynamic',
  scale: 1,
  zUp: false,
});

export interface ImportResult {
  model: ModelDef;
  warnings: string[];
}

type V3 = [number, number, number];
const r = (v: number) => Math.round(v * 10000) / 10000;
const v3 = (v: THREE.Vector3): V3 => [r(v.x), r(v.y), r(v.z)];

export function isColliderName(name: string): boolean {
  return /^COL_/i.test(name) || /_col$/i.test(name) || /^UCX_/i.test(name);
}

function parseMaybeJSON<T>(v: unknown): T | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return undefined;
    }
  }
  return v as T;
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

function hasMesh(o: THREE.Object3D): boolean {
  let found = false;
  o.traverse((c) => {
    if ((c as THREE.Mesh).isMesh) found = true;
  });
  return found;
}

/** Give every node a unique, non-empty name so mesh shapes can reference them. */
export function ensureUniqueNames(root: THREE.Object3D): void {
  const seen = new Map<string, number>();
  root.traverse((o) => {
    let n = o.name || ((o as THREE.Mesh).isMesh ? 'mesh' : 'node');
    const k = seen.get(n) ?? 0;
    seen.set(n, k + 1);
    if (k > 0) n = `${n}.${k}`;
    o.name = n;
  });
}

function sanitizeId(name: string, used: Set<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'part';
  let id = base;
  let i = 2;
  while (used.has(id)) id = `${base}-${i++}`;
  used.add(id);
  return id;
}

/** Transform of `o` relative to `root` (root's own transform excluded). */
function relativeMatrix(root: THREE.Object3D, o: THREE.Object3D): THREE.Matrix4 {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  return new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
}

function decompose(m: THREE.Matrix4): { p: THREE.Vector3; q: THREE.Quaternion; s: THREE.Vector3 } {
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  m.decompose(p, q, s);
  return { p, q, s };
}

/** Our own GLB export: exact reconstruction from ps_* JSON blobs. */
function fromOwnExport(input: THREE.Object3D, opts: ImportOptions, warnings: string[]): ModelDef | null {
  // GLTFLoader wraps the exported root in a scene node; look one level down too.
  const root = input.userData.ps_model ? input : input.children.find((c) => c.userData.ps_model);
  if (!root) return null;
  const meta = parseMaybeJSON<{ id: string; name: string; description?: string }>(root.userData.ps_model);
  if (!meta) return null;
  const parts: PartInput[] = [];
  const joints: JointInput[] = [];
  const softParts: SoftPartInput[] = [];
  for (const child of root.children) {
    const ud = child.userData;
    if (ud.ps_part) {
      const part = parseMaybeJSON<PartInput>(ud.ps_part)!;
      const shapes: ShapeInput[] = [];
      for (const sc of child.children) {
        const shape = parseMaybeJSON<ShapeInput>(sc.userData.ps_shape);
        if (!shape) continue;
        if (shape.type === 'mesh') {
          // Mesh shapes now point at the freshly imported asset.
          shapes.push({ ...shape, asset: opts.assetId, node: sc.name, scale: [1, 1, 1] });
        } else shapes.push(shape);
      }
      parts.push({ ...part, id: part.id ?? child.name, shapes });
    } else if (ud.ps_joint) {
      const j = parseMaybeJSON<JointInput>(ud.ps_joint);
      if (j) joints.push(j);
    } else if (ud.ps_soft) {
      const sp = parseMaybeJSON<SoftPartInput>(ud.ps_soft);
      if (sp) softParts.push(sp);
    }
  }
  try {
    return parseModel({ id: meta.id, name: opts.name || meta.name, description: meta.description ?? '', category: 'My Models', parts, joints, softParts });
  } catch (err) {
    warnings.push(`Could not read physics data: ${(err as Error).message}`);
    return null;
  }
}

const COLLIDERS = ['hull', 'box', 'sphere', 'trimesh'] as const;

function colliderFor(choice: ColliderChoice | string | undefined, body: 'dynamic' | 'fixed'): 'hull' | 'box' | 'sphere' | 'trimesh' {
  if (!choice || !COLLIDERS.includes(choice as never)) return body === 'fixed' ? 'trimesh' : 'hull';
  return choice as (typeof COLLIDERS)[number];
}

export function objectToModel(input: THREE.Object3D, opts: ImportOptions): ImportResult {
  const warnings: string[] = [];
  const own = fromOwnExport(input, opts, warnings);
  if (own) return { model: own, warnings };

  const root = input;
  if (opts.zUp) root.rotation.x = -Math.PI / 2;
  root.scale.setScalar(opts.scale);
  root.updateMatrixWorld(true);
  // Undo the root transform for "relative" queries by wrapping in a holder.
  const holder = new THREE.Group();
  holder.add(root);
  holder.updateMatrixWorld(true);

  const used = new Set<string>();
  const parts: PartInput[] = [];
  const joints: JointInput[] = [];
  const softParts: SoftPartInput[] = [];
  const partByObject = new Map<THREE.Object3D, string>();

  // Collect joint empties first; they are not bodies.
  const jointNodes: THREE.Object3D[] = [];
  root.traverse((o) => {
    if (/^JOINT_/i.test(o.name) || o.userData.ps_joint) jointNodes.push(o);
  });

  // Decide which objects become bodies.
  let bodies: THREE.Object3D[];
  const top = root.children.length === 1 && !hasMeshDirect(root.children[0]) && root.children[0].children.length > 0 && !root.children[0].userData.ps_body
    ? root.children[0].children // unwrap a single scene/collection node
    : root.children;
  // Top-level COL_<Name> / <Name>_col objects belong to the body called <Name>.
  const colOwner = new Map<THREE.Object3D, THREE.Object3D>();
  if (opts.mode === 'per-object') {
    for (const o of top) {
      if (!isColliderName(o.name)) continue;
      const base = o.name.replace(/^(COL_|UCX_)/i, '').replace(/_col$/i, '').replace(/[._]\d+$/, '');
      const owner = top.find((t) => t !== o && t.name === base);
      if (owner) colOwner.set(o, owner);
    }
    bodies = top.filter((o) => !jointNodes.includes(o) && hasMesh(o) && !colOwner.has(o));
  } else bodies = [root];

  // Soft parts are authored per object (ps_kind) and always become separate soft parts.
  const softNodes: THREE.Object3D[] = [];
  root.traverse((o) => {
    const k = o.userData.ps_kind;
    if ((k === 'cloth' || k === 'softbody' || k === 'fluid') && (o as THREE.Mesh).isMesh) softNodes.push(o);
  });

  for (const b of bodies) {
    const ud = b === root ? findBodyProps(top) : b.userData;
    const body: 'dynamic' | 'fixed' = ud.ps_body === 'fixed' || ud.ps_body === 'static' ? 'fixed' : ud.ps_body === 'dynamic' ? 'dynamic' : opts.body;
    const id = sanitizeId(b === root ? opts.name : b.name, used);
    const meshes: THREE.Mesh[] = [];
    const collect = (n: THREE.Object3D) => n.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && !softNodes.includes(o) && !isInside(o, softNodes)) meshes.push(o as THREE.Mesh);
    });
    collect(b);
    for (const [col, owner] of colOwner) if (owner === b) collect(col);
    if (!meshes.length) continue;
    // Part origin: bottom-centre of the body's bounds keeps spawning intuitive.
    const box = new THREE.Box3();
    for (const m of meshes) box.expandByObject(m);
    const origin = b === root ? new THREE.Vector3((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2) : decompose(relativeMatrix(holder, b)).p;
    const partQuat = b === root ? new THREE.Quaternion() : decompose(relativeMatrix(holder, b)).q;
    const partInv = new THREE.Matrix4().compose(origin, partQuat, new THREE.Vector3(1, 1, 1)).invert();

    const hasColliders = meshes.some((m) => isColliderName(m.name) || m.userData.ps_role === 'collider');
    const shapes: ShapeInput[] = [];
    for (const m of meshes) {
      const isCol = isColliderName(m.name) || m.userData.ps_role === 'collider';
      const local = new THREE.Matrix4().multiplyMatrices(partInv, relativeMatrix(holder, m));
      const { p, q, s } = decompose(local);
      const mud = m.userData;
      const choice = (mud.ps_collider ?? ud.ps_collider ?? opts.collider) as ColliderChoice;
      shapes.push({
        type: 'mesh',
        asset: opts.assetId,
        node: m.name,
        position: v3(p),
        rotation: degFromQuat(q),
        scale: v3(s),
        collider: isCol ? (choice === 'trimesh' && body === 'dynamic' ? 'hull' : colliderFor(COLLIDERS.includes(choice as never) ? choice : 'hull', body)) : colliderFor(choice, body),
        visible: !isCol,
        // With explicit collision pieces, visual meshes don't collide themselves.
        collide: isCol || !hasColliders,
      });
    }
    const material = (ud.ps_material as string | undefined) ?? opts.material;
    parts.push({
      id,
      name: b === root ? opts.name : b.name,
      body,
      position: v3(origin),
      rotation: degFromQuat(partQuat),
      material,
      density: num(ud.ps_density),
      friction: num(ud.ps_friction),
      restitution: num(ud.ps_restitution),
      shapes,
    });
    partByObject.set(b, id);
    for (const m of meshes) partByObject.set(m, id);
  }

  // Joints
  const nameToPart = (n: unknown): string | null | undefined => {
    if (n === null || n === undefined || n === '' || n === 'world' || n === 'WORLD') return null;
    const o = root.getObjectByName(String(n));
    if (!o) return undefined;
    let p: THREE.Object3D | null = o;
    while (p) {
      const id = partByObject.get(p);
      if (id) return id;
      p = p.parent;
    }
    return undefined;
  };
  for (const jn of jointNodes) {
    const data = parseMaybeJSON<Record<string, unknown>>(jn.userData.ps_joint) ?? {};
    const type = String(data.type ?? 'hinge');
    const a = nameToPart(data.a);
    const b = nameToPart(data.b);
    if (!a) {
      warnings.push(`${jn.name}: part A “${String(data.a)}” not found — joint skipped`);
      continue;
    }
    if (b === undefined) {
      warnings.push(`${jn.name}: part B “${String(data.b)}” not found — attached to the world`);
    }
    const { p, q } = decompose(relativeMatrix(holder, jn));
    // The Blender add-on writes the axis explicitly (Y-up world); otherwise use the empty's local +Z.
    const explicit = parseMaybeJSON<number[]>(data.axis);
    const axis = explicit && explicit.length === 3
      ? new THREE.Vector3(explicit[0], explicit[1], explicit[2]).applyQuaternion(root.quaternion).normalize()
      : new THREE.Vector3(0, 0, 1).applyQuaternion(q).normalize();
    const motor = parseMaybeJSON<{ velocity?: number; force?: number }>(data.motor);
    const limits = parseMaybeJSON<number[]>(data.limits);
    joints.push({
      type: (['fixed', 'ball', 'hinge', 'slider', 'spring', 'rope'].includes(type) ? type : 'hinge') as JointInput['type'],
      a,
      b: b ?? null,
      anchor: v3(p),
      axis: v3(axis),
      limits: limits && limits.length === 2 ? [Number(limits[0]), Number(limits[1])] : undefined,
      motor: motor && motor.velocity !== undefined ? { velocity: Number(motor.velocity), force: Number(motor.force ?? 50) } : undefined,
      stiffness: num(data.stiffness),
      damping: num(data.damping),
      length: num(data.length),
      collide: data.collide === true,
    });
  }

  // Soft parts from ps_kind
  for (const sn of softNodes) {
    const ud = sn.userData;
    const { p, q, s } = decompose(relativeMatrix(holder, sn));
    const kind = ud.ps_kind as 'cloth' | 'softbody' | 'fluid';
    const id = sanitizeId(sn.name, used);
    const mat = (ud.ps_material as string | undefined) ?? (kind === 'cloth' ? 'fabric' : kind === 'fluid' ? 'water' : 'jelly');
    if (kind === 'fluid') {
      const box = new THREE.Box3().setFromObject(sn);
      const size = box.getSize(new THREE.Vector3());
      softParts.push({ type: 'fluid', id, name: sn.name, position: v3(box.getCenter(new THREE.Vector3())), size: v3(size), material: mat });
      continue;
    }
    if (Math.abs(s.x - s.y) > 1e-3 || Math.abs(s.y - s.z) > 1e-3) warnings.push(`${sn.name}: non-uniform scale on a soft mesh is ignored — apply scale in Blender`);
    const pinsRaw = parseMaybeJSON<number[] | number[][]>(ud.ps_pinned) ?? [];
    const pins: V3[] = [];
    if (Array.isArray(pinsRaw)) {
      if (pinsRaw.length && Array.isArray(pinsRaw[0])) for (const pt of pinsRaw as number[][]) pins.push([pt[0], pt[1], pt[2]]);
      else for (let i = 0; i + 2 < pinsRaw.length; i += 3) pins.push([(pinsRaw as number[])[i], (pinsRaw as number[])[i + 1], (pinsRaw as number[])[i + 2]]);
    }
    // Pinned points are authored in Blender world space (Y-up after export), scaled with the import.
    const pinned = pins.map((pt) => v3(new THREE.Vector3(...pt).multiplyScalar(opts.scale)));
    if (kind === 'cloth') {
      const attach = ud.ps_attach ? nameToPart(ud.ps_attach) ?? null : null;
      softParts.push({ type: 'cloth', id, name: sn.name, position: v3(p), rotation: degFromQuat(q), asset: opts.assetId, node: sn.name, pins: 'none', pinnedPoints: pinned, attachTo: attach, material: mat, stretch: num(ud.ps_stretch), bend: num(ud.ps_bend) });
    } else {
      softParts.push({ type: 'softbody', id, name: sn.name, position: v3(p), rotation: degFromQuat(q), shape: 'mesh', asset: opts.assetId, node: sn.name, mass: num(ud.ps_mass), pressure: num(ud.ps_pressure), shapeMatching: num(ud.ps_shape_matching), material: mat });
    }
  }

  holder.remove(root);
  root.rotation.set(0, 0, 0);
  root.scale.set(1, 1, 1);
  root.updateMatrixWorld(true);

  if (!parts.length && !softParts.length) warnings.push('No meshes found in the file.');
  const model = parseModel(JSON.parse(JSON.stringify({ id: 'import', name: opts.name, category: 'My Models', parts, joints, softParts })));
  return { model, warnings };
}

function hasMeshDirect(o: THREE.Object3D): boolean {
  return (o as THREE.Mesh).isMesh === true;
}

function isInside(o: THREE.Object3D, nodes: THREE.Object3D[]): boolean {
  let p = o.parent;
  while (p) {
    if (nodes.includes(p)) return true;
    p = p.parent;
  }
  return false;
}

/** For single-body imports, the first object with physics props provides them. */
function findBodyProps(objects: THREE.Object3D[]): Record<string, unknown> {
  for (const o of objects) {
    let found: Record<string, unknown> | null = null;
    o.traverse((c) => {
      if (!found && (c.userData.ps_body || c.userData.ps_material || c.userData.ps_density)) found = c.userData;
    });
    if (found) return found;
  }
  return {};
}
