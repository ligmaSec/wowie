# Configuration reference

Everything the bridge reads: `bridge/config.json`, command-line flags, environment variables, and the files it writes next to itself. `node setup.js` writes a working `config.json` from `bridge/config.example.json` (and brings an older one up to date); this page explains each key so you can tune it by hand.

The bridge reads `config.json` once at start. Restart it after editing, except for an agent's `allowedTools`, which the **Allow & retry** button updates live.

## Paths

| Key | Default (from `config.example.json`) | Meaning |
|---|---|---|
| `addonDir` | `…\World of Warcraft\_forever_\Interface\AddOns` | The game's AddOns folder. The bridge writes the slot addons, `Inbox.lua` and every signal file under it. `setup.js` fills this in from the client it finds. |
| `inboxFile` | `<addonDir>\Wowie\Inbox.lua` | The file the game reads on `/reload` (fallback path). Normally derived from `addonDir`; only change it if you moved the addon. A value that names an older addon folder is ignored in favour of the derived one. |
| `savedVariablesFile` | `…\WTF\Account\<account>\SavedVariables\Wowie.lua` | The addon's saved data. The bridge polls it for the reload-path outbox. `setup.js` picks the first account under `WTF\Account`; pass `--account <name>` to choose another. |
| `defaultCwd` | `C:\path\to\your\project` | Folder for chats that have not chosen one with `/wowie cd`, when the bridge is started from inside this repo (`npm start`). See [Which folder the agent works in](#which-folder-the-agent-works-in). |

## Agents

| Key | Default | Meaning |
|---|---|---|
| `agent` | `"claude"` | The agent for chats that have not picked one with `/wowie agent`. One of `claude`, `codex`, `grok`, `agy`, `hermes`; the bridge refuses to start on anything else. |
| `agents.<id>` | one block per agent | That agent's settings, below. A missing block means the defaults. |

Keys under `agents.claude`, `agents.codex`, `agents.grok`, `agents.agy` and `agents.hermes` (what each one means per agent is spelled out in [AGENTS.md](AGENTS.md)):

| Key | Default | Meaning |
|---|---|---|
| `permissionMode` | `"acceptEdits"` | `acceptEdits` auto-approves file edits inside the working folder; `bypassPermissions` approves everything; `default` approves nothing beyond what `allowedTools` names. Claude gets it as `--permission-mode`; for Codex it picks the sandbox (`read-only` / `workspace-write` / none); for Grok it becomes `--permission-mode dontAsk` plus allow rules, or `--always-approve` (headless Grok runs ordinary commands on its own and blocks dangerous ones unless a rule allows them; see [AGENTS.md](AGENTS.md)). |
| `allowedTools` | git, npm, npx, node, python, pip, pytest, ls, dir, WebSearch, WebFetch | Rules in Claude Code's syntax: `Bash(git:*)` allows any command starting with `git`, `WebSearch` a tool. Passed to Claude as `--allowedTools`, translated to Grok's `--allow` globs, ignored by Codex. The **Allow & retry** button in game appends rules here permanently. |
| `deniedTools` | `[]` | Rules the agent may never use, same syntax. Claude: `--disallowedTools`; Grok: `--deny`, which wins over everything, `bypassPermissions` included; ignored by Codex. |
| `model` | `""` | Passed to the CLI (`--model` / `-m`) when non-empty. Empty uses the CLI's default. |
| `reasoning` | `""` | Default effort for Claude and Antigravity (`--effort low\|medium\|high\|xhigh\|max`) or Codex (`-c model_reasoning_effort=\"<level>\"`, including `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`). Availability depends on the CLI and model. Empty leaves the CLI default; unsupported for Grok/Hermes. |
| `models` | `[]` | Additional model IDs shown in the in-game Model selector. The configured `model`, Claude aliases and live Codex/Antigravity catalogs are added automatically. Custom IDs remain available when discovery fails. |
| `path` | `""` | Full path to the executable. Empty means: look in the installer's folder, then (for Codex) `CODEX_BIN`, then `PATH`, then npm's launcher. A `.js` path is run with the bridge's Node. |
| `extraArgs` | `[]` | More command-line arguments, added verbatim (before Codex's `resume` subcommand). |
| `networkAccess` (codex only) | `false` | `true` lets commands inside Codex's `workspace-write` sandbox reach the network (`-c sandbox_workspace_write.network_access=true`). |

A `config.json` from before agents existed kept Claude's settings at the top level (`claudePath`, `model`, `permissionMode`, `allowedTools`). The bridge still reads them, under anything in `agents.claude`; `setup.js` moves them down.

The addon's **Defaults...** panel saves an agent/model/reasoning tuple in `WowieDB.settings.defaults`; **Save** applies it, **Cancel** discards edits, and **Bridge defaults → Save** clears it. Per-chat selectors take precedence, followed by addon defaults for that agent, these bridge settings, and finally CLI defaults. The addon sends resolved choices on both transports without changing `config.json`. New chats inherit the current chat's choices. Explicit model/effort selections override matching `extraArgs`; unrelated arguments remain. Default-agent changes preserve provider-specific chat overrides on their original agent. Clearing an override starts a fresh session when needed; pending requests, including resends after `/reload`, keep their original selection.

## Reading and workspace (addon)

`WowieDB.settings.replyFontSize` stores Small (13), Medium (14, default) or Large (16) reply text. **Settings → Reading** edits it with the same Save/Cancel behavior as assistant defaults. **Preview formatting** temporarily replaces Settings; Back preserves the unsaved draft. It is local-only and changes no chat or provider state. `WowieDB.settings.sidebarCollapsed` stores the **Chats** sidebar toggle. Existing window size, drafts and conversations are retained.

`ReplyView.lua` formats assistant messages into native selectable blocks. Raw transcripts stay unchanged. URLs open a copy box, not a browser; summaries and routine bridge notes are disclosures, while errors remain visible. This new module requires a full WoW restart after installation; `/reload` alone cannot discover it.

## Information sharing (addon)

Information-sharing choices live in `WowieDB.settings.sharing` (category ID → boolean); `WowieDB.settings.context` is the independent master switch. **Sharing → Recommended** permits useful ordinary built-ins, including action bars/keybinds, current interactions, travel, cached lockouts and optional Auctionator prices. **Minimal** selects only identity and location. Presets replace selections and leave private/advanced permissions off; opening the UI or upgrading does not overwrite existing explicit choices.

`WowieDB.settings.contextDelivery` is `"smart"` by default or `"full"`. Smart sends only small enabled identity/location/money data plus the enabled-source catalog; the AI requests other sections with `wowcontext` queries. Full includes selected snapshot providers with every question. Auctionator and advanced API namespaces are always query-only. Change delivery under **Customize**; it does not change permissions, pause state or a pending request's immutable snapshot.

Private/social scopes, raw UI/addon tables and advanced API namespaces default off. Macro bodies require `macros` consent, including advanced macro-body readers. Mail-body access separately requires `mail_body` consent because the game's read API marks messages as read. Pausing keeps selections; current queries recheck consent. Already-sent information cannot be recalled, and these controls do not restrict the CLI's host-file/tool permissions.

The `auctionator` category reads recognized active cached price tables without invoking scans, addon database methods or trading actions. Query up to 50 exact base item IDs, for example `{"op":"snapshot","category":"auctionator","itemIDs":[2592,2770]}`. Results use copper, with `minimumCopper` and raw scan-day histories. Database pages accept `limit` 1–100 and sequential `offset` values from `nextOffset`; no whole-database copy/sort is needed. Each history field has its own `complete`/`nextOffset`; fetch more with the same `itemIDs`, `historyOffset` and optional `historyLimit` 1–100. Start from zero and follow cursors sequentially; caches can change between reads. Unsupported/serialized caches are unavailable, not guessed prices. Optional-source availability never silently grants consent.

## Runs

| Key | Default | Meaning |
|---|---|---|
| `gameContext` | `true` | Allow selected short context, Smart/Full information envelopes and permission-gated addon queries. `false` excludes all of them from agent input and disables query requests. The addon also has its own Sharing master switch, presets and customization. |
| `primerFile` | `"docs/WOW-ADDON-PRIMER.md"` | A markdown file appended to the system prompt together with the game context, whatever folder the chat works in: how to write addons and macros for this client. Relative to the Wowie folder, or absolute. Re-read on every run, so edits count at once. `""` sends none. Off whenever the context is off. |
| `maxParallel` | `3` | How many chats may run an agent at the same time. Further messages queue per chat. |
| `timeoutMs` | `1800000` (30 min) | A run longer than this is killed (with its children) and reported as an error in game. |
| `progressWriteMs` | `3000` | Minimum gap between progress writes to the slot files. Final replies are written immediately. |
| `pollMs` | `750` | How often the bridge checks the SavedVariables file for a reload-path message. |

## Screen capture

Keys under `capture`:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Run `capture.ps1` (Windows), `capture_mac.py` (macOS), `capture_wayland.py` (Linux/Wayland) or `capture_x11.py` (Linux/X11). With `false` only the reload path works (`/wowie mode reload` in game). |
| `backend` | `"auto"` | Linux: `"auto"` uses direct Wayland capture when `WAYLAND_DISPLAY` is set or `XDG_SESSION_TYPE=wayland`, otherwise X11. `"wayland"` forces libwayland-client capture on a compatible compositor; `"x11"` forces libX11 and requires an X11/Xwayland game window. There is no portal fallback or automatic X11 fallback on Wayland failure. |
| `processName` | `"Wow"` | The game executable without `.exe`; also used to match Wayland app IDs. `setup.js` sets it from the `Wow*.exe` it finds in the client folder (on macOS, from the binary inside the `.app` bundle). On Windows the capture also skips a game running from a different client folder than `addonDir`, because retail's exe has the same name. Generic Steam/Faugus app IDs and Proton X11 classes are matched by the game's "World of Warcraft" title. |
| `cellPx` | `4` | Robust capture geometry. Decoders also discover 2-pixel Compact/Quiet and 4-pixel Quiet fallback; choose optional modes in the in-game Settings panel rather than changing this for appearance. |
| `cellsPerRow` | `200` | Cells per strip row. Must match the addon. |
| `maxRows` | `48` | Maximum strip rows captured. Must match the addon. |
| `intervalMs` | `50` | Capture period. The bridge advertises a frame period of at least twice this value, with a 100 ms floor; slower custom capture values are preserved. |
| `pacingVersion` | `1` | Installer migration marker. The old 250 ms default upgrades to 50 ms once; later explicit choices and pre-existing non-default rates are kept. |
| `python` | `"python3"` | Linux and macOS: capture interpreter. Wayland needs only Python's standard library and the system libwayland-client library. |
| `windowName` | `""` | Linux (X11 and Wayland) and macOS: find the game window by title substring instead of the default process/app-ID matching. |
| `keepComposited` | `false` | X11 only: set `_NET_WM_BYPASS_COMPOSITOR=2` on the game window so the compositor keeps drawing it. Try it if `npm run probe` sees a black or stale strip in borderless fullscreen. |

X11/Windows region capture covers `cellsPerRow × cellPx` by `maxRows × cellPx` pixels (800 × 192 by default), plus bounded alignment search. Direct Wayland capture automatically follows the current/new matching game window through a persistent connection and reusable native-resolution shared-memory buffer, without spawning a screenshot process per frame. It searches for the strip and caches verified geometry; `npm run probe` saves the whole game window to `bridge/probe.png`, or use `npm run probe -- output.png`. Optional 2-pixel modes fit inside the strip region. Profile discovery does not make clipped or checksum-failing frames valid. See [Linux installation](INSTALL-LINUX.md) for required compositor protocols and permission setup.

## Slot pool and signal files

These sizes are baked into the files `install-slots.js` creates, and the addon has matching constants at the top of `addon/Wowie/Wowie.lua` (`SLOT_COUNT`, `ACT_MAX`, `PRESENCE_MAX`). Change all three places together, re-run `node bridge/install-slots.js`, and restart the game.

| Key | Default | Meaning |
|---|---|---|
| `slots` | `200` | Reply-slot addons `Wowie_S001` … `Wowie_S200`. Each slot can be loaded once per UI session; `/reload` frees them all. |
| `actMax` | `60` | Heartbeat files per message (`act/NNN/01..60.wav`). One flips per agent action. |
| `presenceMax` | `2000` | Presence files (`presence/0001..2000.wav`). One flips per `presenceIntervalMs`. |
| `presenceIntervalMs` | `30000` | Publish fresh Inbox/all reply-slot timestamps and advance a presence WAV when available. Heartbeats retain the last hello ACK unchanged and never renew connection verification. |
| `tocInterface` | `"16001"` | `## Interface:` version written into every slot addon's `.toc`. Bump it when the client's TOC version changes. |

## Command line

`wowie` (after `npm link`) and `node bridge/bridge.js` take the same flags. `npm start` runs `bridge/supervisor.js`, which restarts the bridge on crash and passes flags through.

| Flag | Meaning |
|---|---|
| `--project <dir>` | Default working folder for this run. Overrides everything else. |
| `--once` | Handle one pending reload-path message and exit. |
| `--inject "<text>"` | Pretend the strip said this, run the agent, publish the result, exit. Handy for checking a setup without the game. |
| `--agent <id>` | Which agent `--inject` uses (default: `agent` from the config). |
| `--help`, `-h` | Print usage. |

Exit codes: `0` normal, `1` the injected or one-shot job failed, `2` config missing, unreadable or naming an unknown agent. The supervisor only restarts on codes other than `0` and `2`.

## Environment

| Variable | Meaning |
|---|---|
| `WOWIE_PROJECT` | Default working folder, below `--project` and above the start folder in precedence. |
| `CLAUDECODE` | Removed from Claude's environment so a bridge started from inside a Claude Code session can still launch `claude -p`. |
| `GROK_DISABLE_AUTOUPDATER` | Set to `1` for Grok runs, so a headless run never stops for an update. |
| `GROK_HOME` | Honoured when looking for `grok.exe` (`<GROK_HOME>\bin`); Grok's own setting. |
| `WOWIE_MAP_FILE` | Set by the bridge for each run, whatever the agent: a file where the agent's tools append map commands, one JSON object per line (see [MAP.md](MAP.md)). |

## Which folder the agent works in

Each chat can pick its own folder with `/wowie cd` or **Folder...** in the menu that opens when you right-click the chat in the left panel. Chats that have not are given the bridge's default folder, chosen in this order:

1. `--project <dir>`
2. `WOWIE_PROJECT`
3. The folder the bridge was started from, unless that is inside this repo
4. `defaultCwd` in `config.json`
5. The current folder

A relative `/wowie cd` path is resolved against that default. `~` expands to your home folder. The agents keep sessions per folder, so a chat that changes folder starts a fresh session there; the same happens when a chat changes agent.

## Files the bridge writes next to itself

All of these are gitignored.

| File | Contents |
|---|---|
| `bridge/config.json` | Your configuration. |
| `bridge/state.json` | Agent-session metadata, legacy nonce receipts, presence/map state and the latest selected **short** context. Durable recovery may restore session metadata from `requests.json`; deleting this file is not a safe execution reset. |
| `bridge/requests.json` | Fsynced request/result journal, generations, deletion markers, query batches, control receipts and restore offers. Active jobs include their permitted snapshots/continuations; terminal results discard those active payloads. Retains all unacknowledged results and the latest 200 terminal results per chat unless deleted, then keeps non-runnable tombstones for older acknowledged requests. Preserve this file to prevent duplicate external work. |
| `bridge/transcripts.json` | The last 200 chat messages per conversation. Internal information requests do not duplicate user turns or store the raw full snapshot; ordinary final answers remain in history. |
| `bridge/mapjobs/` | One map command file per running job (`WOWIE_MAP_FILE`), read and deleted when the job ends. Map layers themselves live in `state.json` (`map`). |
| `bridge/bridge.log` | Everything printed to the console, with timestamps. Grows without bound; delete it whenever you like. |
| `bridge/tmp/` | Prompt files for agents that read the prompt from disk (Grok). Each is deleted when its run ends. |

The bridge owns an exclusive localhost port derived from the canonical addon installation path. An occupied port fails closed (exit 2), including a rare collision with an unrelated service; it is not a network transport for the game. The guardian releases ownership after its child processes stop. Windows uses built-in Windows PowerShell and kernel Job Objects; no npm runtime dependencies are added.

## `setup.js` flags

| Flag | Meaning |
|---|---|
| `--wow "<client folder>"` | The folder containing `Wow*.exe` and `Interface\`, when auto-detection fails. |
| `--project "<dir>"` | Written to `defaultCwd`. Defaults to the folder you ran setup from. |
| `--account <name>` | Which `WTF\Account\<name>` to use when there are several. |

Re-running `setup.js` re-copies existing addon code (except the bridge-owned `Inbox.lua`), preserves custom configuration, and creates only missing slots/signals. For an installation from before the rename, stop the bridge and fully quit the client first; setup refuses live-client migration. It copies each account's saved globals into `Wowie.lua` without rewriting history text, preserves existing Wowie files, migrates generated sounds, enabled-addon choices and hotkey targets, and removes old addon folders only after new slot installation succeeds. Recovery copies are retained. The rename requires a full relaunch; later Lua-only updates can use `/reload`.
