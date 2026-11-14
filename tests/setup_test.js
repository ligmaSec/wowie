// setup.js against fake install trees: which client it picks and what config it
// leaves, with the beta folder still on disk and with existing installs.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const REPO = path.join(__dirname, '..');

// A copy of the code (setup.js works next to itself) and an empty install tree.
function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wowie-setup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repo, 'bridge'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'setup.js'), path.join(repo, 'setup.js'));
  fs.cpSync(path.join(REPO, 'addon'), path.join(repo, 'addon'), { recursive: true });
  for (const f of fs.readdirSync(path.join(REPO, 'bridge'))) {
    if (f.endsWith('.js') || f === 'config.example.json') fs.copyFileSync(path.join(REPO, 'bridge', f), path.join(repo, 'bridge', f));
  }
  return { repo, wow: path.join(dir, 'World of Warcraft') };
}

function client(s, flavor, exe, account) {
  const dir = path.join(s.wow, flavor);
  fs.mkdirSync(path.join(dir, 'Interface', 'AddOns'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'WTF', 'Account', 'SavedVariables'), { recursive: true });
  if (account) fs.mkdirSync(path.join(dir, 'WTF', 'Account', account, 'SavedVariables'), { recursive: true });
  fs.writeFileSync(path.join(dir, exe), '');
  fs.writeFileSync(path.join(dir, 'BlizzardError.exe'), '');
  return dir;
}

function setup(s, ...args) {
  // Replaces the search list outright: this must never find a real game on the
  // machine running the tests (it would install into it).
  const env = { ...process.env, WOWIE_TEST_WOW_ROOT: s.wow };
  const r = spawnSync(process.execPath, ['setup.js', '--project', '.', ...args], { cwd: s.repo, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return r.stdout;
}

const config = s => JSON.parse(fs.readFileSync(path.join(s.repo, 'bridge', 'config.json'), 'utf8'));
const slots = dir => fs.readdirSync(path.join(dir, 'Interface', 'AddOns')).filter(n => /^Wowie_S\d{3}$/.test(n)).length;

function savedState(t, source) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  t.after(() => lua.lua_close(L));
  const run = (code, returns = 0) => {
    assert.equal(lauxlib.luaL_loadstring(L, to_luastring(code)), lua.LUA_OK);
    const result = lua.lua_pcall(L, 0, returns, 0);
    assert.equal(result, lua.LUA_OK, result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(L, -1)));
  };
  run(source);
  return expression => {
    run(`return tostring(${expression})`, 1);
    const value = to_jsstring(lua.lua_tostring(L, -1));
    lua.lua_pop(L, 1);
    return value;
  };
}

test('a fresh install prefers Forever over a leftover beta folder', t => {
  const s = sandbox(t);
  const beta = client(s, '_classic_beta_', 'WowB.exe', '1#1');
  const forever = client(s, '_forever_', 'Wow.exe', '1#1');
  setup(s);
  const cfg = config(s);
  assert.equal(cfg.addonDir, path.join(forever, 'Interface', 'AddOns'));
  assert.equal(cfg.inboxFile, path.join(forever, 'Interface', 'AddOns', 'Wowie', 'Inbox.lua'));
  assert.equal(cfg.savedVariablesFile, path.join(forever, 'WTF', 'Account', '1#1', 'SavedVariables', 'Wowie.lua'));
  assert.equal(cfg.capture.processName, 'Wow');
  assert.equal(slots(forever), 200);
  assert.equal(slots(beta), 0);
});

test('a re-run moves a beta config to Forever and keeps the rest of it', t => {
  const s = sandbox(t);
  const beta = client(s, '_classic_beta_', 'WowB.exe', '1#1');
  setup(s);
  assert.equal(config(s).capture.processName, 'WowB');
  const edited = config(s);
  edited.defaultCwd = 'C:\\my-project';
  edited.capture.intervalMs = 500;
  fs.writeFileSync(path.join(s.repo, 'bridge', 'config.json'), JSON.stringify(edited));

  const forever = client(s, '_forever_', 'Wow.exe', '1#1');
  assert.match(setup(s), /moved to _forever_, process Wow/);
  const cfg = config(s);
  assert.equal(cfg.addonDir, path.join(forever, 'Interface', 'AddOns'));
  assert.equal(cfg.capture.processName, 'Wow');
  assert.equal(cfg.defaultCwd, 'C:\\my-project');
  assert.equal(cfg.capture.intervalMs, 500);
  assert.equal(slots(forever), 200);
  assert.equal(slots(beta), 200);
});

test('--wow moves the config too, so addon and slots land in the same client', t => {
  const s = sandbox(t);
  client(s, '_classic_beta_', 'WowB.exe', '1#1');
  setup(s);
  const era = client(s, '_classic_era_', 'WowClassic.exe', '1#1');
  setup(s, '--wow', era);
  assert.equal(config(s).addonDir, path.join(era, 'Interface', 'AddOns'));
  assert.equal(config(s).capture.processName, 'WowClassic');
  assert.equal(slots(era), 200);
});

test('a re-run stays on a client that is not the beta', t => {
  const s = sandbox(t);
  const era = client(s, '_classic_era_', 'WowClassic.exe', '1#1');
  setup(s, '--wow', era);
  client(s, '_forever_', 'Wow.exe', '1#1');
  assert.match(setup(s), /already exists, keeping it/);
  assert.equal(config(s).addonDir, path.join(era, 'Interface', 'AddOns'));
});

test('setup installs before the first login and fills the account in later', t => {
  const s = sandbox(t);
  const forever = client(s, '_forever_', 'Wow.exe', null);
  assert.match(setup(s), /account  : none yet/);
  assert.equal(config(s).savedVariablesFile, '');
  assert.equal(slots(forever), 200);

  fs.mkdirSync(path.join(forever, 'WTF', 'Account', '1#1', 'SavedVariables'), { recursive: true });
  setup(s);
  assert.equal(config(s).savedVariablesFile, path.join(forever, 'WTF', 'Account', '1#1', 'SavedVariables', 'Wowie.lua'));
});

test('capture pacing migrates the old default once and preserves explicit custom intervals', t => {
  const s = sandbox(t);
  const dir = client(s, '_forever_', 'Wow.exe', 'ACCT');
  setup(s, '--wow', dir);
  const file = path.join(s.repo, 'bridge', 'config.json');
  let cfg = config(s);
  cfg.capture.intervalMs = 250;
  delete cfg.capture.pacingVersion;
  cfg.capture.windowName = 'keep my window selector';
  cfg.maxParallel = 7;
  fs.writeFileSync(file, JSON.stringify(cfg));
  setup(s, '--wow', dir);
  cfg = config(s);
  assert.equal(cfg.capture.intervalMs, 50);
  assert.equal(cfg.capture.windowName, 'keep my window selector');
  assert.equal(cfg.maxParallel, 7);
  cfg.capture.intervalMs = 250; // an explicit choice after migration is not an old default
  fs.writeFileSync(file, JSON.stringify(cfg));
  setup(s, '--wow', dir);
  assert.equal(config(s).capture.intervalMs, 250);
  cfg.capture.intervalMs = 120;
  delete cfg.capture.pacingVersion;
  fs.writeFileSync(file, JSON.stringify(cfg));
  setup(s, '--wow', dir);
  assert.equal(config(s).capture.intervalMs, 120, 'a pre-existing non-default capture rate must remain authoritative');
});

test('rename preserves every account, request data, local map edits, assets and binding targets', t => {
  const s = sandbox(t);
  const dir = client(s, '_forever_', 'Wow.exe', 'ACCT');
  const addons = path.join(dir, 'Interface', 'AddOns');
  const account = path.join(dir, 'WTF', 'Account', 'ACCT');
  const saved = path.join(account, 'SavedVariables');
  const legacy = `--[==[
WoWAIDB = "do not rewrite a comment"
]==]
WoWAIDB = {
  session = "stable-session", lastSeq = 146, activeChat = "chat-one",
  settings = {context=true,sharing={inventory=true,addons=false},pixelDisplay="quiet",pixelVerified={quiet="quiet4"}},
  chats = {{id="chat-one",name="Kept chat",draft="  next draft\\nline two  ",pendingId=146,
    history={{role="user",text=[=[A literal wow-ai / WoW AI reference.
WoWAIDB = "keep this chat text"
WoWAIMapDB = "also literal"
]=]}},
    request={nonce="pending-identity-0001",profile="all selected bytes",agent="codex",model="saved-model",reasoning="high"}}}
}
WoWAIMapDB = {map={epoch="map-one",version=4,layers={}},edits={mine={points={{1432,12,34,"Local place","poi"}}}},hidden={mine=true},nav={layer="mine",index=1}}
`;
  fs.writeFileSync(path.join(saved, 'WoWAI.lua'), legacy);
  const second = path.join(dir, 'WTF', 'Account', 'SECOND', 'SavedVariables');
  fs.mkdirSync(second, { recursive: true });
  fs.writeFileSync(path.join(second, 'WoWClaude.lua'), 'WoWClaudeDB = {session="second-account",settings={context=false}}\n');
  const oldAddon = path.join(addons, 'WoWAI');
  fs.mkdirSync(path.join(oldAddon, 'presence'), { recursive: true });
  fs.writeFileSync(path.join(oldAddon, 'presence', '0001.wav'), Buffer.from([7, 8, 9, 10]));
  fs.mkdirSync(path.join(addons, 'WoWAI_S001'));
  fs.writeFileSync(path.join(addons, 'WoWAI_S001', 'Inbox.lua'), 'old slot body');
  fs.mkdirSync(path.join(addons, 'UnrelatedAddon'));
  fs.writeFileSync(path.join(addons, 'UnrelatedAddon', 'keep.lua'), 'untouched');
  const nodes = path.join(addons, 'WoWAI_Nodes');
  fs.mkdirSync(nodes);
  fs.writeFileSync(path.join(nodes, 'WoWAI_Nodes.toc'), '## Title: WoW AI Nodes\nNodes.lua\n');
  fs.writeFileSync(path.join(nodes, 'Nodes.lua'), 'WoWAINodes = {maps={}}\nWoWAINodes.maps[1432] = {label="WoWAINodes is literal data"}\n');
  const character = path.join(account, '93', 'Hero');
  fs.mkdirSync(character, { recursive: true });
  const bindings = 'bind CTRL-R "CLICK WoWAIRefreshButton:LeftButton"\nbind SPACE JUMP\n';
  fs.writeFileSync(path.join(character, 'bindings-cache.wtf'), bindings);
  fs.writeFileSync(path.join(character, 'AddOns.txt'), 'WoWAI: enabled\nWoWAI_S001: enabled\nWoWAI_Nodes: disabled\nUnrelatedAddon: enabled\n');
  const example = JSON.parse(fs.readFileSync(path.join(s.repo, 'bridge', 'config.example.json')));
  const previous = { ...example, addonDir: addons, inboxFile: path.join(oldAddon, 'Inbox.lua'),
    savedVariablesFile: path.join(saved, 'WoWAI.lua'), defaultCwd: '/keep/project', maxParallel: 7 };
  previous.capture.intervalMs = 120;
  previous.agents.codex.model = 'keep-model';
  fs.writeFileSync(path.join(s.repo, 'bridge', 'config.json'), JSON.stringify(previous));
  const receipts = '{"handledNonces":{"stable-session":{"pending-identity-0001":1}}}';
  fs.writeFileSync(path.join(s.repo, 'bridge', 'state.json'), receipts);
  setup(s, '--wow', dir);
  const migrated = fs.readFileSync(path.join(saved, 'Wowie.lua'), 'utf8');
  const get = savedState(t, migrated);
  assert.equal(get('WowieDB.session'), 'stable-session');
  assert.equal(get('WowieDB.lastSeq'), '146');
  assert.equal(get('WowieDB.chats[1].request.nonce'), 'pending-identity-0001');
  assert.equal(get('WowieDB.chats[1].request.profile'), 'all selected bytes');
  assert.equal(get('WowieDB.chats[1].request.model'), 'saved-model');
  assert.equal(get('WowieDB.chats[1].draft'), '  next draft\nline two  ');
  assert.equal(get('WowieDB.settings.sharing.addons'), 'false');
  assert.equal(get('WowieDB.settings.pixelVerified.quiet'), 'quiet4');
  assert.equal(get('WowieMapDB.edits.mine.points[1][4]'), 'Local place');
  assert.equal(get('WowieMapDB.nav.index'), '1');
  assert.match(get('WowieDB.chats[1].history[1].text'), /WoWAIDB = "keep this chat text"/);
  assert.match(get('WowieDB.chats[1].history[1].text'), /WoWAIMapDB = "also literal"/);
  assert.equal(fs.readFileSync(path.join(saved, 'WoWAI.lua'), 'utf8'), legacy, 'the recovery copy is never altered');
  assert.equal(savedState(t, fs.readFileSync(path.join(second, 'Wowie.lua'), 'utf8'))('WowieDB.session'), 'second-account');
  assert.deepEqual(fs.readFileSync(path.join(addons, 'Wowie', 'presence', '0001.wav')), Buffer.from([7, 8, 9, 10]));
  assert.equal(fs.readFileSync(path.join(character, 'bindings-cache.wtf'), 'utf8'), 'bind CTRL-R "CLICK WowieRefreshButton:LeftButton"\nbind SPACE JUMP\n');
  assert.equal(fs.readFileSync(path.join(character, 'bindings-cache.wtf.wowie-backup'), 'utf8'), bindings);
  assert.equal(fs.readFileSync(path.join(character, 'AddOns.txt'), 'utf8'), 'Wowie: enabled\nWowie_S001: enabled\nWowie_Nodes: disabled\nUnrelatedAddon: enabled\n');
  assert.equal(fs.readFileSync(path.join(addons, 'UnrelatedAddon', 'keep.lua'), 'utf8'), 'untouched');
  assert.equal(savedState(t, fs.readFileSync(path.join(addons, 'Wowie_Nodes', 'Nodes.lua'), 'utf8'))('WowieNodes.maps[1432].label'), 'WoWAINodes is literal data');
  assert.equal(fs.existsSync(oldAddon), false);
  assert.equal(fs.existsSync(path.join(addons, 'WoWAI_S001')), false);
  const after = config(s);
  assert.equal(after.defaultCwd, '/keep/project');
  assert.equal(after.maxParallel, 7);
  assert.equal(after.capture.intervalMs, 120);
  assert.equal(after.agents.codex.model, 'keep-model');
  assert.equal(after.inboxFile, path.join(addons, 'Wowie', 'Inbox.lua'));
  assert.equal(after.savedVariablesFile, path.join(saved, 'Wowie.lua'));
  assert.equal(fs.readFileSync(path.join(s.repo, 'bridge', 'state.json'), 'utf8'), receipts);
});

test('rename keeps existing new-name data and assets, and repeated setup is idempotent', t => {
  const s = sandbox(t);
  const dir = client(s, '_forever_', 'Wow.exe', 'ACCT');
  const addons = path.join(dir, 'Interface', 'AddOns'), saved = path.join(dir, 'WTF', 'Account', 'ACCT', 'SavedVariables');
  const current = 'WowieDB = {session="current",chats={{draft="keep newest"}}}\n';
  fs.writeFileSync(path.join(saved, 'Wowie.lua'), current);
  fs.writeFileSync(path.join(saved, 'WoWAI.lua'), 'WoWAIDB = {session="older"}\n');
  for (const [name, value] of [['Wowie', 'current asset'], ['WoWAI', 'older asset']]) {
    fs.mkdirSync(path.join(addons, name, 'sig'), { recursive: true });
    fs.writeFileSync(path.join(addons, name, 'sig', '001.wav'), value);
  }
  const cache = path.join(dir, 'WTF', 'Account', 'ACCT', 'AddOns.txt');
  fs.writeFileSync(cache, 'Wowie: disabled\nWoWAI: enabled\nOther: enabled\n');
  setup(s, '--wow', dir);
  setup(s, '--wow', dir);
  assert.equal(fs.readFileSync(path.join(saved, 'Wowie.lua'), 'utf8'), current);
  assert.equal(fs.readFileSync(path.join(addons, 'Wowie', 'sig', '001.wav'), 'utf8'), 'current asset');
  assert.equal(fs.readFileSync(cache, 'utf8'), 'Wowie: disabled\nOther: enabled\n');
  assert.equal(slots(dir), 200);
});

test('rename carries generated assets over before any account exists', t => {
  const s = sandbox(t), dir = client(s, '_forever_', 'Wow.exe', null);
  const addon = path.join(dir, 'Interface', 'AddOns', 'WoWAI');
  fs.mkdirSync(path.join(addon, 'ctl'), { recursive: true });
  fs.writeFileSync(path.join(addon, 'ctl', 'valid.wav'), 'existing flag');
  setup(s, '--wow', dir);
  assert.equal(config(s).savedVariablesFile, '');
  assert.equal(fs.readFileSync(path.join(dir, 'Interface', 'AddOns', 'Wowie', 'ctl', 'valid.wav'), 'utf8'), 'existing flag');
  assert.equal(fs.existsSync(addon), false);
});

for (const broken of ['WoWAIDB = {text="unfinished', 'WoWAIDB = {text="unfinished table"']) {
test('invalid previous saved data cannot remove the old install or create a corrupt replacement: ' + broken.length, t => {
  const s = sandbox(t), dir = client(s, '_forever_', 'Wow.exe', 'ACCT');
  const saved = path.join(dir, 'WTF', 'Account', 'ACCT', 'SavedVariables');
  const oldAddon = path.join(dir, 'Interface', 'AddOns', 'WoWAI');
  fs.mkdirSync(oldAddon);
  fs.writeFileSync(path.join(oldAddon, 'keep.lua'), 'recovery code');
  fs.writeFileSync(path.join(saved, 'WoWAI.lua'), broken);
  const r = spawnSync(process.execPath, ['setup.js', '--wow', dir], { cwd: s.repo, env: { ...process.env, WOWIE_TEST_WOW_ROOT: s.wow }, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.equal(fs.readFileSync(path.join(oldAddon, 'keep.lua'), 'utf8'), 'recovery code');
  assert.equal(fs.readFileSync(path.join(saved, 'WoWAI.lua'), 'utf8'), broken);
  assert.equal(fs.existsSync(path.join(saved, 'Wowie.lua')), false);
});
}

test('failed slot installation leaves the previous addon available for recovery', t => {
  const s = sandbox(t), dir = client(s, '_forever_', 'Wow.exe', 'ACCT');
  const saved = path.join(dir, 'WTF', 'Account', 'ACCT', 'SavedVariables');
  const oldAddon = path.join(dir, 'Interface', 'AddOns', 'WoWAI');
  fs.mkdirSync(oldAddon);
  fs.writeFileSync(path.join(oldAddon, 'keep.lua'), 'recovery code');
  fs.writeFileSync(path.join(saved, 'WoWAI.lua'), 'WoWAIDB = {session="safe"}\n');
  fs.writeFileSync(path.join(s.repo, 'bridge', 'install-slots.js'), 'process.exit(7);\n');
  const r = spawnSync(process.execPath, ['setup.js', '--wow', dir], { cwd: s.repo, env: { ...process.env, WOWIE_TEST_WOW_ROOT: s.wow }, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.equal(fs.readFileSync(path.join(oldAddon, 'keep.lua'), 'utf8'), 'recovery code');
  assert.equal(savedState(t, fs.readFileSync(path.join(saved, 'Wowie.lua'), 'utf8'))('WowieDB.session'), 'safe');
});

test('migration refuses live-client changes before touching saved data', { skip: process.platform !== 'linux' }, async t => {
  const s = sandbox(t), dir = client(s, '_forever_', 'Wow.exe', 'ACCT');
  const saved = path.join(dir, 'WTF', 'Account', 'ACCT', 'SavedVariables');
  fs.writeFileSync(path.join(saved, 'WoWAI.lua'), 'WoWAIDB = {session="active"}\n');
  const running = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', path.join(dir, 'Wow.exe')], { stdio: 'ignore' });
  t.after(() => running.kill());
  await new Promise((resolve, reject) => { running.once('spawn', resolve); running.once('error', reject); });
  const env = { ...process.env };
  delete env.WOWIE_TEST_WOW_ROOT;
  const r = spawnSync(process.execPath, ['setup.js', '--wow', dir], { cwd: s.repo, env, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.equal(fs.existsSync(path.join(saved, 'Wowie.lua')), false);
  assert.equal(fs.readFileSync(path.join(saved, 'WoWAI.lua'), 'utf8'), 'WoWAIDB = {session="active"}\n');
});
