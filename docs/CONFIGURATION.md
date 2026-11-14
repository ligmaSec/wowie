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

Information-sharing choices live separately in `WowieDB.settings.sharing` (category ID → boolean); `WowieDB.settings.context` is the master switch. Common character categories default on, sensitive/broad data and `api:<namespace>` scopes default off. Pausing the master preserves choices. Scope descriptions disclose overlap and window dependencies. Mail-body access has an additional explicit default-off permission because the game's read API marks messages as read. Snapshots reflect permissions when the question was sent; additional queries check current permissions. Already-sent data cannot be recalled, and these controls do not change the agent CLI's host-file/tool permissions.

## Runs

| Key | Default | Meaning |
|---|---|---|
| `gameContext` | `true` | Allow the selected short context, full information snapshots and permission-gated addon queries. `false` excludes all of them from agent input and disables query requests. The addon also has a master switch and individual **Sharing...** checkboxes. |
| `primerFile` | `"docs/WOW-ADDON-PRIMER.md"` | A markdown file appended to the system prompt together with the game context, whatever folder the chat works in: how to write addons and macros for this client. Relative to the Wowie folder, or absolute. Re-read on every run, so edits count at once. `""` sends none. Off whenever the context is off. |
| `maxParallel` | `3` | How many chats may run an agent at the same time. Further messages queue per chat. |
| `timeoutMs` | `1800000` (30 min) | A run longer than this is killed (with its children) and reported as an error in game. |
| `progressWriteMs` | `3000` | Minimum gap between progress writes to the slot files. Final replies are written immediately. |
| `pollMs` | `750` | How often the bridge checks the SavedVariables file for a reload-path message. |

## Screen capture

Keys under `capture`:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Run `capture.ps1` (Windows), `capture_mac.py` (macOS) or `capture_x11.py` (Linux). With `false` only the reload path works (`/wowie mode reload` in game). |
| `processName` | `"Wow"` | The game executable without `.exe`. `setup.js` sets it from the `Wow*.exe` it finds in the client folder (on macOS, from the binary inside the `.app` bundle). On Windows the capture also skips a game running from a different client folder than `addonDir`, because retail's exe has the same name. Proton runtimes (Steam, umu-launcher, Faugus) ignore it: they set `WM_CLASS` to `steam_app_<appid>` for every window in the prefix, and the Linux capture matches the client by its "World of Warcraft" title instead. |
| `cellPx` | `4` | Robust capture geometry. Decoders also discover 2-pixel Compact/Quiet and 4-pixel Quiet fallback; choose optional modes in the in-game Settings panel rather than changing this for appearance. |
| `cellsPerRow` | `200` | Cells per strip row. Must match the addon. |
| `maxRows` | `48` | Maximum strip rows captured. Must match the addon. |
| `intervalMs` | `50` | Capture period. The bridge advertises a frame period of at least twice this value, with a 100 ms floor; slower custom capture values are preserved. |
| `pacingVersion` | `1` | Installer migration marker. The old 250 ms default upgrades to 50 ms once; later explicit choices and pre-existing non-default rates are kept. |
| `python` | `"python3"` | Linux and macOS: interpreter for `capture_x11.py` / `capture_mac.py`. |
| `windowName` | `""` | Linux and macOS: find the game window by title substring instead of by process name (on Linux, by WM_CLASS `<processName>.exe`, or by the game title for Proton's `steam_app_<appid>` windows). |
| `keepComposited` | `false` | Linux: set `_NET_WM_BYPASS_COMPOSITOR=2` on the game window so the compositor keeps drawing it. Try it if `npm run probe` sees a black or stale strip in borderless fullscreen. |

The capture region covers `cellsPerRow × cellPx` by `maxRows × cellPx` pixels (800 × 192 by default), plus the backend's bounded alignment search. Optional 2-pixel modes fit inside that region. Profile discovery does not make clipped or checksum-failing frames valid.

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
| `bridge/state.json` | Agent sessions, handled message IDs, presence/map state and the latest selected **short** context. Full snapshots/query results are held for the active job, not copied here. Delete it to forget all sessions. |
| `bridge/transcripts.json` | The last 200 chat messages per conversation. Internal information requests do not duplicate user turns or store the raw full snapshot; ordinary final answers remain in history. |
| `bridge/mapjobs/` | One map command file per running job (`WOWIE_MAP_FILE`), read and deleted when the job ends. Map layers themselves live in `state.json` (`map`). |
| `bridge/bridge.log` | Everything printed to the console, with timestamps. Grows without bound; delete it whenever you like. |
| `bridge/tmp/` | Prompt files for agents that read the prompt from disk (Grok). Each is deleted when its run ends. |

## `setup.js` flags

| Flag | Meaning |
|---|---|
| `--wow "<client folder>"` | The folder containing `Wow*.exe` and `Interface\`, when auto-detection fails. |
| `--project "<dir>"` | Written to `defaultCwd`. Defaults to the folder you ran setup from. |
| `--account <name>` | Which `WTF\Account\<name>` to use when there are several. |

Re-running `setup.js` re-copies existing addon code (except the bridge-owned `Inbox.lua`), preserves custom configuration, and creates only missing slots/signals. For an installation from before the rename, stop the bridge and fully quit the client first; setup refuses live-client migration. It copies each account's saved globals into `Wowie.lua` without rewriting history text, preserves existing Wowie files, migrates generated sounds, enabled-addon choices and hotkey targets, and removes old addon folders only after new slot installation succeeds. Recovery copies are retained. The rename requires a full relaunch; later Lua-only updates can use `/reload`.
