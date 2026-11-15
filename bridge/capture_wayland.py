#!/usr/bin/env python3
"""Capture WoW directly from Wayland without a portal or source picker.

Requires Python's standard library, libwayland-client, and compositor support
for ext-foreign-toplevel-list/image-capture-source/image-copy-capture.
"""

import argparse
import re
import signal
import sys
import time

from capture_common import Decoder, MAGIC_CELLS, emit, test_images, write_png
from wayland_capture import CaptureError, WaylandCapture, normalise_frame


class FrameDecoder:
    """Find strips in native RGB/BGRA buffers, then sample cached cells directly."""
    def __init__(self, decoder):
        self.decoder = decoder
        self.hint = None
        self.patterns = {}

    def _patterns(self, pixel_stride, channel_offsets):
        layout = (pixel_stride, channel_offsets)
        if layout in self.patterns:
            return self.patterns[layout]
        patterns = []
        bits = {position: bit for position, bit in zip(channel_offsets, (4, 2, 1))}
        # Search native storage in C. Thresholds only locate candidates; the
        # calibrated decoder and full Fletcher checksum still decide acceptance.
        for cell in dict.fromkeys(cell for _display, cell in self.decoder.profiles):
            gap = b".{" + str((cell - 1) * pixel_stride).encode() + b"}"
            alternatives = []
            for threshold in (32, 64, 96, 128, 160):
                low = b"[\x00-" + bytes([threshold - 1]) + b"]"
                high = b"[" + bytes([threshold]) + b"-\xff]"
                alternatives.append(gap.join(
                    b"".join((high if symbol & bits[position] else low)
                             if position in bits else b"." for position in range(pixel_stride))
                    for symbol in MAGIC_CELLS))
            patterns.append((cell, re.compile(b"(?=" + b"|".join(alternatives) + b")", re.DOTALL)))
        self.patterns[layout] = patterns
        return patterns

    def decode(self, data, width, height, stride, offset=0, search=True,
               pixel_stride=3, channel_offsets=(0, 1, 2)):
        channel_offsets = tuple(channel_offsets)
        if (width <= 0 or height <= 0 or offset < 0 or pixel_stride < 3
                or len(channel_offsets) != 3 or len(set(channel_offsets)) != 3
                or min(channel_offsets) < 0 or max(channel_offsets) >= pixel_stride
                or stride < width * pixel_stride
                or offset + (height - 1) * stride + width * pixel_stride > len(data)):
            raise CaptureError("invalid or truncated native capture buffer", 1)
        red, green, blue = channel_offsets

        def px(x, y):
            p = offset + y * stride + x * pixel_stride
            return data[p + red], data[p + green], data[p + blue]

        if self.hint and (self.hint[0] + self.decoder.cells * self.hint[3] > width
                          or self.hint[1] + self.hint[3] > height):
            self.hint = None
        message, self.hint = self.decoder.find_and_decode(px, width, height, self.hint)
        if message and "error" not in message:
            return message
        if not search:
            return message
        rejected = message
        for cell, pattern in self._patterns(pixel_stride, channel_offsets):
            if width < self.decoder.cells * cell:
                continue
            for y in range(cell // 2, height, max(1, cell // 2)):
                start = offset + y * stride
                for match in pattern.finditer(data, start, start + width * pixel_stride):
                    x, remainder = divmod(match.start() - start, pixel_stride)
                    ox, oy = x - cell // 2, y - cell // 2
                    if remainder or ox < 0 or ox + self.decoder.cells * cell > width:
                        continue
                    for display, pitch in self.decoder.profiles:
                        if pitch != cell:
                            continue
                        hint = (ox, oy, display, cell)
                        candidate = self.decoder.decode(px, width, height, *hint)
                        if candidate and "error" not in candidate:
                            self.hint = hint
                            return candidate
                        if candidate:
                            rejected = candidate
        return rejected


def capture(args, source, running):
    decoder = FrameDecoder(Decoder(args.cell, args.cells, args.max_rows))
    last_key = None
    next_capture = last_search = last_warn = 0
    while running():
        now = time.monotonic()
        if now < next_capture:
            source.connection.dispatch(min(0.1, next_capture - now))
            continue
        frame = source.next_frame()
        if frame is None:
            continue
        frame = normalise_frame(frame)
        now = time.monotonic()
        next_capture = now + args.interval_ms / 1000.0
        search = bool(args.probe) or now - last_search >= 1
        message = decoder.decode(frame.data, frame.width, frame.height, frame.stride,
                                 search=search, pixel_stride=4, channel_offsets=frame.channel_offsets)
        if search:
            last_search = now
        if args.probe:
            red, green, blue = frame.channel_offsets

            def px(x, y):
                p = y * frame.stride + x * 4
                return frame.data[p + red], frame.data[p + green], frame.data[p + blue]

            write_png(args.probe, px, frame.width, frame.height)
            emit({"info": "saved %dx%d to %s" % (frame.width, frame.height, args.probe),
                  "strip": message, "offset": decoder.hint})
            return
        if message and message.get("error"):
            if now - last_warn >= 5:
                emit({"warn": "strip seen but rejected: " + message["error"]})
                last_warn = now
        elif message:
            key = (message["display"], message["id"], message["text"])
            if key != last_key:
                emit(message)
                last_key = key


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cell", type=int, default=4)
    parser.add_argument("--cells", type=int, default=200)
    parser.add_argument("--max-rows", type=int, default=48)
    parser.add_argument("--interval-ms", type=float, default=50)
    parser.add_argument("--process-name", default="Wow")
    parser.add_argument("--window-name", default="")
    parser.add_argument("--test-image", default="")
    parser.add_argument("--probe", default="")
    args = parser.parse_args()
    if min(args.cell, args.cells, args.max_rows, args.interval_ms) <= 0:
        parser.error("capture geometry and interval must be positive")
    if args.test_image:
        test_images(args.test_image, Decoder(args.cell, args.cells, args.max_rows))
        return 0
    source = None
    running = True

    def stop(_signal, _frame):
        nonlocal running
        running = False
        if source:
            source.stop()

    previous = {sig: signal.signal(sig, stop) for sig in (signal.SIGINT, signal.SIGTERM)}
    try:
        source = WaylandCapture(args.process_name, args.window_name,
                                info=lambda text: emit({"info": text}), cancelled=lambda: not running)
        capture(args, source, lambda: running)
        return 0
    except CaptureError as exc:
        if not running:
            return 0
        emit({"error": str(exc)})
        return exc.code
    except OSError as exc:
        emit({"error": "Wayland capture failed: " + str(exc)})
        return 1
    finally:
        if source:
            source.close()
        for sig, handler in previous.items():
            signal.signal(sig, handler)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (KeyboardInterrupt, BrokenPipeError):
        pass
