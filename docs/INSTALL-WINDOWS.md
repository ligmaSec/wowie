# Installing on Windows

A start-to-finish walkthrough for a fresh Windows machine, ending with the `wowie` command available in any terminal. Upgrading an earlier install? See [Upgrading from an earlier install](#upgrading-from-an-earlier-install). The short version is in the [README](../README.md); this page spells out every step and what can go wrong.

## 1. Prerequisites

| Need | Check | Get it |
|---|---|---|
| Windows 10/11 on NTFS | | |
| World of Warcraft: Forever, **windowed or borderless** | Options → Graphics → Display Mode | Exclusive fullscreen blocks screen capture, so the bridge can't see your messages |
| Node.js 22.2 or newer | `node -v` prints `v22.x` or higher | [nodejs.org](https://nodejs.org), the LTS installer; tick "Add to PATH" (default) |
| Git | `git --version` | [git-scm.com](https://git-scm.com/download/win) |
| At least one agent CLI, logged in (they work side by side) | | |
| · Claude Code | `claude --version` prints a version | [claude.com/claude-code](https://claude.com/claude-code), then run `claude` once and log in |
| · Codex | `codex --version` prints a version | `npm install -g @openai/codex`, then run `codex` once and log in |
| · Grok Build | `grok --version` prints a version | `irm https://x.ai/cli/install.ps1 \| iex` in PowerShell (or `npm install -g @xai-official/grok`), then `grok login`; needs a SuperGrok or X Premium+ subscription |
| · Antigravity | `agy --version` prints a version | Google's Antigravity CLI installer (the bridge also looks in `%LocalAppData%\agy\bin`), then run `agy` once and log in |
| · Hermes Agent | `hermes --version` prints a version | Hermes Agent installer, then `hermes setup` once |

Open a new terminal after installing Node or Git so the `PATH` change is picked up. Any terminal works: Windows Terminal, PowerShell, cmd, or Git Bash.

## 2. Get the code

```powershell
cd C:\Users\<you>\Documents          # or wherever you keep projects
git clone https://github.com/ligmaSec/wowie
cd wowie
npm install
```

`npm install` only pulls the test tooling; the bridge itself has no dependencies.

## 3. Set up the game side

```powershell
node setup.js --project "C:\path\to\the\project\you\want\to\work\on"
```

This:

- finds the WoW: Forever client (it looks under `Program Files (x86)\World of Warcraft\_forever_` and a few other common places; pass `--wow "D:\Games\World of Warcraft\_forever_"` if it can't find yours),
- copies the addon into `Interface\AddOns\Wowie`,
- writes `bridge\config.json` with your paths and the project folder,
- reports which agent CLIs it found (Claude Code, Codex, Grok Build, Antigravity, Hermes); one is enough, and you can add another later,
- creates the 200 reply-slot addons and about 15,000 tiny signal files next to it. That count is normal: the client only discovers addon files when it launches, so everything the bridge might ever touch has to exist up front.

`--project` is the fallback folder for chats. Once the `wowie` command is installed (step 5) you'll usually pick the folder by where you start the bridge instead.

If you have several WoW accounts, setup picks the first and says so; pass `--account <name>` to choose.

Now **fully quit and relaunch World of Warcraft** (a `/reload` is not enough, the new files have to be there at launch). On the character screen, open **AddOns** and make sure *Wowie* is enabled. The 200 *Wowie slot* entries stay enabled too; leave them alone.

## 4. First run

From the `wowie` folder:

```powershell
npm start
```

You should see a banner like:

```
Wowie bridge
  folder   : C:\path\to\your\project  (config.json; chats can override with /wowie cd)
  addons   : C:\Program Files (x86)\World of Warcraft\_forever_\Interface\AddOns
  slots    : 200 installed
  capture  : on (Wow, 200x48 cells of 4px)
  parallel : up to 3 chats at once
  fallback : ...
  agent    : claude (default; chats pick their own with /wowie agent)
  claude   : C:\Users\<you>\.local\bin\claude.exe  [acceptEdits, 11 allowed tool rules]
  codex    : not found - install it (npm install -g @openai/codex, then run `codex` once and log in) or set agents.codex.path in config.json
  grok     : C:\Users\<you>\.grok\bin\grok.exe  [acceptEdits, 11 allowed tool rules]
  ...
```

An agent shown as `not found` is fine as long as no chat uses it; a chat that picks it gets a reply saying so. The default (`agent` in `bridge\config.json`) must be one you have.

In the game, type `/wowie`. The window opens; the light in its corner should turn green within about ten seconds. Type something in the box and press Enter. The reply arrives with the whisper sound.

If the light stays red, see [Troubleshooting](#troubleshooting).

## 5. Install the `wowie` command

The bridge works in the folder you start it from, like the agent CLIs themselves. To be able to type `wowie` from any folder, install it once from inside the repo:

```powershell
cd C:\Users\<you>\Documents\wowie
npm link
```

`npm link` puts a `wowie` launcher into npm's global folder (`%AppData%\npm`, already on your `PATH` since Node was installed) that points back at this repo. Nothing is copied: pulling a newer version of the repo updates the command, and `bridge\config.json` stays where `setup.js` wrote it.

> Don't use `npm install -g .` instead. That copies the files into npm's global folder, where there is no `config.json`, and the bridge refuses to start.

Check it:

```powershell
wowie --help
```

Then use it from any project:

```powershell
cd C:\path\to\realms
wowie
```

The banner's `folder` line now says `started here`, and every chat that hasn't chosen its own folder with `/wowie cd` works in `realms`. `wowie --project <dir>` names the folder explicitly. Only one bridge can run at a time (two would fight over the screen and the slot files), so this sets the default folder rather than running one bridge per project.

Leave the window open while you play. Ctrl+C stops it. It restarts itself if it ever crashes.

### Updating

```powershell
cd C:\Users\<you>\Documents\wowie
git pull
node setup.js        # re-copies the addon; keeps your config.json and the slot pool
```

Then `/reload` in game and restart the bridge. If `setup.js` reports that it created new files, quit and relaunch the game instead of `/reload`.

### Moving from the beta to the Forever release

The release client lives in `_forever_` and its exe is `Wow.exe` (the beta's were `_classic_beta_` and `WowB.exe`). An install from the beta needs one step:

```powershell
cd C:\Users\<you>\Documents\wowie
git pull
node setup.js
```

It moves `bridge/config.json` to `_forever_` (the paths and the process name; your other settings stay) and installs the addon and its slots there. It works before your first login, so you can do it ahead of launch. The beta folder is left alone.

Then fully quit and relaunch the game, and enable "Wowie" at the character select AddOns screen. Your chats come back from the bridge's `transcripts.json` the first time the addon talks to it.

### Upgrading from an earlier install

Stop the bridge after active jobs finish and **fully quit the game before running setup**. Then `git pull` (or clone this repository) and run `node setup.js`. The installer carries account data into `Wowie.lua` without rewriting conversation text, preserves existing Wowie data and custom settings, migrates generated sounds, addon-enable choices and hotkey targets, and builds the renamed slot pool before removing obsolete addon folders. Original saved files and cache backups remain available for recovery. Fully relaunch the game (not just `/reload`: renamed files are discovered only at launch), enable **Wowie**, and restart the bridge.

If you installed the global command, uninstall its previous launcher (`npm unlink -g <previous name>`) and run `npm link` from this repository. The installer updates existing hotkey targets; `/wowie bind <key>` is available if you want to choose a different key.

### Uninstalling

```powershell
npm unlink -g wowie      # removes the command
```

Delete `Interface\AddOns\Wowie` and the `Wowie_S001` … `Wowie_S200` folders next to it, and the `wowie` folder. Your chats' saved data is in `WTF\Account\<account>\SavedVariables\Wowie.lua`.

## Troubleshooting

**`wowie` is not recognized.** Open a new terminal; `npm link` needs `%AppData%\npm` on the `PATH`, which the Node installer sets up but an already-open terminal doesn't see. Check with `npm prefix -g`: that folder must be in `$env:Path`.

**PowerShell says "running scripts is disabled on this system".** npm creates three launchers (`wowie`, `wowie.cmd`, `wowie.ps1`) and PowerShell prefers the `.ps1` one, which a *Restricted* execution policy blocks. Either allow local scripts for your user:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

or type `wowie.cmd` instead, which bypasses the policy.

**"Cannot read config.json … Run node setup.js".** The command is pointing at a copy of the repo that hasn't been set up (usually `npm install -g .` was used instead of `npm link`, or the repo folder was moved). Run `npm link` again from the repo folder you set up.

**The banner says `slots : NOT INSTALLED`.** `setup.js` couldn't write into the AddOns folder, or it wrote somewhere else. Check `addonDir` in `bridge\config.json`, then run `node bridge\install-slots.js` and relaunch the game.

**A reply says `… is not installed on the bridge PC`, or `Could not start …`.** The bridge looks for each agent in its installer's folder (`%UserProfile%\.local\bin\claude.exe`, `%UserProfile%\.grok\bin\grok.exe`), then for `<name>.exe` on the `PATH`, then behind npm's `<name>.cmd` launchers (how `npm install -g @openai/codex` installs Codex; for Codex, a `CODEX_BIN` environment variable is checked first). The banner shows what it found for each. If yours lives elsewhere, put the full path in `agents.<id>.path` in `bridge\config.json` and restart the bridge.

**A reply says the agent is not logged in, or the run ends in a timeout.** Run the CLI once by hand in a terminal on this PC (`claude`, `codex`, `grok login`) and finish the login; headless runs reuse it. Grok also stops for nothing else: the bridge passes `--no-auto-update`.

**The light stays red / "no sign of the bridge".** The bridge can't see the strip in the top-left corner of the game window. In order of likelihood: the game is in exclusive fullscreen (switch to windowed or borderless); the game window is minimized or on a monitor the bridge can't capture; `capture.processName` in the config doesn't match your game exe (`Wow` for Forever; `setup.js` sets it from the exe it finds). `bridge\bridge.log` prints `attached to '...'` when it finds the window and `strip #N` when it decodes a message.

**Windows Defender or another antivirus complains about the slot files.** They are 15,000 empty or 124-byte files; nothing runs from them. Exclude `Interface\AddOns` if the scanner slows the bridge's writes down.

**Everything else** is in the README's Troubleshooting section and in `/wowie diag` in game.
