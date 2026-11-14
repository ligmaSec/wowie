#!/usr/bin/env node
'use strict';
// One-shot installer.
//
//   node setup.js [--wow "<client folder>"] [--project "<default work folder>"] [--account <name>]
//
// Finds the WoW: Forever client, copies the addon into Interface\AddOns, writes
// bridge/config.json from the example (if missing), and builds the slot pool.
// Re-running is safe: existing config and generated files are kept. A config
// still on the beta client moves to Forever once Forever is installed.
//
// Renaming an existing installation carries over saved state and generated assets.
// Legacy names are recognized only here as migration inputs; active files use Wowie.
// Migration requires the client to be closed so its latest SavedVariables are flushed.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const ADDON_SRC = path.join(ROOT, 'addon', 'Wowie');
const BRIDGE = path.join(ROOT, 'bridge');
const CONFIG = path.join(BRIDGE, 'config.json');
const EXAMPLE = path.join(BRIDGE, 'config.example.json');
const { sameFolder } = require(path.join(BRIDGE, 'protocol.js'));

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true;
}

function isClient(dir) {
  try {
    if (!fs.existsSync(path.join(dir, 'Interface'))) return false;
    const items = fs.readdirSync(dir);
    // Windows: the game exe. macOS: the .app bundle. Linux (Wine): the Wine exe.
    return items.some(f => /^Wow.*\.exe$/i.test(f) || /\.app$/i.test(f));
  } catch { return false; }
}

// The client folder an existing config.json points at.
function configuredClient() {
  try { return path.dirname(path.dirname(JSON.parse(fs.readFileSync(CONFIG, 'utf8')).addonDir)); } catch { return null; }
}

function findClient() {
  if (args.wow) {
    if (isClient(args.wow)) return args.wow;
    throw new Error(`--wow "${args.wow}" does not look like a WoW client folder (needs Interface\\ and a game binary)`);
  }
  // A re-run stays on its client, unless that's the beta: Forever replaced it.
  const current = configuredClient();
  if (current && isClient(current) && path.basename(current) !== '_classic_beta_') return current;
  let roots;
  if (process.platform === 'win32') {
    roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, 'D:\\', 'E:\\', 'D:\\Games', 'E:\\Games', 'C:\\Games']
      .filter(Boolean).map(r => path.join(r, 'World of Warcraft'));
  } else if (process.platform === 'darwin') {
    roots = ['/Applications/World of Warcraft', path.join(os.homedir(), 'Applications', 'World of Warcraft')];
  } else {
    // Linux: the client lives inside a Wine prefix.
    roots = [process.env.WINEPREFIX, path.join(os.homedir(), '.wine'),
      path.join(os.homedir(), 'Games', 'battlenet')]
      .filter(Boolean).flatMap(p => ['Program Files (x86)', 'Program Files'].map(pf => path.join(p, 'drive_c', pf, 'World of Warcraft')));
  }
  if (current) roots.unshift(path.dirname(current));
  // Tests search a fake install tree and nothing else, never a real game.
  if (process.env.WOWIE_TEST_WOW_ROOT) roots = [process.env.WOWIE_TEST_WOW_ROOT];
  for (const root of roots) {
    // The beta folder can outlive the beta: Forever goes first.
    for (const flavor of ['_forever_', '_classic_beta_', '_retail_', '_classic_era_', '_classic_']) {
      const dir = path.join(root, flavor);
      if (isClient(dir)) return dir;
    }
  }
  throw new Error('Could not find the WoW client. Pass --wow "<path to World of Warcraft/_forever_>"');
}

function findAccount(client) {
  const base = path.join(client, 'WTF', 'Account');
  let names = [];
  try { names = fs.readdirSync(base).filter(n => n !== 'SavedVariables' && fs.statSync(path.join(base, n)).isDirectory()); } catch {}
  if (args.account) {
    if (!names.includes(args.account)) throw new Error(`Account "${args.account}" not found under ${base}`);
    return args.account;
  }
  // The game creates this folder at the first login. Everything else can be
  // installed before that (slots must exist when the game launches); the bridge
  // finds the account by itself once it appears.
  if (!names.length) return null;
  if (names.length > 1) console.log(`Several accounts found (${names.join(', ')}); using "${names[0]}". Pass --account to choose another.`);
  return names[0];
}

const LEGACY_ADDONS = ['WoWAI', 'WoWClaude'];
const LEGACY_GLOBALS = { WoWAIDB: 'WowieDB', WoWAIMapDB: 'WowieMapDB', WoWClaudeDB: 'WowieDB' };

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.wowie-tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// Skip Lua strings/comments, including long brackets. Never rewrite a chat message
// or a table key that merely mentions an old global.
function renameLuaIdentifiers(source, names, assignmentsOnly = false) {
  const output = [];
  let i = 0, copied = 0, depth = 0, renamed = 0;
  function longEnd(start) {
    let marker = start + 1;
    while (source[marker] === '=') marker++;
    if (source[marker] !== '[') return null;
    const close = ']' + '='.repeat(marker - start - 1) + ']';
    const end = source.indexOf(close, marker + 1);
    if (end < 0) throw new Error('Unterminated Lua long string/comment in migration input');
    return end + close.length;
  }
  while (i < source.length) {
    const c = source[i];
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < source.length && source[i] !== quote) i += source[i] === '\\' ? 2 : 1;
      if (i >= source.length) throw new Error('Unterminated Lua string in migration input');
      i++;
    } else if (c === '-' && source[i + 1] === '-') {
      const end = source[i + 2] === '[' ? longEnd(i + 2) : null;
      i = end == null ? (source.indexOf('\n', i) < 0 ? source.length : source.indexOf('\n', i)) : end;
    } else if (c === '[' && (source[i + 1] === '[' || source[i + 1] === '=')) {
      i = longEnd(i) ?? (i + 1);
    } else if (/[A-Za-z_]/.test(c)) {
      const start = i++;
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i])) i++;
      const name = source.slice(start, i);
      let next = i;
      while (next < source.length && /\s/.test(source[next])) next++;
      if (Object.hasOwn(names, name) && (!assignmentsOnly || (depth === 0 && source[next] === '=' && source[next + 1] !== '='))) {
        output.push(source.slice(copied, start), names[name]);
        copied = i;
        renamed++;
      }
    } else {
      if ('{(['.includes(c)) depth++;
      else if ('})]'.includes(c)) depth--;
      if (depth < 0) throw new Error('Unbalanced Lua delimiters in migration input');
      i++;
    }
  }
  if (depth !== 0) throw new Error('Unbalanced Lua delimiters in migration input');
  output.push(source.slice(copied));
  return { text: output.join(''), renamed };
}

function clientIsRunning() {
  if (process.env.WOWIE_TEST_WOW_ROOT) return false;
  if (process.platform === 'linux') {
    for (const pid of fs.readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
      let args;
      try { args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0'); } catch { continue; }
      if (args.some(arg => /(?:^|[\\/])Wow[^\\/]*\.exe$/i.test(arg))) return true;
    }
    return false;
  }
  const command = process.platform === 'win32' ? 'tasklist' : 'pgrep';
  const args = process.platform === 'win32' ? ['/NH', '/FO', 'CSV'] : ['-x', 'World of Warcraft'];
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  if (result.error || (result.status !== 0 && !(process.platform !== 'win32' && result.status === 1))) {
    throw new Error('Cannot verify the client is closed; close it before migrating this installation');
  }
  return process.platform === 'win32' ? /^"Wow[^"]*\.exe"/im.test(result.stdout) : result.status === 0;
}

function migrateOldInstall(client) {
  const addons = path.join(client, 'Interface', 'AddOns');
  const accounts = path.join(client, 'WTF', 'Account');
  const oldFolders = (fs.existsSync(addons) ? fs.readdirSync(addons) : [])
    .filter(name => LEGACY_ADDONS.some(old => name === old || new RegExp('^' + old + '_S\\d{3}$').test(name)) || name === 'WoWAI_Nodes');
  const accountDirs = fs.existsSync(accounts) ? fs.readdirSync(accounts, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => path.join(accounts, entry.name)) : [];
  const saved = [];
  for (const account of accountDirs) {
    const target = path.join(account, 'SavedVariables', 'Wowie.lua');
    if (fs.existsSync(target)) continue;
    const source = LEGACY_ADDONS.map(old => path.join(account, 'SavedVariables', old + '.lua')).find(file => fs.existsSync(file));
    if (source) saved.push({ source, target });
  }
  let verifiedClosed = false;
  function requireClosed() {
    if (!verifiedClosed && clientIsRunning()) {
      throw new Error('Fully quit World of Warcraft before migrating the addon to Wowie; /reload is not sufficient');
    }
    verifiedClosed = true;
  }
  if (oldFolders.length || saved.length) requireClosed();
  // Prepare all saved-data transformations before changing installation files.
  const prepared = saved.map(entry => {
    const source = fs.readFileSync(entry.source, 'utf8');
    const result = renameLuaIdentifiers(source, LEGACY_GLOBALS, true);
    if (source.trim() && !result.renamed) throw new Error('No recognized saved globals in ' + entry.source);
    return { ...entry, text: result.text };
  });
  for (const entry of prepared) {
    writeAtomic(entry.target, entry.text);
    console.log(`migrate  : saved state copied to ${entry.target}; original retained`);
  }
  for (const old of LEGACY_ADDONS) {
    for (const asset of ['sig', 'ack', 'act', 'presence', 'ctl']) {
      const source = path.join(addons, old, asset);
      if (fs.existsSync(source)) fs.cpSync(source, path.join(addons, 'Wowie', asset), { recursive: true, force: false });
    }
  }
  const oldNodes = path.join(addons, 'WoWAI_Nodes');
  function copyNodes(source, target) {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      const from = path.join(source, entry.name), to = path.join(target, entry.name.replace('WoWAI_Nodes', 'Wowie_Nodes'));
      if (entry.isDirectory()) copyNodes(from, to);
      else if (!fs.existsSync(to)) {
        if (entry.name.endsWith('.lua')) writeAtomic(to, renameLuaIdentifiers(fs.readFileSync(from, 'utf8'), { WoWAINodes: 'WowieNodes' }).text);
        else if (entry.name.endsWith('.toc')) writeAtomic(to, fs.readFileSync(from, 'utf8').replaceAll('WoW AI', 'Wowie').replaceAll('WoWAI', 'Wowie'));
        else fs.cpSync(from, to, { force: false });
      }
    }
  }
  if (fs.existsSync(oldNodes)) copyNodes(oldNodes, path.join(addons, 'Wowie_Nodes'));
  function updateCaches(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { updateCaches(file); continue; }
      if (entry.name !== 'bindings-cache.wtf' && entry.name !== 'AddOns.txt') continue;
      const source = fs.readFileSync(file, 'utf8');
      let text = source;
      if (entry.name === 'bindings-cache.wtf') {
        text = source.replace(/^(bind[ \t]+\S+[ \t]+["']?CLICK[ \t]+)(?:WoWAI|WoWClaude)(RefreshButton:LeftButton["']?[ \t]*)$/gm, '$1Wowie$2');
      } else {
        const existing = new Set([...source.matchAll(/^(Wowie(?:_S\d{3}|_Nodes)?):/gm)].map(match => match[1]));
        text = source.replace(/^(?:WoWAI|WoWClaude)(_S\d{3}|_Nodes)?(:[^\r\n]*)(?:\r?\n|$)/gm, (_, suffix = '', value) => {
          const name = 'Wowie' + suffix;
          return existing.has(name) ? '' : name + value + '\n';
        });
      }
      if (text !== source) {
        requireClosed();
        if (!fs.existsSync(file + '.wowie-backup')) fs.copyFileSync(file, file + '.wowie-backup');
        writeAtomic(file, text);
      }
    }
  }
  for (const dir of accountDirs) updateCaches(dir);
  return oldFolders.map(name => path.join(addons, name));
}

function copyAddon(client) {
  const dest = path.join(client, 'Interface', 'AddOns', 'Wowie');
  fs.mkdirSync(dest, { recursive: true });
  let copied = 0;
  for (const f of fs.readdirSync(ADDON_SRC)) {
    const target = path.join(dest, f);
    if (f === 'Inbox.lua' && fs.existsSync(target)) continue; // the bridge owns it once running
    fs.copyFileSync(path.join(ADDON_SRC, f), target);
    copied++;
  }
  return { dest, copied };
}

// A config.json from before the rename, or from before agents: fix the paths
// that named the old addon, and move Claude's settings under agents.claude next
// to the codex and grok blocks from the example. Everything else is kept.
function upgradeConfig(cfg, example) {
  const notes = [];
  if (!cfg.capture) { cfg.capture = { ...example.capture }; notes.push('capture'); }
  if (cfg.capture.pacingVersion !== 1) {
    if (cfg.capture.intervalMs == null || cfg.capture.intervalMs === 250) cfg.capture.intervalMs = example.capture.intervalMs;
    cfg.capture.pacingVersion = 1;
    notes.push('capture pacing');
  }
  if (/(?:^|[\\/])(?:WoWAI|WoWClaude)[\\/]Inbox\.lua$/.test(cfg.inboxFile || '')) {
    cfg.inboxFile = path.join(cfg.addonDir, 'Wowie', 'Inbox.lua');
    notes.push('inboxFile');
  }
  if (/(?:WoWAI|WoWClaude)\.lua$/.test(cfg.savedVariablesFile || '')) {
    cfg.savedVariablesFile = cfg.savedVariablesFile.replace(/(?:WoWAI|WoWClaude)\.lua$/, 'Wowie.lua');
    notes.push('savedVariablesFile');
  }
  if (!cfg.agents) {
    const claude = { ...example.agents.claude };
    if (cfg.claudePath) claude.path = cfg.claudePath;
    if (cfg.model) claude.model = cfg.model;
    if (cfg.permissionMode) claude.permissionMode = cfg.permissionMode;
    if (Array.isArray(cfg.allowedTools)) claude.allowedTools = cfg.allowedTools;
    cfg.agent = cfg.agent || example.agent;
    cfg.agents = { claude, codex: { ...example.agents.codex }, grok: { ...example.agents.grok } };
    for (const k of ['claudePath', 'model', 'permissionMode', 'allowedTools']) delete cfg[k];
    notes.push('agents');
  }
  return notes;
}

function savedVariablesFile(client, account) {
  return account ? path.join(client, 'WTF', 'Account', account, 'SavedVariables', 'Wowie.lua') : '';
}

// The game exe without .exe, as the capture looks for it.
function processNameOf(client) {
  const exe = fs.readdirSync(client).find(f => /^Wow.*\.exe$/i.test(f) || /\.app$/i.test(f));
  if (!exe) return null;
  let processName = exe.replace(/\.exe$/i, '');
  // macOS: the process name is the executable inside the .app bundle, not the bundle name.
  if (process.platform === 'darwin' && exe.toLowerCase().endsWith('.app')) {
    const macosDir = path.join(client, exe, 'Contents', 'MacOS');
    try {
      const bins = fs.readdirSync(macosDir).filter(f => fs.statSync(path.join(macosDir, f)).isFile());
      if (bins.length) processName = bins[0];
    } catch {}
  }
  return processName;
}

function pointAtClient(cfg, client, account) {
  cfg.addonDir = path.join(client, 'Interface', 'AddOns');
  cfg.inboxFile = path.join(cfg.addonDir, 'Wowie', 'Inbox.lua');
  cfg.savedVariablesFile = savedVariablesFile(client, account);
  const processName = processNameOf(client);
  if (processName) cfg.capture = { ...cfg.capture, processName };
}

function writeConfig(client, account) {
  const example = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
  if (fs.existsSync(CONFIG)) {
    const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    const notes = upgradeConfig(cfg, example);
    if (!sameFolder(cfg.addonDir, path.join(client, 'Interface', 'AddOns'))) {
      pointAtClient(cfg, client, account);
      notes.push(`moved to ${path.basename(client)}, process ${cfg.capture.processName}`);
    } else if (account && !cfg.savedVariablesFile) {
      cfg.savedVariablesFile = savedVariablesFile(client, account);
      notes.push('savedVariablesFile');
    }
    if (notes.length) {
      fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n');
      console.log(`config   : ${CONFIG} updated (${notes.join(', ')}); everything else kept`);
    } else {
      console.log(`config   : ${CONFIG} already exists, keeping it`);
    }
    return cfg;
  }
  const cfg = example;
  pointAtClient(cfg, client, account);
  cfg.defaultCwd = args.project ? path.resolve(args.project) : process.cwd();
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`config   : wrote ${CONFIG}`);
  return cfg;
}

// Which agent CLIs this PC has, so the last lines of setup can say what is missing.
function agentReport(cfg) {
  const A = require(path.join(BRIDGE, 'agents.js'));
  const lines = [];
  for (const id of A.agentIds()) {
    const r = A.resolveCommand(id, A.agentConfig(cfg, id));
    lines.push(`  ${A.AGENTS[id].name.padEnd(7)}: ${r.found ? r.file + (r.args.length ? ' ' + r.args.join(' ') : '') : 'not found (' + A.AGENTS[id].install + ')'}`);
  }
  return lines.join('\n');
}

try {
  const client = findClient();
  console.log(`client   : ${client}`);
  const account = findAccount(client);
  console.log(`account  : ${account || 'none yet (the game creates it at your first login; the bridge picks it up then)'}`);
  const oldFolders = migrateOldInstall(client);
  const { dest, copied } = copyAddon(client);
  console.log(`addon    : ${copied} file(s) -> ${dest}`);
  const cfg = writeConfig(client, account);
  console.log(`project  : ${cfg.defaultCwd}  (change with /wowie cd in game, or defaultCwd in config.json)`);
  console.log(`agent    : ${cfg.agent} by default (change with /wowie agent in game, or "agent" in config.json)`);
  console.log(agentReport(cfg));
  console.log('slots    : building the reply-slot pool and signal files...');
  const r = spawnSync(process.execPath, [path.join(BRIDGE, 'install-slots.js')], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('install-slots.js failed');
  for (const dir of oldFolders) fs.rmSync(dir, { recursive: true, force: true });
  if (oldFolders.length) console.log(`migrate  : removed ${oldFolders.length} obsolete addon/slot folder(s) after installing Wowie`);
  console.log(`
Done. Next:
  1. Fully quit and relaunch World of Warcraft (it only discovers new addon files at launch).
  2. Enable "Wowie" at the character select AddOns screen (the Wowie slot ### entries stay enabled).
  3. Start the bridge:  npm start   (in this terminal${process.platform === 'win32' ? '; bridge\\start-window.cmd opens its own window' : '; on Linux keep the game borderless/windowed and check the capture with: npm run probe'})
  4. In game:  /wowie
`);
} catch (e) {
  console.error('setup failed:', e.message);
  process.exit(1);
}
