import * as THREE from 'three';
import { RAPIER } from '../physics/RigidWorld';
import type { Entity, PartInstance, ProxyShape } from '../sim/types';
import type { JointDef, MaterialRef, MaterialSpec, ModelDef, PartDef, PlacementDef, ShapeDef } from './schema';
import { makeThreeMaterial, resolveMaterial } from './materials';
import { boxRounding, capsuleMiddle, computeHull, primitiveGeometry, quatFromDeg, DEG } from './geometry';
import { assetBounds, assetHull, assetTrimesh, cloneAssetNode } from './assets';

export interface InstantiateContext {
  world: RAPIER.World;
  /** Fixed body at the origin used as the second body of world joints. */
  worldBody: RAPIER.RigidBody;
  parent: THREE.Object3D;
  nextId(): number;
}

const tmpV = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();

function v3(a: readonly number[]): THREE.Vector3 {
  return new THREE.Vector3(a[0], a[1], a[2]);
}

function partSpec(part: PartDef, override?: MaterialRef): MaterialSpec {
  const spec = { ...resolveMaterial(override ?? part.material) };
  if (part.density !== undefined) spec.density = part.density;
  if (part.friction !== undefined) spec.friction = part.friction;
  if (part.restitution !== undefined) spec.restitution = part.restitution;
  return spec;
}

/** Build the Rapier collider desc, collision proxy and bounding radius for one shape. */
function shapeCollision(shape: ShapeDef, body: PartDef['body']): { desc: RAPIER.ColliderDesc | null; proxy: ProxyShape | null; offset: THREE.Vector3; radius: number } {
  const offset = new THREE.Vector3();
  switch (shape.type) {
    case 'box': {
      const [x, y, z] = shape.size;
      const r = boxRounding(shape.size);
      const desc = r > 0.001
        ? RAPIER.ColliderDesc.roundCuboid(x / 2 - r, y / 2 - r, z / 2 - r, r)
        : RAPIER.ColliderDesc.cuboid(x / 2, y / 2, z / 2);
      return { desc, proxy: { kind: 'box', hx: x / 2, hy: y / 2, hz: z / 2 }, offset, radius: Math.hypot(x, y, z) / 2 };
    }
    case 'sphere':
      return { desc: RAPIER.ColliderDesc.ball(shape.radius), proxy: { kind: 'sphere', r: shape.radius }, offset, radius: shape.radius };
    case 'cylinder':
      return {
        desc: RAPIER.ColliderDesc.cylinder(shape.height / 2, shape.radius),
        proxy: { kind: 'cylinder', r: shape.radius, hh: shape.height / 2 },
        offset,
        radius: Math.hypot(shape.radius, shape.height / 2),
      };
    case 'capsule': {
      const hh = capsuleMiddle(shape.radius, shape.height) / 2;
      return { desc: RAPIER.ColliderDesc.capsule(hh, shape.radius), proxy: { kind: 'capsule', r: shape.radius, hh }, offset, radius: hh + shape.radius };
    }
    case 'cone': {
      const g = primitiveGeometry(shape);
      const hull = computeHull(g.getAttribute('position').array as Float32Array);
      return {
        desc: RAPIER.ColliderDesc.cone(shape.height / 2, shape.radius),
        proxy: { kind: 'hull', planes: hull.planes, radius: hull.radius },
        offset,
        radius: hull.radius,
      };
    }
    case 'mesh': {
      const scale = v3(shape.scale);
      let kind = shape.collider;
      if (kind === 'trimesh' && body === 'dynamic') kind = 'hull'; // Rapier trimeshes are hollow; dynamic bodies need volume.
      if (kind === 'trimesh') {
        const t = assetTrimesh(shape.asset, shape.node, scale);
        if (!t || t.indices.length < 3) return { desc: null, proxy: null, offset, radius: 0.5 };
        let radius = 0;
        for (let i = 0; i < t.vertices.length; i += 3) radius = Math.max(radius, Math.hypot(t.vertices[i], t.vertices[i + 1], t.vertices[i + 2]));
        return { desc: RAPIER.ColliderDesc.trimesh(t.vertices, t.indices), proxy: { kind: 'trimesh', vertices: t.vertices, indices: t.indices, radius }, offset, radius };
      }
      if (kind === 'hull') {
        const hull = assetHull(shape.asset, shape.node, scale);
        if (!hull) return { desc: null, proxy: null, offset, radius: 0.5 };
        const desc = RAPIER.ColliderDesc.convexHull(hull.vertices);
        return { desc, proxy: { kind: 'hull', planes: hull.planes, radius: hull.radius }, offset, radius: hull.radius };
      }
      const box = assetBounds(shape.asset, shape.node, scale);
      if (!box || box.isEmpty()) return { desc: null, proxy: null, offset, radius: 0.5 };
      box.getCenter(offset);
      const size = box.getSize(tmpV);
      if (kind === 'sphere') {
        const r = Math.max(size.x, size.y, size.z) / 2;
        return { desc: RAPIER.ColliderDesc.ball(r), proxy: { kind: 'sphere', r }, offset, radius: r + offset.length() };
      }
      return {
        desc: RAPIER.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2),
        proxy: { kind: 'box', hx: size.x / 2, hy: size.y / 2, hz: size.z / 2 },
        offset,
        radius: size.length() / 2 + offset.length(),
      };
    }
  }
}

function shapeVisual(shape: ShapeDef, spec: MaterialSpec, keepOriginal: boolean): THREE.Object3D | null {
  if (!shape.visible) return null;
  if (shape.type === 'mesh') {
    const obj = cloneAssetNode(shape.asset, shape.node);
    if (!obj) return null;
    obj.scale.set(shape.scale[0], shape.scale[1], shape.scale[2]);
    // Imported meshes keep their own materials when the material is "original".
    if (!keepOriginal) {
      const mat = makeThreeMaterial(spec);
      obj.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.material = mat;
      });
    }
    return obj;
  }
  const mesh = new THREE.Mesh(primitiveGeometry(shape), makeThreeMaterial(spec));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function bodyDesc(part: PartDef): RAPIER.RigidBodyDesc {
  switch (part.body) {
    case 'fixed': return RAPIER.RigidBodyDesc.fixed();
    case 'kinematic': return RAPIER.RigidBodyDesc.kinematicPositionBased();
    default: return RAPIER.RigidBodyDesc.dynamic();
  }
}

export function placementMatrix(p: PlacementDef): { pos: THREE.Vector3; quat: THREE.Quaternion } {
  return { pos: v3(p.position), quat: quatFromDeg(p.rotation) };
}

export function instantiateModel(ctx: InstantiateContext, model: ModelDef, placement: PlacementDef): Entity {
  const { pos: P, quat: Q } = placementMatrix(placement);
  const entity: Entity = {
    id: ctx.nextId(),
    name: model.name,
    model,
    placement,
    parts: [],
    partById: new Map(),
    joints: [],
    softs: [],
  };

  for (const part of model.parts) {
    const spec = partSpec(part, placement.material);
    const worldPos = v3(part.position).applyQuaternion(Q).add(P);
    const worldQuat = Q.clone().multiply(quatFromDeg(part.rotation));

    const desc = bodyDesc(part)
      .setTranslation(worldPos.x, worldPos.y, worldPos.z)
      .setRotation({ x: worldQuat.x, y: worldQuat.y, z: worldQuat.z, w: worldQuat.w })
      .setLinearDamping(part.linearDamping)
      .setAngularDamping(part.angularDamping)
      .setGravityScale(part.gravityScale)
      .setCcdEnabled(part.ccd);
    const body = ctx.world.createRigidBody(desc);

    const object = new THREE.Group();
    object.name = part.name;
    object.position.copy(worldPos);
    object.quaternion.copy(worldQuat);

    const inst: PartInstance = {
      entity,
      def: part,
      body,
      object,
      shapes: [],
      spec,
      prevPos: worldPos.clone(),
      prevQuat: worldQuat.clone(),
      currPos: worldPos.clone(),
      currQuat: worldQuat.clone(),
      boundRadius: 0.1,
      area: 0.01,
    };
    object.userData.part = inst;

    let bound = 0;
    for (const shape of part.shapes) {
      const shapeSpec = shape.material && placement.material === undefined ? resolveMaterial(shape.material) : spec;
      const localPos = v3(shape.position);
      const localQuat = quatFromDeg(shape.rotation);
      const col = shape.collide ? shapeCollision(shape, part.body) : { desc: null, proxy: null, offset: new THREE.Vector3(), radius: 0 };
      let collider: RAPIER.Collider | null = null;
      if (col.desc) {
        const off = col.offset.clone().applyQuaternion(localQuat).add(localPos);
        col.desc
          .setTranslation(off.x, off.y, off.z)
          .setRotation({ x: localQuat.x, y: localQuat.y, z: localQuat.z, w: localQuat.w })
          .setDensity(shapeSpec.density)
          .setFriction(shapeSpec.friction)
          .setRestitution(shapeSpec.restitution);
        collider = ctx.world.createCollider(col.desc, body);
      }
      const effectiveRef = placement.material ?? shape.material ?? part.material;
      const keepOriginal = shape.type === 'mesh' && !shape.asset.startsWith('proc:') && effectiveRef === 'original';
      const visual = shapeVisual(shape, shapeSpec, keepOriginal);
      if (visual) {
        visual.position.copy(localPos);
        visual.quaternion.copy(localQuat);
        object.add(visual);
      }
      const proxyPos = col.offset.clone().applyQuaternion(localQuat).add(localPos);
      inst.shapes.push({ def: shape, localPos: proxyPos, localQuat, proxy: col.proxy, boundRadius: col.radius, collider, visual, spec: shapeSpec });
      bound = Math.max(bound, proxyPos.length() + col.radius);
    }
    inst.boundRadius = Math.max(0.05, bound);
    // Rough cross-section for drag: a third of the bounding sphere's disc
    inst.area = Math.PI * inst.boundRadius * inst.boundRadius * 0.5;

    if (part.initialVelocity || placement.velocity) {
      const v = v3(part.initialVelocity ?? [0, 0, 0]).applyQuaternion(Q);
      if (placement.velocity) v.add(v3(placement.velocity));
      body.setLinvel({ x: v.x, y: v.y, z: v.z }, true);
    }
    if (part.initialAngularVelocity) {
      const w = v3(part.initialAngularVelocity).applyQuaternion(Q);
      body.setAngvel({ x: w.x, y: w.y, z: w.z }, true);
    }

    ctx.parent.add(object);
    entity.parts.push(inst);
    entity.partById.set(part.id, inst);
  }

  for (const j of model.joints) {
    const joint = createJoint(ctx, entity, j, P, Q);
    if (joint) entity.joints.push(joint);
  }

  return entity;
}

function localPoint(body: RAPIER.RigidBody, world: THREE.Vector3): RAPIER.Vector {
  const t = body.translation();
  const r = body.rotation();
  tmpQ.set(r.x, r.y, r.z, r.w).invert();
  const p = world.clone().sub(tmpV.set(t.x, t.y, t.z)).applyQuaternion(tmpQ);
  return { x: p.x, y: p.y, z: p.z };
}

function localDir(body: RAPIER.RigidBody, world: THREE.Vector3): RAPIER.Vector {
  const r = body.rotation();
  tmpQ.set(r.x, r.y, r.z, r.w).invert();
  const d = world.clone().applyQuaternion(tmpQ).normalize();
  return { x: d.x, y: d.y, z: d.z };
}

function invRot(body: RAPIER.RigidBody): RAPIER.Rotation {
  const r = body.rotation();
  const q = new THREE.Quaternion(r.x, r.y, r.z, r.w).invert();
  return { x: q.x, y: q.y, z: q.z, w: q.w };
}

export function createJoint(ctx: InstantiateContext, entity: Entity, j: JointDef, P: THREE.Vector3, Q: THREE.Quaternion): RAPIER.ImpulseJoint | null {
  const a = entity.partById.get(j.a);
  if (!a) return null;
  const bPart = j.b ? entity.partById.get(j.b) : null;
  if (j.b && !bPart) return null;
  const bodyA = a.body;
  const bodyB = bPart ? bPart.body : ctx.worldBody;

  const anchorW = v3(j.anchor).applyQuaternion(Q).add(P);
  const anchorBW = j.anchorB ? v3(j.anchorB).applyQuaternion(Q).add(P) : anchorW;
  const axisW = v3(j.axis).applyQuaternion(Q).normalize();
  const a1 = localPoint(bodyA, anchorW);
  const a2 = localPoint(bodyB, anchorBW);

  let data: RAPIER.JointData;
  switch (j.type) {
    case 'fixed':
      data = RAPIER.JointData.fixed(a1, invRot(bodyA), localPoint(bodyB, anchorW), invRot(bodyB));
      break;
    case 'ball':
      data = RAPIER.JointData.spherical(a1, localPoint(bodyB, anchorW));
      break;
    case 'hinge':
      data = RAPIER.JointData.revoluteWithAxes(a1, localPoint(bodyB, anchorW), localDir(bodyA, axisW), localDir(bodyB, axisW));
      break;
    case 'slider':
      data = RAPIER.JointData.prismatic(a1, localPoint(bodyB, anchorW), localDir(bodyA, axisW));
      if (j.limits) {
        data.limitsEnabled = true;
        data.limits = [j.limits[0], j.limits[1]];
      }
      break;
    case 'spring': {
      const len = j.length ?? anchorW.distanceTo(anchorBW);
      data = RAPIER.JointData.spring(len, j.stiffness, j.damping, a1, a2);
      break;
    }
    case 'rope': {
      const len = j.length ?? Math.max(0.01, anchorW.distanceTo(anchorBW));
      data = RAPIER.JointData.rope(len, a1, a2);
      break;
    }
  }
  const joint = ctx.world.createImpulseJoint(data, bodyA, bodyB, true);
  joint.setContactsEnabled(j.collide);
  if (j.type === 'hinge' || j.type === 'slider') {
    const unit = joint as RAPIER.UnitImpulseJoint;
    if (j.type === 'hinge' && j.limits) unit.setLimits(j.limits[0] * DEG, j.limits[1] * DEG);
    // Rapier drives body B relative to body A; our convention is "part A spins
    // at +velocity about the axis", so the sign is flipped.
    if (j.motor) unit.configureMotorVelocity(-j.motor.velocity, j.motor.force);
  }
  return joint;
}

/** Remove an entity's bodies, joints and visuals. Soft parts are removed by the particle world. */
export function destroyEntityRigid(world: RAPIER.World, entity: Entity): void {
  for (const j of entity.joints) {
    if (j.isValid()) world.removeImpulseJoint(j, true);
  }
  for (const p of entity.parts) {
    world.removeRigidBody(p.body);
    p.object.removeFromParent();
  }
  entity.joints = [];
}
