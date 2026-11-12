# wow-ai

<p align="center">
  <img src="docs/screenshot.jpg" alt="The WoW AI chat window open in Goldshire, with a message on its way to a coding agent" width="900">
</p>

Chat with your local coding agents from inside **World of Warcraft: Forever**: [Claude Code](https://claude.com/claude-code), [OpenAI Codex](https://developers.openai.com/codex), [xAI's Grok Build](https://docs.x.ai/build/overview), Google's Antigravity CLI and Hermes Agent. Send a task, go back to questing, get pinged in-game when the answer lands. No alt-tabbing, no `/reload` per message.

- Multiple chats, each its own persistent agent session (like separate terminals), running in parallel. Each chat picks its agent, model, reasoning effort and folder
- Live progress while the agent works: action count, elapsed time, the files it's editing and commands it's running
- Replies echoed into the game chat; `/r` replies to the agent when it was the last to message you
- Choose what the AI knows through searchable Sharing checkboxes: gear, bags, spells, skills, quests and other addon-readable information, with opt-in native API queries
- The agent can mark your world map and track destinations on your map/minimap, with dotted routes through ShortestPathForever when enabled
- Herb and ore spawns on the world map, filtered by your gathering skill (`/wow-ai map ore`, `/wow-ai map herb`)
- Ready-made macros: ask for one and the reply carries a **Create macro** button that saves it and puts it on your cursor, ready to drop on an action bar (`/wow-ai macro undo` reverts it)
- An **Allow & retry** button when Claude or Grok needs a command outside your allowlist
- A status light for the bridge, automatic retries, and recovery of your chats (and map layers) if the beta client wipes addon data
- Runs on Windows, on Linux with the game under Wine, and on macOS with a native client

Nothing here injects code, reads game memory, or generates input. The addon uses documented addon APIs only; the companion reads your screen and writes ordinary files.

## How it works, in one paragraph

WoW addons are sandboxed: no network, no file reads at runtime. Two doors remain. **Out:** the addon draws your message as a strip of colored 4-pixel squares in the top-left corner of the screen; the bridge screen-captures that corner four times a second, decodes it, and runs the chat's agent headless in the chat's folder. **In:** a load-on-demand addon reads its files from disk at the moment it is loaded, so the bridge writes the reply into a pool of 200 pre-made slot addons and the game loads a fresh one from a timer. Cheap "is it ready yet" checks ride on a third trick: an empty `.wav` won't play and a valid one will. Map layers travel the same way: the agent's tools hand them to the bridge, which keeps them versioned and ships them inside the slot files. Details in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/MAP.md](docs/MAP.md).

## Curseforge
Official curseforge addon page: https://www.curseforge.com/wow/addons/ai-agents-chat

## Agents

The bridge drives whichever of these you have installed; each chat can use a different one.

| Agent | CLI the bridge runs | Permissions | Allow & retry |
|---|---|---|---|
| **Claude Code** (`claude`) | `claude -p --output-format stream-json`, resumed with `--resume` | `permissionMode` + `allowedTools` rules | yes |
| **Codex** (`codex`) | `codex exec --json`, resumed with `codex exec resume` | a sandbox chosen from `permissionMode` (read-only, workspace-write, or none) | no: a command the sandbox declined is reported in the reply |
| **Grok Build** (`grok`) | `grok --prompt-file … --output-format streaming-json`, resumed with `-r` | `permissionMode` + the same `allowedTools` rules, translated to Grok's globs | yes, when Grok reports a refused tool |
| **Antigravity** (`agy`) | `agy -p=<prompt> --output-format stream-json`, resumed with `--conversation` | Antigravity permission switches | no |
| **Hermes** (`hermes`) | `hermes chat --query-file -`, resumed with `--resume` | default only; the bridge never uses `--yolo` | no |

`agent` in `bridge/config.json` is the default (`claude`). Use the **Agent** selector in the discussion header to switch the current chat, or `/wow-ai agent codex` / **Agent...** in its conversation menu. **Model** and **Reasoning** beside it configure the next message. Reply bubbles and game-chat echo identify whoever answered. Changing agent starts a fresh session while keeping the transcript. Install notes, CLI switches and limits are in [docs/AGENTS.md](docs/AGENTS.md).

## Requirements

- Windows (NTFS), or Linux with the game using Wine/Proton's X11 backend on **X11 or Xwayland** and python3 (see [docs/INSTALL-LINUX.md](docs/INSTALL-LINUX.md)), or macOS with a native client and python3
- World of Warcraft: Forever (tested on 1.60.1.69913 and 1.60.1.69977, TOC 16001), **windowed or borderless** (exclusive fullscreen blocks screen capture)
- [Node.js](https://nodejs.org) 22.2 or newer
- At least one agent CLI, installed and logged in:
  - [Claude Code](https://claude.com/claude-code): `claude --version` works
  - [Codex](https://developers.openai.com/codex): `npm install -g @openai/codex`, then `codex` once to log in
  - [Grok Build](https://docs.x.ai/build/overview): `irm https://x.ai/cli/install.ps1 | iex`, then `grok login`
  - Antigravity (`agy`): install Google's Antigravity CLI, then run `agy` once to log in
  - Hermes Agent (`hermes`): install it, then run `hermes setup` once

## Install

### Windows

Step-by-step for a fresh machine, with troubleshooting: [docs/INSTALL-WINDOWS.md](docs/INSTALL-WINDOWS.md). The short version:

```powershell
git clone https://github.com/chelinho139/wow-ai
cd wow-ai
node setup.js --project "C:\path\to\the\project\you\want\to\work\on"
```

`setup.js` finds the client (pass `--wow "<client folder>"` if it can't), copies the addon into `Interface\AddOns\WoWAI`, writes `bridge/config.json`, reports which agent CLIs it found, and generates the slot pool and signal files (≈15,000 tiny files; that's normal — the client only discovers addon files at launch, so they have to exist up front).

Then **fully quit and relaunch WoW**, enable *WoW AI* on the AddOns screen, and start the bridge:

```
npm start               # in the current terminal (or: bridge\start.ps1)
bridge\start-window.cmd # double-click version: opens its own window
```

It restarts itself if it ever crashes. Ctrl+C (or closing the window) stops it. The banner lists every agent with where its executable was found, or what to install.

### Linux (Wine)

Details and capture troubleshooting: [docs/INSTALL-LINUX.md](docs/INSTALL-LINUX.md). The short version:

```bash
git clone https://github.com/chelinho139/wow-ai
cd wow-ai
node setup.js --project ~/path/to/the/project   # finds the client in $WINEPREFIX, ~/.wine...; or pass --wow "<client folder>"
npm start
```

The bridge captures the game window through X11/Xwayland (`bridge/capture_x11.py`, no packages needed), including clients launched through Proton runtimes such as Steam, umu-launcher and Faugus, and writes the slot files straight into the Wine prefix. Check the capture once: send any message from the game and, while the strip of colored squares is in the top-left corner, run `npm run probe` in a second terminal. It saves what the capture sees to `bridge/probe.png` and says whether it decoded the strip.

### macOS (native client)

Same commands as Linux: `node setup.js --project <dir>` (it looks for the client under `/Applications/World of Warcraft` and `~/Applications/World of Warcraft`; pass `--wow "<client folder>"` otherwise), then `npm start`. The bridge captures the game window with `bridge/capture_mac.py`, which needs only python3: it finds the window through System Events and grabs its top-left corner with the built-in `screencapture`. The first run asks for two permissions in System Settings, **Automation** (System Events) and **Screen Recording**, for the terminal the bridge runs in. `npm run probe:mac` saves what the capture sees to `bridge/probe.png` and says whether it decoded the strip.

### Moving from the beta to the Forever release

The release client lives in `_forever_` and its exe is `Wow.exe` (the beta's were `_classic_beta_` and `WowB.exe`). An install from the beta needs one step:

```
git pull
node setup.js
```

It moves `bridge/config.json` to `_forever_` (the paths and the process name; your other settings stay) and installs the addon and its slots there. It works before your first login, so you can do it ahead of launch. The beta folder is left alone.

Then fully quit and relaunch the game, and enable "WoW AI" at the character select AddOns screen. Your chats come back from the bridge's `transcripts.json` the first time the addon talks to it.

### Upgrading from wow-claude

This project used to be called wow-claude, with a `WoWClaude` addon and a `/wow-claude` command. `git pull` (or clone the new name) and run `node setup.js` again: it copies your chats and settings from the old addon's saved data, removes the old `WoWClaude` addon and its slot folders so the two don't fight over `/ai` and `/r`, and rewrites the paths and the Claude settings in `bridge/config.json` into the new layout. Then quit and relaunch WoW. If you had installed the command, run `npm unlink -g wow-claude` and `npm link` again, and re-do `/wow-ai bind <key>` if you had a hotkey. Your agent sessions carry on: the bridge keeps them per chat.

### `wow-ai`: start it from the project folder

Like the agent CLIs themselves, the bridge works in the folder you start it from. Install the command once:

```powershell
npm link          # in the wow-ai folder; makes `wow-ai` available everywhere
```

Then, from any project:

```powershell
cd C:\path\to\realms
wow-ai
```

Every chat that hasn't picked its own folder now works in `realms`, and the workspace header shows it. `wow-ai --project <dir>` names the folder explicitly; `npm start` inside this repo falls back to `defaultCwd` in the config. Only one bridge can run at a time (two would fight over the screen and the slot files), so this sets the default folder rather than giving you one bridge per project.

## Use

In game, `/wow-ai` opens the wow-ai workspace. Its header shows a labeled connection state; **Connect** appears beside the composer until the bridge answers. Start the bridge and click Connect. Messages written before connection stay in the box. **Connection...** holds reconnect, check/retry and reload recovery actions instead of crowding the main toolbar.

The **Conversations** sidebar is searchable and scrollable. Click **New chat**, choose a conversation, or open its visible **...** menu (right-click also works) for rename, working folder, agent, copy, clear transcript, fresh agent session and delete actions. Destructive menu actions ask for confirmation. Each chat retains its own project, agent choices, transcript and multiline draft.

The compact **Agent**, **Model** and **Reasoning** selectors in the discussion header configure the **next message** in this chat. Pickers are searchable, include inherited values, and still offer a custom model ID. Model choices include configured IDs, Claude aliases, and live Codex/Antigravity catalogs; unsupported reasoning controls are disabled. Changing agent clears its model/effort overrides. Already-pending requests and resends keep their original settings.

The discussion takes most of the window, with a compact multiline composer below it. **Enter** sends, **Shift+Enter** inserts a newline, and **Esc** releases keyboard focus without discarding a draft. One bottom action row separates connection recovery, status, **Cancel wait**, and Send/Connect/**Check reply**, including while disconnected with a pending request. Checking a reply keeps the next-message draft; cancel stops local waiting, not the external agent. Reading older messages does not snap to the bottom; **Latest** in the header returns to the newest reply without covering discussion text. The minimized bar retains its **Open** button and unread/working state.

Click **Settings** for addon-wide agent/model/reasoning defaults, then **Save**. **Cancel** discards edits; **Use bridge defaults**, then Save, removes addon overrides. These choices survive `/reload` and logout in `WoWAIDB`, without editing `bridge/config.json`. Precedence remains **per-chat choice → addon default for the same agent → bridge config → CLI default**. Clearing a model/effort override starts a fresh session when necessary so a resumed CLI cannot retain it. This redesign changes only wow-ai's own windows; WoW's game UI, maps and other addons are unchanged.

| Command | What it does |
|---|---|
| `/wow-ai` | toggle the window (`/ai`, `/wowai` and the old `/wow-claude` are the same command); the minimize button (top right) or Esc collapses it to a small bar, click the bar to expand |
| `/ai <text>` | send from the normal chat box (`/wow-ai <text>` is the same). `/ai` is a full alias, so `/ai agent grok` or `/ai cd realms` work too; a message that merely starts with a command word, like `/ai help me with this macro` or `/ai delete the unused imports`, is still sent as a message because the rest of the line doesn't fit that command |
| `/r <text>` | replies to the agent when it was the last to message you; otherwise the normal whisper reply |
| `/wow-ai new [name]` | new chat = new agent session. Unnamed chats take their title from your first message |
| `/wow-ai chat <n\|name>` | switch chats (or choose one in Conversations; its **...** menu exposes chat actions) |
| `/wow-ai agent [claude\|codex\|grok\|agy\|hermes]` | which agent this chat talks to; no name shows the current one, `default` uses the saved addon default (or the bridge's when unset). Changing agent starts a fresh session |
| `/wow-ai cd <folder>` | folder this chat's agent works in (**Folder...** after right-clicking the chat opens the same thing as a dialog). Relative to the bridge's folder (`/wow-ai cd realms`, `/wow-ai cd ../other`), `~` works, a full path too; `/wow-ai cd` alone goes back to the bridge's default. A chat that changes folder starts a fresh session there |
| `/wow-ai reset` | wipe this chat's agent memory, keep the transcript |
| `/wow-ai context [on\|off]` | show the selected short summary or pause/resume sharing; **Sharing...** controls individual information categories |
| `/wow-ai rename`, `/wow-ai delete`, `/wow-ai clear` | manage the current chat |
| `/wow-ai echo summary\|full\|short\|off\|<chars>` | how much of each reply to print into the game chat. `summary` (the default) prints only the agent's closing TL;DR lines, the full reply is in the window behind `[open]`; `full` prints up to 4000 chars, `short` one preview line |
| `/wow-ai longchat on` | let the game chat box take 4000 characters, for long `/ai` messages |
| `/wow-ai bind <key>` | hotkey: checks for a reply while waiting, otherwise toggles the window |
| `/wow-ai cancel` | stop waiting on this chat's reply |
| `/wow-ai resend` | show the strip again if the bridge missed it |
| `/wow-ai reload` | reload the UI now (also frees the slot pool) |
| `/wow-ai mode reload` | fallback transport that costs a `/reload` per step, if pixels or slots can't work |
| `/wow-ai diag`, `/wow-ai slots` | transport diagnostics |
| `/wow-ai help` | the full list |

Drag-select text directly inside a message and press **Ctrl+C**; no copy dialog is required. Message text is read-only, retains literal text/indentation, and stays selected across unchanged redraws. **Esc** releases message focus. Optional **Copy latest reply** in the chat menu and `/wow-ai copy` still open the separate whole-reply copy box. Drag the window by its header, not by discussion text.

### Short in the chat, full in the window

Every run tells the agent that only a short summary of its reply is printed in the game chat, and asks it to end each reply with a `TL;DR:` block of one or two lines. The bridge splits that block off and the addon prints just those lines under `[Claude · chat]`, with the `[open]` link to the whole reply in the window (the window keeps the full text, TL;DR included). When an agent forgets the block, the first two lines of the reply are printed instead, with a hint to open the rest. `/wow-ai echo full` goes back to printing the whole reply.

### Choose what the AI knows

Click **Sharing** in the workspace header. **Character**, **Private / Social**, **Advanced API** and **Selected** views organize the 26 built-in categories and native API scopes discovered from your client; search filters the current view. Checkmarks and counts update immediately, and large catalogs reuse only visible rows. The master **Sharing on / paused** control pauses access without erasing your editable choices. **Common defaults** restores conservative choices; **Clear choices** removes every selected scope, including saved API scopes that are not currently available. Permissions save immediately—there is no separate Save action.

| Information | Default | Availability |
|---|---|---|
| Identity, location, money, gear, carried items, player/pet spellbooks, professions/skills, talents and quests | On | Fresh snapshot with each question; uncached item details and unsupported APIs are explicit |
| Reputation, auras, pet state, combat stats, currencies, achievements and collections | Off | Where the client exposes them |
| Target/focus, party/raid, bank, mail, chat, guild, friends/Battle.net, UI and addon/global tables | Off | Sensitive/broad scopes; bank and mail require their windows open |
| Mail message bodies | Off | Separate explicit consent: reading loaded messages marks them as read |
| Advanced `api:<namespace>` scopes | Off | Permission-gated documented getters, queried only when the AI needs more data |

Checked snapshot data accompanies your message and can reach the selected AI provider. The agent can request additional read-only data, and the addon checks the **current** permissions before reading it. Broad API/UI/addon permissions can overlap snapshot categories; their descriptions explain this. These controls govern the addon information channel, not the coding agent's separate host-file/tool permissions. No arbitrary Lua, setters, sending/deleting mail, movement or protected gameplay actions are exposed through addon queries. Closed-window, restricted, secret and unsupported values are reported as unavailable rather than guessed.

Large snapshots are transferred across multiple pixel frames instead of being clipped to the short character summary. Updated bridges negotiate native zlib compression plus base64 and larger fragments; clients without native compression use plain base64. This is lossless: all selected information still arrives, and the capture cadence is unchanged. Short summaries reuse the same captured values instead of reading providers twice. API results support explicit pagination and nested paths.

More snapshot categories still increase the AI's prompt size and processing time: transport compression does not reduce model tokens. For lower latency, choose a lower **Reasoning** setting or a faster **Model** in the UI. Snapshots over 4 MiB require fewer snapshot categories or paginated queries. **Changes affect future snapshots and current queries; already-sent information cannot be recalled.** Manually shift-clicked links still share their tooltip as part of your explicit message.

`/wow-ai context` shows the short selected summary; `/wow-ai context off` pauses snapshot/query sharing, and `gameContext: false` disables it at the bridge. The pixel path needs no reload per query. The reload fallback stores pending snapshots/results in SavedVariables and uses its normal hardware-event reload cycle.

Update both bridge and addon together. A first install of the Sharing panel needs a **full WoW restart**, because it adds Lua files; later Lua-only updates need a bridge restart and `/reload`. Requests carry immutable identities so a rolled-back saved counter cannot silently discard a new question. Pending pre-nonce questions migrate automatically on reload, preserving their original data and selections; do not retype them just to resume the transfer.

Along with it, every run gets [docs/WOW-ADDON-PRIMER.md](docs/WOW-ADDON-PRIMER.md): a short reference on writing addons and macros for this client (TOC layout, sandbox rules, common frames and events, where to verify an API), so "write me an addon that..." works from any folder, not just this repo. Edit the file to suit your setup; the bridge re-reads it on every run. `"primerFile": ""` in the config drops it, and `/wow-ai context off` turns it off together with the character context.

### Link items, spells and quests

Click the input box, then **shift-click** an item in your bags, a spell in the spellbook, a quest in the log, or a link in the chat: it lands in your message the way it would in the game chat. When you send, each link becomes `[Name]` in the text and its tooltip (an item's stats, a spell's description) is attached below, so the agent sees what you see when hovering it. This works from the game chat box too (`/ai is this an upgrade? [Fine Longsword]`). Without a box focused, shift-click keeps its normal meaning.

### Macros, ready to use

Ask for a macro (*"a Charge macro that uses Intercept in combat"*, *"a mouseover heal"*) and the reply comes with a **Create macro: <name>** button under it. A click saves it (an account macro, or a character one if the agent says so) and puts it on your cursor: click an action bar slot to place it. It is also in `/macro` as usual.

- A macro with that name already there? The button says **Update**, and it asks before replacing a different one of yours. `/wow-ai macro undo` brings back what was there (or removes the macro the button created).
- Macros that run code (`/run`, `/script`, `/click`) are marked on the button and ask before being saved.
- Nothing is saved in combat, and the addon never runs a macro: only your own click on the bar does.

The agent writes each macro in a ```` ```wowmacro <Name> ```` block (optional `icon=` and `scope=character` after the name); the bridge checks the game's limits (name up to 16 characters, text up to 255 bytes) and keeps a readable copy in the reply. The buttons live with the message in the addon's saved data, so they don't come back after the beta wipes it (the macro text does).

### Map, routes and gathering nodes

The agent can draw on your world map. Ask *"route me through copper and tin around here"*, *"plan the quests I can do in Westfall"* or *"where is the nearest mining trainer?"*, and the answer arrives with:

- **Layers on the world map:** numbered pins joined by lines for routes, and pins for quest givers, objectives, turn-ins, trainers, dungeon entrances or any mark. They show on the zone map and on the continent map; hover a pin for its label, click it to navigate there.
- **Tracked destinations:** the active stop goes to the game's map/minimap waypoint tracking, not a standalone compass. With ShortestPathForever enabled, its routing API draws your configured route dots and terrain-aware path; OpenMap follows the native waypoint. New/changed routes and single destinations activate without opening the map unless another route is active. Use `/aimap nav <layer>` for a saved mark, and `next`, `prev` or `stop` to control it. Player-selected pins and quests keep priority when tracking is stopped or replaced.
- **Herb and ore spawns:** with an optional `WoWAI_Nodes` data addon installed, every gathering spawn point of the zone you are looking at, filtered to what your skill can gather.

The system prompt tells every agent how to hand marks to the bridge: append commands to the file named in `WOW_AI_MAP_FILE` (set for every run), or end the reply with a small ```` ```wowmap ```` block. The bridge validates the marks, keeps them in `state.json` and ships them to the game, so they survive a UI reload and the beta's saved-data wipes. Where the agent gets its coordinates from is up to the folder the chat works in: [docs/MAP.md](docs/MAP.md) describes the command format and how to feed it game data.

| Command | What it does |
|---|---|
| `/wow-ai map` | list the layers, navigation and node settings |
| `/wow-ai map ore [on\|off]`, `/wow-ai map herb [on\|off]` | show or hide mining / herbalism spawns on the world map |
| `/wow-ai map filter all\|skill` | every spawn, or only what your skill can gather (default) |
| `/wow-ai map hide <layer>`, `/wow-ai map show <layer>` | hide or show one of the agent's layers |
| `/wow-ai map nav <layer> [n]`, `next`, `prev`, `stop` | track a destination or control the owned map route |

`/aimap` is a shorter alias. To remove layers for good, ask the agent ("clear the map", "remove the mining route").

### Permissions

The agents run headless, so they can't ask you to approve a tool. Each agent's block in `bridge/config.json` has a `permissionMode`, `acceptEdits` by default: file edits inside the project are auto-approved, `allowedTools` lists the commands it may run (`Bash(git:*)` is any command starting with `git`; the same rule syntax for every agent, translated for Grok), and `deniedTools` the ones it never may. What happens to anything else differs. Claude denies it. Codex has no allowlist: it runs commands in a sandbox that can write the project folder but not reach the network (unless `networkAccess` is on), and explains a blocked command in its reply. Grok's headless mode runs ordinary commands on its own and blocks the dangerous ones (deleting a project file, pushing) unless a rule allows them. With Claude and Grok the reply then grows an **Allow WebSearch, Bash(cargo:*) & retry** button: click it, the rules are added to that agent's list in your config permanently, and the agent resumes where it stopped. The rule is a prefix (`Bash(rm:*)` allows any `rm`), so read the button before clicking. `bypassPermissions` gives any agent full autonomy; you decide. The mapping per agent, as measured against the real CLIs, is in [docs/AGENTS.md](docs/AGENTS.md).

## Configuration (`bridge/config.json`)

The keys you are most likely to touch. Every key, flag and environment variable is in [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

| Key | Meaning |
|---|---|
| `defaultCwd` | folder for chats that haven't been given one with `/wow-ai cd` |
| `agent` | the agent for chats that haven't picked one with `/wow-ai agent` (`claude`, `codex`, `grok`, `agy` or `hermes`) |
| `agents.<id>.permissionMode`, `.allowedTools`, `.deniedTools`, `.model` | that agent's permissions, allowlist, denylist and model; `.path` where its executable is if the bridge can't find it, `.extraArgs` anything else to pass it |
| `agents.<id>.reasoning`, `.models` | default reasoning effort for Claude/Codex/Antigravity; optional model IDs to add to the in-game picker |
| `agents.codex.networkAccess` | let Codex's sandbox reach the network (default `false`) |
| `maxParallel` | how many chats may run an agent at once (default 3) |
| `gameContext` | `false` never tells the agent about your character, whatever the addon sends (default `true`) |
| `primerFile` | the addon/macro primer appended with the context (default `docs/WOW-ADDON-PRIMER.md`; `""` = none) |
| `capture.processName` | the game exe without `.exe` (`Wow` for Forever); set by `setup.js` |
| `capture.keepComposited`, `capture.windowName` | Linux: keep the compositor drawing the game window (if the probe sees black), or find the window by title |
| `slots`, `actMax`, `presenceMax` | pool sizes; must match the constants at the top of `WoWAI.lua` if you change them |
| `timeoutMs` | kill a run that takes longer than this (default 30 min) |

## Troubleshooting

- **Connect says "No answer from the bridge" / light stays red** — is the bridge running? Is the game window on screen and not minimized? Exclusive fullscreen blocks capture. `bridge.log` shows `strip #N` when a message is decoded and `strip seen but rejected: ...` when one is misread.
- **Linux: `bridge.log` keeps saying `waiting for Wow window`** — the game isn't running or its window has another name: set `capture.processName` to the exe name, or `capture.windowName` to part of the window title. On Wayland, the game must use Wine/Proton's X11 backend (Xwayland); Wine's native Wayland windows cannot be captured.
- **Linux: `npm run probe` shows a black or stale picture** — the compositor is letting the game present on its own. Try `"keepComposited": true` under `capture`, then windowed mode, then `nvidia-settings -a AllowFlipping=0` on NVIDIA; `/wow-ai mode reload` works without any capture.
- **No herb/ore pins after `/wow-ai map ore`** — `/wow-ai map` says whether the `WoWAI_Nodes` data addon is installed; pins show on zone maps only, and with `filter skill` only what your skill can gather.
- **The reply says "X is not installed on the bridge PC"** — the bridge's banner shows where it looked for each agent. Install the CLI, or put the full path of its executable in `agents.<id>.path` in `bridge/config.json` and restart the bridge.
- **A reply says the agent is not logged in, or asks for a login** — run the CLI once by hand on the bridge PC (`claude`, `codex`, or `grok login`) and log in; the bridge reuses that.
- **Reply never appears but `bridge.log` says `done`** — `/wow-ai slots`; if the pool is empty, `/wow-ai reload` frees it and picks the reply up via the fallback path.
- **"Reply slots not installed"** — `node bridge/install-slots.js`, then restart WoW.
- **Chats vanished after a reload** — the beta client sometimes wipes addon saved data. The bridge keeps `transcripts.json` and sends your chats back automatically on the next message.
- **`/wow-ai diag` says the sound channel is unusable** — the cheap readiness checks and heartbeat are off; everything still works through slot polls, just with coarser progress. If it says a valid file reports as unplayable, WoW hasn't been restarted since the files were created.

## Documentation

- [docs/INSTALL-WINDOWS.md](docs/INSTALL-WINDOWS.md): step-by-step install on a fresh machine, with troubleshooting
- [docs/AGENTS.md](docs/AGENTS.md): each agent's install, how the bridge drives it, permissions per agent, limits, and how to add another
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md): every config key, command-line flag and environment variable
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the pixel strip, slot pool and signal files work, and why
- [docs/INSTALL-LINUX.md](docs/INSTALL-LINUX.md): Linux + Wine install, and how to check the screen capture
- [docs/MAP.md](docs/MAP.md): map layers, tracked destinations and herb/ore nodes
- [CONTRIBUTING.md](CONTRIBUTING.md): repo layout, running the tests, conventions
- [CHANGELOG.md](CHANGELOG.md): release notes

## Development

```
npm install
npm test          # everything except the live test; CI runs it on Windows (.github/workflows/test.yml), and it runs on Linux and macOS too
npm run test:live # runs the bridge in a sandbox with a real agent call (add -- --agent codex or grok)
```

Layout: `addon/WoWAI` is the addon (`WoWAI.lua` the chat and transport, `Map.lua` the map layers, tracked destinations and nodes), `bridge/` the companion (`bridge.js` does I/O and processes, `protocol.js` is the pure part, `agents.js` knows how to launch and read each agent, `capture.ps1` / `capture_x11.py` the screen capture per platform), `docs/` the design and reference, `tests/` the checks (`map_test.js` and `map_addon_test.js` cover the map protocol and `Map.lua` in a Lua VM). After editing the addon, copy it into the game folder (`node setup.js` does that too) and `/reload`. What each test covers, and the conventions for changes, are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Credits

- [0xInuarashi's wow-forever-codex](https://github.com/0xinuarashi/wow-forever-codex) measured the client's file-loading rules on a live Forever build (files must exist at launch; a not-yet-loaded file is read fresh on first use) and pioneered the pixel-out channel for Codex, with a font-metrics return channel. This project uses the same rules with load-on-demand addons instead of fonts.
- [Gethe/wow-ui-source](https://github.com/Gethe/wow-ui-source) — Blizzard's UI code, `forever` branch, used to verify every API this addon calls.
- [Questie](https://github.com/Questie/Questie) and [QuestieDB](https://github.com/Questie/QuestieDB) documented how Forever's maps work (Classic uiMapIDs, re-projected zones), which the map layer relies on.

## License

MIT — see [LICENSE](LICENSE).
