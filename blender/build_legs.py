"""
Build the leg model and the stocking tube for Denier Lab with MPFB (MakeHuman for Blender, CC0 assets).

Only the body below the waist is kept (arms, hands and everything above the waist are deleted).

Each leg gets a smooth centre line: the bone chain hip -> knee -> ankle -> ball -> toe tip with its
corners rounded (Chaikin), so the bend at the ankle is a curve and the heel gets its own stretch of u.
  u = arc length along that line in metres (0 at the hip joint, negative above it, ~0.97 at the toe tip)

Legs mesh: second UV layer "leg", u = its vertex's u (nearest point on the centre line).

Stocking mesh: a tube per leg along the centre line, one ring every STOCK_DU from STOCK_U0 to
CAP_LEN before the toe tip, STOCK_COLS points per ring in the ring's plane; then a dome of CAP_ROWS
rings whose points fan out from the centre line towards the front, ending in a single point. Each
point sits on the outermost skin along its direction (ray cast inward from outside). Over the toes
the rays hit the 3D convex hull of the forefoot instead, so the stocking wraps the toes like a sock
(one smooth toe box, no gaps or bumps between toes) and the tip is round. UV "fab" = (u, (theta + pi) / 2pi), theta = 0 at the
front of the leg.

Outputs (Y-up, metres, feet on y = 0, facing +Z):
  web/models/legs.glb     "Legs" (UV0 = MakeHuman skin UVs, UV1 = "leg") and "Stocking" (UV0 = "fab";
                          glTF stores 1 - v)
  web/models/legs.json    per side: u of knee / ankle / ball / toe tip, and per ring of the stocking
                          tube its u, centre C, tangent T (down the leg) and normal N (theta = 0)

Usage:
  /Applications/Blender.app/Contents/MacOS/Blender --background --python blender/build_legs.py
"""
import bpy, bmesh, json, math, os
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree

from bl_ext.user_default.mpfb.services.humanservice import HumanService
from bl_ext.user_default.mpfb.services.targetservice import TargetService

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "web", "models")
LEG_BONES = {"pelvis", "thigh_l", "calf_l", "foot_l", "ball_l", "thigh_r", "calf_r", "foot_r", "ball_r"}
CUT_ABOVE_HIP = 0.07          # keep this much above the hip joints; the skirt hides the cut
SUBDIV = 1
CURVE_STEP = 0.001            # centre line sampling (m)
STOCK_U0 = 0.17               # first stocking ring (the length slider starts at 0.26)
STOCK_DU = 0.004              # ring spacing, roughly
STOCK_COLS = 96               # points per ring
RAY_OUT = 0.12                # rays start this far out from the centre line
CAP_LEN = 0.035               # the toe is closed by a dome starting this far before the toe tip
CAP_ROWS = 10


def clear():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)


def build_human():
    macros = TargetService.get_default_macro_info_dict()
    # adult woman (MakeHuman age 0.6 is about 31 years)
    macros.update({"gender": 0.0, "age": .6, "muscle": .5, "weight": .5, "height": .55, "proportions": .8})
    body = HumanService.create_human(mask_helpers=True, detailed_helpers=False, extra_vertex_groups=True,
                                     feet_on_ground=False, scale=0.1, macro_detail_dict=macros)
    rig = HumanService.add_builtin_rig(body, "game_engine")
    joints = {}
    for s in ("l", "r"):
        b = lambda n: rig.data.bones[f"{n}_{s}"]
        mw = rig.matrix_world
        joints[s] = {
            "hip": mw @ b("thigh").head_local, "knee": mw @ b("calf").head_local,
            "ankle": mw @ b("foot").head_local, "ball": mw @ b("ball").head_local,
            "ball_tail": mw @ b("ball").tail_local,
        }
    return body, rig, joints


def bake_mesh(body):
    """Apply the shape-key mix, drop helpers, arms and everything above the waist."""
    for md in list(body.modifiers):
        body.modifiers.remove(md)
    bpy.context.view_layer.objects.active = body
    body.select_set(True)
    bpy.ops.object.shape_key_remove(all=True, apply_mix=True)

    names = {g.index: g.name for g in body.vertex_groups}
    body_gi = body.vertex_groups["body"].index
    bm = bmesh.new()
    bm.from_mesh(body.data)
    dl = bm.verts.layers.deform.active
    return bm, dl, names, body_gi


def cut(bm, dl, names, body_gi, cut_z):
    kill = []
    for v in bm.verts:
        w = v[dl]
        if w.get(body_gi, 0.0) < .5 or v.co.z > cut_z:
            kill.append(v)
            continue
        bones = [(wt, names[i]) for i, wt in w.items() if names[i] in LEG_BONES or names[i].startswith(("upperarm", "lowerarm", "hand", "index", "middle", "ring", "pinky", "thumb", "spine"))]
        if bones and max(bones)[1] not in LEG_BONES:
            kill.append(v)
    bmesh.ops.delete(bm, geom=kill, context="VERTS")
    # drop loose islands (bits of fingers that survived the weight test)
    bm.verts.ensure_lookup_table()
    seen, islands = set(), []
    for v in bm.verts:
        if v in seen:
            continue
        stack, isl = [v], []
        seen.add(v)
        while stack:
            x = stack.pop()
            isl.append(x)
            for e in x.link_edges:
                y = e.other_vert(x)
                if y not in seen:
                    seen.add(y)
                    stack.append(y)
        islands.append(isl)
    islands.sort(key=len, reverse=True)
    for isl in islands[1:]:
        bmesh.ops.delete(bm, geom=isl, context="VERTS")


def chain_for(j, verts):
    """hip -> knee -> ankle -> ball -> toe tip (toe tip found from the mesh along the ball bone)."""
    d = (j["ball_tail"] - j["ball"]).normalized()
    far = max((v - j["ball"]).dot(d) for v in verts)
    return [j["hip"], j["knee"], j["ankle"], j["ball"], j["ball"] + d * far]


class Centreline:
    """The chain with rounded corners, sampled every CURVE_STEP, with parallel-transported frames."""

    def __init__(self, pts):
        for _ in range(5):                       # Chaikin corner cutting, ends fixed
            new = [pts[0]]
            for a, b in zip(pts, pts[1:]):
                new += [a.lerp(b, .25), a.lerp(b, .75)]
            new.append(pts[-1])
            pts = new
        cum = [0.0]
        for a, b in zip(pts, pts[1:]):
            cum.append(cum[-1] + (b - a).length)
        self.length = cum[-1]
        n = int(self.length / CURVE_STEP)
        self.p, j = [], 0
        for i in range(n + 1):
            s = min(self.length, i * CURVE_STEP)
            while j < len(cum) - 2 and cum[j + 1] < s:
                j += 1
            self.p.append(pts[j].lerp(pts[j + 1], (s - cum[j]) / max(1e-9, cum[j + 1] - cum[j])))
        self.u = [i * CURVE_STEP for i in range(n + 1)]
        self.p.append(pts[-1])
        self.u.append(self.length)
        m = len(self.p)
        self.t = [(self.p[min(m - 1, i + 1)] - self.p[max(0, i - 1)]).normalized() for i in range(m)]
        # theta = 0 points to the front of the leg (Blender -Y, which is glTF +Z)
        self.n, ref = [], Vector((0, -1, 0))
        for t in self.t:
            ref = (ref - t * ref.dot(t)).normalized()
            self.n.append(ref.copy())
        self.kd = KDTree(m)
        for i, q in enumerate(self.p):
            self.kd.insert(q, i)
        self.kd.balance()

    def at(self, u):
        f = min(len(self.p) - 1.001, max(0.0, u / CURVE_STEP))
        i, t = int(f), f - int(f)
        c = self.p[i].lerp(self.p[i + 1], t)
        tt = self.t[i].lerp(self.t[i + 1], t).normalized()
        nn = self.n[i].lerp(self.n[i + 1], t)
        nn = (nn - tt * nn.dot(tt)).normalized()
        return c, tt, nn

    def project(self, q):
        """u of the nearest point on the line (extends straight up above the hip)."""
        _, i, _ = self.kd.find(q)
        best = None
        for a in (i - 1, i):
            if a < 0 or a + 1 >= len(self.p):
                continue
            ab = self.p[a + 1] - self.p[a]
            t = (q - self.p[a]).dot(ab) / ab.length_squared
            t = min(t, 1.0) if a == 0 else min(max(t, 0.0), 1.0)
            d = (q - (self.p[a] + ab * t)).length
            if best is None or d < best[0]:
                best = (d, self.u[a] + t * (self.u[a + 1] - self.u[a]))
        return best[1] if best else self.u[i]


def side_bvh(me, sign):
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if any(v.co.x * sign <= 0 for v in f.verts)], context="FACES")
    bvh = BVHTree.FromBMesh(bm)
    bm.free()
    return bvh


def toe_hull_bvh(me, sign, curve, u_from):
    """BVH of the 3D convex hull of the skin from u_from to the toe tip."""
    bm = bmesh.new()
    for v in me.vertices:
        if v.co.x * sign > 0 and curve.project(v.co) > u_from:
            bm.verts.new(v.co)
    bmesh.ops.convex_hull(bm, input=bm.verts)
    bvh = BVHTree.FromBMesh(bm)
    bm.free()
    return bvh


def stocking_tube(curve, bvh, toe_bvh, u_ball):
    """Rings of points on the outermost skin, a dome over the toe tip, convex hull over the toes.

    Returns rings as (u, C, T, N) frames, the angles, and per ring the points' offsets from C."""
    cap_from = curve.length - CAP_LEN
    rows = int(math.ceil((cap_from - STOCK_U0) / STOCK_DU)) + 1
    du = (cap_from - STOCK_U0) / (rows - 1)
    angles = [-math.pi + 2 * math.pi * c / STOCK_COLS for c in range(STOCK_COLS)]

    def outermost(origin, d, reach, tree=bvh):
        hit = tree.ray_cast(origin + d * reach, -d, reach)
        return reach - hit[3] if hit[0] is not None else 0.0

    # over the toes, blend from the skin to the forefoot's convex hull
    toe_w = lambda u: 1.0 if u is None else min(1.0, max(0.0, (u - (u_ball - 0.05)) / 0.02))

    # leg rings: radius per angle in the ring's plane
    frames, dirs, raw = [], [], []
    for r in range(rows):
        u = STOCK_U0 + r * du
        c, t, n = curve.at(u)
        b = t.cross(n)
        ds = [n * math.cos(a) + b * math.sin(a) for a in angles]
        frames.append([u, c, t, n])
        dirs.append(ds)
        ring = [outermost(c, d, RAY_OUT) for d in ds]
        w = toe_w(u)
        if w > 0:
            ring = [rr + (max(rr, outermost(c, d, RAY_OUT, toe_bvh)) - rr) * w for rr, d in zip(ring, ds)]
        raw.append(ring)
    # dome rings: from the last leg ring's centre Q, directions tilting forward to the tip
    q, tq, nq = frames[-1][1], frames[-1][2], frames[-1][3]
    bq = tq.cross(nq)
    for i in range(1, CAP_ROWS + 1):
        phi = math.pi / 2 * i / CAP_ROWS
        ds = [(nq * math.cos(a) + bq * math.sin(a)) * math.cos(phi) + tq * math.sin(phi) for a in angles]
        dirs.append(ds)
        raw.append([max(outermost(q, d, 0.08), outermost(q, d, 0.08, toe_bvh)) for d in ds])
        frames.append([None, q, tq, nq])
    for ring in raw:                                   # fill missed rays from their neighbours
        for k in range(STOCK_COLS):
            if ring[k] == 0.0:
                nb = [ring[(k + o) % STOCK_COLS] for o in (-2, -1, 1, 2) if ring[(k + o) % STOCK_COLS] > 0]
                ring[k] = sum(nb) / len(nb) if nb else 0.0
    raw[-1] = [sum(raw[-1]) / STOCK_COLS] * STOCK_COLS   # the tip is a single point

    R = [ring[:] for ring in raw]
    n_rows = len(R)
    # smooth along and around, but never inside the skin
    for _ in range(3):
        S = [ring[:] for ring in R]
        for r in range(1, n_rows - 1):
            for k in range(STOCK_COLS):
                S[r][k] = (R[r - 1][k] + 2 * R[r][k] + R[r + 1][k]) / 4
        R = S
    S = [[(ring[k - 1] + 2 * ring[k] + ring[(k + 1) % STOCK_COLS]) / 4 for k in range(STOCK_COLS)] for ring in R]
    R = [[max(S[r][k], raw[r][k]) for k in range(STOCK_COLS)] for r in range(n_rows)]
    R[-1] = [sum(R[-1]) / STOCK_COLS] * STOCK_COLS

    # dome rings get a centre and u from how far forward their points reach
    offs = [[dirs[r][k] * R[r][k] for k in range(STOCK_COLS)] for r in range(n_rows)]
    last_u = frames[rows - 1][0]
    for r in range(rows, n_rows):
        fwd = sum(o.dot(tq) for o in offs[r]) / STOCK_COLS
        u = max(last_u + 0.001, cap_from + fwd)
        frames[r][0], frames[r][1] = u, q + tq * (u - cap_from)
        offs[r] = [o - tq * (u - cap_from) for o in offs[r]]
        last_u = u
    return frames, angles, offs


def main():
    clear()
    body, rig, joints = build_human()
    bpy.data.objects.remove(rig)
    bm, dl, names, body_gi = bake_mesh(body)
    hip_z = max(joints["l"]["hip"].z, joints["r"]["hip"].z)
    cut(bm, dl, names, body_gi, hip_z + CUT_ABOVE_HIP)
    bm.to_mesh(body.data)
    bm.free()
    body.vertex_groups.clear()

    sub = body.modifiers.new("sub", "SUBSURF")
    sub.levels = sub.render_levels = SUBDIV
    bpy.ops.object.modifier_apply(modifier="sub")
    for poly in body.data.polygons:
        poly.use_smooth = True

    me = body.data
    ground = min(v.co.z for v in me.vertices)
    for v in me.vertices:
        v.co.z -= ground
    for s in joints:
        for k in joints[s]:
            joints[s][k] = joints[s][k] - Vector((0, 0, ground))

    curves, tubes = {}, {}
    for s, sign in (("l", 1), ("r", -1)):
        side_verts = [v.co for v in me.vertices if v.co.x * sign > 0]
        curves[s] = Centreline(chain_for(joints[s], side_verts))
    # second UV set: (u, theta), theta measured like the stocking's (0 at the front, towards T x N);
    # the skin outline uses it to stop exactly where the stocking covers the skin at that angle
    leg_uv = []
    for v in me.vertices:
        cv = curves["l" if v.co.x > 0 else "r"]
        u = cv.project(v.co)
        c, t, n = cv.at(min(u, cv.length))
        d = v.co - c
        leg_uv.append((u, math.atan2(d.dot(t.cross(n)), d.dot(n))))
    uv = me.uv_layers.new(name="leg")
    for loop in me.loops:
        uv.data[loop.index].uv = leg_uv[loop.vertex_index]
    me.uv_layers.active_index = 0
    body.name = me.name = "Legs"

    marks = {}
    for s, sign in (("l", 1), ("r", -1)):
        j, cv = joints[s], curves[s]
        marks[s] = {"knee": cv.project(j["knee"]), "ankle": cv.project(j["ankle"]), "ball": cv.project(j["ball"])}
        toe_bvh = toe_hull_bvh(me, sign, cv, marks[s]["ball"] - 0.06)
        tubes[s] = stocking_tube(cv, side_bvh(me, sign), toe_bvh, marks[s]["ball"])
        marks[s]["end"] = tubes[s][0][-1][0]
    stocking = build_stocking_mesh(tubes)

    os.makedirs(OUT, exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    body.select_set(True)
    stocking.select_set(True)
    bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, "legs.glb"), use_selection=True, export_format="GLB",
                              export_yup=True, export_apply=True, export_texcoords=True, export_normals=True,
                              export_materials="NONE", export_animations=False)
    yup = lambda v: [round(v.x, 6), round(v.z, 6), round(-v.y, 6)]
    info = {"vertices": len(me.vertices)}
    for s in ("l", "r"):
        frames, angles, offs = tubes[s]
        info[s] = {k: round(v, 5) for k, v in marks[s].items()}
        info[s].update({"rows": len(frames), "cols": STOCK_COLS, "u": [round(f[0], 6) for f in frames],
                        "C": [yup(f[1]) for f in frames], "T": [yup(f[2]) for f in frames], "N": [yup(f[3]) for f in frames]})
    with open(os.path.join(OUT, "legs.json"), "w") as f:
        json.dump(info, f)
    print("LEGS done:", len(me.vertices), "verts;", {s: info[s]["end"] for s in ("l", "r")},
          "stocking verts", len(stocking.data.vertices))


def build_stocking_mesh(tubes):
    verts, faces, fab = [], [], []
    for s in ("l", "r"):
        frames, angles, offs = tubes[s]
        base, cols = len(verts), len(angles)
        for (u, c, t, n), ring in zip(frames, offs):
            for o in ring:
                verts.append(c + o)
        for r in range(len(frames) - 1):
            for k in range(cols):
                k1 = (k + 1) % cols
                faces.append((base + r * cols + k, base + r * cols + k1, base + (r + 1) * cols + k1, base + (r + 1) * cols + k))
                u0, u1 = frames[r][0], frames[r + 1][0]
                fab.append([(u0, k / cols), (u0, (k + 1) / cols), (u1, (k + 1) / cols), (u1, k / cols)])
    me = bpy.data.meshes.new("Stocking")
    me.from_pydata(verts, [], faces)
    uv = me.uv_layers.new(name="fab")
    for poly, uvs in zip(me.polygons, fab):
        for li, q in zip(poly.loop_indices, uvs):
            uv.data[li].uv = q
    for poly in me.polygons:
        poly.use_smooth = True
    obj = bpy.data.objects.new("Stocking", me)
    bpy.context.collection.objects.link(obj)
    return obj


main()
