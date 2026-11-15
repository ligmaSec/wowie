"""Direct window capture using libwayland-client and reusable shared memory.

Only the version-1 foreign-toplevel/image-copy protocols are bound. The native
library owns wire framing, object IDs and FD transfer; no portal is contacted.
"""

import ctypes as C
import ctypes.util
from dataclasses import dataclass
import errno
import mmap
import os
import select
import sys
import time


class CaptureError(Exception):
    def __init__(self, message, code=2):
        super().__init__(message)
        self.code = code


class Interface(C.Structure):
    pass


class Message(C.Structure):
    _fields_ = [("name", C.c_char_p), ("signature", C.c_char_p),
                ("types", C.POINTER(C.POINTER(Interface)))]


Interface._fields_ = [("name", C.c_char_p), ("version", C.c_int),
                      ("method_count", C.c_int), ("methods", C.POINTER(Message)),
                      ("event_count", C.c_int), ("events", C.POINTER(Message))]


class Argument(C.Union):
    _fields_ = [("i", C.c_int32), ("u", C.c_uint32), ("f", C.c_int32),
                ("s", C.c_char_p), ("o", C.c_void_p), ("n", C.c_uint32),
                ("a", C.c_void_p), ("h", C.c_int32)]


Dispatcher = C.CFUNCTYPE(C.c_int, C.c_void_p, C.c_void_p, C.c_uint32,
                         C.POINTER(Message), C.POINTER(Argument))

# Wire order/signatures from wayland-protocols staging, all bound at version 1.
PROTOCOLS = {
    "ext_foreign_toplevel_list_v1": (
        [("stop", "", ()), ("destroy", "", ())],
        [("toplevel", "n", ("ext_foreign_toplevel_handle_v1",)), ("finished", "", ())]),
    "ext_foreign_toplevel_handle_v1": (
        [("destroy", "", ())],
        [("closed", "", ()), ("done", "", ()), ("title", "s", (None,)),
         ("app_id", "s", (None,)), ("identifier", "s", (None,))]),
    "ext_image_capture_source_v1": ([("destroy", "", ())], []),
    "ext_foreign_toplevel_image_capture_source_manager_v1": (
        [("create_source", "no", ("ext_image_capture_source_v1", "ext_foreign_toplevel_handle_v1")),
         ("destroy", "", ())], []),
    "ext_image_copy_capture_manager_v1": (
        [("create_session", "nou", ("ext_image_copy_capture_session_v1", "ext_image_capture_source_v1", None)),
         ("create_pointer_cursor_session", "noo", ("ext_image_copy_capture_cursor_session_v1", "ext_image_capture_source_v1", "wl_pointer")),
         ("destroy", "", ())], []),
    "ext_image_copy_capture_cursor_session_v1": ([], []),  # Never instantiated (cursors are excluded).
    "ext_image_copy_capture_session_v1": (
        [("create_frame", "n", ("ext_image_copy_capture_frame_v1",)), ("destroy", "", ())],
        [("buffer_size", "uu", (None, None)), ("shm_format", "u", (None,)),
         ("dmabuf_device", "a", (None,)), ("dmabuf_format", "ua", (None, None)),
         ("done", "", ()), ("stopped", "", ())]),
    "ext_image_copy_capture_frame_v1": (
        [("destroy", "", ()), ("attach_buffer", "o", ("wl_buffer",)),
         ("damage_buffer", "iiii", (None,) * 4), ("capture", "", ())],
        [("transform", "u", (None,)), ("damage", "iiii", (None,) * 4),
         ("presentation_time", "uuu", (None,) * 3), ("ready", "", ()),
         ("failed", "u", (None,))]),
}


class Connection:
    """Small native binding; dispatches on one thread and remains interruptible."""
    def __init__(self, cancelled=lambda: False):
        library = ctypes.util.find_library("wayland-client")
        if not library:
            raise CaptureError("libwayland-client not found; install your distribution's Wayland client library")
        self.lib = C.CDLL(library, use_errno=True)
        functions = {
            "wl_display_connect": (C.c_void_p, [C.c_char_p]),
            "wl_display_disconnect": (None, [C.c_void_p]),
            "wl_display_get_fd": (C.c_int, [C.c_void_p]),
            "wl_display_get_error": (C.c_int, [C.c_void_p]),
            "wl_display_prepare_read": (C.c_int, [C.c_void_p]),
            "wl_display_cancel_read": (None, [C.c_void_p]),
            "wl_display_read_events": (C.c_int, [C.c_void_p]),
            "wl_display_dispatch_pending": (C.c_int, [C.c_void_p]),
            "wl_display_flush": (C.c_int, [C.c_void_p]),
            "wl_proxy_get_version": (C.c_uint32, [C.c_void_p]),
            "wl_proxy_destroy": (None, [C.c_void_p]),
            "wl_proxy_add_dispatcher": (C.c_int, [C.c_void_p, Dispatcher, C.c_void_p, C.c_void_p]),
            "wl_proxy_marshal_array_flags": (C.c_void_p, [C.c_void_p, C.c_uint32,
                C.POINTER(Interface), C.c_uint32, C.c_uint32, C.POINTER(Argument)]),
        }
        for name, (result, arguments) in functions.items():
            function = getattr(self.lib, name)
            function.restype, function.argtypes = result, arguments
        self.interfaces = {name: Interface.in_dll(self.lib, name + "_interface")
                           for name in ("wl_display", "wl_registry", "wl_callback", "wl_shm",
                                        "wl_shm_pool", "wl_buffer", "wl_pointer")}
        self.interfaces.update({name: Interface(name.encode(), 1, 0, None, 0, None) for name in PROTOCOLS})
        self.metadata = []  # Native metadata pointers must outlive every proxy.
        for name, (requests, events) in PROTOCOLS.items():
            for specs, count_field, messages_field in ((requests, "method_count", "methods"),
                                                       (events, "event_count", "events")):
                messages = (Message * len(specs))()
                for index, (message, signature, types) in enumerate(specs):
                    pointers = (C.POINTER(Interface) * len(types))(
                        *(C.pointer(self.interfaces[t]) if t else None for t in types))
                    messages[index] = Message(message.encode(), signature.encode(), pointers)
                    self.metadata.append(pointers)
                setattr(self.interfaces[name], count_field, len(specs))
                setattr(self.interfaces[name], messages_field, messages)
                self.metadata.append(messages)
        self.handlers, self.objects = {}, {}
        self.error = None
        self.stopped = False
        self.cancelled = cancelled
        self.dispatcher = Dispatcher(self._event)
        self.display = self.lib.wl_display_connect(None)
        if not self.display:
            raise CaptureError("cannot connect to Wayland; run capture in the game's desktop session (WAYLAND_DISPLAY/XDG_RUNTIME_DIR)")
        self.objects[self.display] = self.interfaces["wl_display"]
        self.fd = self.lib.wl_display_get_fd(self.display)

    def _event(self, _implementation, target, opcode, _message, arguments):
        try:
            handler = self.handlers.get(target)
            if handler:
                handler(opcode, arguments)
            return 0
        except Exception as exc:
            # Exceptions cannot cross a ctypes callback boundary.
            self.error = exc
            return -1

    def check(self, result=0):
        if self.error:
            error, self.error = self.error, None
            raise error
        if result < 0:
            code = self.lib.wl_display_get_error(self.display) or C.get_errno() or errno.EIO
            raise CaptureError("Wayland connection failed: " + os.strerror(code), 1)
        return result

    def listen(self, proxy, interface, handler):
        self.objects[proxy] = self.interfaces[interface]
        self.handlers[proxy] = handler
        if self.lib.wl_proxy_add_dispatcher(proxy, self.dispatcher, None, None) < 0:
            raise CaptureError("could not register Wayland events for " + interface, 1)
        return proxy

    def request(self, proxy, opcode, *values, child=None, destroy=False):
        signature = self.objects[proxy].methods[opcode].signature.decode()
        arguments = (Argument * len(values))()
        for argument, kind, value in zip(arguments, signature, values):
            if kind in "on":
                argument.o = value
            elif kind == "s":
                argument.s = value.encode() if isinstance(value, str) else value
            elif kind in "ih":
                argument.i = value
            else:
                argument.u = value
        interface = C.pointer(self.interfaces[child]) if child else None
        result = self.lib.wl_proxy_marshal_array_flags(proxy, opcode, interface,
            1 if child else self.lib.wl_proxy_get_version(proxy), int(destroy), arguments)
        if destroy:
            self.handlers.pop(proxy, None)
            self.objects.pop(proxy, None)
        if child:
            if not result:
                raise CaptureError("could not create Wayland object " + child, 1)
            self.objects[result] = self.interfaces[child]
        return result

    def destroy(self, proxy, opcode=None):
        if proxy:
            if opcode is not None:
                self.request(proxy, opcode, destroy=True)
            else:
                self.lib.wl_proxy_destroy(proxy)
                self.handlers.pop(proxy, None)
                self.objects.pop(proxy, None)

    def dispatch(self, timeout=0.1):
        self.check(self.lib.wl_display_dispatch_pending(self.display))
        if self.stopped or self.cancelled():
            return
        while self.lib.wl_display_prepare_read(self.display) != 0:
            self.check(self.lib.wl_display_dispatch_pending(self.display))
        prepared = True
        try:
            flushed = self.lib.wl_display_flush(self.display)
            blocked = flushed < 0 and C.get_errno() == errno.EAGAIN
            if not blocked:
                self.check(flushed)
            readable, writable, _ = select.select([self.fd], [self.fd] if blocked else [], [], timeout)
            if readable:
                prepared = False
                self.check(self.lib.wl_display_read_events(self.display))
            else:
                self.lib.wl_display_cancel_read(self.display)
                prepared = False
            if writable:
                result = self.lib.wl_display_flush(self.display)
                if result < 0 and C.get_errno() != errno.EAGAIN:
                    self.check(result)
        finally:
            if prepared:
                self.lib.wl_display_cancel_read(self.display)
        self.check(self.lib.wl_display_dispatch_pending(self.display))

    def roundtrip(self):
        done = []
        callback = self.request(self.display, 0, None, child="wl_callback")
        self.listen(callback, "wl_callback", lambda _op, _args: done.append(True))
        deadline = time.monotonic() + 10
        try:
            while not done and not self.stopped and not self.cancelled():
                if time.monotonic() >= deadline:
                    raise CaptureError("Wayland setup timed out; check that the compositor is responding")
                self.dispatch()
        finally:
            self.destroy(callback)

    def close(self):
        if self.display:
            self.lib.wl_display_disconnect(self.display)
            self.display = None
            self.handlers.clear()
            self.objects.clear()


def channel_offsets(format):
    # wl_shm formats use native-endian words; X/alpha is not a colour channel.
    if format in (0, 1):  # ARGB8888 / XRGB8888
        return (2, 1, 0) if sys.byteorder == "little" else (1, 2, 3)
    if format in (0x34324241, 0x34324258):  # ABGR8888 / XBGR8888
        return (0, 1, 2) if sys.byteorder == "little" else (3, 2, 1)
    raise CaptureError("the compositor did not offer an RGB 8-bit shared-memory capture format")


class Buffer:
    def __init__(self, connection, shm, width, height, format):
        self.connection, self.width, self.height = connection, width, height
        self.format = format
        self.channel_offsets = channel_offsets(format)
        self.stride = width * 4
        size = self.stride * height
        if width <= 0 or height <= 0 or size > 0x7fffffff:
            raise CaptureError("invalid Wayland capture buffer dimensions", 1)
        self.fd, self.data, self.proxy = None, None, None
        pool = None
        try:
            self.fd = os.memfd_create("wowie-capture", os.MFD_CLOEXEC)
            os.ftruncate(self.fd, size)
            self.data = mmap.mmap(self.fd, size)
            pool = connection.request(shm, 0, None, self.fd, size, child="wl_shm_pool")
            self.proxy = connection.request(pool, 0, None, 0, width, height, self.stride,
                                            format, child="wl_buffer")
            connection.listen(self.proxy, "wl_buffer", lambda _op, _args: None)
        except Exception:
            self.close()
            raise
        finally:
            connection.destroy(pool, 1)

    def close(self):
        self.connection.destroy(self.proxy, 0)
        self.proxy = None
        if self.data is not None:
            self.data.close()
            self.data = None
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None


@dataclass
class Frame:
    data: object
    width: int
    height: int
    stride: int
    channel_offsets: tuple
    transform: int = 0


def normalise_frame(frame):
    """Undo compositor transforms; the usual untransformed mmap is zero-copy."""
    transform = frame.transform
    if transform == 0:
        return frame
    if transform not in range(1, 8):
        raise CaptureError("invalid Wayland capture transform", 1)
    w, h, stride = frame.width, frame.height, frame.stride
    width, height = (h, w) if transform & 1 else (w, h)
    output_stride = width * 4
    data = bytearray(output_stride * height)
    for y in range(height):
        start, step = {
            1: ((h - 1) * stride + y * 4, -stride),
            2: ((h - 1 - y) * stride + (w - 1) * 4, -4),
            3: ((w - 1 - y) * 4, stride),
            4: (y * stride + (w - 1) * 4, -4),
            5: (y * 4, stride),
            6: ((h - 1 - y) * stride, 4),
            7: ((h - 1) * stride + (w - 1 - y) * 4, -stride),
        }[transform]
        for channel in range(4):
            end = start + channel + width * step
            if step < 0 and end < 0:
                end = None
            data[y * output_stride + channel:(y + 1) * output_stride:4] = \
                frame.data[start + channel:end:step]
    return Frame(data, width, height, output_stride, frame.channel_offsets)


def matches_window(title, app_id, process_name="Wow", window_name=""):
    if window_name:
        return window_name.casefold() in title.casefold()
    name = process_name.casefold().removesuffix(".exe")
    if app_id.casefold().removesuffix(".exe") == name:
        return True
    # Faugus gives Battle.net and WoW the same steam_app_* application ID.
    return title.casefold() == "world of warcraft" or title.casefold().startswith("world of warcraft ")


class WaylandCapture:
    """Return native frames valid until next_frame(), reusing one wl_shm buffer."""
    REQUIRED = ("wl_shm", "ext_foreign_toplevel_list_v1",
                "ext_foreign_toplevel_image_capture_source_manager_v1",
                "ext_image_copy_capture_manager_v1")

    def __init__(self, process_name="Wow", window_name="", info=lambda _message: None,
                 cancelled=lambda: False):
        self.connection = Connection(cancelled)
        self.process_name, self.window_name, self.info = process_name, window_name, info
        self.windows, self.globals = {}, {}
        self.selected = self.source = self.session = self.frame = self.buffer = None
        self.constraints = None
        self.pending_size, self.pending_formats = None, set()
        self.ready = self.session_stopped = False
        self.failure = None
        self.transform = 0
        self.started = None
        self.received = False
        try:
            registry = self.connection.request(self.connection.display, 1, None, child="wl_registry")
            self.connection.listen(registry, "wl_registry", self._registry_event)
            self.connection.roundtrip()
            missing = [name for name in self.REQUIRED if name not in self.globals]
            if missing:
                raise CaptureError("direct Wayland window capture is unavailable: missing " + ", ".join(missing)
                                   + "; use a compositor with image-copy/foreign-toplevel capture support (such as current Hyprland)")
            bound = {}
            for name in self.REQUIRED:
                bound[name] = self.connection.request(registry, 0, self.globals[name], name, 1,
                                                      None, child=name)
            self.shm = bound["wl_shm"]
            self.connection.listen(self.shm, "wl_shm", lambda _op, _args: None)
            self.source_manager = bound["ext_foreign_toplevel_image_capture_source_manager_v1"]
            self.capture_manager = bound["ext_image_copy_capture_manager_v1"]
            self.connection.listen(bound["ext_foreign_toplevel_list_v1"],
                                   "ext_foreign_toplevel_list_v1", self._list_event)
            self.connection.roundtrip()
            self.info("direct Wayland window capture ready; waiting for " + (window_name or "World of Warcraft"))
        except Exception:
            self.connection.close()
            raise

    def _registry_event(self, opcode, args):
        if opcode == 0:
            self.globals[args[1].s.decode()] = args[0].u
        elif opcode == 1 and args[0].u in self.globals.values():
            raise CaptureError("a required Wayland global was removed", 1)

    def _list_event(self, opcode, args):
        if opcode == 1:
            raise CaptureError("the compositor stopped window discovery; check capture permissions")
        handle = args[0].o
        window = {"title": "", "app_id": "", "identifier": "", "closed": False, "done": False}
        self.windows[handle] = window
        self.connection.listen(handle, "ext_foreign_toplevel_handle_v1",
                               lambda op, values: self._window_event(window, op, values))

    @staticmethod
    def _window_event(window, opcode, args):
        if opcode == 0:
            window["closed"] = True
        elif opcode == 1:
            window.update(window.pop("pending", {}))
            window["done"] = True
        else:
            key = {2: "title", 3: "app_id", 4: "identifier"}[opcode]
            window.setdefault("pending", {})[key] = args[0].s.decode("utf-8", "replace")

    def _session_event(self, opcode, args):
        if opcode == 0:
            self.pending_size = (args[0].u, args[1].u)
        elif opcode == 1:
            self.pending_formats.add(args[0].u)
        elif opcode == 4:
            if self.pending_size is None:
                raise CaptureError("Wayland capture supplied no buffer dimensions", 1)
            format = next((f for f in (1, 0, 0x34324258, 0x34324241) if f in self.pending_formats), None)
            if format is None:
                raise CaptureError("direct Wayland capture requires an RGB 8-bit wl_shm format; the compositor offered none")
            self.constraints = (*self.pending_size, format)
            self.pending_size, self.pending_formats = None, set()
        elif opcode == 5:
            self.session_stopped = True

    def _frame_event(self, opcode, args):
        if opcode == 0:
            self.transform = args[0].u
        elif opcode == 3:
            self.ready = True
        elif opcode == 4:
            self.failure = args[0].u

    def _detach(self):
        self.connection.destroy(self.frame, 0)
        self.connection.destroy(self.session, 1)
        self.connection.destroy(self.source, 0)
        if self.buffer:
            self.buffer.close()
        self.selected = self.source = self.session = self.frame = self.buffer = None
        self.constraints = None
        self.pending_size, self.pending_formats = None, set()
        self.ready = self.session_stopped = self.received = False
        self.failure = None
        self.started = None

    def next_frame(self, timeout=0.1):
        self.connection.dispatch(0)
        if self.selected and self.windows[self.selected]["closed"]:
            self._detach()
            self.info("game window closed; waiting for World of Warcraft")
        for handle, window in list(self.windows.items()):
            if window["closed"]:
                self.connection.destroy(handle, 0)
                del self.windows[handle]
        if self.session_stopped:
            # Drain the source's closed event before treating this as revocation.
            self.connection.roundtrip()
            if self.windows[self.selected]["closed"]:
                self._detach()
            else:
                raise CaptureError("direct Wayland capture was stopped; check the compositor's capture permission and restart the bridge")
        if not self.session:
            for handle, window in self.windows.items():
                if window["done"] and not window["closed"] and matches_window(
                        window["title"], window["app_id"], self.process_name, self.window_name):
                    self.selected = handle
                    self.source = self.connection.request(self.source_manager, 0, None, handle,
                                                           child="ext_image_capture_source_v1")
                    self.session = self.connection.request(self.capture_manager, 0, None, self.source, 0,
                                                            child="ext_image_copy_capture_session_v1")
                    self.connection.listen(self.session, "ext_image_copy_capture_session_v1", self._session_event)
                    self.started = time.monotonic()
                    self.info("attached to Wayland window " + window["identifier"] + ": " + window["title"])
                    break
        if self.session and self.constraints and not self.frame:
            width, height, format = self.constraints
            fresh = self.buffer is None or (self.buffer.width, self.buffer.height, self.buffer.format) != self.constraints
            if fresh:
                if self.buffer:
                    self.buffer.close()
                self.buffer = Buffer(self.connection, self.shm, width, height, format)
            self.frame = self.connection.request(self.session, 0, None, child="ext_image_copy_capture_frame_v1")
            self.connection.listen(self.frame, "ext_image_copy_capture_frame_v1", self._frame_event)
            self.connection.request(self.frame, 1, self.buffer.proxy)
            if fresh:
                self.connection.request(self.frame, 2, 0, 0, width, height)
            self.connection.request(self.frame, 3)
        if not self.ready and self.failure is None:
            self.connection.dispatch(timeout)
        if self.failure is not None:
            reason, self.failure = self.failure, None
            self.connection.destroy(self.frame, 0)
            self.frame = None
            if reason == 1:  # Constraints can change while the request is in flight.
                if self.buffer:
                    self.buffer.close()
                    self.buffer = None
                self.connection.roundtrip()
                return None
            if reason == 2:
                self.session_stopped = True
                return None
            raise CaptureError("Wayland frame capture failed", 1)
        if self.ready:
            self.ready = False
            self.received = True
            self.connection.destroy(self.frame, 0)
            self.frame = None
            buffer = self.buffer
            return Frame(buffer.data, buffer.width, buffer.height, buffer.stride,
                         buffer.channel_offsets, self.transform)
        if self.started and not self.received and time.monotonic() - self.started > 30:
            raise CaptureError("no direct Wayland frame received in 30 seconds; check compositor capture permissions", 1)
        return None

    def stop(self):
        self.connection.stopped = True

    def close(self):
        try:
            self._detach()
        finally:
            self.connection.close()
