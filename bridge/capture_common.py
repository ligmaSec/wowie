"""Shared stdlib pixel-strip decoder and PNG helpers for Linux capture backends."""

import json
import os
import struct
import sys
import zlib

SLACK = 8  # pixels of misalignment searched around the window origin
MAGIC_CELLS = (6, 1, 6, 1, 5)  # The sixth cell contains unknown ID bits.


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


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


class Decoder:
    def __init__(self, cell=4, cells=200, max_rows=48):
        self.cell = cell
        self.cells = cells
        self.max_rows = max_rows
        self.width = cells * max(cell, 4)
        self.height = max_rows * max(cell, 4)
        # Keep these rules in sync with capture_mac.py and capture.ps1.
        self.profiles = [("robust", cell)]
        if cell != 4:
            self.profiles.append(("robust", 4))
        self.profiles += [("compact", 2), ("quiet", 2), ("quiet4", 4)]

    def decode(self, px, width, height, ox, oy, display, cell):
        if ox + self.cells * cell > width or oy + cell > height:
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
        total = self.cells * min(self.max_rows, (height - oy) // cell)
        for i in range(total):
            value = cell_value(px, i % self.cells, i // self.cells, ox, oy, cell, levels)
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


    def find_and_decode(self, px, width, height, hint):
        """Cached origin/profile first; bounded search continues past rejected candidates."""
        rejected = None
        if hint:
            if hint[2] in ("quiet", "quiet4"):
                endpoint = (hint[0], hint[1], "compact" if hint[3] == 2 else "robust", hint[3])
                msg = self.decode(px, width, height, *endpoint)
                if msg and "error" not in msg:
                    return msg, endpoint
            msg = self.decode(px, width, height, *hint)
            if msg and "error" not in msg:
                return msg, hint
            rejected = msg
        # Endpoint profiles precede quiet, so adaptive thresholds never steal them.
        for display, cell in self.profiles:
            for oy in range(SLACK + 1):
                for ox in range(SLACK + 1):
                    candidate = (ox, oy, display, cell)
                    if candidate == hint:
                        continue
                    msg = self.decode(px, width, height, *candidate)
                    if msg and "error" not in msg:
                        return msg, candidate
                    if msg:
                        rejected = msg
        return rejected, hint


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


def test_images(path, decoder):
    # A directory exercises the same cached path as a live capture sequence.
    images = ([os.path.join(path, name) for name in sorted(os.listdir(path))
               if name.lower().endswith(".png")] if os.path.isdir(path) else [path])
    hint = None
    for image in images:
        px, w, h = read_png(image)
        msg, hint = decoder.find_and_decode(px, w, h, hint)
        emit(msg if msg else {"error": "no valid strip in image"})
