#!/usr/bin/env python3
"""Linux/X11 counterpart of capture.ps1: screen-captures the top-left corner of the
WoW client window (running under Wine) and decodes the WoWAI pixel strip (see
Codec.lua in the addon). Prints one JSON line per new message to stdout, with the
same {info|warn|error|id,text} contract as capture.ps1. Started by bridge.js.

Zero dependencies: python3 + ctypes against libX11.

  capture_x11.py --test-image strip.png   decode a PNG once and exit (tests)
  capture_x11.py --probe out.png          save what the capture sees once and exit
  capture_x11.py --window-name NAME       match a window by title instead of WM_CLASS
"""

import argparse
import ctypes
import ctypes.util
import json
import os
import struct
import sys
import time
import zlib

p = argparse.ArgumentParser()
p.add_argument("--cell", type=int, default=4)
p.add_argument("--cells", type=int, default=200)
p.add_argument("--max-rows", type=int, default=48)
p.add_argument("--interval-ms", type=int, default=50)
p.add_argument("--process-name", default="Wow")
p.add_argument("--window-name", default="")
p.add_argument("--keep-composited", action="store_true",
               help="ask the compositor not to unredirect the game window (_NET_WM_BYPASS_COMPOSITOR=2)")
p.add_argument("--test-image", default="")
p.add_argument("--probe", default="")
args = p.parse_args()

CELL, CELLS, MAXROWS = args.cell, args.cells, args.max_rows
W, H = CELLS * max(CELL, 4), MAXROWS * max(CELL, 4)
SLACK = 8  # pixels of misalignment searched around the window origin


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


# ---------------------------------------------------------------------------
# Decoder: identical rules to capture.ps1
# ---------------------------------------------------------------------------

# Keep these rules in sync with capture_mac.py and capture.ps1.
PROFILES = [("robust", CELL)]
if CELL != 4:
    PROFILES.append(("robust", 4))
PROFILES += [("compact", 2), ("quiet", 2), ("quiet4", 4)]
MAGIC_CELLS = (6, 1, 6, 1, 5)  # The sixth cell contains unknown ID bits.


def calibration(px, ox, oy, cell):
    samples = [px(ox + i * cell + cell // 2, oy + cell // 2) for i in range(5)]
    levels = []
    for channel, bit in enumerate((4, 2, 1)):
        low = [samples[i][channel] for i in range(5) if not MAGIC_CELLS[i] & bit]
        high = [samples[i][channel] for i in range(5) if MAGIC_CELLS[i] & bit]
        lo, hi = sum(low) / len(low), sum(high) / len(high)
        separation = hi - lo
        # Endpoints belong to robust/compact, not to adaptive dark calibration.
        if separation < 12 or lo > 128 or hi >= 192:
            return None
        residual = max(4, min(12, separation * 0.25))
        if any(abs(v - lo) > residual for v in low) or any(abs(v - hi) > residual for v in high):
            return None
        levels.append((lo, hi))
    return levels


def cell_value(px, c, r, ox, oy, cell, levels):
    channels = px(ox + c * cell + cell // 2, oy + r * cell + cell // 2)
    value = 0
    for channel, bit in enumerate((4, 2, 1)):
        v = channels[channel]
        if levels is None:
            on = v >= 128
        else:
            lo, hi = levels[channel]
            on = v >= (lo + hi) / 2
            if abs(v - (hi if on else lo)) > max(10, min(24, (hi - lo) * 0.35)):
                return None
        if on:
            value |= bit
    return value


def decode(px, width, height, ox, oy, display, cell):
    if ox + CELLS * cell > width or oy + cell > height:
        return None
    levels = calibration(px, ox, oy, cell) if display in ("quiet", "quiet4") else None
    if display in ("quiet", "quiet4") and levels is None:
        return None
    if levels is None:
        # A gamma-brightened quiet palette can cross 128 without becoming an
        # endpoint palette. Its known symbols still have a small channel span.
        samples = [px(ox + i * cell + cell // 2, oy + cell // 2) for i in range(5)]
        if not any(max(s[ch] for s in samples) - min(s[ch] for s in samples) >= 96 for ch in range(3)):
            return None
    acc = nbits = 0
    out = bytearray()
    needed = 6
    total = CELLS * min(MAXROWS, (height - oy) // cell)
    for i in range(total):
        value = cell_value(px, i % CELLS, i // CELLS, ox, oy, cell, levels)
        if value is None:
            return None
        acc = (acc << 3) | value
        nbits += 3
        while nbits >= 8:
            out.append((acc >> (nbits - 8)) & 0xFF)
            nbits -= 8
            acc &= (1 << nbits) - 1
            if len(out) == 2 and (out[0] != 0xC7 or out[1] != 0x1A):
                return None
            if len(out) == 6:
                length = out[4] * 256 + out[5]
                needed = 8 + length
                if length > 3200 or needed > total * 3 // 8:
                    return {"error": "length"}
            if len(out) >= needed:
                break
        if len(out) >= needed:
            break
    if len(out) < needed:
        return {"error": "truncated"}
    length = out[4] * 256 + out[5]
    s1 = s2 = 0
    for k in range(2, 6 + length):
        s1 = (s1 + out[k]) % 255
        s2 = (s2 + s1) % 255
    if out[6 + length] != s1 or out[7 + length] != s2:
        return {"error": "checksum"}
    text = bytes(out[6:6 + length]).decode("utf-8", errors="replace")
    return {"id": out[2] * 256 + out[3], "text": text, "display": display}


def find_and_decode(px, width, height, hint):
    """Cached origin/profile first; bounded search continues past rejected candidates."""
    rejected = None
    if hint:
        if hint[2] in ("quiet", "quiet4"):
            endpoint = (hint[0], hint[1], "compact" if hint[3] == 2 else "robust", hint[3])
            msg = decode(px, width, height, *endpoint)
            if msg and "error" not in msg:
                return msg, endpoint
        msg = decode(px, width, height, *hint)
        if msg and "error" not in msg:
            return msg, hint
        rejected = msg
    # Endpoint profiles precede quiet, so adaptive thresholds never steal them.
    for display, cell in PROFILES:
        for oy in range(SLACK + 1):
            for ox in range(SLACK + 1):
                candidate = (ox, oy, display, cell)
                if candidate == hint:
                    continue
                msg = decode(px, width, height, *candidate)
                if msg and "error" not in msg:
                    return msg, candidate
                if msg:
                    rejected = msg
    return rejected, hint


# ---------------------------------------------------------------------------
# PNG in/out (tests and --probe)
# ---------------------------------------------------------------------------

def read_png(path):
    data = open(path, "rb").read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    pos, idat = 8, b""
    width = height = depth = ctype = None
    while pos < len(data):
        (n,) = struct.unpack(">I", data[pos:pos + 4])
        kind = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + n]
        pos += 12 + n
        if kind == b"IHDR":
            width, height, depth, ctype = struct.unpack(">IIBB", body[:10])
        elif kind == b"IDAT":
            idat += body
        elif kind == b"IEND":
            break
    if depth != 8 or ctype not in (2, 6):
        raise ValueError("only 8-bit RGB/RGBA PNGs are supported")
    bpp = 3 if ctype == 2 else 4
    raw = zlib.decompress(idat)
    stride = width * bpp
    rows, prev = [], bytearray(stride)
    for y in range(height):
        f = raw[y * (stride + 1)]
        line = bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        for i in range(stride):
            a = line[i - bpp] if i >= bpp else 0
            b = prev[i]
            c = prev[i - bpp] if i >= bpp else 0
            if f == 1:
                line[i] = (line[i] + a) & 0xFF
            elif f == 2:
                line[i] = (line[i] + b) & 0xFF
            elif f == 3:
                line[i] = (line[i] + (a + b) // 2) & 0xFF
            elif f == 4:
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        rows.append(line)
        prev = line

    def px(x, y):
        o = x * bpp
        row = rows[y]
        return row[o], row[o + 1], row[o + 2]
    return px, width, height


def write_png(path, px, width, height):
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        for x in range(width):
            raw.extend(px(x, y))

    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)
    with open(path, "wb") as fh:
        fh.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
                 + chunk(b"IDAT", zlib.compress(bytes(raw))) + chunk(b"IEND", b""))


if args.test_image:
    # A directory exercises the same cached path as a live capture sequence.
    images = ([os.path.join(args.test_image, name) for name in sorted(os.listdir(args.test_image))
               if name.lower().endswith(".png")] if os.path.isdir(args.test_image) else [args.test_image])
    hint = None
    for image in images:
        px, w, h = read_png(image)
        msg, hint = find_and_decode(px, w, h, hint)
        emit(msg if msg else {"error": "no valid strip in image"})
    sys.exit(0)


# ---------------------------------------------------------------------------
# X11
# ---------------------------------------------------------------------------

if not os.environ.get("DISPLAY"):
    emit({"error": "DISPLAY is not set; the capture needs the X session the game runs in"})
    sys.exit(3)

lib = ctypes.util.find_library("X11")
if not lib:
    emit({"error": "libX11 not found"})
    sys.exit(3)
X = ctypes.cdll.LoadLibrary(lib)

Window = ctypes.c_ulong
Atom = ctypes.c_ulong


class XImage(ctypes.Structure):
    _fields_ = [
        ("width", ctypes.c_int), ("height", ctypes.c_int), ("xoffset", ctypes.c_int),
        ("format", ctypes.c_int), ("data", ctypes.c_void_p), ("byte_order", ctypes.c_int),
        ("bitmap_unit", ctypes.c_int), ("bitmap_bit_order", ctypes.c_int), ("bitmap_pad", ctypes.c_int),
        ("depth", ctypes.c_int), ("bytes_per_line", ctypes.c_int), ("bits_per_pixel", ctypes.c_int),
        ("red_mask", ctypes.c_ulong), ("green_mask", ctypes.c_ulong), ("blue_mask", ctypes.c_ulong),
        ("obdata", ctypes.c_void_p),
        ("create_image", ctypes.c_void_p), ("destroy_image", ctypes.c_void_p),
        ("get_pixel", ctypes.c_void_p), ("put_pixel", ctypes.c_void_p),
        ("sub_image", ctypes.c_void_p), ("add_pixel", ctypes.c_void_p),
    ]


class XWindowAttributes(ctypes.Structure):
    _fields_ = [
        ("x", ctypes.c_int), ("y", ctypes.c_int), ("width", ctypes.c_int), ("height", ctypes.c_int),
        ("border_width", ctypes.c_int), ("depth", ctypes.c_int), ("visual", ctypes.c_void_p),
        ("root", Window), ("class", ctypes.c_int), ("bit_gravity", ctypes.c_int),
        ("win_gravity", ctypes.c_int), ("backing_store", ctypes.c_int),
        ("backing_planes", ctypes.c_ulong), ("backing_pixel", ctypes.c_ulong),
        ("save_under", ctypes.c_int), ("colormap", ctypes.c_ulong),
        ("map_installed", ctypes.c_int), ("map_state", ctypes.c_int),
        ("all_event_masks", ctypes.c_long), ("your_event_mask", ctypes.c_long),
        ("do_not_propagate_mask", ctypes.c_long), ("override_redirect", ctypes.c_int),
        ("screen", ctypes.c_void_p),
    ]


class XClassHint(ctypes.Structure):
    # Raw pointers: c_char_p would hand back Python copies, and XFree on those crashes.
    _fields_ = [("res_name", ctypes.c_void_p), ("res_class", ctypes.c_void_p)]


X.XOpenDisplay.restype = ctypes.c_void_p
X.XOpenDisplay.argtypes = [ctypes.c_char_p]
X.XDefaultRootWindow.restype = Window
X.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
X.XInternAtom.restype = Atom
X.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
X.XGetWindowProperty.argtypes = [ctypes.c_void_p, Window, Atom, ctypes.c_long, ctypes.c_long, ctypes.c_int, Atom,
                                 ctypes.POINTER(Atom), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_ulong),
                                 ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_void_p)]
X.XGetClassHint.argtypes = [ctypes.c_void_p, Window, ctypes.POINTER(XClassHint)]
X.XFetchName.argtypes = [ctypes.c_void_p, Window, ctypes.POINTER(ctypes.c_void_p)]
X.XGetWindowAttributes.argtypes = [ctypes.c_void_p, Window, ctypes.POINTER(XWindowAttributes)]
X.XTranslateCoordinates.argtypes = [ctypes.c_void_p, Window, Window, ctypes.c_int, ctypes.c_int,
                                    ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(Window)]
X.XGetImage.restype = ctypes.POINTER(XImage)
X.XGetImage.argtypes = [ctypes.c_void_p, Window, ctypes.c_int, ctypes.c_int, ctypes.c_uint, ctypes.c_uint,
                        ctypes.c_ulong, ctypes.c_int]
X.XFree.argtypes = [ctypes.c_void_p]
X.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
X.XChangeProperty.argtypes = [ctypes.c_void_p, Window, Atom, Atom, ctypes.c_int, ctypes.c_int,
                              ctypes.c_void_p, ctypes.c_int]
X.XFlush.argtypes = [ctypes.c_void_p]

# Xlib's default error handler exits the process; a window that disappears between
# lookup and capture (loading screens, client restart) must only cost one frame.
ERROR_HANDLER = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p)
x_errors = [0]


def _on_x_error(_display, _event):
    x_errors[0] += 1
    return 0


_error_handler_ref = ERROR_HANDLER(_on_x_error)
X.XSetErrorHandler(_error_handler_ref)

dpy = X.XOpenDisplay(None)
if not dpy:
    emit({"error": "cannot open display " + os.environ.get("DISPLAY", "")})
    sys.exit(3)
root = X.XDefaultRootWindow(dpy)
A_CLIENT_LIST = X.XInternAtom(dpy, b"_NET_CLIENT_LIST", 0)
A_WINDOW = X.XInternAtom(dpy, b"WINDOW", 0)
A_CARDINAL = X.XInternAtom(dpy, b"CARDINAL", 0)
A_BYPASS = X.XInternAtom(dpy, b"_NET_WM_BYPASS_COMPOSITOR", 0)
ZPIXMAP, ALL_PLANES, IS_VIEWABLE = 2, 0xFFFFFFFF, 2


def client_list():
    typ, fmt = Atom(), ctypes.c_int()
    n, rest, data = ctypes.c_ulong(), ctypes.c_ulong(), ctypes.c_void_p()
    if X.XGetWindowProperty(dpy, root, A_CLIENT_LIST, 0, 4096, 0, A_WINDOW, ctypes.byref(typ), ctypes.byref(fmt),
                            ctypes.byref(n), ctypes.byref(rest), ctypes.byref(data)) != 0 or not data:
        return []
    arr = ctypes.cast(data, ctypes.POINTER(Window))
    wins = [arr[i] for i in range(n.value)]
    X.XFree(data)
    return wins


def attrs(w):
    a = XWindowAttributes()
    before = x_errors[0]
    ok = X.XGetWindowAttributes(dpy, w, ctypes.byref(a))
    return a if ok and x_errors[0] == before else None


def window_title(w):
    name = ctypes.c_void_p()
    if not X.XFetchName(dpy, w, ctypes.byref(name)) or not name.value:
        return ""
    try:
        return ctypes.string_at(name.value).decode("utf-8", "replace")
    finally:
        X.XFree(name.value)


def class_names(w):
    hint = XClassHint()
    if not X.XGetClassHint(dpy, w, ctypes.byref(hint)):
        return []
    names = []
    for ptr in (hint.res_name, hint.res_class):
        if ptr:
            names.append(ctypes.string_at(ptr).decode("utf-8", "replace"))
            X.XFree(ptr)
    return names


def window_matches(w):
    if args.window_name:
        return args.window_name.lower() in window_title(w).lower()
    names = [n.lower() for n in class_names(w)]
    if args.process_name.lower() + ".exe" in names:
        return True
    # Proton runtimes (Steam, umu-launcher, Faugus) give every window in the
    # prefix the same WM_CLASS of steam_app_<appid>, so it names neither the exe
    # nor the client. Their windows keep the game's title.
    return any(n.startswith("steam_app_") for n in names) and "world of warcraft" in window_title(w).lower()


def find_window():
    """The largest viewable window of the game (skips launchers, crash reporters, tooltips)."""
    best, area = None, 0
    for w in client_list():
        if not window_matches(w):
            continue
        a = attrs(w)
        if a and a.map_state == IS_VIEWABLE and a.width * a.height > area:
            best, area = w, a.width * a.height
    return best


def keep_composited(w):
    val = ctypes.c_ulong(2)
    X.XChangeProperty(dpy, w, A_BYPASS, A_CARDINAL, 32, 0, ctypes.byref(val), 1)
    X.XFlush(dpy)


def mask_shift(mask):
    s = 0
    while mask and not (mask >> s) & 1:
        s += 1
    return s, (mask >> s) if mask else 1


def grab_from(drawable, x, y, width, height):
    before = x_errors[0]
    img = X.XGetImage(dpy, drawable, x, y, width, height, ALL_PLANES, ZPIXMAP)
    X.XSync(dpy, 0)
    if not img or x_errors[0] != before:
        return None
    im = img.contents
    try:
        if im.bits_per_pixel not in (24, 32):
            return {"error": "unsupported pixel format: %d bpp" % im.bits_per_pixel}
        size = im.bytes_per_line * im.height
        buf = ctypes.string_at(im.data, size)
        bpp = im.bits_per_pixel // 8
        stride = im.bytes_per_line
        order = "little" if im.byte_order == 0 else "big"
        chans = [mask_shift(m) for m in (im.red_mask, im.green_mask, im.blue_mask)]
        width, height = im.width, im.height
    finally:
        destroy = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.POINTER(XImage))(im.destroy_image)
        destroy(img)

    def px(x, y):
        o = y * stride + x * bpp
        v = int.from_bytes(buf[o:o + bpp], order)
        return tuple(((v >> s) & m) * 255 // m for s, m in chans)
    return px, width, height


def grab(w):
    """Capture the strip region of window w, from the root window when it can be read
    (that is what is on screen), else from the window's own drawable. Xwayland answers
    BadMatch for XGetImage on the root window even though the game window reads fine."""
    a = attrs(w)
    if not a or a.map_state != IS_VIEWABLE:
        return None
    ra = attrs(root)
    if ra:
        rx, ry, child = ctypes.c_int(), ctypes.c_int(), Window()
        before = x_errors[0]
        X.XTranslateCoordinates(dpy, w, root, 0, 0, ctypes.byref(rx), ctypes.byref(ry), ctypes.byref(child))
        if x_errors[0] == before:
            x0, y0 = max(0, rx.value), max(0, ry.value)
            gw = min(W + SLACK, a.width, ra.width - x0)
            gh = min(H + SLACK, a.height, ra.height - y0)
            if gw > 0 and gh > 0:
                g = grab_from(root, x0, y0, gw, gh)
                if g:
                    return g
    gw, gh = min(W + SLACK, a.width), min(H + SLACK, a.height)
    if gw <= 0 or gh <= 0:
        return None
    return grab_from(w, 0, 0, gw, gh)


def run():
    if args.probe:
        w = find_window()
        if not w:
            emit({"error": "no game window found"})
            sys.exit(1)
        if args.keep_composited:
            keep_composited(w)
            time.sleep(0.5)
        g = grab(w)
        if not g or isinstance(g, dict):
            emit(g or {"error": "capture failed"})
            sys.exit(1)
        px, width, height = g
        write_png(args.probe, px, width, height)
        msg, off = find_and_decode(px, width, height, None)
        emit({"info": "saved %dx%d to %s" % (width, height, args.probe), "strip": msg, "offset": off})
        return

    last_key = None
    last_warn = 0.0
    win = None
    hint = None
    while True:
        if win is None:
            win = find_window()
            if win is None:
                emit({"info": "waiting for %s window" % (args.window_name or args.process_name)})
                time.sleep(3)
                continue
            if args.keep_composited:
                keep_composited(win)
            a = attrs(win)
            emit({"info": "attached to window 0x%x (%dx%d)" % (win, a.width if a else 0, a.height if a else 0)})
        g = grab(win)
        if g is None:
            if attrs(win) is None:  # destroyed: look for it again
                win = None
            time.sleep(1)
            continue
        if isinstance(g, dict):
            emit(g)
            time.sleep(5)
            continue
        px, width, height = g
        msg, hint = find_and_decode(px, width, height, hint)
        if msg and msg.get("error"):
            if time.time() - last_warn >= 5:
                last_warn = time.time()
                emit({"warn": "strip seen but rejected: " + msg["error"]})
        elif msg:
            key = "%s:%d:%s" % (msg["display"], msg["id"], msg["text"])
            if key != last_key:
                last_key = key
                emit(msg)
        time.sleep(args.interval_ms / 1000.0)


try:
    run()
except KeyboardInterrupt:
    pass
