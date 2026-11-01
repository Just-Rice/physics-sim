# Making models in Blender

Physics Sim imports `.glb` files exported from Blender. The physics data (body type, material, colliders, joints, cloth) travels inside the file as glTF *extras* (Blender calls them Custom Properties). There are two ways to set them:

- **Use the add-on.** It's easiest: a sidebar panel, plus one-click export.
- **Set it by hand** with object names and Custom Properties. Any exporter that keeps extras works.

You can also import a plain `.glb`, `.obj` or `.stl` with no physics data. The import dialog then lets you choose the body type, collider and material.

---

## 1. Install the add-on

1. Get [`blender/physics_sim_addon.py`](../blender/physics_sim_addon.py) from this repository.
2. In Blender (4.2 or newer), go to **Edit → Preferences → Add-ons → ⌄ (top right) → Install from Disk…** and pick the file.
3. Turn on **Physics Sim exporter**. In its preferences, set the **Export folder**. The default is `~/Documents/Physics Sim/Blender`.
4. In the 3D View, press **N** and open the **Physics Sim** tab.

## 2. Tag your objects

Select a mesh. The panel shows:

| Setting | What it does |
|---|---|
| **Role** | *Rigid body* (default), *Collider only*, *Cloth*, *Soft body*, *Water volume* or *Ignore* |
| **Material** | A Physics Sim preset (steel, rubber, glass…) that sets both the look **and** density, friction and bounce. *Keep Blender look* keeps your own materials and textures. |
| **Body** | *Dynamic* falls and can be thrown. *Fixed* is static scenery. |
| **Collider** | *Auto* uses a convex hull, or the exact mesh for fixed bodies. Box and sphere are faster. |
| Density / Friction / Bounciness | Override the material. Leave them at 0 / -1 / -1 to use the material's values. |

**Concave dynamic objects** (cups, chairs, cars) collide as their convex hull, so a cup collides as if it were solid. To get the real shape, model a few simple boxes or hulls around it. Select them and press **Mark as collider**. That renames them `COL_…`, shows them as wireframe, and hides them in the app. Parent them to the visible object, or name them `COL_<ObjectName>`. Once a body has collider pieces, only those pieces collide.

## 3. Add joints

1. Select part **B**, then shift-click part **A** so A is the active object.
2. Choose **Add joint → Hinge** (or Ball, Fixed, Slider, Spring, Rope).

This creates an empty called `JOINT_…` halfway between the two parts:

- The empty's **position is the anchor**.
- For hinges and sliders, its **Z arrow is the axis**. Rotate the empty to aim it.
- Leave **Part B** empty to pin part A to the world.
- Turn on **Motor** to drive the joint. Speed is in rad/s for hinges and m/s for sliders. Wheels, windmills and conveyor-style sliders all use this.
- Turn on **Limits** to clamp the range, in degrees for hinges and metres for sliders.

## 4. Cloth and soft bodies

- **Cloth:** use a subdivided plane (about 20×20 to 40×40 faces). Set Role to *Cloth*. Create a vertex group named `pin` and assign the vertices that should stay put. Set **Attach to** to make the pinned vertices follow another object, such as a flag pole.
- **Soft body:** a closed, reasonably low-poly mesh (an icosphere with subdivisions 2–3 is ideal). **Jelly** sets how strongly it returns to its shape. **Pressure** above 1 inflates it like a balloon.
- **Water volume:** a box. Its bounds are filled with water particles when the model is placed.

Apply the object's scale (**Ctrl+A → Scale**) for cloth and soft bodies.

## 5. Export

Press **Export for Physics Sim**. The file is written to the export folder as `<blend-file-name>.glb`.

- **Mac app:** open **Settings → Advanced → Blender live link → Choose watch folder…** and pick the same folder. Each export imports the model, or **reloads it in place** if it's already in your library. Every copy in the scene is replaced, so you can tweak a model in Blender and see it in the simulation seconds later.
- **Browser:** drag the `.glb` onto the app window, or use **Library → Import model**.

### Exporting without the add-on

Use **File → Export → glTF 2.0 (.glb)**, and tick **Include → Custom Properties**. Leave **Compression** off. Then set these by hand:

| Where | Name / Custom Property | Values |
|---|---|---|
| Object name | `COL_Anything`, `Anything_col` or `UCX_Anything` | Invisible collision shape |
| Object name | `JOINT_Anything` (an empty) | Joint; also needs `ps_joint` |
| Object | `ps_body` | `dynamic` or `fixed` |
| Object | `ps_material` | Preset id: `plastic`, `rubber`, `wood`, `steel`, `chrome`, `gold`, `glass`, `ice`, `jelly`, `fabric`, `water`, … |
| Object | `ps_density`, `ps_friction`, `ps_restitution` | Numbers |
| Object | `ps_collider` | `hull`, `box`, `sphere` or `trimesh` |
| Object | `ps_kind` | `cloth`, `softbody` or `fluid` |
| Cloth object | `ps_pinned` | JSON list of pinned points, `[[x, y, z], …]`, in Y-up world space |
| Cloth object | `ps_attach` | Name of the object the pins follow |
| Joint empty | `ps_joint` | JSON, e.g. `{"type": "hinge", "a": "Wheel", "b": "Body", "motor": {"velocity": 3, "force": 40}, "limits": [-30, 30]}` |

Without an explicit `axis` in `ps_joint`, the joint axis is the empty's local +Z *after* glTF's Y-up conversion. That is Blender's local −Y. The add-on avoids this confusion by writing the axis for you.

## 6. Import options in the app

When you drop a file, the import dialog shows a preview. You choose:

- **Bodies:** one rigid body, or one body per top-level object. Files with joints default to one body per object.
- **Body type**, **Collider**, **Material** and **Scale**. Huge or tiny models are auto-scaled to about 1 m.
- **Z axis is up**, for OBJ/STL files from CAD tools.

Imported models land in **Library → My models**. They're stored in your browser (IndexedDB), or in the Mac app's storage. Right-click one to open it in the **Model Builder**, where you can add joints, motors or more parts. You can also export it again as `.glb`, and that file still carries all the physics data.

## Tips

- Keep models in metres. A 1.8 m ragdoll should be 1.8 Blender units tall.
- Apply rotation and scale before exporting (**Ctrl+A → All Transforms**). That keeps colliders and joint axes predictable.
- Fewer than about 50k triangles per model keeps ray tracing fast. Physics only uses the collider shapes, so high-poly visuals are fine there.
- Leave Draco mesh compression off. The app doesn't decode it.
