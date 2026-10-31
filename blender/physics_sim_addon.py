# SPDX-License-Identifier: MIT
"""
Physics Sim — Blender add-on

Tag objects with physics settings (body type, material, collider, cloth,
soft body, water), add joints as empties, and export a .glb that the
Physics Sim app imports with all of it intact. With the Mac app's
"Blender live link" folder, every export reloads the model in the app.

Install: Edit → Preferences → Add-ons → (⌄) Install from Disk… → pick this file.
Then open the 3D View sidebar (N) → "Physics Sim" tab.
"""

bl_info = {
    "name": "Physics Sim exporter",
    "author": "Physics Sim",
    "version": (1, 0, 0),
    "blender": (4, 2, 0),
    "location": "3D View → Sidebar (N) → Physics Sim",
    "description": "Tag objects with physics properties and joints, export .glb for Physics Sim",
    "category": "Import-Export",
}

import json
import os

import bpy
from bpy.props import BoolProperty, EnumProperty, FloatProperty, PointerProperty, StringProperty
from mathutils import Vector

ADDON_ID = __package__ or __name__

MATERIALS = [
    ("original", "Keep Blender look", "Use the object's own Blender materials"),
    ("plastic", "Plastic", ""), ("rubber", "Rubber", ""), ("wood", "Wood", ""), ("steel", "Steel", ""),
    ("chrome", "Chrome", ""), ("gold", "Gold", ""), ("copper", "Copper", ""), ("aluminium", "Aluminium", ""),
    ("glass", "Glass", ""), ("glass-tinted", "Glass (tinted)", ""), ("frosted-glass", "Frosted glass", ""),
    ("diamond", "Diamond", ""), ("ice", "Ice", ""), ("marble", "Marble", ""), ("stone", "Stone", ""),
    ("brick", "Brick", ""), ("concrete", "Concrete", ""), ("foam", "Foam", ""), ("fabric", "Fabric", ""),
    ("jelly", "Jelly", ""), ("balloon", "Balloon", ""), ("water", "Water", ""), ("neon", "Neon light", ""),
    ("lamp", "Warm lamp", ""),
]

ROLES = [
    ("RIGID", "Rigid body", "A solid object (default)"),
    ("COLLIDER", "Collider only", "Invisible collision shape for its parent body"),
    ("CLOTH", "Cloth", "Simulated as cloth (use a subdivided plane)"),
    ("SOFTBODY", "Soft body", "Squishy closed mesh (jelly, balloon)"),
    ("FLUID", "Water volume", "Box filled with water particles"),
    ("IGNORE", "Ignore", "Not exported to Physics Sim"),
]

JOINT_TYPES = [
    ("hinge", "Hinge", "Rotates about the empty's Z axis"),
    ("ball", "Ball", "Free rotation about the anchor"),
    ("fixed", "Fixed", "Welds two parts together"),
    ("slider", "Slider", "Slides along the empty's Z axis"),
    ("spring", "Spring", "Springy distance between the parts"),
    ("rope", "Rope", "Maximum distance between the parts"),
]


def default_folder():
    return os.path.join(os.path.expanduser("~"), "Documents", "Physics Sim", "Blender")


class PhysicsSimPreferences(bpy.types.AddonPreferences):
    bl_idname = ADDON_ID

    export_folder: StringProperty(
        name="Export folder",
        description="Where 'Export for Physics Sim' writes .glb files. Point the Mac app's Blender live link here",
        subtype="DIR_PATH",
        default=default_folder(),
    )

    def draw(self, context):
        self.layout.prop(self, "export_folder")


class PhysicsSimObjectProps(bpy.types.PropertyGroup):
    role: EnumProperty(name="Role", items=ROLES, default="RIGID")
    body: EnumProperty(name="Body", items=[("dynamic", "Dynamic", "Falls and can be thrown"), ("fixed", "Fixed", "Static scenery")], default="dynamic")
    material: EnumProperty(name="Material", items=MATERIALS, default="original")
    density: FloatProperty(name="Density (kg/m³)", description="0 = use the material's density", default=0.0, min=0.0)
    friction: FloatProperty(name="Friction", description="-1 = use the material's friction", default=-1.0, min=-1.0, max=5.0)
    restitution: FloatProperty(name="Bounciness", description="-1 = use the material's restitution", default=-1.0, min=-1.0, max=1.0)
    collider: EnumProperty(
        name="Collider",
        items=[("auto", "Auto", "Convex hull, or exact mesh for fixed bodies"), ("hull", "Convex hull", ""), ("box", "Box", ""), ("sphere", "Sphere", ""), ("trimesh", "Exact mesh", "Fixed bodies only")],
        default="auto",
    )
    # Cloth
    attach_to: PointerProperty(name="Attach to", type=bpy.types.Object, description="Pinned vertices follow this object")
    pin_group: StringProperty(name="Pin group", description="Vertex group of pinned vertices", default="pin")
    stretch: FloatProperty(name="Stretch", default=0.0, min=0.0, max=0.1)
    bend: FloatProperty(name="Bend softness", default=0.02, min=0.0, max=1.0)
    # Soft body
    mass: FloatProperty(name="Mass (kg)", default=2.0, min=0.001)
    pressure: FloatProperty(name="Pressure", default=1.0, min=0.0, max=5.0)
    shape_matching: FloatProperty(name="Jelly", default=0.15, min=0.0, max=1.0)


class PhysicsSimJointProps(bpy.types.PropertyGroup):
    is_joint: BoolProperty(default=False)
    type: EnumProperty(name="Type", items=JOINT_TYPES, default="hinge")
    part_a: PointerProperty(name="Part A", type=bpy.types.Object)
    part_b: PointerProperty(name="Part B", type=bpy.types.Object, description="Empty = attached to the world")
    use_limits: BoolProperty(name="Limits", default=False)
    limit_min: FloatProperty(name="Min", default=-45.0)
    limit_max: FloatProperty(name="Max", default=45.0)
    use_motor: BoolProperty(name="Motor", default=False)
    motor_velocity: FloatProperty(name="Speed", default=2.0, description="rad/s for hinges, m/s for sliders")
    motor_force: FloatProperty(name="Strength", default=50.0, min=0.01)
    stiffness: FloatProperty(name="Stiffness", default=200.0, min=0.01)
    damping: FloatProperty(name="Damping", default=5.0, min=0.0)
    length: FloatProperty(name="Length", default=0.0, min=0.0, description="0 = current distance")
    collide: BoolProperty(name="Parts collide", default=False)


def to_yup(v):
    """Blender (Z-up) → glTF/Physics Sim (Y-up)."""
    return [round(v.x, 5), round(v.z, 5), round(-v.y, 5)]


def joint_payload(obj):
    j = obj.physics_sim_joint
    axis_world = obj.matrix_world.to_3x3() @ Vector((0.0, 0.0, 1.0))
    axis_world.normalize()
    data = {
        "type": j.type,
        "a": j.part_a.name if j.part_a else None,
        "b": j.part_b.name if j.part_b else None,
        "axis": to_yup(axis_world),
        "collide": j.collide,
        "stiffness": j.stiffness,
        "damping": j.damping,
    }
    if j.length > 0:
        data["length"] = j.length
    if j.use_limits:
        data["limits"] = [j.limit_min, j.limit_max]
    if j.use_motor:
        data["motor"] = {"velocity": j.motor_velocity, "force": j.motor_force}
    return data


def pinned_points(obj, group_name):
    vg = obj.vertex_groups.get(group_name) if group_name else None
    if not vg:
        return []
    mesh = obj.data
    pts = []
    for v in mesh.vertices:
        for g in v.groups:
            if g.group == vg.index and g.weight > 0.5:
                pts.append(to_yup(obj.matrix_world @ v.co))
                break
    return pts


def object_payload(obj):
    """ps_* custom properties for one object (written just before export)."""
    p = obj.physics_sim
    props = {}
    if p.role == "COLLIDER":
        props["ps_role"] = "collider"
        props["ps_collider"] = p.collider if p.collider != "auto" else "hull"
        return props
    props["ps_body"] = p.body
    if p.material != "original":
        props["ps_material"] = p.material
    if p.density > 0:
        props["ps_density"] = p.density
    if p.friction >= 0:
        props["ps_friction"] = p.friction
    if p.restitution >= 0:
        props["ps_restitution"] = p.restitution
    if p.collider != "auto":
        props["ps_collider"] = p.collider
    if p.role == "CLOTH":
        props["ps_kind"] = "cloth"
        props["ps_pinned"] = json.dumps(pinned_points(obj, p.pin_group))
        props["ps_stretch"] = p.stretch
        props["ps_bend"] = p.bend
        if p.attach_to:
            props["ps_attach"] = p.attach_to.name
    elif p.role == "SOFTBODY":
        props["ps_kind"] = "softbody"
        props["ps_mass"] = p.mass
        props["ps_pressure"] = p.pressure
        props["ps_shape_matching"] = p.shape_matching
    elif p.role == "FLUID":
        props["ps_kind"] = "fluid"
    return props


def export_glb(context, filepath, selection_only=False):
    written = []
    hidden_for_export = []
    try:
        for obj in context.scene.objects:
            if obj.type == "EMPTY" and obj.physics_sim_joint.is_joint:
                obj["ps_joint"] = json.dumps(joint_payload(obj))
                written.append((obj, ["ps_joint"]))
            elif obj.type == "MESH":
                if obj.physics_sim.role == "IGNORE":
                    hidden_for_export.append((obj, obj.hide_render))
                    continue
                payload = object_payload(obj)
                for k, v in payload.items():
                    obj[k] = v
                written.append((obj, list(payload.keys())))
        os.makedirs(os.path.dirname(filepath) or ".", exist_ok=True)
        ignored = {o.name for o, _ in hidden_for_export}
        if ignored:
            # Export everything except ignored objects by selecting the rest.
            for o in context.scene.objects:
                o.select_set(o.name not in ignored and (o.select_get() or not selection_only))
            selection_only = True
        bpy.ops.export_scene.gltf(
            filepath=filepath,
            export_format="GLB",
            export_extras=True,
            export_yup=True,
            export_apply=True,
            use_selection=selection_only,
            export_cameras=False,
            export_lights=False,
        )
    finally:
        for obj, keys in written:
            for k in keys:
                if k in obj:
                    del obj[k]
    return filepath


class PHYSICSSIM_OT_mark_collider(bpy.types.Operator):
    bl_idname = "physics_sim.mark_collider"
    bl_label = "Mark as collider"
    bl_description = "Make the selected meshes invisible collision shapes (COL_ prefix, wireframe)"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        n = 0
        for obj in context.selected_objects:
            if obj.type != "MESH":
                continue
            obj.physics_sim.role = "COLLIDER"
            if not obj.name.upper().startswith("COL_"):
                obj.name = "COL_" + obj.name
            obj.display_type = "WIRE"
            n += 1
        self.report({"INFO"}, f"{n} collider(s)")
        return {"FINISHED"}


class PHYSICSSIM_OT_add_joint(bpy.types.Operator):
    bl_idname = "physics_sim.add_joint"
    bl_label = "Add joint"
    bl_description = "Add a joint empty. Select part B, then shift-select part A (active) first"
    bl_options = {"REGISTER", "UNDO"}

    type: EnumProperty(name="Type", items=JOINT_TYPES, default="hinge")

    def execute(self, context):
        active = context.active_object if context.active_object and context.active_object.type == "MESH" else None
        others = [o for o in context.selected_objects if o != active and o.type == "MESH"]
        if active and others:
            loc = (active.matrix_world.translation + others[0].matrix_world.translation) / 2
        elif active:
            loc = active.matrix_world.translation.copy()
        else:
            loc = context.scene.cursor.location.copy()
        empty = bpy.data.objects.new(f"JOINT_{self.type}", None)
        empty.empty_display_type = "SINGLE_ARROW"
        empty.empty_display_size = 0.5
        empty.location = loc
        context.collection.objects.link(empty)
        j = empty.physics_sim_joint
        j.is_joint = True
        j.type = self.type
        j.part_a = active
        j.part_b = others[0] if others else None
        for o in context.selected_objects:
            o.select_set(False)
        empty.select_set(True)
        context.view_layer.objects.active = empty
        return {"FINISHED"}


class PHYSICSSIM_OT_export(bpy.types.Operator):
    bl_idname = "physics_sim.export"
    bl_label = "Export for Physics Sim"
    bl_description = "Export the scene as .glb with physics data into the export folder"

    selection_only: BoolProperty(name="Selection only", default=False)
    filepath: StringProperty(subtype="FILE_PATH", default="")

    def execute(self, context):
        path = self.filepath
        if not path:
            prefs = context.preferences.addons[ADDON_ID].preferences if ADDON_ID in context.preferences.addons else None
            folder = bpy.path.abspath(prefs.export_folder) if prefs else default_folder()
            name = bpy.path.display_name_from_filepath(bpy.data.filepath) or "model"
            path = os.path.join(folder, f"{name}.glb")
        try:
            export_glb(context, path, self.selection_only)
        except Exception as err:  # noqa: BLE001 — surface any exporter error to the user
            self.report({"ERROR"}, f"Export failed: {err}")
            return {"CANCELLED"}
        self.report({"INFO"}, f"Exported {path}")
        return {"FINISHED"}


class PHYSICSSIM_PT_panel(bpy.types.Panel):
    bl_label = "Physics Sim"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Physics Sim"

    def draw(self, context):
        layout = self.layout
        obj = context.active_object
        if obj and obj.type == "EMPTY" and obj.physics_sim_joint.is_joint:
            j = obj.physics_sim_joint
            layout.label(text=f"Joint: {obj.name}", icon="CONSTRAINT")
            layout.prop(j, "type")
            layout.prop(j, "part_a")
            layout.prop(j, "part_b")
            if j.type in {"hinge", "slider"}:
                layout.label(text="Axis: the empty's Z arrow")
                row = layout.row()
                row.prop(j, "use_limits")
                if j.use_limits:
                    row.prop(j, "limit_min")
                    row.prop(j, "limit_max")
                row = layout.row()
                row.prop(j, "use_motor")
                if j.use_motor:
                    row.prop(j, "motor_velocity")
                    row.prop(j, "motor_force")
            if j.type in {"spring", "rope"}:
                layout.prop(j, "length")
                if j.type == "spring":
                    layout.prop(j, "stiffness")
                    layout.prop(j, "damping")
            layout.prop(j, "collide")
        elif obj and obj.type == "MESH":
            p = obj.physics_sim
            layout.prop(p, "role")
            if p.role in {"RIGID", "CLOTH", "SOFTBODY", "FLUID"}:
                layout.prop(p, "material")
            if p.role == "RIGID":
                layout.prop(p, "body", expand=True)
                layout.prop(p, "collider")
                col = layout.column(align=True)
                col.prop(p, "density")
                col.prop(p, "friction")
                col.prop(p, "restitution")
            elif p.role == "COLLIDER":
                layout.prop(p, "collider")
            elif p.role == "CLOTH":
                layout.prop(p, "attach_to")
                layout.prop_search(p, "pin_group", obj, "vertex_groups")
                layout.prop(p, "stretch")
                layout.prop(p, "bend")
            elif p.role == "SOFTBODY":
                layout.prop(p, "mass")
                layout.prop(p, "pressure")
                layout.prop(p, "shape_matching")
        else:
            layout.label(text="Select a mesh or a joint empty")
        layout.separator()
        row = layout.row(align=True)
        row.operator("physics_sim.mark_collider", icon="MOD_WIREFRAME")
        layout.operator_menu_enum("physics_sim.add_joint", "type", text="Add joint", icon="CONSTRAINT")
        layout.separator()
        layout.operator("physics_sim.export", icon="EXPORT")
        if ADDON_ID in context.preferences.addons:
            layout.label(text=f"→ {context.preferences.addons[ADDON_ID].preferences.export_folder}", icon="FILE_FOLDER")


CLASSES = (
    PhysicsSimPreferences,
    PhysicsSimObjectProps,
    PhysicsSimJointProps,
    PHYSICSSIM_OT_mark_collider,
    PHYSICSSIM_OT_add_joint,
    PHYSICSSIM_OT_export,
    PHYSICSSIM_PT_panel,
)


def register():
    for c in CLASSES:
        bpy.utils.register_class(c)
    bpy.types.Object.physics_sim = PointerProperty(type=PhysicsSimObjectProps)
    bpy.types.Object.physics_sim_joint = PointerProperty(type=PhysicsSimJointProps)


def unregister():
    del bpy.types.Object.physics_sim_joint
    del bpy.types.Object.physics_sim
    for c in reversed(CLASSES):
        bpy.utils.unregister_class(c)


if __name__ == "__main__":
    register()
