"""Direct Wayland wire/decoder regressions. Run: python3 tests/wayland_test.py"""
import array
import ctypes.util
import json
import mmap
import os
from pathlib import Path
import queue
import select
import signal
import socket
import struct
import subprocess
import sys
import threading
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bridge"))
from capture_common import Decoder
from capture_wayland import FrameDecoder
from wayland_capture import Frame, normalise_frame

def raster(placements, width=1103, height=480, pixel_stride=3, channel_offsets=(0, 1, 2)):
    stride, offset = width * pixel_stride + 7, 11
    pixels = bytearray([23]) * (offset + stride * height)
    for ox, oy, display, identifier, payload, corrupt in placements:
        cell = 2 if display in ("compact", "quiet") else 4
        body = bytearray(identifier.to_bytes(2, "big") + len(payload).to_bytes(2, "big") + payload)
        s1 = s2 = 0
        for byte in body:
            s1 = (s1 + byte) % 255
            s2 = (s2 + s1) % 255
        packet = b"\xc7\x1a" + body + bytes([s1 ^ int(corrupt), s2])
        bits = "".join(format(byte, "08b") for byte in packet)
        bits += "0" * ((-len(bits)) % 3)
        low, high = (16, 80) if display.startswith("quiet") else (0, 255)
        for index in range(0, len(bits), 3):
            symbol = int(bits[index:index + 3], 2)
            color = bytes(high if symbol & bit else low for bit in (4, 2, 1))
            x = ox + ((index // 3) % 200) * cell
            y = oy + ((index // 3) // 200) * cell
            for row in range(y, y + cell):
                for column in range(x, x + cell):
                    p = offset + row * stride + column * pixel_stride
                    for channel, value in zip(channel_offsets, color):
                        pixels[p + channel] = value
    return bytes(pixels), width, height, stride, offset


class FrameTests(unittest.TestCase):
    def test_window_decorations_and_monitor_origins_all_profiles(self):
        for display in ("robust", "compact", "quiet", "quiet4"):
            with self.subTest(display=display):
                payload = ("héllo 界 " * 200).encode()[:3000]
                # A valid-looking damaged strip precedes the real packet.
                data = raster([(21, 31, display, 49152, b"decoy", True),
                               (117, 173, display, 65000, payload, False)])
                result = FrameDecoder(Decoder()).decode(*data)
                self.assertEqual(result, {"id": 65000, "text": payload.decode(errors="replace"), "display": display})

    def test_cached_profile_changes_and_window_move(self):
        decoder = FrameDecoder(Decoder())
        for display, ox, oy in (("quiet4", 93, 41), ("robust", 93, 41),
                                ("compact", 207, 201), ("quiet", 113, 303)):
            result = decoder.decode(*raster([(ox, oy, display, 16384, display.encode(), False)]))
            self.assertEqual(result["display"], display)
            self.assertEqual(result["text"], display)
        blank = raster([], width=410, height=20)
        self.assertIsNone(decoder.decode(*blank))
        self.assertIsNone(decoder.hint)

    def test_checksum_failure_never_emits_a_message(self):
        result = FrameDecoder(Decoder()).decode(*raster([(77, 89, "quiet4", 65535, b"corrupt", True)]))
        self.assertEqual(result, {"error": "checksum"})

    def test_padded_four_byte_layouts_at_right_and_bottom_edges(self):
        for channels in ((2, 1, 0), (0, 1, 2)):
            for display in ("robust", "compact", "quiet", "quiet4"):
                with self.subTest(channels=channels, display=display):
                    cell = 2 if display in ("compact", "quiet") else 4
                    data = raster([(913 - 200 * cell, 29 - cell, display, 42, b"edge", False)],
                                  width=913, height=29, pixel_stride=4, channel_offsets=channels)
                    decoder = FrameDecoder(Decoder())
                    with mmap.mmap(-1, len(data[0])) as pixels:
                        pixels[:] = data[0]
                        result = decoder.decode(pixels, *data[1:], pixel_stride=4, channel_offsets=channels)
                        self.assertEqual(result, {"id": 42, "text": "edge", "display": display})
                        self.assertEqual(decoder.decode(pixels, *data[1:], search=False,
                                                        pixel_stride=4, channel_offsets=channels), result)

    def test_four_byte_checksum_rejection_and_cached_resize(self):
        for channels in ((2, 1, 0), (0, 1, 2)):
            with self.subTest(channels=channels):
                decoder = FrameDecoder(Decoder())
                def decode(placements, **size):
                    return decoder.decode(*raster(placements, pixel_stride=4, channel_offsets=channels, **size),
                                          pixel_stride=4, channel_offsets=channels)
                self.assertEqual(decode([(97, 211, "quiet4", 7, b"damaged", True)]), {"error": "checksum"})
                self.assertEqual(decode([(97, 211, "quiet4", 8, b"valid", False)])["text"], "valid")
                self.assertIsNone(decode([], width=410, height=20))
                self.assertIsNone(decoder.hint)
                self.assertEqual(decode([(1, 1, "compact", 9, b"moved", False)], width=410, height=20)["text"], "moved")

    def test_compositor_transforms_preserve_pixel_orientation_and_channels(self):
        # Distinct rows/columns catch flipped rotation directions; padding must
        # never become image data when a compositor transforms its SHM buffer.
        images = (
            (3, 2, (1, 2, 3, 4, 5, 6)),
            (2, 3, (3, 6, 2, 5, 1, 4)),
            (3, 2, (6, 5, 4, 3, 2, 1)),
            (2, 3, (4, 1, 5, 2, 6, 3)),
            (3, 2, (3, 2, 1, 6, 5, 4)),
            (2, 3, (1, 4, 2, 5, 3, 6)),
            (3, 2, (4, 5, 6, 1, 2, 3)),
            (2, 3, (6, 3, 5, 2, 4, 1)),
        )
        expected = b"".join(bytes((v, v + 10, v + 20, 255)) for v in range(1, 7))
        for transform, (width, height, values) in enumerate(images):
            with self.subTest(transform=transform):
                stride = width * 4 + 8
                data = bytearray(stride * height)
                for index, value in enumerate(values):
                    p = index // width * stride + index % width * 4
                    data[p:p + 4] = bytes((value, value + 10, value + 20, 255))
                frame = Frame(data, width, height, stride, (2, 1, 0), transform)
                result = normalise_frame(frame)
                self.assertEqual((result.width, result.height), (3, 2))
                pixels = b"".join(result.data[y * result.stride:y * result.stride + 12] for y in range(2))
                self.assertEqual(pixels, expected)
                if transform == 0:
                    self.assertIs(result.data, data)


TOPLEVEL_LIST = "ext_foreign_toplevel_list_v1"
SOURCE_MANAGER = "ext_foreign_toplevel_image_capture_source_manager_v1"
CAPTURE_MANAGER = "ext_image_copy_capture_manager_v1"
SESSION = "ext_image_copy_capture_session_v1"
FRAME = "ext_image_copy_capture_frame_v1"
HANDLE = "ext_foreign_toplevel_handle_v1"
SOURCE = "ext_image_capture_source_v1"
GLOBALS = ("wl_shm", TOPLEVEL_LIST, SOURCE_MANAGER, CAPTURE_MANAGER)


def uints(*values):
    return struct.pack("=" + "I" * len(values), *values)


def wire_string(value):
    value = value.encode() + b"\0"
    return uints(len(value)) + value + b"\0" * (-len(value) % 4)


class Compositor:
    """Small real Wayland peer; no client implementation details are imported.

    Opcodes and argument order follow the three staging ext-* XML protocols
    and core wayland.xml. All events and client requests traverse a Unix stream;
    wl_shm.create_pool descriptors arrive through SCM_RIGHTS.
    """
    def __init__(self, titles=(), missing=None, args=()):
        self.socket, client = socket.socketpair()
        self.socket.settimeout(0.1)
        self.objects = {1: "wl_display"}
        self.globals = {i: name for i, name in enumerate(GLOBALS, 1) if name != missing}
        self.titles = list(titles)
        self.commands = queue.Queue()
        self.errors = []
        self.events = []
        self.messages = []
        self.selected = []
        self.buffers = {}
        self.pools = {}
        self.maps = []
        self.frames = {}
        self.sessions = {}
        self.pending = None
        self.list_id = None
        self.next_server_id = 0xff000000
        self.size = (913, 89)
        self.format = 1  # WL_SHM_FORMAT_XRGB8888: B,G,R,X on little endian.
        self.fds = []
        self.running = True
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()
        env = dict(os.environ, WAYLAND_SOCKET=str(client.fileno()), WAYLAND_DISPLAY="wowie-isolated-invalid",
                   XDG_RUNTIME_DIR="/nonexistent/wowie-test", DBUS_SESSION_BUS_ADDRESS="unix:path=/nonexistent/wowie-test")
        helper = Path(__file__).resolve().parents[1] / "bridge" / "capture_wayland.py"
        try:
            self.child = subprocess.Popen(
                [sys.executable, str(helper), "--interval-ms", "1", *args],
                pass_fds=(client.fileno(),), env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        finally:
            client.close()
        self.reader = threading.Thread(target=self.read_messages, daemon=True)
        self.reader.start()

    def read_messages(self):
        for line in self.child.stdout:
            try:
                self.messages.append(json.loads(line))
            except ValueError as exc:
                self.errors.append(AssertionError("non-JSON helper stdout: %r (%s)" % (line, exc)))

    def event(self, obj, opcode, body=b""):
        self.socket.sendall(uints(obj, ((len(body) + 8) << 16) | opcode) + body)

    def destroy(self, obj):
        self.objects.pop(obj)
        if obj < 0xff000000:
            self.event(1, 1, uints(obj))  # wl_display.delete_id

    def toplevel(self, title, app_id):
        obj = self.next_server_id
        self.next_server_id += 1
        self.objects[obj] = HANDLE
        self.event(self.list_id, 0, uints(obj))
        self.event(obj, 4, wire_string("window-%d" % obj))
        self.event(obj, 2, wire_string(title))
        self.event(obj, 3, wire_string(app_id))
        self.event(obj, 1)
        self.events.append(("toplevel", obj, title))

    def constraints(self, session):
        self.event(session, 0, uints(*self.size))
        self.event(session, 1, uints(self.format))
        self.event(session, 4)

    def request(self, obj, opcode, body):
        interface = self.objects[obj]
        args = struct.unpack("=" + "I" * (len(body) // 4), body)
        if interface == "wl_display":
            new_id, = args
            if opcode == 1:
                self.objects[new_id] = "wl_registry"
                for name, global_interface in self.globals.items():
                    self.event(new_id, 0, uints(name) + wire_string(global_interface) + uints(1))
            else:
                assert opcode == 0
                self.event(new_id, 0, uints(0))
                self.event(1, 1, uints(new_id))
                self.events.append(("sync",))
        elif interface == "wl_registry":
            assert opcode == 0
            name, length = args[:2]
            interface = body[8:8 + length - 1].decode()
            version, new_id = struct.unpack_from("=II", body, 8 + ((length + 3) & ~3))
            assert self.globals[name] == interface and version == 1
            self.objects[new_id] = interface
            if interface == "wl_shm":
                self.event(new_id, 0, uints(0))
                self.event(new_id, 0, uints(1))
            elif interface == TOPLEVEL_LIST:
                self.list_id = new_id
                for title, app_id in self.titles:
                    self.toplevel(title, app_id)
                self.events.append(("listed",))
        elif interface == "wl_shm" and opcode == 0:
            pool, size = args
            fd = self.fds.pop(0)
            try:
                mapping = mmap.mmap(fd, size)
            finally:
                os.close(fd)
            self.maps.append(mapping)
            self.pools[pool] = mapping
            self.objects[pool] = "wl_shm_pool"
            self.events.append(("fd", size))
        elif interface == "wl_shm_pool" and opcode == 0:
            buffer, offset, width, height, stride, fmt = args
            assert stride >= width * 4
            assert offset + stride * height <= len(self.pools[obj])
            self.buffers[buffer] = (self.pools[obj], offset, width, height, stride, fmt)
            self.objects[buffer] = "wl_buffer"
        elif interface == SOURCE_MANAGER and opcode == 0:
            source, handle = args
            assert self.objects[handle] == HANDLE
            self.objects[source] = SOURCE
            self.selected.append(handle)
        elif interface == CAPTURE_MANAGER and opcode == 0:
            session, source, options = args
            assert self.objects[source] == SOURCE and options == 0
            self.objects[session] = SESSION
            self.sessions[session] = self.selected[-1]
            self.constraints(session)
        elif interface == SESSION and opcode == 0:
            frame, = args
            self.objects[frame] = FRAME
            self.frames[frame] = {"session": obj}
        elif interface == FRAME and opcode == 1:
            self.frames[obj]["buffer"], = args
        elif interface == FRAME and opcode == 2:
            x, y, width, height = args
            assert width > 0 and height > 0
        elif interface == FRAME and opcode == 3:
            assert self.pending is None
            assert "buffer" in self.frames[obj]
            self.pending = obj
            self.events.append(("capture", obj))
        elif interface == TOPLEVEL_LIST and opcode == 0:
            self.event(obj, 1)
        else:
            destructor = {FRAME: 0, SESSION: 1, CAPTURE_MANAGER: 2, SOURCE_MANAGER: 1,
                          TOPLEVEL_LIST: 1, HANDLE: 0, SOURCE: 0, "wl_buffer": 0, "wl_shm_pool": 1}
            assert destructor.get(interface) == opcode, (interface, opcode, args)
            if self.pending == obj:
                self.pending = None
            self.destroy(obj)
            self.events.append(("destroy", interface))

    def command(self, name, *args):
        self.commands.put((name, args))

    def control(self, name, args):
        if name == "toplevel":
            self.toplevel(*args)
        elif name == "resize":
            self.size, self.format = args
            session = self.frames[self.pending]["session"]
            self.constraints(session)
            self.event(self.pending, 4, uints(1))  # failure_reason.buffer_constraints
            self.pending = None
        elif name == "close":
            handle = self.selected[-1]
            self.event(handle, 0)
            for session, source_handle in self.sessions.items():
                if source_handle == handle and session in self.objects:
                    self.event(session, 5)
            if self.pending is not None:
                self.event(self.pending, 4, uints(2))
                self.pending = None
        elif name == "revoke":
            session = self.frames[self.pending]["session"]
            self.event(session, 5)
            self.event(self.pending, 4, uints(2))
            self.pending = None
        elif name == "frame":
            identifier, text = args
            frame = self.pending
            mapping, offset, width, height, stride, fmt = self.buffers[self.frames[frame]["buffer"]]
            assert (width, height) == self.size and fmt == self.format
            channels = (2, 1, 0) if fmt in (0, 1) else (0, 1, 2)
            pixels, _, _, pitch, start = raster([(31, 13, "robust", identifier, text.encode(), False)],
                                               width=width, height=height, pixel_stride=4, channel_offsets=channels)
            for y in range(height):
                mapping[offset + y * stride:offset + y * stride + width * 4] = pixels[start + y * pitch:start + y * pitch + width * 4]
            self.event(frame, 0, uints(0))
            self.event(frame, 1, uints(0, 0, width, height))
            self.event(frame, 2, uints(0, 1, 0))
            self.event(frame, 3)
            self.pending = None
        elif name == "disconnect":
            self.socket.shutdown(socket.SHUT_RDWR)
        else:
            raise AssertionError(name)

    def run(self):
        data = bytearray()
        try:
            while self.running:
                while not self.commands.empty():
                    self.control(*self.commands.get_nowait())
                if not select.select([self.socket], [], [], 0.01)[0]:
                    continue
                chunk, ancillary, flags, _ = self.socket.recvmsg(65536, socket.CMSG_SPACE(16 * 4))
                assert not flags & socket.MSG_CTRUNC
                for level, kind, payload in ancillary:
                    assert (level, kind) == (socket.SOL_SOCKET, socket.SCM_RIGHTS)
                    descriptors = array.array("i")
                    descriptors.frombytes(payload)
                    self.fds.extend(descriptors)
                if not chunk:
                    break
                data.extend(chunk)
                while len(data) >= 8:
                    obj, header = struct.unpack_from("=II", data)
                    size, opcode = header >> 16, header & 0xffff
                    assert size >= 8 and size % 4 == 0
                    if len(data) < size:
                        break
                    self.request(obj, opcode, bytes(data[8:size]))
                    del data[:size]
        except (BrokenPipeError, ConnectionResetError):
            pass  # A clean client shutdown need not read delete_id acknowledgements.
        except Exception as exc:
            if self.running:
                self.errors.append(exc)

    def wait(self, predicate, timeout=6):
        deadline = time.monotonic() + timeout
        while not predicate():
            if self.errors:
                raise self.errors[0]
            if time.monotonic() >= deadline:
                raise AssertionError("Wayland fixture timed out: events=%r messages=%r exit=%r" %
                                     (self.events, self.messages, self.child.poll()))
            time.sleep(0.01)
        if self.errors:
            raise self.errors[0]

    def message(self, identifier, text):
        self.wait(lambda: any(event.get("id") == identifier for event in self.messages))
        assert {"id": identifier, "text": text, "display": "robust"} in self.messages, self.messages

    def stop_child(self, sig=signal.SIGTERM):
        self.child.send_signal(sig)
        code = self.child.wait(timeout=3)
        self.reader.join(1)
        assert code == 0, (code, self.child.stderr.read(), self.messages)

    def close(self):
        if self.child.poll() is None:
            self.child.kill()
        self.child.wait(timeout=3)
        self.reader.join(1)
        self.running = False
        self.thread.join(1)
        self.socket.close()
        for mapping in self.maps:
            mapping.close()
        for fd in self.fds:
            os.close(fd)
        self.child.stdout.close()
        self.child.stderr.close()
        if self.errors:
            raise self.errors[0]


@unittest.skipUnless(sys.platform == "linux" and ctypes.util.find_library("wayland-client"),
                     "requires Linux libwayland-client")
class NativeTests(unittest.TestCase):
    def compositor(self, **kwargs):
        peer = Compositor(**kwargs)
        self.addCleanup(peer.close)
        return peer

    def test_waits_for_wow_not_battlenet_and_decodes_native_shm(self):
        peer = self.compositor(titles=[("Battle.net", "steam_app_12345")])
        peer.wait(lambda: ("listed",) in peer.events)
        time.sleep(0.15)
        self.assertIsNone(peer.child.poll())
        self.assertEqual(peer.selected, [])
        peer.command("toplevel", "World of Warcraft", "steam_app_12345")
        peer.wait(lambda: peer.pending is not None)
        game = next(event[1] for event in peer.events if event[0] == "toplevel" and event[2] == "World of Warcraft")
        self.assertEqual(peer.selected, [game])
        peer.command("frame", 501, "native héllo")
        peer.message(501, "native héllo")
        peer.wait(lambda: peer.pending is not None)
        # No ready event: an unchanged window can leave capture pending indefinitely.
        time.sleep(0.15)
        self.assertIsNone(peer.child.poll())
        self.assertEqual(sum(event[0] == "fd" for event in peer.events), 1)
        peer.stop_child()

    def test_resize_constraints_and_window_reopen(self):
        peer = self.compositor(titles=[("World of Warcraft", "com.faugus.Launcher")])
        peer.wait(lambda: peer.pending is not None)
        peer.command("frame", 601, "before resize")
        peer.message(601, "before resize")
        peer.wait(lambda: peer.pending is not None)
        peer.command("resize", (1009, 113), 0)
        peer.wait(lambda: peer.pending is not None
                  and sum(event[0] == "fd" for event in peer.events) >= 2)
        peer.command("frame", 602, "after resize")
        peer.message(602, "after resize")
        peer.wait(lambda: peer.pending is not None)
        peer.command("close")
        peer.wait(lambda: ("destroy", SESSION) in peer.events)
        self.assertIsNone(peer.child.poll())
        peer.command("toplevel", "World of Warcraft", "com.faugus.Launcher")
        peer.wait(lambda: len(peer.selected) == 2 and peer.pending is not None)
        peer.command("frame", 603, "reopened")
        peer.message(603, "reopened")
        peer.stop_child()

    def test_custom_title_and_process_name(self):
        for args, titles in [
            (("--window-name", "Custom game"), [("World of Warcraft", "Wow"), ("Custom game - realm", "unrelated")]),
            (("--process-name", "WowClassic"), [("Battle.net", "steam_app_9"), ("Realm", "WowClassic")]),
        ]:
            with self.subTest(args=args):
                peer = self.compositor(args=args, titles=titles)
                peer.wait(lambda: peer.pending is not None)
                chosen = next(event[1] for event in peer.events if event[0] == "toplevel" and event[2] == titles[1][0])
                self.assertEqual(peer.selected, [chosen])
                peer.command("frame", 701, "matched")
                peer.message(701, "matched")
                peer.stop_child()

    def test_missing_required_protocol_is_terminal(self):
        for missing in GLOBALS:
            with self.subTest(missing=missing):
                peer = self.compositor(missing=missing)
                self.assertEqual(peer.child.wait(timeout=6), 2)
                peer.reader.join(1)
                self.assertTrue(any("error" in event for event in peer.messages), peer.messages)
                self.assertFalse(peer.selected)

    def test_removed_picker_and_token_cli_options_are_usage_errors(self):
        for args in (("--select-source",), ("--restore-token-file", "/unused/token")):
            with self.subTest(args=args):
                peer = self.compositor(args=args)
                self.assertEqual(peer.child.wait(timeout=6), 2)
                self.assertIn("unrecognized arguments", peer.child.stderr.read())
                self.assertFalse(peer.selected)

    def test_disconnect_is_runtime_failure(self):
        peer = self.compositor(titles=[("World of Warcraft", "Wow")])
        peer.wait(lambda: peer.pending is not None)
        peer.command("disconnect")
        self.assertEqual(peer.child.wait(timeout=6), 1)
        peer.reader.join(1)
        self.assertTrue(any("error" in event for event in peer.messages), peer.messages)

    def test_capture_permission_revocation_is_terminal(self):
        peer = self.compositor(titles=[("World of Warcraft", "Wow")])
        peer.wait(lambda: peer.pending is not None)
        peer.command("revoke")
        self.assertEqual(peer.child.wait(timeout=6), 2)
        peer.reader.join(1)
        self.assertTrue(any("error" in event for event in peer.messages), peer.messages)

    def test_signals_stop_while_waiting_for_game_or_unchanged_frame(self):
        for sig in (signal.SIGINT, signal.SIGTERM):
            for titles in ([], [("World of Warcraft", "Wow")]):
                with self.subTest(signal=sig, titles=titles):
                    peer = self.compositor(titles=titles)
                    peer.wait(lambda: peer.pending is not None if titles else ("listed",) in peer.events)
                    peer.stop_child(sig)


if __name__ == "__main__":
    unittest.main()
