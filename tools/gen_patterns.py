#!/usr/bin/env python3
"""
Stocking patterns made with an image service (Nano Banana, preset 'flash-image'; machine notes not in this repo).

Each pattern is a square, seamlessly tiling mask: white motif on black. The shader tints it with the
stocking colour, so one mask works in every colour.

  patterns/raw/<id>.png        as generated
  patterns/raw/<id>_seam.png   the same shifted by half a tile, with the seam cross repaired by a second pass
  web/patterns/<id>.png        final mask, 1024 px, white with the mask in alpha (also the UI swatch)
  web/patterns/patterns.json   the list the page loads
  shots/patterns-sheet.png     each mask tiled 2 x 2, to check seams by eye

Steps per pattern: generate on a blank square canvas -> roll by half a tile so the edges meet in the middle ->
ask for the seam cross to be repaired -> keep the repaired band only along the cross (the edges stay as they
were, so they still match) -> grey levels -> mask.

Usage: python3 tools/gen_patterns.py [ids...] [--force]   (regenerates only what is missing unless --force)
"""
import http.cookiejar, json, os, socket, subprocess, sys, time, uuid, urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "patterns", "raw")
OUT = os.path.join(ROOT, "web", "patterns")
SSH_HOST, LOCAL_PORT, REMOTE = "<image-host>", 14601, "127.0.0.1:4600"
PRESET = "flash-image"
SIZE = 1024

PROMPT = ("Fill this entire square canvas edge to edge with a seamless repeating pattern for printing on "
          "sheer stockings: {}. Pure white motif on a pure solid black background. Flat 2D vector graphic, "
          "crisp clean edges, no shading, no gradients, no grey, no texture, no text, no border, no frame. "
          "The pattern must continue off every edge so it tiles seamlessly. Keep the square format.")
SEAM = ("This is a repeating white-on-black pattern with a visible seam: a vertical and a horizontal line "
        "through the middle where the motifs do not join up. Repaint only the area along those two lines so "
        "the pattern continues naturally across them, in exactly the same style, size and spacing as the rest. "
        "Wherever a motif is cut by these lines, replace the pieces with one complete, whole motif; no broken, "
        "cracked or half shapes. Keep everything else exactly as it is. Pure white on pure black, flat, no grey. "
        "Keep the square format.")

# around: how many times the image repeats round the leg (a stocking is knitted with a fixed number
# of stitches, so motifs stretch wider over the thigh). The images come back with many motifs each, so
# this is set by eye from the result: motifs about 2-3 cm on the calf; base: how much of the plain sheer knit shows
# between the motifs (1 = the usual denier, 0 = open holes, as in lace)
PATTERNS = {
    "rose_lace": dict(name="玫瑰蕾丝", around=1, base=0.35, prompt=
        "delicate floral lace: small roses and leaves joined by fine scalloped threads and tiny mesh, dense"),
    "vine": dict(name="巴洛克藤蔓", around=1, base=1, prompt=
        "elegant baroque scrolls and curling vines with small leaves, thin flowing lines"),
    "leopard": dict(name="豹纹", around=2, base=1, prompt=
        "leopard print: irregular rosette spots and small solid spots, organic, evenly spread"),
    "hearts": dict(name="小爱心", around=2, base=1, prompt=
        "small solid hearts scattered evenly in a staggered half-drop arrangement, plenty of space between them"),
    "butterfly": dict(name="蝴蝶", around=1, base=1, prompt=
        "small elegant butterflies in outline with delicate wing patterns, scattered at different angles"),
    "stars": dict(name="星星月亮", around=2, base=1, prompt=
        "small five-pointed stars, crescent moons and tiny dots scattered like a night sky"),
    # an exact geometric repeat is where the image model is weakest (its seams broke the rows), so
    # houndstooth is woven instead: see houndstooth()
    "houndstooth": dict(name="千鸟格", around=3, base=1, woven=True),
    "argyle": dict(name="菱格", around=3, base=1, prompt=
        "argyle: large diamonds in outline crossed by thin diagonal dashed lines, exactly 2 by 2 repeats"),
    "sakura": dict(name="樱花", around=2, base=1, prompt=
        "cherry blossom flowers with five rounded petals and a few small petals drifting, scattered"),
    "spiderweb": dict(name="蛛网", around=1, base=0.2, prompt=
        "spider web made of thin threads, radial lines and connecting curved spirals, covering the whole square"),
}


# ---------- image service (guest mode; same calls as <private tool>) ----------
class Service:
    def __init__(self):
        self.base = f"http://127.0.0.1:{LOCAL_PORT}"
        self.http = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def call(self, method, path, body=None, headers=None, timeout=120):
        data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
        h = {"Content-Type": "application/json"} if isinstance(body, dict) else {}
        h.update(headers or {})
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=h)
        try:
            with self.http.open(req, timeout=timeout) as r:
                raw = r.read()
                return json.loads(raw) if r.headers.get_content_type() == "application/json" else raw
        except urllib.error.HTTPError as e:
            msg = f"{method} {path} -> {e.code}: {e.read()[:300]!r}"
            if e.code == 429:                 # guest rate limit: the server says how long to wait
                try:
                    wait = float(e.headers.get("Retry-After") or 60)
                except ValueError:
                    wait = 60
                raise Retry(msg, wait) from None
            if e.code >= 500 or e.code == 408:
                raise Retry(msg) from None
            raise RuntimeError(msg) from None  # 4xx: our request is wrong, trying again will not help
        except (urllib.error.URLError, OSError) as e:   # refused, reset, timed out, tunnel gone
            raise Retry(f"{method} {path}: {e}") from None

    def upload(self, path):
        boundary = uuid.uuid4().hex
        with open(path, "rb") as fh:
            img = fh.read()
        body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"target\"\r\n\r\ncloud\r\n"
                f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"ref.png\"\r\n"
                f"Content-Type: image/png\r\n\r\n").encode() + img + f"\r\n--{boundary}--\r\n".encode()
        r = self.call("POST", "/api/upload", body, {"Content-Type": f"multipart/form-data; boundary={boundary}"})
        return {"filename": r["filename"], "subfolder": r["subfolder"], "type": r["type"]}

    def edit(self, prompt, ref_path, tries=8):
        """Submit an image edit and return the PNG. Submitting is retried on errors that can pass
        (rate limits, upstream 5xx, a failed generation, network errors); once a job is accepted it
        is only polled, never submitted again, so one pattern never costs two generations by mistake."""
        for attempt in range(tries):
            try:
                ref = self.upload(ref_path)
                token = self.call("POST", "/api/precheck", {"prompt": prompt}).get("promptToken")
                gen = self.call("POST", "/api/generate", {"mode": "img2img", "presetId": PRESET, "prompt": prompt,
                                                          "promptToken": token, "references": [ref]})
                return self.wait_for(gen["id"])
            except Retry as e:
                if attempt == tries - 1:
                    raise RuntimeError(str(e)) from None
                wait = e.wait or 10 * (attempt + 1)
                print(f"  retry in {wait:.0f}s after: {str(e)[:120]}", flush=True)
                time.sleep(wait)

    def wait_for(self, gid, limit=20 * 60):
        """Poll a job until it is done (each poll retried on its own), at most `limit` seconds."""
        deadline = time.time() + limit
        while time.time() < deadline:
            time.sleep(5)
            try:
                g = self.call("GET", f"/api/generation/{gid}")
            except Retry as e:
                print(f"  poll {gid}: {str(e)[:120]}", flush=True)
                continue
            if g.get("status") == "completed":
                return self.call("GET", g["images"][0]["url"], timeout=300)
            if g.get("status") in ("failed", "cancelled"):
                raise Retry(f"generation {gid} {g['status']}: {g.get('error')}")
            if g.get("status") not in ("pending", "queued", "running", "processing", None):
                print(f"  poll {gid}: unexpected status {g.get('status')!r}", flush=True)
        raise RuntimeError(f"generation {gid} not done after {limit // 60} min (it may still finish on op5)")


class Retry(RuntimeError):
    """An error worth trying again; `wait` is how long the server asked us to wait (s), if it said."""
    def __init__(self, msg, wait=None):
        super().__init__(msg)
        self.wait = wait


def open_tunnel():
    proc = subprocess.Popen(["ssh", "-N", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
                             "-o", "ExitOnForwardFailure=yes", "-L", f"{LOCAL_PORT}:{REMOTE}", SSH_HOST])
    for _ in range(75):
        try:
            socket.create_connection(("127.0.0.1", LOCAL_PORT), .2).close()
            return proc
        except OSError:
            if proc.poll() is not None:
                raise RuntimeError("ssh tunnel to the image host failed")
            time.sleep(.2)
    proc.terminate()
    raise RuntimeError("ssh tunnel to the image host did not come up")


# ---------- image steps ----------
def grey_square(png_bytes):
    im = Image.open(__import__("io").BytesIO(png_bytes)).convert("L")
    s = min(im.size)
    im = im.crop(((im.width - s) // 2, (im.height - s) // 2, (im.width + s) // 2, (im.height + s) // 2))
    return np.array(im.resize((SIZE, SIZE), Image.LANCZOS), np.float32) / 255


def min_cut(cost):
    """Column per row of the cheapest top-to-bottom path through cost (rows x cols), moving at most one
    column per row (the minimum-error boundary of image quilting)."""
    h, w = cost.shape
    acc, back = cost.copy(), np.zeros((h, w), np.int64)
    for y in range(1, h):
        prev = np.stack([np.r_[np.inf, acc[y - 1, :-1]], acc[y - 1], np.r_[acc[y - 1, 1:], np.inf]])
        k = prev.argmin(0)
        back[y] = np.arange(w) + k - 1
        acc[y] += prev[k, np.arange(w)]
    path = np.zeros(h, np.int64)
    path[-1] = acc[-1].argmin()
    for y in range(h - 1, 0, -1):
        path[y - 1] = back[y, path[y]]
    return path


def cross_mask(a, b, inner=40, outer=150):
    """Where to take the repaired image b instead of a: a band along each centre line whose two sides
    follow the paths where a and b agree best (so no motif is cut or doubled), between `inner` and `outer`
    pixels from the line."""
    c = SIZE // 2
    diff = np.abs(a - b)
    diff = np.asarray(Image.fromarray((diff * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(5)), np.float32)
    cols = np.arange(SIZE)
    m = np.zeros((SIZE, SIZE), bool)
    for d in (diff, diff.T):                       # the vertical band, then the horizontal one (transposed)
        left = c - outer + min_cut(d[:, c - outer:c - inner])
        right = c + inner + min_cut(d[:, c + inner:c + outer])
        band = (cols[None, :] >= left[:, None]) & (cols[None, :] <= right[:, None])
        m |= band if d is diff else band.T
    return m.astype(np.float32)


def levels(a):
    """Stretch to black/white and firm up the edges, keeping a little anti-aliasing."""
    lo, hi = np.percentile(a, 3), np.percentile(a, 97)
    a = np.clip((a - lo) / max(hi - lo, 1e-3), 0, 1)
    return np.clip((a - 0.5) * 1.6 + 0.5, 0, 1)


def houndstooth(units=4):
    """Houndstooth as it is woven: a 2/2 twill, warp and weft both 4 dark threads then 4 light ones.
    Where the warp is on top the cell takes the warp thread's colour, else the weft's."""
    i, j = np.mgrid[0:8, 0:8]
    cell = np.where((i + j) % 4 < 2, j < 4, i < 4).astype(np.float32)
    big = np.kron(np.tile(cell, (units, units)), np.ones((SIZE // (8 * units),) * 2, np.float32))
    return np.asarray(Image.fromarray((big * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.8)),
                      np.float32) / 255


def save_mask(pid, mask):
    rgba = np.dstack([np.full((SIZE, SIZE, 3), 255, np.uint8), (mask * 255).astype(np.uint8)])
    Image.fromarray(rgba, "RGBA").save(os.path.join(OUT, pid + ".png"), optimize=True)


def produce(svc, pid, spec, force):
    if spec.get("woven"):
        save_mask(pid, houndstooth())
        return pid
    raw, seam = os.path.join(RAW, pid + ".png"), os.path.join(RAW, pid + "_seam.png")
    t = time.time()
    if force or not os.path.exists(raw):
        png = svc.edit(PROMPT.format(spec["prompt"]), CANVAS)
        with open(raw, "wb") as fh:
            fh.write(png)
        print(f"{pid}: generated ({time.time() - t:.0f}s)", flush=True)
    a = grey_square(open(raw, "rb").read())
    rolled = np.roll(np.roll(a, SIZE // 2, 0), SIZE // 2, 1)       # the old edges now cross in the middle
    if force or not os.path.exists(seam):
        tmp = os.path.join(RAW, pid + "_rolled.png")
        Image.fromarray((rolled * 255).astype(np.uint8)).save(tmp)
        png = svc.edit(SEAM, tmp)
        with open(seam, "wb") as fh:
            fh.write(png)
        print(f"{pid}: seam repaired ({time.time() - t:.0f}s)", flush=True)
    fixed = grey_square(open(seam, "rb").read())
    m = cross_mask(rolled, fixed)
    save_mask(pid, levels(rolled * (1 - m) + fixed * m))   # outside the cross: untouched, edges still match
    return pid


def contact_sheet(ids):
    font = ImageFont.truetype("/System/Library/Fonts/Hiragino Sans GB.ttc", 26)
    cell, cols = 400, 5
    rows = (len(ids) + cols - 1) // cols
    sheet = Image.new("RGB", (cell * cols, (cell + 40) * rows), "white")
    d = ImageDraw.Draw(sheet)
    for i, pid in enumerate(ids):
        a = Image.open(os.path.join(OUT, pid + ".png")).getchannel("A").resize((cell // 2, cell // 2), Image.LANCZOS)
        tile = Image.new("L", (cell, cell))
        for ox in (0, cell // 2):
            for oy in (0, cell // 2):
                tile.paste(a, (ox, oy))
        x, y = (i % cols) * cell, (i // cols) * (cell + 40)
        sheet.paste(Image.eval(tile, lambda v: 255 - v).convert("RGB"), (x, y + 40))
        d.text((x + cell // 2, y + 20), PATTERNS[pid]["name"], fill="black", font=font, anchor="mm")
    os.makedirs(os.path.join(ROOT, "shots"), exist_ok=True)
    sheet.save(os.path.join(ROOT, "shots", "patterns-sheet.png"))


def main():
    global CANVAS
    ids = [a for a in sys.argv[1:] if not a.startswith("--")] or list(PATTERNS)
    force = "--force" in sys.argv
    os.makedirs(RAW, exist_ok=True)
    os.makedirs(OUT, exist_ok=True)
    CANVAS = os.path.join(RAW, "canvas.png")
    if not os.path.exists(CANVAS):
        Image.new("RGB", (2048, 2048), (0, 0, 0)).save(CANVAS)
    tunnel = open_tunnel()
    failed = []
    try:
        svc = Service()
        svc.call("GET", "/api/capabilities")
        with ThreadPoolExecutor(2) as pool:
            jobs = {pid: pool.submit(produce, svc, pid, PATTERNS[pid], force) for pid in ids}
        for pid, j in jobs.items():
            try:
                j.result()
            except Exception as e:
                failed.append(pid)
                print(f"FAILED {pid}: {e}")
    finally:
        tunnel.terminate()
    done = [pid for pid in PATTERNS if os.path.exists(os.path.join(OUT, pid + ".png"))]
    manifest = [dict(id=pid, name=PATTERNS[pid]["name"], file=f"patterns/{pid}.png",
                     around=PATTERNS[pid]["around"], base=PATTERNS[pid]["base"]) for pid in done]
    with open(os.path.join(OUT, "patterns.json"), "w") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=1)
    if done:
        contact_sheet(done)
    print("done" if not failed else f"failed: {', '.join(failed)}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
