# Wowie

**An in-game AI chat assistant for World of Warcraft: Forever.**

Ask questions about your character, items, spells, professions or quests without leaving the game. Wowie connects an addon chat window to an AI CLI on your computer, with checkboxes controlling which addon-readable information accompanies your questions.

> **A chat companion, not an autopilot.** Wowie is intended for conversation, explanations and read-only character context—not botting, unattended play or gaining an unfair advantage. You remain in control of your character and every gameplay action.

Wowie is an independently maintained fork with its own interface and workflow. It builds on the original project's chat and bridge foundation; see [Credits](#credits) for attribution.

## Interface

<p align="center">
  <img src="docs/screenshots/wowie-chat.png" alt="Wowie chat window with conversations, agent, model and reasoning selectors, and Sharing, Navigation and Settings controls" width="1000">
</p>

*Local folder path blurred.*

## Purpose and boundaries

**The assistant reads character information; it does not control your character.** The addon's information-query channel exposes permission-gated data readers, not arbitrary Lua execution or gameplay commands.

- **No automated gameplay:** the addon does not move your character, cast spells, execute combat rotations, gather resources, trade or complete quests for you.
- **No injected game code or game-memory inspection:** communication uses addon-visible pixels and ordinary addon files, not a process hook or generated keyboard/mouse input.
- **No privileged game knowledge:** queries are limited to what the client's addon APIs and permitted addon data expose. Restricted, unavailable and unsupported values are reported as such.
- **Visible UI conveniences, not character control:** map annotations and waypoint tracking update your map UI. Optional macro buttons save a draft only when you click them; Wowie does not execute the macro.

Local AI CLIs have their own computer-side permissions, separate from character sharing; see [Agent permissions](#agent-permissions). The read-only information channel is not a sandbox for those tools.

This intended use is not a guarantee that a particular server permits external AI tools. Wowie is unofficial and makes no claim of server approval or ban immunity.

## The Wowie experience

- **Chat-first workspace:** a black-and-gold interface, searchable conversations, a large discussion area, directly selectable replies and persistent per-chat drafts.
- **Agent, model and reasoning controls:** choose them in the discussion header, or save addon-wide defaults in **Settings**. Each conversation keeps its own session and overrides.
- **Explicit character sharing:** searchable checkboxes for gear, bags, spellbooks, professions, talents, quests and other available information. Private/social and advanced scopes are opt-in.
- **Integrated navigation:** search saved destinations, add or delete points, show them on the map and manage route stops from **Navigation**, without typing layer names.
- **Bridge verification and recovery:** fresh round-trip checks, delivery acknowledgements, persistent transcripts and clearer idle/error states.
- **Less intrusive transport options:** **Robust**, **Compact** and **Quiet** pixel displays, with calibration before a smaller or dark display is enabled.

Supported agents are **Claude Code**, **OpenAI Codex**, **Grok Build**, **Antigravity CLI** and **Hermes Agent**. Model and reasoning options depend on the selected CLI and its capabilities. Installation, authentication and provider-specific limits are documented in [Agents](docs/AGENTS.md).

## Getting started

### Requirements

- **World of Warcraft: Forever**, windowed or borderless. Tested builds include 1.60.1.69913 and 1.60.1.69977, TOC 16001; compatibility with other clients is not implied.
- **Node.js 22.2 or newer**.
- At least one supported AI CLI, installed and authenticated on the bridge computer. Its normal provider/account requirements still apply.
- A supported capture environment:
  - **Windows:** NTFS.
  - **Linux:** Python 3 and Wine/Proton using **X11 or Xwayland**. Native Wine Wayland windows are not supported by the X11 capture helper.
  - **macOS:** Python 3 and a native game client, with Automation and Screen Recording permission for the terminal running the bridge.

The bridge runs locally; the selected AI CLI may send prompts to an external provider. “Local bridge” does not mean “local model.”

### Install and launch

1. **Fully quit WoW before running setup.** This is especially important when migrating an existing installation so the client can save its latest data.
2. Clone this repository and install the addon:

   ```sh
   git clone https://github.com/ligmaSec/wowie
   cd wowie
   node setup.js --project "<folder for the AI CLI to work in>"
   ```

   Setup finds the client automatically where possible. If necessary, add `--wow "<client folder>"`, pointing at the folder containing `Interface` and `WTF`, such as `_forever_`.

   The installer copies **Wowie**, writes `bridge/config.json` and generates its load-on-demand reply slots and signal files. Thousands of tiny generated files are expected: the client must discover them at launch.

3. Launch WoW and enable **Wowie** and its generated slot addons at character selection.
4. Start the bridge from the repository:

   ```sh
   npm start
   ```

   Keep that terminal open while using Wowie. The supervisor restarts a crashed bridge; **Ctrl+C** stops it. Windows also has `bridge\start.ps1` and `bridge\start-window.cmd`.

5. Open **`/wowie`**, choose your agent, review **Sharing**, then send a question. **Reconnect** checks the bridge without asking the AI anything.

Platform walkthroughs: [Windows](docs/INSTALL-WINDOWS.md) · [Linux / Wine / Proton](docs/INSTALL-LINUX.md). On macOS, setup checks `/Applications/World of Warcraft` and `~/Applications/World of Warcraft`; grant the requested capture permissions on first use.

The `--project` folder is the AI CLI's working directory, not an extra source of in-game character data. Choose it with the CLI's host permissions in mind.

### Updating or migrating an existing installation

Let active agent jobs finish, stop the bridge, and **fully quit WoW**. Update this checkout, then run:

```sh
node setup.js
```

The installer carries forward account data, chats, settings, pending request identities, local map edits, generated sounds, addon-enable choices and hotkey targets. Existing Wowie data is not overwritten; previous saved files and cache backups are retained for recovery. Obsolete addon/slot folders are removed only after installation succeeds.

Relaunch the game and start the bridge again. **`/reload` cannot discover renamed or newly added addon files.** For later Lua-only updates, deploy the files and use `/reload`; restart the bridge after bridge changes when it is idle.

If you used a previous global launcher, unlink that command and run `npm link` from this repository. The current launcher is **`wowie`**; `wowie --project <folder>` selects a working folder explicitly. Otherwise, `wowie` uses the folder it is launched from, while `npm start` in this repository falls back to the configured `defaultCwd`. Run only one bridge at a time.

## Using Wowie

Open `/wowie` and use **New chat** in the Conversations sidebar. Each chat has a persistent agent session, transcript, working folder and draft. Its **...** menu provides rename, copy, folder, fresh-session, clear and delete actions.

- **Agent / Model / Reasoning** apply to the next message. Changing agents starts a fresh agent session while keeping the transcript. Pending requests retain the settings they were sent with.
- **Settings** saves addon-wide defaults without editing the bridge configuration. Selection precedence is **per-chat choice → addon default for that agent → bridge config → CLI default**.
- **Enter** sends; **Shift+Enter** inserts a newline. Drag-select reply text and press **Ctrl+C** to copy it directly. **Esc** releases text focus without discarding your draft.
- **Shift-click** an item, spell, quest or chat link into the composer to include its name and tooltip in your question.
- **Cancel wait** stops local waiting, not the external AI process. **Check reply** retrieves an outstanding reply without consuming your next-message draft.

The full answer stays in the discussion window. Game-chat echo defaults to a short `TL;DR` with an **open** link; `/wowie echo full` changes that.

### Map annotations and navigation

Ask for a location or route, then manage its points through **Navigation**:

- **Navigate**, **Start route**, **Previous**, **Next**, **Stop** and **Show on map** control guidance.
- **Add point** saves your current position, a world-map pin or entered coordinates to **My places** or an existing route.
- **Delete** asks for confirmation; local edits persist through reloads and bridge refreshes.

Guidance uses native map/minimap waypoint tracking. With **ShortestPathForever** enabled, its routing API can provide terrain-aware dotted paths. These are directions for you to follow, not automatic movement.

Optional **`Wowie_Nodes`** data provides known herb/ore spawn coordinates filtered by gathering skill. Neither those static points nor an AI-generated map mark proves that a resource is currently present. AI-supplied locations can be wrong.

See [Map and navigation](docs/MAP.md) for data sources, layers and optional command shortcuts.

### Macro drafts

An answer can include a **Create macro** or **Update macro** button. Clicking it saves the proposed macro and puts it on your cursor for manual placement. Replacing a different existing macro, or saving one containing `/run`, `/script` or `/click`, asks for confirmation.

No macro is saved in combat, and Wowie never runs it. Execution remains a normal player action through the game's macro system. `/wowie macro undo` restores the previous macro or removes one the button created.

### Useful commands

Most controls are available in the UI; commands are optional shortcuts.

| Command | Purpose |
|---|---|
| `/wowie` | Open or collapse the workspace; `/ai` and `/ask` are aliases |
| `/wowie <text>` | Send a question from the normal chat box |
| `/wowie new [name]` | Start a separate conversation |
| `/wowie agent <id>` | Select `claude`, `codex`, `grok`, `agy` or `hermes` |
| `/wowie cd <folder>` | Change the current chat's AI working folder |
| `/wowie context [on\|off]` | Show the selected summary or resume/pause character sharing |
| `/wowie copy` | Open the whole-reply copy box |
| `/wowie diag`, `/wowie slots` | Inspect transport and reply-slot status |
| `/wowie help` | Show the full command list |

## Sharing and privacy

Open **Sharing** to choose the information the AI receives. Character snapshots accompany questions; additional queries are checked against the **current** permissions before the addon reads them.

- Common character categories such as identity, location, equipment, inventory, spells, skills, talents and quests are enabled by default.
- Bank, mail, chat history, guild, friends/Battle.net, party/raid, target/focus, UI, addon/global tables and advanced API scopes are off by default.
- **Sensitive** means private or broad data access, not permission to automate gameplay. Broad API/UI/addon scopes can overlap other categories; read their descriptions before enabling them.
- Bank and mailbox information depends on the relevant window being open. **Mail message bodies require separate consent because the client's read API marks those messages as read.** This is an explicit side-effect exception, not a zero-write guarantee.
- **Sharing on / paused** preserves your choices while pausing snapshot/query access. It cannot recall information already sent. Links you manually include in a message still share their tooltip.

Prompts and permitted character data can reach the selected AI provider. Chat history and bridge state are also persisted locally for recovery. Do not treat the Sharing panel as an anonymity mechanism or a way to remove data from a provider after delivery.

Only approved native data getters and permitted raw data are exposed through character queries. Arbitrary Lua, setters, mail sending/deletion and protected gameplay commands are not query operations. Closed-window, secret or restricted values are returned as unavailable.

### Agent permissions

The external AI CLIs are general-purpose tools. Depending on their own configuration, they can read or edit files and run commands in their working folder. **Character-sharing checkboxes do not restrict those host tools.**

Review `agents.<id>` in `bridge/config.json`, including the permission mode, tool rules and provider-specific sandbox options. Use a CLI's read-only/planning mode where supported if you want host-side work to be read-only too; the default configuration must not be assumed to enforce that.

For Claude and Grok, **Allow & retry** can permanently add displayed tool rules to the configuration. That is computer-side authorization, not a gameplay permission. See [Agents](docs/AGENTS.md) and [Configuration](docs/CONFIGURATION.md) for the exact behavior of each CLI.

## How communication works

WoW addons cannot open a normal network connection or freely write files. Wowie uses two channels:

1. **Out of the game:** the addon encodes requests in a checked pixel strip. The bridge captures and decodes that strip, then runs the selected CLI.
2. **Into the game:** the bridge writes ordinary files in pre-created load-on-demand slot addons. WoW loads a fresh slot to receive replies, progress, context queries and map annotations.

Sound-file readiness checks are notification hints, not proof of a live connection. **Reconnect** requires a fresh matching challenge/acknowledgement round trip. The UI reports verification age rather than pretending there is a persistent socket.

Under **Settings → Pixel display**, Compact uses smaller cells where the display supports them. Quiet uses dark colors and verifies whether a smaller or larger dark grid is reliable. Failed calibration keeps the robust display. These options reduce visual intrusion; they do not change the assistant's permissions.

Normal pixel-mode exchanges do not require a reload per message. The reply pool is still finite: **200 slots per UI session**, freed by `/reload`, not by restarting Node. A reload-based fallback exists for setups where capture is unavailable.

Protocol details and limitations: [Architecture](docs/ARCHITECTURE.md).

## Troubleshooting

- **Bridge not responding:** start the bridge, ensure the game window is capturable, then click **Reconnect**. A failed check keeps your draft.
- **Idle / not verified:** the previous verification expired; this is not proof that the bridge stopped. Sending checks again automatically.
- **Replies stop after extended use:** inspect `/wowie slots`. If exhausted, `/reload` frees the pool.
- **A question takes a long time:** more shared data means a larger prompt. Select fewer categories, a faster model or a lower reasoning level; compression does not reduce model tokens.
- **Linux capture is black, stale or cannot find the game:** follow the [Linux capture guide](docs/INSTALL-LINUX.md). `npm run probe` captures a diagnostic image; avoid sharing it if it contains private information.
- **New addon files or slots are missing:** run setup with the client closed, then fully relaunch—not just `/reload`.
- **An agent is missing or not authenticated:** check the bridge banner and run that CLI manually once. See [Agents](docs/AGENTS.md).
- **Saved chats disappeared:** the bridge keeps transcripts and can restore them on the next exchange. Preserve bridge data instead of deleting it as a connection fix.

## Documentation

- [Windows installation](docs/INSTALL-WINDOWS.md)
- [Linux / Wine / Proton installation](docs/INSTALL-LINUX.md)
- [Agents, authentication and host permissions](docs/AGENTS.md)
- [Configuration, flags and environment variables](docs/CONFIGURATION.md)
- [Architecture and transport](docs/ARCHITECTURE.md)
- [Map layers and navigation](docs/MAP.md)
- [Addon and macro API primer](docs/WOW-ADDON-PRIMER.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

## Development

```sh
npm install
npm test
```

Source lives in `addon/Wowie/` and `bridge/`; isolated checks live in `tests/`. The optional `npm run test:live` makes a real AI request and is not part of the normal suite. See [Contributing](CONTRIBUTING.md) for the repository layout and test conventions.

## Credits

- [chelinho139's original project](https://github.com/chelinho139/wow-ai) — the upstream foundation from which Wowie was forked.
- [0xInuarashi's wow-forever-codex](https://github.com/0xinuarashi/wow-forever-codex) — investigation of Forever's file-loading behavior and the pixel-out channel.
- [Gethe/wow-ui-source](https://github.com/Gethe/wow-ui-source) — client UI/API reference.
- [Questie](https://github.com/Questie/Questie) and [QuestieDB](https://github.com/Questie/QuestieDB) — documentation of Forever's map behavior.

## License

MIT — see [LICENSE](LICENSE). Original attribution and license notices are retained.
