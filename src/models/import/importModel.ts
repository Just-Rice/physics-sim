import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { App } from '../../app/App';
import type { PickedFile } from '../../platform';
import { registerAsset } from '../assets';
import type { StoredAsset } from '../library';
import { safeParseModel, type ModelDef } from '../schema';
import { defaultImportOptions, ensureUniqueNames, objectToModel, type ImportOptions } from './conventions';
import { triangleCount } from '../geometry';
import { MATERIAL_PRESETS } from '../materials';
import { h, modal } from '../../ui/dom';
import { generateEnvironment } from '../../render/environment';

const MESH_EXT = /\.(glb|gltf|obj|stl)$/i;

async function hashBytes(bytes: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-1', bytes);
  return [...new Uint8Array(d)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function parseGLB(bytes: ArrayBuffer, manager?: THREE.LoadingManager): Promise<THREE.Group> {
  return new Promise((resolve, reject) => {
    new GLTFLoader(manager).parse(bytes, '', (g) => resolve(g.scene), (e) => reject(e));
  });
}

async function toGLB(root: THREE.Object3D): Promise<ArrayBuffer> {
  return (await new GLTFExporter().parseAsync(root, { binary: true })) as ArrayBuffer;
}

/** Load any supported mesh file (plus companions for .gltf) into GLB bytes. */
export async function loadMeshFiles(files: PickedFile[]): Promise<{ glb: ArrayBuffer; main: PickedFile }> {
  const main = files.find((f) => MESH_EXT.test(f.name));
  if (!main) throw new Error('No .glb, .gltf, .obj or .stl file found');
  const ext = main.name.split('.').pop()!.toLowerCase();
  if (ext === 'glb') return { glb: main.bytes, main };
  if (ext === 'gltf') {
    // Resolve .bin and textures from the other dropped files.
    const urls = new Map<string, string>();
    for (const f of files) urls.set(f.name.split('/').pop()!, URL.createObjectURL(new Blob([f.bytes])));
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((url) => urls.get(decodeURIComponent(url.split('/').pop() ?? '')) ?? url);
    const text = new TextDecoder().decode(main.bytes);
    const scene = await new Promise<THREE.Group>((resolve, reject) => new GLTFLoader(manager).parse(text, '', (g) => resolve(g.scene), reject));
    // Wait for textures referenced by blob URLs
    await new Promise((r) => setTimeout(r, 50));
    const glb = await toGLB(scene);
    urls.forEach((u) => URL.revokeObjectURL(u));
    return { glb, main };
  }
  let obj: THREE.Object3D;
  if (ext === 'obj') {
    obj = new OBJLoader().parse(new TextDecoder().decode(main.bytes));
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.material = new THREE.MeshStandardMaterial({ color: '#c9c9c9', roughness: 0.6 });
    });
  } else {
    const geo = new STLLoader().parse(main.bytes);
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: '#c9c9c9', roughness: 0.6 }));
    m.name = main.name.replace(/\.[^.]+$/, '');
    obj = new THREE.Group();
    obj.add(m);
  }
  obj.name = main.name.replace(/\.[^.]+$/, '');
  ensureUniqueNames(obj);
  return { glb: await toGLB(obj), main };
}

/** Parse stored GLB bytes and register them as a mesh asset. */
export async function registerStoredAsset(asset: StoredAsset): Promise<THREE.Group> {
  const root = await parseGLB(asset.bytes);
  ensureUniqueNames(root);
  registerAsset({ id: asset.id, name: asset.name, root, source: 'import', bytes: asset.bytes });
  return root;
}

function guessMode(root: THREE.Object3D): ImportOptions['mode'] {
  let joints = 0, bodies = 0;
  root.traverse((o) => {
    if (/^JOINT_/i.test(o.name) || o.userData.ps_joint) joints++;
    if (o.userData.ps_body) bodies++;
  });
  return joints > 0 || bodies > 1 ? 'per-object' : 'single';
}

function guessZUp(name: string): boolean {
  return /\.(stl)$/i.test(name);
}

/** Full import: physmodel JSON, or a mesh file through the import dialog. */
export async function importFiles(app: App, files: PickedFile[], opts: { silent?: boolean } = {}): Promise<void> {
  const json = files.find((f) => /\.json$/i.test(f.name));
  if (json && !files.some((f) => MESH_EXT.test(f.name))) {
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder().decode(json.bytes));
    } catch {
      app.toast(`${json.name} is not valid JSON`, 'error');
      return;
    }
    const r = safeParseModel(raw);
    if (!r.ok) {
      app.toast(`Not a Physics Sim model: ${r.error.split('\n')[0]}`, 'error');
      return;
    }
    const model = { ...r.model, id: app.library.uniqueId(r.model.name), category: 'My Models' as const };
    await app.library.saveUserModel(model);
    app.libraryPanel.setTab('mine');
    app.toast(`Added “${model.name}” to My Models`);
    return;
  }

  let loaded: { glb: ArrayBuffer; main: PickedFile };
  try {
    loaded = await loadMeshFiles(files);
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    app.toast(/draco|meshopt/i.test(msg) ? 'This file uses mesh compression — export from Blender with compression turned off.' : `Import failed: ${msg}`, 'error');
    return;
  }
  const assetId = `asset-${await hashBytes(loaded.glb)}`;
  const baseName = loaded.main.name.replace(/\.[^.]+$/, '');
  const existing = app.library.user.find((m) => m.source === loaded.main.name);

  // Hot reload (watched Blender folder) or silent import: reuse previous options.
  if (opts.silent || existing) {
    const root = await parseGLB(loaded.glb);
    ensureUniqueNames(root);
    const prev = (existing?.importOptions as Partial<ImportOptions> | undefined) ?? {};
    const io: ImportOptions = { ...defaultImportOptions(assetId, existing?.name ?? baseName), mode: guessMode(root), zUp: guessZUp(loaded.main.name), ...prev, assetId };
    await commit(app, root, loaded, io, existing?.id, false);
    app.toast(existing ? `Reloaded “${existing.name}” from ${loaded.main.name}` : `Imported “${baseName}”`);
    return;
  }

  const root = await parseGLB(loaded.glb);
  ensureUniqueNames(root);
  const io: ImportOptions = { ...defaultImportOptions(assetId, baseName), mode: guessMode(root), zUp: guessZUp(loaded.main.name) };
  showImportDialog(app, root, loaded, io);
}

async function commit(app: App, root: THREE.Object3D, loaded: { glb: ArrayBuffer; main: PickedFile }, io: ImportOptions, keepId: string | undefined, place: boolean): Promise<ModelDef | null> {
  const stored: StoredAsset = { id: io.assetId, name: loaded.main.name, bytes: loaded.glb, ext: 'glb' };
  const assetRoot = await registerStoredAsset(stored);
  let result: ReturnType<typeof objectToModel>;
  try {
    result = objectToModel(assetRoot.clone(true), io);
  } catch (err) {
    console.error(err);
    app.toast(`Could not read ${loaded.main.name}: ${(err as Error).message.split('\n')[0]}`, 'error');
    return null;
  }
  const { model, warnings } = result;
  if (!model.parts.length && !model.softParts.length) {
    app.toast('Nothing to import: no meshes found', 'error');
    return null;
  }
  const final: ModelDef = { ...model, id: keepId ?? app.library.uniqueId(io.name), name: io.name, category: 'My Models', source: loaded.main.name, importOptions: { ...io } };
  await app.library.saveUserModel(final, [stored]);
  app.libraryPanel.refreshThumb(final.id);
  app.replaceModelInstances(final);
  for (const w of warnings.slice(0, 3)) app.toast(w, 'error');
  if (place) {
    const t = app.view.controls.target.clone();
    app.spawnModel(final, new THREE.Vector3(t.x, 0.6, t.z));
  }
  return final;
}

function showImportDialog(app: App, root: THREE.Group, loaded: { glb: ArrayBuffer; main: PickedFile }, io: ImportOptions): void {
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const tris = triangleCount(root);
  let joints = 0, colliders = 0, softs = 0, meshes = 0;
  root.traverse((o) => {
    if (/^JOINT_/i.test(o.name)) joints++;
    if (/^COL_|_col$|^UCX_/i.test(o.name)) colliders++;
    if (o.userData.ps_kind && o.userData.ps_kind !== 'rigid') softs++;
    if ((o as THREE.Mesh).isMesh) meshes++;
  });
  if (maxDim > 30 || maxDim < 0.02) io.scale = Math.round((1 / maxDim) * 1000) / 1000;

  // Preview
  const canvas = document.createElement('canvas');
  const preview = h('div', { class: 'preview' }, canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 0.8;
  const scene = new THREE.Scene();
  const env = generateEnvironment('studio', 40, 135);
  scene.environment = env.texture;
  scene.background = new THREE.Color('#10141c');
  scene.add(new THREE.DirectionalLight(0xffffff, 2).translateX(3).translateY(5).translateZ(4));
  const grid = new THREE.GridHelper(4, 16, 0x335577, 0x223344);
  scene.add(grid);
  const holder = new THREE.Group();
  const shown = root.clone(true);
  holder.add(shown);
  scene.add(holder);
  const camera = new THREE.PerspectiveCamera(40, 2, 0.01, 1000);
  const controls = new OrbitControls(camera, canvas);
  const frame = () => {
    holder.rotation.x = io.zUp ? -Math.PI / 2 : 0;
    holder.scale.setScalar(io.scale);
    holder.position.set(0, 0, 0);
    holder.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(holder);
    holder.position.y = -b.min.y;
    holder.position.x = -(b.min.x + b.max.x) / 2;
    holder.position.z = -(b.min.z + b.max.z) / 2;
    const r = Math.max(0.2, b.getSize(new THREE.Vector3()).length() / 2);
    grid.scale.setScalar(Math.max(0.5, r));
    controls.target.set(0, r * 0.5, 0);
    camera.position.set(r * 1.8, r * 1.3, r * 2.2);
    camera.near = r / 100;
    camera.far = r * 100;
    camera.updateProjectionMatrix();
    controls.update();
  };
  let alive = true;
  const loop = () => {
    if (!alive) return;
    const w = preview.clientWidth || 600, hgt = preview.clientHeight || 260;
    if (canvas.width !== w || canvas.height !== hgt) {
      renderer.setSize(w, hgt, false);
      camera.aspect = w / hgt;
      camera.updateProjectionMatrix();
    }
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  };

  const field = (label: string, el: HTMLElement) => h('div', { class: 'row' }, h('label', {}, label), el);
  const name = h('input', { type: 'text', value: io.name });
  name.addEventListener('keydown', (e) => e.stopPropagation());
  const sel = (opts: [string, string][], value: string, on: (v: string) => void) => {
    const s = h('select', { class: 'select' }, ...opts.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
    s.addEventListener('change', () => on(s.value));
    return s;
  };
  const scale = h('input', { type: 'number', value: String(io.scale), step: 0.01, min: 0.0001 });
  scale.addEventListener('keydown', (e) => e.stopPropagation());
  scale.addEventListener('change', () => {
    io.scale = Math.max(0.0001, Number(scale.value) || 1);
    frame();
  });
  const zUp = h('input', { type: 'checkbox', checked: io.zUp });
  zUp.addEventListener('change', () => {
    io.zUp = zUp.checked;
    frame();
  });
  const dims = h('span', { class: 'insp-sub' });
  const updateDims = () => (dims.textContent = `≈ ${(size.x * io.scale).toFixed(2)} × ${(size.y * io.scale).toFixed(2)} × ${(size.z * io.scale).toFixed(2)} m`);
  updateDims();
  scale.addEventListener('change', updateDims);

  const warn: HTMLElement[] = [];
  if (tris > 150000) warn.push(h('div', { class: 'warn' }, `${tris.toLocaleString()} triangles — fine for physics, but ray tracing will be slow. Consider decimating in Blender.`));
  if (meshes > 40 && io.mode === 'per-object') warn.push(h('div', { class: 'warn' }, `${meshes} meshes as separate bodies may be slow.`));

  const body = h('div', {},
    h('h2', {}, `Import ${loaded.main.name}`),
    h('p', { class: 'sub' }, `${meshes} mesh${meshes === 1 ? '' : 'es'} · ${tris.toLocaleString()} triangles${colliders ? ` · ${colliders} COL_ collider${colliders === 1 ? '' : 's'}` : ''}${joints ? ` · ${joints} joint${joints === 1 ? '' : 's'}` : ''}${softs ? ` · ${softs} soft part${softs === 1 ? '' : 's'}` : ''}`),
    preview,
    field('Name', name),
    field('Bodies', sel([['single', 'One rigid body'], ['per-object', 'One body per object']], io.mode, (v) => (io.mode = v as ImportOptions['mode']))),
    field('Body type', sel([['dynamic', 'Dynamic (falls, can be thrown)'], ['fixed', 'Fixed (static scenery)']], io.body, (v) => (io.body = v as ImportOptions['body']))),
    field('Collider', sel([['auto', 'Auto (convex hull, exact if fixed)'], ['hull', 'Convex hull'], ['box', 'Box'], ['sphere', 'Sphere'], ['trimesh', 'Exact mesh (fixed bodies only)']], io.collider, (v) => (io.collider = v as ImportOptions['collider']))),
    field('Material', sel([['original', 'Keep the file’s look'], ...MATERIAL_PRESETS.filter((m) => m.id !== 'original').map((m) => [m.id, m.label] as [string, string])], io.material, (v) => (io.material = v))),
    field('Scale', h('div', { style: 'display:flex;gap:8px;align-items:center' }, scale, dims)),
    field('Z axis is up', zUp),
    ...warn,
    h('div', { class: 'footer' },
      h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'),
      h('button', { class: 'btn', onclick: () => go(false) }, 'Add to library'),
      h('button', { class: 'btn primary', onclick: () => go(true) }, 'Add & place')),
  );
  const m = modal(body, {
    onClose: () => {
      alive = false;
      controls.dispose();
      renderer.dispose();
    },
  });
  const go = async (place: boolean) => {
    io.name = name.value.trim() || io.name;
    m.close();
    const model = await commit(app, root, loaded, io, undefined, place);
    if (model) {
      app.libraryPanel.setTab('mine');
      app.toast(`Imported “${model.name}”${place ? ' and placed it' : ''}`);
    }
  };
  frame();
  requestAnimationFrame(loop);
}
