# Installing on Linux (Wine)

The addon is unchanged; the bridge writes replies straight into the Wine prefix. Linux capture selects **direct per-window Wayland capture on compatible compositors**, or **libX11 on X11**. Direct Wayland capture supports Wine/Proton's native Wayland backend and Xwayland game windows, with no source picker or portal fallback.

## Requirements

- An X11 session, or a Wayland compositor exposing the protocols listed below. Hyprland is tested-capable; this does **not** mean every Wayland compositor supports direct capture.
- The game **windowed or borderless**.
- Node.js 22.2+, python3, and at least one agent CLI logged in (see [AGENTS.md](AGENTS.md)).
- Capture uses Python's standard library plus libX11 on X11 or libwayland-client on Wayland. No Python packages, GI, GStreamer, PipeWire or desktop portal are required for capture.

### Wayland requirements

The compositor must expose all of:

- `ext_foreign_toplevel_list_v1` (ext-foreign-toplevel-list): window discovery.
- `ext_foreign_toplevel_image_capture_source_manager_v1` (ext-image-capture-source): per-window capture sources.
- `ext_image_copy_capture_manager_v1` (ext-image-copy-capture): frame copying.
- Core `wl_shm`: shared-memory frame buffers.

Install the system client library if missing: `sudo pacman -S wayland` on Arch, or `sudo apt install libwayland-client0` on Debian/Ubuntu. Installing this library does not add missing compositor protocols; use a compositor/version that implements them.

Compositor capture policy may require an explicit **allow grant for the bridge's capture client**. Use your compositor's documented permission mechanism and grant only the needed capture access; do not disable security or grant blanket permissions. Missing protocols or denied access stop capture with a terminal setup error (exit 2), rather than reopening dialogs. Runtime failures exit 1. There is no portal fallback.

## Install

```bash
git clone https://github.com/ligmaSec/wowie
cd wowie
npm ci                      # only needed to run the tests
node setup.js --wow "$HOME/.wine/drive_c/Program Files (x86)/World of Warcraft/_forever_" --project ~/path/to/the/project
```

Without `--wow`, `setup.js` looks in `$WINEPREFIX`, `~/.wine` and `~/Games/battlenet`. Then fully restart the game, enable *Wowie* on the AddOns screen, and start the bridge with `npm start`.

## Check the capture (do this once)

Log in, open the Wowie window and send any message, then while the strip of colored squares is in the top-left corner run:

```bash
npm run probe
```

The probe uses the same backend, interpreter and geometry as the bridge, saves `bridge/probe.png`, and reports whether it decoded a strip. Its only optional argument is an output path: `npm run probe -- output.png`. On Wayland this image contains the **entire game window**; do not share it without checking for private content.

### Wayland

No source selection is needed: capture automatically finds the current WoW window, waits if the game is absent, and follows it after close/reopen. A persistent Wayland connection and reusable native-resolution shared-memory buffer handle frames and resize without spawning a screenshot process per frame. Native Wayland capture preserves the game's HDR path.

`capture.processName` (default `"Wow"`) matches the game's app ID. Generic Steam/Faugus app IDs are matched by the "World of Warcraft" title so Battle.net is not selected. Set `capture.windowName` to a title substring to override automatic matching. `keepComposited` is X11-only.

`capture.backend` defaults to `"auto"`: a Wayland session uses direct Wayland capture even when `DISPLAY` is also set for Xwayland. Set `"backend": "wayland"` under `capture` to force this backend. Set `"backend": "x11"` only for a game using Wine/Proton's X11 backend: it can capture Xwayland/X11 windows, **not native Wayland windows**. There is no automatic X11 fallback on Wayland failure.

If startup reports a missing library, install libwayland-client. If it reports missing protocols, check the compositor's support/version; desktop portal packages cannot supply them. If permission is denied, configure an explicit compositor allow grant before restarting the bridge. Run the bridge in the same desktop session as the game.

### X11 / explicit Xwayland capture

The probe finds the game window automatically. If the picture is black or stale while the game shows the strip, the compositor is letting the game flip its own buffers. Try, in order:

1. `"keepComposited": true` under `capture` in `bridge/config.json` (asks mutter/KWin to keep compositing the game window), then restart the bridge.
2. Plain windowed mode in the game settings.
3. `nvidia-settings -a AllowFlipping=0` (NVIDIA).
4. As a last resort `/wowie mode reload` in game: no capture at all, one UI reload per message.

`bridge.log` shows `capture: attached to window 0x...` once the window is found. Plain Wine sets `WM_CLASS` to the executable name (`wow.exe`), but Proton runtimes (Steam, umu-launcher, Faugus) give every window in the prefix the same `steam_app_<appid>` class; the capture recognises those by the game's "World of Warcraft" title, so the Battle.net window is skipped without any setting. If it keeps saying `waiting for Wow window`, set `capture.windowName` to part of the window title, or `capture.processName` to your executable's name (non-Proton prefixes). `capture.python` picks the interpreter if `python3` is not the one on your `PATH`.
