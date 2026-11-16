#!/usr/bin/env node
'use strict';
// Wowie bridge: the half of Wowie that lives outside the game.
//
//   OUT  capture.ps1 screen-captures the addon's pixel strip -> one or more
//        {session, chat, id, cwd, flags, text} records per frame
//        (fallback: the game's SavedVariables file, written on /reload)
//   RUN  the chat's agent (Claude Code, Codex or Grok; see agents.js) headless
//        in the chat's folder, streaming progress. Each chat is its own agent
//        session; up to maxParallel run at once.
//   IN   we write the latest reply/status of every chat into every
//        Wowie_S### slot addon (the game loads a fresh one from a timer),
//        flip a signal .wav per message, and also write Inbox.lua for the
//        reload path.
//
// Zero npm dependencies. Run with npm start or `node bridge.js`.
//   --once            handle one pending SavedVariables prompt and exit
//   --inject "text"   pretend the strip said this and exit when done
//   --agent <id>      agent for --inject (default: "agent" in config.json)
//   --project <dir>   default folder for chats that haven't picked one
//
// Like the agent CLIs themselves, the bridge works in the folder it was started
// from: `cd my-project && wowie` makes my-project the default for every chat
// that hasn't chosen its own with /wowie cd. Started from inside this repo (npm
// start), it falls back to defaultCwd in config.json.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { randomBytes } = require('node:crypto');
const P = require('./protocol'); // the pure protocol code, unit-tested in tests/bridge_test.js
const A = require('./agents');   // how each agent is launched and read, unit-tested in tests/agents_test.js
const C = require('./context');  // permissioned snapshots and read-only query continuations
const { Journal, atomicDurable, requestKey, generationKey, ownerKey } = require('./recovery');

const HERE = __dirname;
const CONFIG_FILE = path.join(HERE, 'config.json');
const STATE_FILE = path.join(HERE, 'state.json');
const LOG_FILE = path.join(HERE, 'bridge.log');
const TMP_DIR = path.join(HERE, 'tmp'); // prompt files for agents that read the prompt from disk

async function main() {
const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('wowie [--project <dir>] [--once] [--inject "text" [--agent <id>]]\n\n' +
    'Runs the Wowie bridge. Chats without a folder of their own work in <dir>,\n' +
    'or in the folder you started it from, or in defaultCwd from bridge/config.json.\n' +
    `Agents: ${A.agentIds().join(', ')} (the default is "agent" in config.json; chats pick with /wowie agent).`);
  process.exit(0);
}
let cfg;
try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
catch (e) {
  console.error(`Cannot read ${CONFIG_FILE} (${e.message}).\nRun "node setup.js" in the wowie folder first.`);
  process.exit(2); // the supervisor doesn't restart on 2
}
const ownership = await require('./ownership').acquire(cfg.addonDir || cfg.inboxFile || HERE);
process.once('exit', () => ownership.close());
const journal = new Journal(path.join(HERE, 'requests.json'));
const receiptWindow = new Map(Object.entries(journal.data.controls).slice(-64));
const once = argv.includes('--once');
const injectIdx = argv.indexOf('--inject');
const inject = injectIdx >= 0 ? argv[injectIdx + 1] : null;
const agentIdx = argv.indexOf('--agent');
const injectAgent = agentIdx >= 0 ? argv[agentIdx + 1] : '';
const exitWhenIdle = once || inject !== null;

// The agent chats use unless they pick their own (/wowie agent, "agent=" flag).
const DEFAULT_AGENT = A.normalizeAgent(cfg.agent || A.DEFAULT_AGENT);
if (!DEFAULT_AGENT) {
  console.error(`"agent": "${cfg.agent}" in ${CONFIG_FILE} is not one of ${A.agentIds().join(', ')}.`);
  process.exit(2);
}
const agentOptions = A.selectionOptions(cfg);

// Default folder: --project, else the folder we were started from (unless that is
// this repo, i.e. npm start), else the configured one.
const REPO = path.dirname(HERE);
function insideRepo(dir) {
  const rel = path.relative(REPO, dir);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
const projectIdx = argv.indexOf('--project');
const DEFAULT_CWD = path.resolve(
  projectIdx >= 0 && argv[projectIdx + 1] ? argv[projectIdx + 1]
    : process.env.WOWIE_PROJECT ? process.env.WOWIE_PROJECT
    : !insideRepo(process.cwd()) ? process.cwd()
    : cfg.defaultCwd || process.cwd());
const DEFAULT_CWD_SOURCE = projectIdx >= 0 ? '--project' : process.env.WOWIE_PROJECT ? 'WOWIE_PROJECT'
  : !insideRepo(process.cwd()) ? 'started here' : 'config.json';

const resolveCwd = raw => P.resolveCwd(raw, DEFAULT_CWD);
const { sameFolder } = P;
// Subfolders of the default folder, for the "folder not found" hint.
function siblingFolders() {
  try {
    return fs.readdirSync(DEFAULT_CWD, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .map(d => d.name).sort().slice(0, 30);
  } catch { return []; }
}

const SLOTS = cfg.slots || 200;
const MAX_PARALLEL = cfg.maxParallel || 3;
const cap = Object.assign({ enabled: true, processName: 'Wow', cellPx: 4, cellsPerRow: 200, maxRows: 48, intervalMs: 50 }, cfg.capture || {});
cap.intervalMs = Number.isFinite(Number(cap.intervalMs)) && Number(cap.intervalMs) > 0 ? Number(cap.intervalMs) : 50;
const CAPTURE_DISPLAYS = new Set(['robust', 'compact', 'quiet', 'quiet4']);
// The installer migrates legacy paths; honor the configured game-side files.
const INBOX_FILE = cfg.inboxFile || path.join(cfg.addonDir || '', 'Wowie', 'Inbox.lua');
let SAVED_VARS = String(cfg.savedVariablesFile || '');
// The client folder holding the AddOns folder.
const CLIENT_DIR = cfg.addonDir ? path.dirname(path.dirname(cfg.addonDir)) : '';

// Set up before the first login there was no account folder to point at: the
// game creates it at login, so keep looking until it shows up.
function findSavedVars() {
  if (SAVED_VARS || !CLIENT_DIR) return;
  const base = path.join(CLIENT_DIR, 'WTF', 'Account');
  try {
    const account = fs.readdirSync(base, { withFileTypes: true }).find(d => d.isDirectory() && d.name !== 'SavedVariables');
    if (account) SAVED_VARS = path.join(base, account.name, 'SavedVariables', 'Wowie.lua');
  } catch {}
}

let state = readJson(STATE_FILE, { lastId: 0, sessions: {}, handled: {} });
if (!state.handled) state.handled = {};
if (!state.sessions) state.sessions = {};
// state.handled contains old numeric receipts only; never interpret them as nonces.

// Bridge-side transcripts. The beta client sometimes wipes addon saved data; since
// every prompt and reply passes through here, this copy lets the addon recover.
const TRANSCRIPT_FILE = path.join(HERE, 'transcripts.json');
let transcripts = readJson(TRANSCRIPT_FILE, { chats: {}, tokens: {} });
if (!transcripts.chats) transcripts.chats = {};
if (!transcripts.tokens) transcripts.tokens = {};
let pendingRestore = Object.values(journal.data.offers).filter(o => !o.acknowledged).at(-1) || null;

function saveTranscripts() {
  atomicDurable(TRANSCRIPT_FILE, JSON.stringify(transcripts));
}


function noteMessage(job, role, text) {
  if (!job.chat || journal.forgotten(job)) return;
  const c = transcripts.chats[job.chat] = transcripts.chats[job.chat] || { id: job.chat, name: '', cwd: job.cwd, generation: job.generation, messages: [] };
  if (c.messages.some(m => m.nonce === job.nonce && m.role === role)) return;
  if (job.name) c.name = job.name;
  if (job.cwd) c.cwd = job.cwd;
  const m = { role, text: String(text ?? '').slice(0, 4000), id: job.id, nonce: job.nonce, t: Math.floor(Date.now() / 1000) };
  if (role === 'assistant' && job.agent) m.agent = job.agent;
  c.messages.push(m);
  while (c.messages.length > 200) c.messages.shift();
  c.updated = Date.now();
  saveTranscripts();
}

// Session discovery and delivery acknowledgement are deliberately independent.
function maybeOfferRestore(job) {
  if (!job.session) return;
  const saved = journal.data.offers[job.session];
  if (saved) { pendingRestore = saved.acknowledged ? null : saved; return; }
  if (journal.data.seenSessions[job.session]) { pendingRestore = null; return; }
  const chats = Object.values(transcripts.chats)
    .filter(c => c.id !== job.chat && c.messages.length)
    .sort((a, b) => (b.updated || 0) - (a.updated || 0))
    .slice(0, 16)
    .map(c => ({ id: c.id, name: c.name, cwd: c.cwd, generation: c.generation, messages: c.messages.slice(-40).map(m => ({ ...m, text: m.text.slice(0, 2000) })) }));
  journal.data.seenSessions[job.session] = Date.now();
  transcripts.tokens[job.session] = Date.now();
  if (chats.length) {
    pendingRestore = { token: job.session, id: randomBytes(16).toString('hex'), chats };
    journal.data.offers[job.session] = pendingRestore;
  } else pendingRestore = null;
  journal.save();
  saveTranscripts();
}

function clearChatSession(job) {
  for (const key of [sessKey(job), chatKey(job)]) {
    delete state.sessions[key];
    if (state.sessionCwd) delete state.sessionCwd[key];
    if (state.sessionAgent) delete state.sessionAgent[key];
  }
}

// A generation tombstone is committed before touching in-memory work or files.
function forgetChat(job, acknowledge = true) {
  journal.data.tombstones[generationKey(job)] = Date.now();
  for (const entry of Object.values(journal.data.requests)) {
    if (generationKey(entry.job) !== generationKey(job)) continue;
    entry.phase = 'forgotten';
    delete entry.result; delete entry.query;
    entry.job = { session: entry.job.session, chat: entry.job.chat, nonce: entry.job.nonce, generation: entry.job.generation };
  }
  for (const offer of Object.values(journal.data.offers)) offer.chats = offer.chats.filter(c => c.id !== job.chat || (c.generation && c.generation !== job.generation));
  if (acknowledge) rememberControl(job, 'forget');
  journal.save();
  for (const active of [...queued.values(), ...pendingProfiles.values(), ...[...running.values()].map(r => r.job)]) {
    if (generationKey(active) !== generationKey(job)) continue;
    active.finished = true;
    clearTimeout(active.contextTimer); clearInterval(active.contextWatcher);
    const run = running.get(chatKey(active));
    if (run?.job === active) { if (run.child) killTree(run.child); running.delete(chatKey(active)); }
    queued.delete(C.key(active)); pendingProfiles.delete(C.key(active)); pendingQueries.delete(C.key(active));
    contextTransfers.forget(active);
  }
  for (const [id, profile] of contextProfiles) if (generationKey(profile.job) === generationKey(job)) dropProfile(id);
  // Known incomplete packets may predate the request envelope.
  for (const [id, packet] of contextPackets) if (generationKey(packet) === generationKey(job)) { contextTransfers.forget(packet); contextPackets.delete(id); }
  const current = journal.data.generations[job.chat || ownerKey(job)];
  if (!current || current === job.generation) { delete transcripts.chats[job.chat]; clearChatSession(job); }
  for (const [key, record] of live) if (record.chat === job.chat && record.generation === job.generation) live.delete(key);
  saveTranscripts(); saveState();
  publishNow(); drainQueue();
  log(`#${job.id} forgot chat ${job.chat} generation ${job.generation}`);
}

function stageReceipt(key, receipt) {
  receiptWindow.delete(key);
  receiptWindow.set(key, receipt);
  if (receiptWindow.size > 64) receiptWindow.delete(receiptWindow.keys().next().value);
}

function rememberControl(job, kind) {
  journal.data.controls[requestKey(job)] = { session: job.session || '', chat: job.chat || '', nonce: job.nonce, kind, target: job.target || '', generation: job.generation || '' };
  stageReceipt(requestKey(job), journal.data.controls[requestKey(job)]);
}

function receiveReceipt(job) {
  const prior = journal.data.controls[requestKey(job)];
  if (prior) {
    if (prior.kind === job.receipt && prior.chat === (job.chat || '') && prior.target === job.target && prior.generation === (job.generation || '')) {
      stageReceipt(requestKey(job), prior);
      publishNow();
    }
    return;
  }
  if (job.receipt === 'reply') {
    const entry = journal.get({ ...job, nonce: job.target });
    if (!entry || !['complete', 'expired'].includes(entry.phase) || entry.job.chat !== job.chat || entry.job.generation !== job.generation) return;
    entry.acknowledged = Date.now();
    journal.retain();
  } else if (job.receipt === 'restore' && !job.chat) {
    const offer = journal.data.offers[job.session];
    if (!offer || offer.id !== job.target) return;
    offer.acknowledged = Date.now();
    if (pendingRestore?.id === offer.id) pendingRestore = null;
  } else return;
  rememberControl(job, job.receipt);
  journal.save();
  publishNow();
}

let lastMtime = 0;
const running = new Map(); // chatKey -> { job, child }
const queued = new Map();  // nonce owner -> job waiting for that chat (or for a free parallel slot)
const live = new Map();    // chatKey -> latest record shown to the game
const requestOwners = new Map(); // chatKey -> latest admitted user request nonce, never hello metadata
const notifiedPhases = new Map();
let notifiedHello = '';
const contextTransfers = new C.Transfers();
const contextProfiles = new Map();
const pendingProfiles = new Map();
const contextPackets = new Map();
let profileBytes = 0;
let recovering = false;
let admitting = false;
const pendingQueries = new Map();
// Only a received hello can acknowledge an addon probe; never restore this from disk.
let connectionAck = null;
let lastPublish = 0;
let rejectedInput = false;
let publishTimer = null;

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { if (err.code === 'ENOENT') return fallback; throw err; }
}

function saveState() {
  atomicDurable(STATE_FILE, JSON.stringify(state, null, 2));
}

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

const { pad3, chatKey, sessKey, SILENT_WAV, jobsFromStrip } = P;
const slotNumber = id => P.slotNumber(id, SLOTS);
const alreadyHandled = job => P.alreadyHandled(state, job);
const markHandled = job => P.markHandled(state, job);

function atomicWrite(file, content) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

// The guardian retains installation ownership until the owned tree has exited.
function killTree(child) { child.kill(); }

// ---------------------------------------------------------------------------
// What the game reads
// ---------------------------------------------------------------------------

// Map layers the agent drew (see protocol.js, "Map layers"). The bridge is the source of
// truth; slot files carry the whole set while the game may not have it yet: for a
// while after it changes, and after every hello (a fresh or wiped client).
if (!state.map) state.map = P.newMap();
const MAP_DIR = path.join(HERE, 'mapjobs');
// Every publish rewrites all slot files, so the map rides along only for a short
// while, and on progress publishes only while it is small.
const MAP_SHARE_MS = 3 * 60 * 1000;
const MAP_PROGRESS_MAX = 20000;
let mapShareUntil = Object.keys(state.map.layers).length ? Date.now() + MAP_SHARE_MS : 0;
let mapLuaCache = { version: -1, epoch: '', text: '' };
function mapLuaSize() {
  if (mapLuaCache.version !== state.map.version || mapLuaCache.epoch !== state.map.epoch) {
    mapLuaCache = { version: state.map.version, epoch: state.map.epoch, text: P.luaMap(state.map) };
  }
  return mapLuaCache.text.length;
}

function mapFileFor(job) {
  return path.join(MAP_DIR, `${String(job.chat || 'default').replace(/[^\w-]/g, '_')}-${job.nonce}.jsonl`);
}

// Collect what the run asked for (its map file, then ```wowmap blocks in its
// reply), apply it, and return the reply text without the blocks plus a note
// for the reply, if anything was asked.
function takeMapCommands(job, text) {
  const file = mapFileFor(job);
  let cmds = [], errors = [];
  try {
    const r = P.parseMapFile(fs.readFileSync(file, 'utf8'));
    cmds = r.cmds; errors = r.errors;
  } catch {}
  try { fs.unlinkSync(file); } catch {}
  const blocks = P.extractMapBlocks(text);
  cmds.push(...blocks.cmds);
  errors.push(...blocks.errors);
  if (!cmds.length && !errors.length) return { text: blocks.text, note: '' };
  const { changed, notes } = P.applyMapCommands(state.map, cmds);
  if (changed) { saveState(); mapShareUntil = Date.now() + MAP_SHARE_MS; }
  const all = [...notes, ...errors];
  log(`#${job.id} map: ${all.join('; ') || 'no change'} (version ${state.map.version})`);
  return { text: blocks.text, note: all.length ? `map: ${all.join('; ')}` : '' };
}

// Slot file / Inbox.lua body: see protocol.luaTable.
function slotFile(globalName, records, urgent = true) {
  const map = Date.now() < mapShareUntil && (urgent || mapLuaSize() <= MAP_PROGRESS_MAX) ? state.map : null;
  return P.luaTable(globalName, records, { cwd: DEFAULT_CWD, restore: pendingRestore, receipts: [...receiptWindow.values()], agent: DEFAULT_AGENT, agents: A.agentIds(), agentOptions, contextEnabled: cfg.gameContext !== false, map, connectionAck, captureIntervalMs: cap.intervalMs });
}

function addonInstalled() {
  return fs.existsSync(path.join(cfg.addonDir, 'Wowie', 'Wowie.toc'));
}

function slotsInstalled() {
  return fs.existsSync(path.join(cfg.addonDir, 'Wowie_S001', 'Inbox.lua'));
}

// The game will load *some* unused slot next, so every slot gets the full picture.
// A missing addon folder (not installed yet, or the game folder moved) must not
// take the bridge down: capture and agent runs keep working, and the game just
// won't see replies until `node setup.js` has run and WoW was restarted.
let warnedNoAddon = false;
function publishNow(urgent = true) {
  lastPublish = Date.now();
  const records = [...live.values()].slice(-30);
  try {
    atomicWrite(INBOX_FILE, slotFile('Wowie_Inbox', records, urgent));
  } catch (e) {
    if (!warnedNoAddon) {
      warnedNoAddon = true;
      log(`publish: cannot write ${INBOX_FILE} (${e.code || e.message}); addon not installed? run: node setup.js, then restart WoW`);
    }
    return;
  }
  if (!slotsInstalled()) return;
  const body = slotFile('Wowie_SlotData', records, urgent);
  let slotsWritten = true;
  for (let i = 1; i <= SLOTS; i++) {
    try { atomicWrite(path.join(cfg.addonDir, 'Wowie_S' + pad3(i), 'Inbox.lua'), body); } catch { slotsWritten = false; }
  }
  if (slotsWritten) notifyReady(records);
}

function notifyReady(records) {
  let ready = false;
  for (const [key, record] of live) {
    if (!records.includes(record)) continue;
    if (!P.validNonce(record.nonce) || !['queued', 'working', 'context_query', 'done', 'error'].includes(record.status)) continue;
    const phase = JSON.stringify([record.nonce, record.status, record.status === 'context_query' ? record.request : '']);
    if (notifiedPhases.get(key) === phase) continue;
    notifiedPhases.set(key, phase);
    ready = true;
  }
  if (connectionAck) {
    const hello = JSON.stringify(connectionAck);
    if (hello !== notifiedHello) { notifiedHello = hello; ready = true; }
  }
  if (ready) presenceBeat();
}

// Final results publish immediately; progress is throttled. `key` is the chat
// (record.session is the agent's session id, a different thing).
function publish(key, record, urgent) {
  if (record.generation && journal.forgotten(record)) return;
  if (requestOwners.has(key) && requestOwners.get(key) !== record.nonce) return;
  live.set(key, record);
  if (urgent) { if (publishTimer) { clearTimeout(publishTimer); publishTimer = null; } publishNow(); return; }
  const wait = (cfg.progressWriteMs || 3000) - (Date.now() - lastPublish);
  if (wait <= 0) publishNow(false);
  else if (!publishTimer) publishTimer = setTimeout(() => { publishTimer = null; publishNow(false); }, wait);
}

function signal(kind, id, on) {
  const file = path.join(cfg.addonDir, 'Wowie', kind, pad3(slotNumber(id)) + '.wav');
  try { atomicWrite(file, on ? SILENT_WAV : Buffer.alloc(0)); } catch {}
}

// Heartbeat: act/NNN/kk.wav flips valid for the k-th action of message NNN. The
// game polls the next one for free, so it can show "12 actions, last one 5 s ago"
// without spending a reply slot.
const ACT_MAX = cfg.actMax || 60;
function actFile(id, k) {
  return path.join(cfg.addonDir, 'Wowie', 'act', pad3(slotNumber(id)), String(k).padStart(2, '0') + '.wav');
}
function resetBeats(id) {
  for (let k = 1; k <= ACT_MAX; k++) { try { atomicWrite(actFile(id, k), Buffer.alloc(0)); } catch {} }
}
function beat(job) {
  if (job.finished || journal.forgotten(job)) return;
  job.beats = (job.beats || 0) + 1;
  if (job.beats > ACT_MAX) return;
  try { atomicWrite(actFile(job.id, job.beats), SILENT_WAV); } catch {}
}

// Readiness uses monotonically increasing pre-created presence filenames. Never
// recycle a cached playable sound; exhausted clients retain bounded slot clocks.
const PRESENCE_MAX = cfg.presenceMax || 2000;
function presenceFile(k) {
  return path.join(cfg.addonDir, 'Wowie', 'presence', String(k).padStart(4, '0') + '.wav');
}
function presenceBeat() {
  if (!fs.existsSync(path.join(cfg.addonDir, 'Wowie', 'presence'))) return;
  const previous = Number.isInteger(state.presence) && state.presence >= 0 ? state.presence : 0;
  if (previous >= PRESENCE_MAX) return;
  const k = previous + 1;
  try { atomicWrite(presenceFile(k), SILENT_WAV); } catch { return; }
  state.presence = k;
  saveState();
}

// Slot clocks advance even without presence sounds, but are not readiness events.
function heartbeat() {
  publishNow(false);
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------


// The addon sends the player's in-game context (character, location, ...) with
// its hello and again whenever it changes; an empty one means "context off".
// It is kept in state.json so a restarted bridge still has it, and goes into
// the agent's system prompt on every run (see protocol.systemPrompt).
function setContext(job) {
  const text = cfg.gameContext === false ? '' : String(job.ctx || '').replace(/\r/g, '').trim().slice(0, 2000);
  const prev = (state.context && state.context.text) || '';
  if (text === prev) return;
  state.context = text ? { text, at: Date.now(), session: job.session || '' } : null;
  saveState();
  const who = (text.split('\n').find(l => /^Character:/i.test(l)) || text.split('\n')[0] || '').slice(0, 100);
  log(`#${job.id}${job.session ? '@' + job.session : ''} game context ${text ? 'updated: ' + who : 'cleared'}`);
}

function gameContext() {
  if (cfg.gameContext === false) return '';
  return (state.context && state.context.text) || '';
}

// The addon/macro primer that goes into the system prompt with the context.
// Read on every run so edits count without a restart; "" in the config turns
// it off. Relative paths are taken from the repo (docs/WOW-ADDON-PRIMER.md).
const PRIMER_FILE = cfg.primerFile === undefined ? 'docs/WOW-ADDON-PRIMER.md' : cfg.primerFile;
let warnedNoPrimer = false;
function primer() {
  if (!PRIMER_FILE) return '';
  const file = path.resolve(REPO, PRIMER_FILE);
  try { return fs.readFileSync(file, 'utf8'); } catch (e) {
    if (!warnedNoPrimer) { warnedNoPrimer = true; log(`primer: cannot read ${file} (${e.code || e.message}); running without it`); }
    return '';
  }
}

// Persist newly allowed rules for an agent so they stick across bridge restarts.
// They go under agents.<id>.allowedTools; a config.json from before agents
// existed keeps Claude's list at the top level, which moves down on first write.
function allowRules(agentId, rules) {
  const current = new Set(A.agentConfig(cfg, agentId).allowedTools || []);
  const added = rules.filter(r => r && !current.has(r));
  if (!added.length) return [];
  const list = [...current, ...added];
  cfg.agents = cfg.agents || {};
  cfg.agents[agentId] = { ...(cfg.agents[agentId] || {}), allowedTools: list };
  try {
    const onDisk = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    onDisk.agents = onDisk.agents || {};
    onDisk.agents[agentId] = { ...(onDisk.agents[agentId] || {}), allowedTools: list };
    if (agentId === 'claude') delete onDisk.allowedTools;
    atomicWrite(CONFIG_FILE, JSON.stringify(onDisk, null, 2) + '\n');
  } catch (e) { log('could not save config.json:', e.message); }
  return added;
}

// ---------------------------------------------------------------------------
// Running an agent
// ---------------------------------------------------------------------------
function armContextWait(job) {
  clearTimeout(job.contextTimer);
  job.deadline = job.deadline || Date.now() + (cfg.timeoutMs || 1800000);
  job.contextTimer = setTimeout(() => finish(job, 'error', 'Timed out waiting for addon information. Keep the game connected and retry the question.'), Math.max(1, job.deadline - Date.now()));
  if (exitWhenIdle && !job.contextWatcher) job.contextWatcher = setInterval(pollSavedVariables, cfg.pollMs || 750);
}

function contextRecord(job, status, text, extra = {}) {
  return { chat: job.chat, id: job.id, nonce: job.nonce, generation: job.generation, status, text, cwd: job.cwd, agent: job.agent || '', ...extra };
}

function dropProfile(id) {
  const profile = contextProfiles.get(id);
  if (profile) { profileBytes -= profile.bytes; contextProfiles.delete(id); }
}

function maintainContext() {
  const cutoff = Date.now() - (cfg.timeoutMs || 1800000);
  contextTransfers.expire(cutoff);
  for (const [id, packet] of contextPackets) if (packet.at < cutoff) contextPackets.delete(id);
  for (const [id, profile] of contextProfiles) {
    if (profile.at < cutoff && !pendingProfiles.has(id)) dropProfile(id);
  }
}

function receiveContextData(packet) {
  if (cfg.gameContext === false || journal.forgotten(packet)) return;
  const id = C.key(packet), entry = journal.get(packet);
  if (entry && (entry.job.generation !== packet.generation || ['complete', 'expired', 'forgotten'].includes(entry.phase))) return;
  if (packet.data === 'profile' && contextProfiles.has(id)) return;
  const wait = pendingQueries.get(id);
  if (packet.data === 'query' && (!wait || wait.request !== packet.request || wait.job.generation !== packet.generation)) return;
  const profileJob = pendingProfiles.get(id);
  if (packet.data === 'profile' && profileJob && (profileJob.generation !== packet.generation || profileJob.profile !== packet.profile)) return;
  let result, payload, continuation;
  try {
    if (packet.payload !== undefined && (typeof packet.payload !== 'string' || Buffer.byteLength(packet.payload) > 4 * 1024 * 1024)) throw new Error('Information snapshot exceeds 4 MiB');
    result = packet.payload !== undefined ? { text: packet.payload } : contextTransfers.add(packet);
    if (result.text === undefined) {
      contextPackets.set(id, { session: packet.session, chat: packet.chat, nonce: packet.nonce, generation: packet.generation, at: contextPackets.get(id)?.at || Date.now() });
      if (profileJob) publish(chatKey(profileJob), contextRecord(profileJob, 'context', `Receiving checked information: ${result.received}/${result.total} parts`), false);
      return;
    }
    contextPackets.delete(id);
    if (packet.data === 'profile') {
      C.snapshot(result.text);
      payload = result.text;
      if (!profileJob) {
        maintainContext();
        const bytes = Buffer.byteLength(payload);
        if (contextProfiles.size >= 64 || profileBytes + bytes > 64 * 1024 * 1024) throw new Error('Completed information snapshot cache is full (64 entries / 64 MiB); retry when pending snapshots expire');
        contextProfiles.set(id, { text: payload, bytes, at: Date.now(), job: { session: packet.session, chat: packet.chat, nonce: packet.nonce, generation: packet.generation, profile: packet.profile } });
        profileBytes += bytes;
      }
    } else {
      const responses = JSON.parse(result.text);
      if (!Array.isArray(responses) || responses.length !== wait.queries.length) throw new Error('Incomplete addon information query results');
      continuation = C.continuation(result.text);
    }
  } catch (err) {
    contextTransfers.forget(packet); contextPackets.delete(id);
    const job = profileJob || wait?.job;
    if (job) finish(job, 'error', `Could not read selected addon information: ${err.message}`);
    else log(`information packet #${packet.id}: ${err.message}`);
    return;
  }
  // Durability failures here are fatal, not misreported as malformed client data.
  if (profileJob && payload !== undefined) {
    pendingProfiles.delete(id);
    clearTimeout(profileJob.contextTimer);
    profileJob.profilePayload = payload;
    journal.checkpoint(profileJob, 'queued');
    scheduleJob(profileJob);
  } else if (continuation !== undefined) {
    wait.job.continuation = continuation;
    journal.checkpoint(wait.job, 'queued', { query: null });
    pendingQueries.delete(id);
    clearTimeout(wait.job.contextTimer);
    running.delete(chatKey(wait.job));
    scheduleJob(wait.job);
  }
}

function requestContext(job, queries) {
  if (!journal.owns(job)) {
    finish(job, 'error', 'This request was superseded by a newer question before addon information was needed.');
    return;
  }
  if (cfg.gameContext === false || !job.profilePayload) {
    finish(job, 'error', 'The agent requested addon information, but information sharing is disabled. Select the relevant checkboxes in Sharing first.');
    return;
  }
  const request = randomBytes(16).toString('hex');
  journal.checkpoint(job, 'context_query', { query: { request, queries } });
  pendingQueries.set(C.key(job), { job, request, queries });
  running.set(chatKey(job), { job, child: null });
  armContextWait(job);
  saveState();
  publish(chatKey(job), contextRecord(job, 'context_query', 'Reading information allowed by your current Sharing checkboxes...', { request, queries }), true);
  drainQueue();
}


function replayResult(job, record) {
  const key = requestOwners.get(chatKey(job)) === job.nonce ? chatKey(job) : `replay:${requestKey(job)}`;
  live.delete(key);
  publish(key, record, true);
}

function submit(job) {
  const needsGeneration = job.forget || job.data || job.receipt === 'reply' || (!job.hello && job.calibration === undefined && job.receipt !== 'restore');
  if (!P.validNonce(job.nonce) || (needsGeneration && !P.validNonce(job.generation))) {
    if (!rejectedInput) {
      rejectedInput = true;
      log(`#${job.id} rejected: Request protocol 2 requires a valid request nonce and chat generation. Update the Wowie addon and /reload; this request was not run.`);
      publishNow();
    }
    return;
  }
  if (job.receipt) {
    if (P.validNonce(job.target)) receiveReceipt(job);
    return;
  }
  if (job.forget) {
    const prior = journal.data.controls[requestKey(job)];
    if (prior) {
      if (prior.kind === 'forget' && prior.chat === (job.chat || '') && prior.generation === job.generation) {
        stageReceipt(requestKey(job), prior);
        publishNow();
      }
    } else forgetChat(job);
    return;
  }
  if (job.hello) {
    const handled = alreadyHandled(job);
    if (!handled && job.ctx !== undefined) setContext(job);
    connectionAck = { session: job.session, nonce: job.nonce, at: Math.floor(Date.now() / 1000), ...(CAPTURE_DISPLAYS.has(job.captureDisplay) ? { display: job.captureDisplay } : {}) };
    if (!handled) { markHandled(job); saveState(); }
    signal('ack', job.id, true);
    maybeOfferRestore(job);
    mapShareUntil = Date.now() + MAP_SHARE_MS;
    publishNow();
    return;
  }
  if (job.calibration !== undefined) return;
  if (journal.forgotten(job)) return;
  if (job.data) { receiveContextData(job); return; }
  const entry = journal.get(job);
  if (entry) {
    if (entry.job.chat !== job.chat || entry.job.generation !== job.generation) { log(`rejected nonce reuse for #${job.id}`); return; }
    if (entry.phase === 'complete') replayResult(entry.job, entry.result);
    else if (entry.phase === 'expired') replayResult(entry.job, contextRecord(entry.job, 'error', 'This acknowledged result is older than the retained 200-result chat history. It cannot be recovered and the original request was not run again.'));
    else if (entry.phase !== 'forgotten') publishNow();
    return;
  }
  const key = chatKey(job), generationOwner = job.chat || ownerKey(job);
  const previous = journal.data.generations[generationOwner];
  admitting = true;
  try {
    if (previous && previous !== job.generation) forgetChat({ ...job, generation: previous }, false);
    journal.data.generations[generationOwner] = job.generation;
    requestOwners.set(key, job.nonce);
    journal.data.owners[ownerKey(job)] = job.nonce;
    job.admitted = true;
    job.deadline = Date.now() + (cfg.timeoutMs || 1800000);
    journal.checkpoint(job, 'queued');
    for (const older of [...pendingProfiles.values(), ...[...pendingQueries.values()].map(w => w.job)]) {
      if (chatKey(older) === key && older.nonce !== job.nonce) finish(older, 'error', 'This request was superseded by a newer question before addon information arrived.');
    }
  } finally { admitting = false; }
  if (alreadyHandled(job)) {
    finish(job, 'error', 'This request was handled by an older bridge, but its full result was not saved. Its outcome cannot be recovered safely; the original request was not run again.');
    return;
  }
  if (job.ctx !== undefined) setContext(job);
  prepareJob(job);
}

function prepareJob(job) {
  if (cfg.gameContext === false) { delete job.profile; delete job.profilePayload; }
  if (job.profilePayload) {
    try { C.snapshot(job.profilePayload); } catch (err) { finish(job, 'error', err.message); return; }
  } else if (job.profile) {
    const id = C.key(job), ready = contextProfiles.get(id);
    if (ready && ready.job.generation === job.generation && ready.job.profile === job.profile) {
      job.profilePayload = ready.text;
      dropProfile(id);
    } else {
      journal.checkpoint(job, 'awaiting_profile');
      pendingProfiles.set(id, job);
      armContextWait(job);
      publish(chatKey(job), contextRecord(job, 'context', 'Receiving the information checked in Sharing...'), true);
      drainQueue();
      return;
    }
  }
  journal.checkpoint(job, 'queued');
  scheduleJob(job);
}

function scheduleJob(job) {
  if (job.finished || journal.forgotten(job)) return;
  const key = chatKey(job);
  if (recovering || running.has(key) || running.size >= MAX_PARALLEL) {
    queued.set(C.key(job), job);
    publish(key, contextRecord(job, 'queued', 'Request received in full; waiting for an available agent...'), true);
  } else runJob(job);
}

function drainQueue() {
  if (recovering || admitting) return;
  for (const [key, job] of queued) {
    if (running.size >= MAX_PARALLEL) break;
    if (running.has(chatKey(job))) continue;
    queued.delete(key);
    runJob(job);
  }
}

function runJob(job) {
  if (job.finished || journal.forgotten(job)) return;
  clearTimeout(job.contextTimer);
  job.deadline = job.deadline || Date.now() + (cfg.timeoutMs || 1800000);
  if (Date.now() >= job.deadline) { finish(job, 'error', 'The conversation timed out while retrieving addon information.'); return; }
  const key = chatKey(job);
  const cwd = resolveCwd(job.cwd);
  job.cwd = cwd;
  const tag = `#${job.id}${job.session ? '@' + job.session : ''}`;
  signal('sig', job.id, false);
  resetBeats(job.id);
  signal('ack', job.id, true);
  if (!fs.existsSync(cwd)) {
    log(`${tag} cwd does not exist: ${cwd}`);
    const sibs = siblingFolders();
    finish(job, 'error', `Folder does not exist: ${cwd}\n` +
      `Paths are relative to ${DEFAULT_CWD}.` +
      (sibs.length ? `\nFolders there: ${sibs.join(', ')}` : '') +
      `\nUse /wowie cd <folder> to pick one, or /wowie cd alone for the default.`);
    return;
  }
  // Which agent: the chat's own (an "agent=" flag), else the bridge's default.
  const agentId = job.agent ? A.normalizeAgent(job.agent) : DEFAULT_AGENT;
  if (!agentId) {
    log(`${tag} unknown agent "${job.agent}"`);
    finish(job, 'error', `Unknown agent "${job.agent}". This bridge knows: ${A.agentIds().join(', ')}.\n` +
      `Use /wowie agent <name> to pick one, or /wowie agent alone for the default (${DEFAULT_AGENT}).`);
    return;
  }
  job.agent = agentId;
  const agent = A.AGENTS[agentId];
  if (job.reasoning && !(agent.reasoningLevels || []).includes(job.reasoning)) {
    finish(job, 'error', `${agent.name} does not support reasoning level "${job.reasoning}". Choose a supported level or Default in the addon.`);
    return;
  }
  const acfg = A.agentConfig(cfg, agentId, job);
  const cmd = A.resolveCommand(agentId, acfg);
  if (!cmd.found) {
    log(`${tag} ${agentId} not found: ${cmd.note}`);
    finish(job, 'error', `${agent.name} is not installed on the bridge PC: ${cmd.note}.`);
    return;
  }
  const skey = sessKey(job);
  if (job.newSession) { delete state.sessions[skey]; delete state.sessions[key]; job.newSession = false; }
  // Agents keep sessions per project folder, and a session belongs to the agent
  // that made it, so a chat that changes either starts fresh.
  const prevCwd = state.sessionCwd && state.sessionCwd[skey];
  if (prevCwd && !sameFolder(prevCwd, cwd) && state.sessions[skey]) {
    log(`${tag} folder changed (${prevCwd} -> ${cwd}): new session`);
    delete state.sessions[skey]; delete state.sessions[key];
  }
  const prevAgent = (state.sessionAgent && state.sessionAgent[skey]) || 'claude';
  if (prevAgent !== agentId && state.sessions[skey]) {
    log(`${tag} agent changed (${prevAgent} -> ${agentId}): new session`);
    delete state.sessions[skey]; delete state.sessions[key];
  }
  if (Array.isArray(job.allow) && job.allow.length) {
    const added = allowRules(agentId, job.allow);
    log(`${tag} allowed for ${agentId}: ${job.allow.join(', ')}${added.length ? '' : ' (already allowed)'}`);
  }
  maybeOfferRestore(job);
  if (!job.userRecorded) { noteMessage(job, 'user', job.text); job.userRecorded = true; }
  const resume = job.continuation ? job.providerSession : state.sessions[skey] || state.sessions[key];
  job.providerSession = resume || '';

  // A full snapshot is permission-bound to this turn. Never re-inject an older
  // global summary whose fields may since have been unchecked or belong to another chat.
  const ctx = cfg.gameContext === false ? '' : job.profilePayload
    ? 'The explicitly selected addon information is attached to this message as JSON. Use that snapshot, not older character facts.'
    : gameContext();
  const system = P.systemPrompt(ctx, primer());
  const systemShort = P.systemPrompt(ctx, '');
  const promptFile = path.join(TMP_DIR, `prompt-${job.id}-${Date.now().toString(36)}.txt`);
  const prompt = job.continuation || C.prompt(cfg.gameContext === false ? '' : job.profilePayload, job.text);
  const input = agent.input({ prompt, system, systemShort, resume, cfg: acfg });
  if (input.promptFile !== undefined) {
    try { fs.mkdirSync(TMP_DIR, { recursive: true }); fs.writeFileSync(promptFile, input.promptFile); }
    catch (e) { finish(job, 'error', `Could not write the prompt file ${promptFile}: ${e.message}`); return; }
  }
  const args = [...cmd.args, ...agent.args({
    cfg: acfg, resume, cwd, system, systemShort, promptFile,
    prompt, timeoutMs: Math.max(1, job.deadline - Date.now()),
  })];
  const env = agent.env({ ...process.env });
  // Where this run's tools append map commands (docs/MAP.md); any agent can use it.
  try {
    fs.mkdirSync(MAP_DIR, { recursive: true });
    fs.rmSync(mapFileFor(job), { force: true });
    env.WOWIE_MAP_FILE = mapFileFor(job);
  } catch (e) { log(`${tag} map file unavailable: ${e.message}`); }

  journal.checkpoint(job, 'running', { query: null });
  log(`${tag} (${job.via}) ${agent.name} starting in ${cwd}${resume ? ' (resume ' + resume.slice(0, 8) + ')' : ' (new session)'}${ctx ? ' [game context]' : ''}${running.size ? ' [' + (running.size + 1) + ' running]' : ''}`);
  const child = ownership.spawn(cmd.file, args, { cwd, env, stdin: input.stdin !== undefined });
  running.set(key, { job, child });
  publish(key, contextRecord(job, 'working', resume ? 'thinking...' : 'starting a new session...', { session: resume }), true);
  if (input.stdin !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input.stdin); }

  const parser = agent.parser();
  const progress = [];
  let sessionId = resume || '';
  let result = null;       // { text, error } once the agent has produced its reply
  const denied = new Set(job.contextDenied || []); // permission rules remain visible across read continuations
  const notes = [...(job.contextNotes || [])];
  let stderr = '';
  let buffer = '';
  let stdoutText = '';
  let parserError = false;

  const pushProgress = (line) => {
    if (job.finished || journal.forgotten(job)) return;
    progress.push(line);
    while (progress.length > 10) progress.shift();
    beat(job);
    publish(key, contextRecord(job, 'working', progress.join('\n'), { session: sessionId }), false);
  };
  if (agent.stream === 'text') pushProgress(`${agent.name} is working (no live progress)`);
  if (input.note) notes.push(input.note);
  // Long thinking stretches produce no tool events; keep the heartbeat alive anyway.
  const keepalive = setInterval(() => beat(job), 45000);

  const handleLine = (line) => {
    if (parserError || job.finished || journal.forgotten(job)) return;
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (!ev || typeof ev !== 'object') return;
    let r;
    try {
      r = parser.feed(ev);
      if (!r || !Array.isArray(r.progress) || !Array.isArray(r.denied) || !Array.isArray(r.notes)) {
        throw new Error('agent parser returned an invalid event result');
      }
    } catch (err) {
      parserError = true;
      const detail = err instanceof Error ? err.message : String(err);
      result = { text: `${agent.name} returned an unreadable event.`, error: true };
      notes.push(`${agent.name} event parser failed: ${detail}`);
      log(`${tag} parser error: ${err && err.stack ? err.stack : detail}`);
      return;
    }
    if (r.session) sessionId = r.session;
    for (const p of r.progress) pushProgress(p);
    for (const d of r.denied) denied.add(d);
    notes.push(...r.notes);
    if (r.done) result = r.done;
  };

  child.stdout.on('data', (chunk) => {
    if (job.finished || journal.forgotten(job)) return;
    if (agent.stream === 'text') {
      stdoutText += chunk.toString('utf8');
      return;
    }
    buffer += chunk.toString('utf8');
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) handleLine(line);
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

  const timer = setTimeout(() => {
    log(`${tag} timed out after ${cfg.timeoutMs} ms, killing`);
    killTree(child);
  }, Math.max(1, job.deadline - Date.now()));

  const cleanup = () => {
    clearTimeout(timer);
    clearInterval(keepalive);
    if (input.promptFile !== undefined) { try { fs.unlinkSync(promptFile); } catch {} }
  };

  child.on('error', (err) => {
    cleanup();
    finish(job, 'error', `Could not start ${agent.name} (${cmd.file}): ${err.message}\nSet agents.${agentId}.path in config.json.`);
  });

  child.on('close', (code) => {
    cleanup();
    if (job.finished || journal.forgotten(job)) return;
    if (buffer.trim()) handleLine(buffer.trim());
    if (!parserError && typeof parser.finish === 'function') {
      try {
        const r = parser.finish({ stdout: stdoutText, stderr, code });
        if (r && r.session) sessionId = r.session;
        if (r && r.done) result = r.done;
        if (r && Array.isArray(r.notes)) notes.push(...r.notes);
      } catch (err) {
        result = { text: `${agent.name} output parser failed: ${err.message}`, error: true };
      }
    }
    if (sessionId) {
      job.providerSession = sessionId;
      state.sessions[skey] = sessionId;
      (state.sessionCwd = state.sessionCwd || {})[skey] = cwd;
      (state.sessionAgent = state.sessionAgent || {})[skey] = agentId;
    }
    // Map marks count whatever the outcome: the tools already reported them.
    const mapped = takeMapCommands(job, result ? result.text : '');
    if (result) result.text = mapped.text;
    if (mapped.note) notes.push(mapped.note);
    if (result && !result.error) {
      let requested;
      try { requested = C.requests(result.text); }
      catch (err) {
        finish(job, 'error', `Invalid addon information request: ${err.message}`, sessionId);
        return;
      }
      if (requested.queries.length) {
        job.contextNotes = notes;
        job.contextDenied = [...denied];
        requestContext(job, requested.queries);
        return;
      }
      result.text = requested.text;
    }
    const extra = notes.length ? `\n\n[bridge] ${notes.join('\n\n[bridge] ')}` : '';
    if (result && !result.error) {
      const body = String(result.text || '').trim() || (notes.length ? '' : `(${agent.name} finished without a reply)`);
      finish(job, 'done', (body + extra).trim(), sessionId, [...denied]);
    } else if (result) {
      finish(job, 'error', (String(result.text || '') + extra).trim(), sessionId, [...denied]);
    } else {
      finish(job, 'error', `${agent.name} exited with code ${code} and no result.\n${stderr.trim().slice(-1500)}`, sessionId);
    }
  });
}

function finish(job, status, text, session, denied) {
  if (job.finished || journal.forgotten(job)) return;
  let macros = [];
  if (status === 'done') {
    const m = P.extractMacros(text);
    text = m.text + (m.notes.length ? `\n\n[bridge] ${m.notes.join('; ')}` : '');
    macros = m.macros;
  }
  const record = contextRecord(job, status, text, { session, denied, macros });
  const entry = journal.checkpoint(job, 'complete', { result: record, query: null, completed: Date.now(), transcriptRecorded: false });
  job.finished = true;
  clearTimeout(job.contextTimer);
  clearInterval(job.contextWatcher);
  pendingProfiles.delete(C.key(job));
  pendingQueries.delete(C.key(job));
  dropProfile(C.key(job));
  contextPackets.delete(C.key(job));
  contextTransfers.forget(job);
  const key = chatKey(job);
  if (running.get(key)?.job.nonce === job.nonce) running.delete(key);
  queued.delete(C.key(job));
  markHandled(job);
  saveState();
  noteMessage(job, status === 'done' ? 'assistant' : 'system', status === 'done' ? text : 'Bridge error: ' + text);
  entry.transcriptRecorded = true;
  journal.save();
  publish(key, record, true);
  signal('sig', job.id, true);
  log(`#${job.id}${job.session ? '@' + job.session : ''} ${status} (${text.length} chars)`);
  drainQueue();
  if (!recovering && !admitting && exitWhenIdle && running.size === 0 && pendingProfiles.size === 0 && queued.size === 0) process.exit(status === 'done' ? 0 : 1);
}

function recoverRequests() {
  recovering = true;
  const entries = Object.values(journal.data.requests).sort((a, b) => a.accepted - b.accepted);
  for (const entry of entries) {
    const job = entry.job;
    if (journal.data.owners[ownerKey(job)] === job.nonce) requestOwners.set(chatKey(job), job.nonce);
  }
  // Complete a durable forget even if the previous process died between the
  // journal commit and removing its transcript/provider-session files.
  for (const token of Object.keys(journal.data.tombstones)) {
    const [chat, generation] = JSON.parse(token);
    const current = journal.data.generations[chat];
    if (!current || current === generation) {
      if (!chat.startsWith('@')) {
        delete transcripts.chats[chat];
        clearChatSession({ chat });
      }
    }
  }
  for (const entry of [...entries].sort((a, b) => (a.updated || a.accepted) - (b.updated || b.accepted))) {
    const job = entry.job;
    if (journal.forgotten(job) || !Object.hasOwn(job, 'providerSession')) continue;
    if (!job.providerSession) { clearChatSession(job); continue; }
    const key = sessKey(job);
    state.sessions[key] = job.providerSession;
    (state.sessionCwd = state.sessionCwd || {})[key] = job.cwd;
    (state.sessionAgent = state.sessionAgent || {})[key] = job.agent;
  }
  for (const entry of entries) {
    const job = { ...entry.job };
    if (journal.forgotten(job) || entry.phase === 'forgotten' || entry.phase === 'expired') continue;
    if (entry.phase === 'complete') {
      const record = entry.result;
      if (!record) throw new Error('Completed request has no durable result');
      if (!entry.transcriptRecorded) {
        noteMessage(job, record.status === 'done' ? 'assistant' : 'system', record.status === 'done' ? record.text : 'Bridge error: ' + record.text);
        entry.transcriptRecorded = true;
      }
      publish(chatKey(job), record, true);
    } else if (entry.phase === 'running') {
      finish(job, 'error', 'The bridge stopped while this agent request was running. Its outcome is uncertain and it was not run again; inspect any external changes before sending a new question.');
    } else if (entry.phase === 'context_query') {
      if (!journal.owns(job)) { finish(job, 'error', 'This addon information request was superseded by a newer question.'); continue; }
      if (!entry.query || !P.validNonce(entry.query.request) || !Array.isArray(entry.query.queries)) throw new Error('Invalid durable addon information query');
      pendingQueries.set(C.key(job), { job, ...entry.query });
      running.set(chatKey(job), { job, child: null });
      armContextWait(job);
      publish(chatKey(job), contextRecord(job, 'context_query', 'Reading information allowed by your current Sharing checkboxes...', entry.query), true);
    } else if (entry.phase === 'queued' || entry.phase === 'awaiting_profile') {
      if (entry.phase === 'awaiting_profile' && !journal.owns(job)) finish(job, 'error', 'This information-sharing request was superseded by a newer question.');
      else prepareJob(job);
    } else throw new Error(`Unknown durable request phase: ${entry.phase}`);
  }
  journal.save(); saveState(); saveTranscripts();
  recovering = false;
}

// ---------------------------------------------------------------------------
// Input loops
// ---------------------------------------------------------------------------

function pollSavedVariables() {
  findSavedVars();
  let st, src;
  try {
    st = fs.statSync(SAVED_VARS);
    if (st.mtimeMs === lastMtime) return;
    src = fs.readFileSync(SAVED_VARS, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') log(`SavedVariables unavailable: ${err.message}`);
    return;
  }
  lastMtime = st.mtimeMs;
  let controls, response, job;
  try {
    controls = P.parseControlOutbox(src);
    response = P.parseContextOutbox(src);
    job = P.parseOutbox(src);
  } catch (err) { log(`SavedVariables rejected: ${err.message}`); return; }
  for (const control of controls) submit(control);
  if (response) submit(response);
  if (job) submit(job);
}

// The launcher is loaded only when capture is enabled (including isolated --once runs).
let captureProcess = null;
let captureRestart = null;
let captureStopping = false;

function stopCapture() {
  captureStopping = true;
  clearTimeout(captureRestart);
  captureRestart = null;
  if (!captureProcess) return;
  const { child, closeReaders } = captureProcess;
  captureProcess = null;
  closeReaders();
  killTree(child);
}

process.once('exit', stopCapture);
process.once('SIGINT', () => { stopCapture(); process.exit(130); });
process.once('SIGTERM', () => { stopCapture(); process.exit(143); });

function startCapture() {
  if (captureStopping) return;
  captureRestart = null;
  let cmd, args;
  try {
    [cmd, args] = require('./capture').captureCommand(cap, { here: HERE, clientDir: CLIENT_DIR });
  } catch (err) {
    log(`capture requires action: ${err.message} Fix the configuration and restart the bridge.`);
    return;
  }
  const ps = ownership.spawn(cmd, args, { cwd: process.cwd(), env: process.env, stdin: false });
  const rl = readline.createInterface({ input: ps.stdout });
  const onLine = (line) => {
    if (captureStopping) return;
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (ev.info) { log('capture:', ev.info); return; }
    if (ev.warn) { log('capture:', ev.warn); return; }
    if (ev.error) { log('capture error:', ev.error); return; }
    if (typeof ev.id === 'number') {
      const jobs = jobsFromStrip(ev.id, ev.text);
      log(`strip #${ev.id}: ${jobs.length} message(s)`);
      for (const job of jobs) {
        if (CAPTURE_DISPLAYS.has(ev.display)) job.captureDisplay = ev.display;
        submit(job);
      }
    }
  };
  const onStderr = (d) => {
    if (!captureStopping) log('capture stderr:', String(d).trim().slice(0, 300));
  };
  const closeReaders = () => {
    rl.removeListener('line', onLine);
    rl.close();
    ps.stderr.removeListener('data', onStderr);
    ps.stdout.destroy();
    ps.stderr.destroy();
  };
  captureProcess = { child: ps, closeReaders };
  rl.on('line', onLine);
  ps.stderr.on('data', onStderr);
  ps.on('error', (err) => {
    if (!captureStopping) log(`capture could not start (${cmd}): ${err.message}`);
  });
  ps.once('close', (code) => {
    closeReaders();
    if (captureProcess?.child === ps) captureProcess = null;
    if (captureStopping) return;
    if (code === 2) {
      log('capture requires action (exit 2); resolve the compositor permission/setup error and restart the bridge. Run npm run probe to inspect direct game-window capture.');
      return;
    }
    log(`capture exited (${code}); restarting in 5 s`);
    captureRestart = setTimeout(startCapture, 5000);
  });
}

function agentLine(id) {
  const acfg = A.agentConfig(cfg, id);
  const cmd = A.resolveCommand(id, acfg);
  if (!cmd.found) return `not found - ${cmd.note}`;
  const where = cmd.args.length ? `${cmd.file} ${cmd.args.join(' ')}` : cmd.file;
  const rules = Array.isArray(acfg.allowedTools) ? acfg.allowedTools.length : 0;
  return `${where}  [${acfg.permissionMode || 'acceptEdits'}${id === 'codex' ? '' : ', ' + rules + ' allowed tool rules'}${acfg.model ? ', model ' + acfg.model : ''}]`;
}

function banner() {
  console.log('Wowie bridge');
  console.log(`  folder   : ${DEFAULT_CWD}  (${DEFAULT_CWD_SOURCE}; chats can override with /wowie cd)`);
  console.log(`  addons   : ${cfg.addonDir}`);
  if (path.basename(CLIENT_DIR) === '_classic_beta_' && fs.existsSync(path.join(path.dirname(CLIENT_DIR), '_forever_'))) {
    console.log('  WARNING  : this config is on the beta client, but _forever_ is installed - run: node setup.js, then restart WoW');
  }
  console.log(`  addon    : ${addonInstalled() ? 'installed' : 'NOT INSTALLED - run: node setup.js, then restart WoW'}`);
  console.log(`  slots    : ${slotsInstalled() ? SLOTS + ' installed' : 'NOT INSTALLED - run: node setup.js (or node bridge/install-slots.js), then restart WoW'}`);
  console.log(`  capture  : ${cap.enabled ? 'on (' + cap.processName + ', ' + cap.cellsPerRow + 'x' + cap.maxRows + ' cells of ' + cap.cellPx + 'px)' : 'off'}`);
  console.log(`  parallel : up to ${MAX_PARALLEL} chats at once`);
  console.log(`  fallback : ${SAVED_VARS || 'waiting for the first login'}`);
  console.log(`  agent    : ${DEFAULT_AGENT} (default; chats pick their own with /wowie agent)`);
  for (const id of A.agentIds()) console.log(`  ${id.padEnd(9)}: ${agentLine(id)}`);
  console.log(`  sessions : ${Object.keys(state.sessions).length} saved`);
  const ctx = gameContext();
  console.log(`  context  : ${cfg.gameContext === false ? 'off (gameContext in config.json)' : ctx ? (ctx.split('\n').find(l => /^Character:/i.test(l)) || ctx.split('\n')[0]).slice(0, 100) : 'none yet (the addon sends it with its hello; /wowie context in game)'}`);
  console.log(`  primer   : ${!PRIMER_FILE ? 'off (primerFile in config.json)' : primer() ? path.resolve(REPO, PRIMER_FILE) + ' (' + primer().length + ' chars, with the context)' : 'NOT FOUND: ' + path.resolve(REPO, PRIMER_FILE)}`);
  console.log('Leave this window open while you play. Ctrl+C to stop.\n');
}

// Query installed CLI catalogs independently; capture and chats never wait on them.
function discoverModels() {
  for (const id of A.agentIds()) {
    const acfg = A.agentConfig(cfg, id);
    if (!A.AGENTS[id].modelCatalog || !A.resolveCommand(id, acfg).found) continue;
    const child = ownership.spawn(process.execPath, [path.join(HERE, 'ownership.js'), 'catalog', id, JSON.stringify(acfg)],
      { cwd: process.cwd(), env: process.env, stdin: false });
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { errors = (errors + chunk.toString('utf8')).slice(-1500); });
    child.on('error', err => log(`${A.displayName(id)} model list unavailable:`, err.message));
    child.on('close', code => {
      if (code !== 0) { log(`${A.displayName(id)} model list unavailable: ${errors || `catalog exited ${code}`}`); return; }
      let models;
      try { models = JSON.parse(output); }
      catch (err) { log(`${A.displayName(id)} model list unreadable: ${err.message}`); return; }
      if (!Array.isArray(models) || !models.length) return;
      agentOptions[id].models = [...new Set([...agentOptions[id].models, ...models])];
      publishNow();
    });
  }
}

findSavedVars();
banner();
recoverRequests();
setInterval(maintainContext, Math.min(30000, Math.max(10, Math.floor((cfg.timeoutMs || 1800000) / 2)))).unref();
if (inject !== null) {
  submit({ id: state.lastId + 1, nonce: randomBytes(16).toString('hex'), generation: randomBytes(16).toString('hex'), session: '', chat: '', text: inject, cwd: '', newSession: false, via: 'inject', agent: injectAgent || '' });
} else {
  pollSavedVariables();
  drainQueue();
  if (once) {
    if (running.size === 0 && pendingProfiles.size === 0 && queued.size === 0) { console.log('nothing pending'); process.exit(rejectedInput ? 1 : 0); }
  } else {
    setInterval(pollSavedVariables, cfg.pollMs || 750);
    discoverModels();
    heartbeat();
    setInterval(heartbeat, cfg.presenceIntervalMs || 30000);
    if (cap.enabled) startCapture();
  }
}
}

main().catch(err => { console.error(`Wowie bridge stopped: ${err.stack || err.message}`); process.exit(err.exitCode || 1); });
