"""Example: build a small cart with wheels, motors, a flag and a jelly ball,
tag it with the Physics Sim add-on and export it as a .glb.

This is the scene used to test the add-on against real Blender (5.2)."""
import importlib.util
import json
import math
import sys

import bpy

# Usage (from a shell):
#   blender --background --python blender/examples/build_test_cart.py -- blender/physics_sim_addon.py cart.glb
# or with the bpy module: python build_test_cart.py blender/physics_sim_addon.py cart.glb
args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
addon_path, out_path = args[0], args[1]
spec = importlib.util.spec_from_file_location("physics_sim_addon", addon_path)
addon = importlib.util.module_from_spec(spec)
spec.loader.exec_module(addon)
addon.register()
print("blender", bpy.app.version_string)

bpy.ops.wm.read_factory_settings(use_empty=True)
addon.register() if not hasattr(bpy.types.Object, "physics_sim") else None
scene = bpy.context.scene

def mesh_obj(op, name, **kw):
    op(**kw)
    o = bpy.context.active_object
    o.name = name
    return o

body = mesh_obj(bpy.ops.mesh.primitive_cube_add, "Body", size=1, location=(0, 0, 0.6))
body.scale = (1.2, 0.6, 0.25)
bpy.ops.object.transform_apply(scale=True)
body.physics_sim.material = "wood"
body.physics_sim.density = 500

col = mesh_obj(bpy.ops.mesh.primitive_cube_add, "Body_hitbox", size=1, location=(0, 0, 0.6))
col.scale = (1.25, 0.65, 0.3)
bpy.ops.object.transform_apply(scale=True)
for o in bpy.context.selected_objects:
    o.select_set(False)
col.select_set(True)
bpy.context.view_layer.objects.active = col
bpy.ops.physics_sim.mark_collider()
col.parent = body
col.matrix_parent_inverse = body.matrix_world.inverted()

wheels = []
for i, (x, y) in enumerate([(0.45, 0.4), (0.45, -0.4), (-0.45, 0.4), (-0.45, -0.4)]):
    w = mesh_obj(bpy.ops.mesh.primitive_cylinder_add, f"Wheel{i}", radius=0.25, depth=0.12, location=(x, y, 0.25), rotation=(math.pi / 2, 0, 0))
    w.physics_sim.material = "rubber"
    wheels.append(w)
    # joint: select body then wheel (active = wheel = part A)
    for o in bpy.context.selected_objects:
        o.select_set(False)
    body.select_set(True)
    w.select_set(True)
    bpy.context.view_layer.objects.active = w
    bpy.ops.physics_sim.add_joint(type="hinge")
    j = bpy.context.active_object
    j.location = (x, y, 0.25)
    # Blender Y is the axle direction: rotate the empty's Z arrow onto Y
    j.rotation_euler = (math.pi / 2, 0, 0)
    if x < 0:
        j.physics_sim_joint.use_motor = True
        j.physics_sim_joint.motor_velocity = -6
        j.physics_sim_joint.motor_force = 40

pole = mesh_obj(bpy.ops.mesh.primitive_cylinder_add, "Pole", radius=0.03, depth=1.2, location=(-0.5, 0, 1.3))
pole.physics_sim.material = "aluminium"
for o in bpy.context.selected_objects:
    o.select_set(False)
body.select_set(True)
pole.select_set(True)
bpy.context.view_layer.objects.active = pole
bpy.ops.physics_sim.add_joint(type="fixed")

flag = mesh_obj(bpy.ops.mesh.primitive_grid_add, "Flag", x_subdivisions=16, y_subdivisions=10, size=1, location=(-0.1, 0, 1.6), rotation=(math.pi / 2, 0, 0))
flag.scale = (0.8, 0.5, 1)
bpy.ops.object.transform_apply(scale=True, rotation=True)
vg = flag.vertex_groups.new(name="pin")
left = [v.index for v in flag.data.vertices if (flag.matrix_world @ v.co).x < -0.49]
vg.add(left, 1.0, "REPLACE")
flag.physics_sim.role = "CLOTH"
flag.physics_sim.material = "fabric"
flag.physics_sim.attach_to = pole

jelly = mesh_obj(bpy.ops.mesh.primitive_ico_sphere_add, "Jelly", subdivisions=2, radius=0.2, location=(0.2, 0, 1.2))
jelly.physics_sim.role = "SOFTBODY"
jelly.physics_sim.material = "jelly"

bpy.ops.physics_sim.export(filepath=out_path)

# Sanity: read the glTF JSON chunk back and print what was exported.
with open(out_path, "rb") as f:
    data = f.read()
length = int.from_bytes(data[12:16], "little")
doc = json.loads(data[20:20 + length])
for n in doc["nodes"]:
    print(n.get("name"), json.dumps(n.get("extras", {}))[:160])
