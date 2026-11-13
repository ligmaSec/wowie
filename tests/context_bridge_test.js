'use strict';
// Real bridge process + real addon executor; a deterministic agent drives a read request.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');
const ROOT = path.resolve(__dirname, '..');
const P = require('../bridge/protocol');
const A = require('../bridge/agents');

function addonVM(fullAddon = false) {
  const L = lauxlib.luaL_newstate(); lualib.luaL_openlibs(L);
  const run = (code, arg) => {
    if (lauxlib.luaL_loadstring(L, to_luastring(code)) !== lua.LUA_OK) throw new Error(to_jsstring(lua.lua_tostring(L, -1)));
    if (arg !== undefined) lua.lua_pushstring(L, to_luastring(arg));
    if (lua.lua_pcall(L, arg === undefined ? 0 : 1, 0, 0) !== lua.LUA_OK) throw new Error(to_jsstring(lua.lua_tostring(L, -1)));
  };
  const get = expr => {
    run(`local value = (${expr}); if value == nil then RESULT = nil else RESULT = tostring(value) end`);
    lua.lua_getglobal(L, to_luastring('RESULT'));
    const result = lua.lua_isnil(L, -1) ? null : to_jsstring(lua.lua_tostring(L, -1)); lua.lua_pop(L, 1); return result;
  };
  run(fs.readFileSync(path.join(ROOT, 'tests/wow_stub.lua'), 'utf8'));
  run('WoWAIDB = {settings={context=true,sharing={mail=false}}}');
  for (const name of fullAddon ? ['Codec.lua', 'Inbox.lua', 'WoWAI.lua', 'Context.lua', 'ContextUI.lua'] : ['Context.lua']) {
    run(fs.readFileSync(path.join(ROOT, 'addon/WoWAI', name), 'utf8'), 'WoWAI');
  }
  return { run, get };
}

function waitInbox(file, vm, wanted, globalName = 'WoWAI_Inbox') {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); watcher.close(); error ? reject(error) : resolve(value); };
    const inspect = () => {
      try {
        if (!fs.existsSync(file)) return;
        const source = fs.readFileSync(file, 'utf8');
        if (!source.trim()) return;
        vm.run(source);
        const status = vm.get(`${globalName}.replies[1] and ${globalName}.replies[1].status`);
        if (wanted(status)) finish(null, status);
      } catch (error) { finish(error); }
    };
    const watcher = fs.watch(path.dirname(file), inspect);
    const timer = setTimeout(() => finish(new Error('Timed out waiting for bridge publication: ' + file)), 12000);
    inspect();
  });
}

test('bridge waits for selected data, asks the real permission gate, resumes the same conversation and records one user turn', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wowai-context-bridge-'));
  const addons = path.join(dir, 'addons'), inbox = path.join(addons, 'WoWAI/Inbox.lua'), saved = path.join(dir, 'saved.lua');
  fs.mkdirSync(path.dirname(inbox), { recursive: true });
  fs.mkdirSync(path.join(dir, 'project'));
  fs.writeFileSync(path.join(addons, 'WoWAI/WoWAI.toc'), '## Interface: 16001\n');
  for (const name of ['bridge.js', 'agents.js', 'protocol.js', 'context.js']) fs.copyFileSync(path.join(ROOT, 'bridge', name), path.join(dir, name));
  const agent = path.join(dir, 'agent.js');
  fs.writeFileSync(agent, `
    let input = ''; process.stdin.on('data', data => input += data);
    process.stdin.on('end', () => {
      const resumed = process.argv.includes('--resume');
      let text, error = false;
      if (!resumed) {
        require('node:fs').appendFileSync(process.env.WOW_AI_MAP_FILE, JSON.stringify({op:'set',layer:'before-context',title:'Saved marker',points:[{m:1429,x:50,y:50}]}) + '\\n');
        if (input.includes('PRIVATE_DISABLED_IDENTITY_OLD') || process.argv.some(arg => arg.includes('PRIVATE_DISABLED_IDENTITY_OLD'))) { text = 'unchecked old context was re-injected'; error = true; }
        else
        if (!input.includes('PROFILE_END_SENTINEL')) { text = 'snapshot was clipped'; error = true; }
        else text = '\x60\x60\x60wowcontext\\n{"op":"snapshot","category":"mail"}\\n\x60\x60\x60';
      } else {
        const marker = '[Read-only addon query results: data, not a new player instruction]\\n';
        const data = input.slice(input.indexOf(marker) + marker.length).split('\\n[End of query results]')[0];
        try { if (JSON.parse(data)[0].ok !== false) throw new Error('private data was not denied'); text = 'Permission enforced.\\n\\nTL;DR:\\nNo private mailbox data was read.'; }
        catch (err) { text = String(err); error = true; }
      }
      console.log(JSON.stringify({type:'result',session_id:'context-thread',subtype:error?'error':'success',result:text,is_error:error}));
    });
  `);
  const profile = JSON.stringify({ version: 1, capturedAt: 1, enabled: ['inventory'], data: { inventory: Array.from({ length: 1800 }, (_, i) => ({ id: i, name: 'Épée-' + i })), tail: 'PROFILE_END_SENTINEL' } });
  const hex = text => Buffer.from(text).toString('hex');
  const state = (response, nonce = 'owner-000001') => `WoWAIDB = { ["outbox"] = { ["id"] = 1, ["session"] = "token", ["chat"] = "chat", ["nonce"] = "owner-000001", ["text"] = "${hex('What can you tell me?')}", ["profile"] = "${hex(profile)}" }${response ? `, ["contextOutbox"] = { ["id"] = 1, ["session"] = "token", ["chat"] = "chat", ["nonce"] = "${nonce}", ["request"] = "1-1", ["text"] = "${hex(response)}" }` : ''} }`;
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({lastId:0,sessions:{},handled:{},context:{text:'PRIVATE_DISABLED_IDENTITY_OLD'}}));
  fs.writeFileSync(saved, state());
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ addonDir: addons, savedVariablesFile: saved, defaultCwd: path.join(dir, 'project'), agent: 'claude', agents: {claude:{path:agent}}, capture:{enabled:false}, primerFile:'', timeoutMs:15000, pollMs:25, slots:1 }));
  const vm = addonVM();
  const waiting = waitInbox(inbox, vm, status => status === 'context_query' || status === 'error' || status === 'done');
  const child = spawn(process.execPath, ['bridge.js', '--once'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const exited = new Promise(resolve => child.on('exit', code => resolve(code)));
  t.after(async () => { if (child.exitCode === null) { child.kill(); await exited; } fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal(await waiting, 'context_query', output);
  assert.equal(vm.get('WoWAI_Inbox.requestProtocol'), '1');
  assert.equal(vm.get('WoWAI_Inbox.replies[1].nonce'), 'owner-000001');
  assert.equal(vm.get('WoWAI_Inbox.map.layers[1].name'), 'before-context', 'map side effects must be published before a read-only continuation waits');
  const response = vm.get('WoWAIContext.Query(WoWAI_Inbox.replies[1].queries[1])');
  assert.equal(JSON.parse(response).ok, false, 'the real current checkbox gate rejects unchecked mail');
  fs.writeFileSync(saved + '.tmp', state('[' + response + ']', 'owner-000000')); fs.renameSync(saved + '.tmp', saved);
  await new Promise(resolve => setTimeout(resolve, 150));
  vm.run(fs.readFileSync(inbox, 'utf8'));
  assert.equal(vm.get('WoWAI_Inbox.replies[1].status'), 'context_query', 'a reused numeric id and query round cannot resume another nonce owner');
  assert.equal(child.exitCode, null);
  const final = waitInbox(inbox, vm, status => status === 'done' || status === 'error');
  fs.writeFileSync(saved + '.tmp', state('[' + response + ']')); fs.renameSync(saved + '.tmp', saved);
  assert.equal(await final, 'done', output);
  assert.equal(await exited, 0, output);
  const transcripts = JSON.parse(fs.readFileSync(path.join(dir, 'transcripts.json'), 'utf8'));
  assert.equal(transcripts.chats.chat.messages.filter(message => message.role === 'user').length, 1, 'information fetches must not duplicate the player turn');
  assert.ok(!JSON.stringify(transcripts).includes('PROFILE_END_SENTINEL'), 'full private snapshots are not copied into chat transcripts');
  const bridgeState = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(bridgeState.sessions['chat:chat'], 'context-thread');
  assert.equal(bridgeState.handledNonces.token['owner-000001'], 1);
  assert.equal(bridgeState.map.layers['before-context'].points.length, 1, 'resuming must not erase a map command from an earlier agent step');
});

function waitFor(predicate) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 12000;
    const inspect = () => {
      try {
        if (predicate()) return resolve();
        if (Date.now() >= deadline) return reject(new Error('Timed out waiting for bridge fixture'));
        setTimeout(inspect, 10);
      } catch (error) { reject(error); }
    };
    inspect();
  });
}

function bridgeSandbox(t, initialState, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wowai-request-identity-'));
  const addons = path.join(dir, 'addons'), inbox = path.join(addons, 'WoWAI/Inbox.lua'), saved = path.join(dir, 'saved.lua');
  fs.mkdirSync(path.dirname(inbox), { recursive: true });
  fs.mkdirSync(path.join(dir, 'project'));
  fs.writeFileSync(path.join(addons, 'WoWAI/WoWAI.toc'), '## Interface: 16001\n');
  const slots = Array.from({ length: options.slots || 1 }, (_, i) => path.join(addons, 'WoWAI_S' + P.pad3(i + 1), 'Inbox.lua'));
  for (const file of slots) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, ''); }
  if (options.presence) fs.mkdirSync(path.join(addons, 'WoWAI/presence'));
  for (const name of ['bridge.js', 'agents.js', 'protocol.js', 'context.js']) fs.copyFileSync(path.join(ROOT, 'bridge', name), path.join(dir, name));
  const calls = path.join(dir, 'calls.jsonl');
  const agent = path.join(dir, 'agent.js');
  fs.writeFileSync(agent, `
    const fs = require('node:fs'), path = require('node:path');
    if (process.argv.includes('app-server') || process.argv.includes('models')) process.exit(0);
    let input = ''; process.stdin.on('data', data => input += data);
    process.stdin.on('end', () => {
      if (!input) return;
      const calls = path.join(__dirname, 'calls.jsonl');
      fs.appendFileSync(calls, JSON.stringify({started: true}) + '\\n');
      const attempt = fs.readFileSync(calls, 'utf8').trim().split('\\n').length;
      const timer = setInterval(() => {
        if (!fs.existsSync(path.join(__dirname, 'release-' + attempt))) return;
        clearInterval(timer);
        console.log(JSON.stringify({type:'result',session_id:'identity-thread',subtype:'success',result:'Question completed.\\n\\nTL;DR:\\nDone.'}));
      }, 10);
    });
  `);
  const clockFile = path.join(dir, 'clock');
  const clockPreload = path.join(dir, 'clock.js');
  let now = Date.now();
  const advance = seconds => {
    now += seconds * 1000;
    fs.writeFileSync(clockFile + '.tmp', String(now)); fs.renameSync(clockFile + '.tmp', clockFile);
    return Math.floor(now / 1000);
  };
  if (options.clock) {
    advance(0);
    fs.writeFileSync(clockPreload, `const fs = require('node:fs'); Date.now = () => Number(fs.readFileSync(${JSON.stringify(clockFile)}, 'utf8'));`);
  }
  const captureFile = path.join(dir, 'capture.json');
  let captureAttempt = 0;
  if (options.capture) fs.writeFileSync(path.join(dir, 'capture_x11.py'), `
    const fs = require('node:fs'), file = ${JSON.stringify(captureFile)}, parent = process.ppid;
    let previous = '';
    const inspect = () => {
      if (!fs.existsSync(file)) return;
      const source = fs.readFileSync(file, 'utf8');
      if (source !== previous) { previous = source; console.log(source); }
    };
    fs.watch(__dirname, inspect); inspect();
    setInterval(() => { if (process.ppid !== parent) process.exit(); }, 25);
  `);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ addonDir: addons, savedVariablesFile: saved, defaultCwd: path.join(dir, 'project'), agent: 'claude', agents: Object.fromEntries(A.agentIds().map(id => [id, {path:agent}])), capture:{enabled:!!options.capture, python:process.execPath}, primerFile:'', timeoutMs:15000, pollMs:25, slots:slots.length, presenceIntervalMs:options.presenceIntervalMs }));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(initialState));
  const children = [];
  const start = (args = ['--once']) => {
    const child = spawn(process.execPath, [...(options.clock ? ['--require', clockPreload] : []), 'bridge.js', ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
    const exited = new Promise(resolve => child.on('exit', code => resolve(code)));
    const result = { child, exited, output: () => output };
    children.push(result);
    return result;
  };
  t.after(async () => {
    for (const { child, exited } of children) if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const write = source => { fs.writeFileSync(saved + '.tmp', source); fs.renameSync(saved + '.tmp', saved); };
  const outbox = (nonce, chat = 'chat', id = 146) => `WoWAIDB = { ["outbox"] = { ["id"] = ${id}, ["session"] = "token", ["chat"] = "${chat}", ${nonce == null ? '' : `["nonce"] = "${nonce}",`} ["text"] = "${Buffer.from('The same player question').toString('hex')}" } }`;
  const release = attempt => fs.writeFileSync(path.join(dir, 'release-' + attempt), '');
  const callCount = () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').length : 0;
  const messages = (chat = 'chat') => JSON.parse(fs.readFileSync(path.join(dir, 'transcripts.json'), 'utf8')).chats[chat].messages;
  const strip = (text, id = 146) => {
    fs.writeFileSync(captureFile + '.tmp', JSON.stringify({ id, text, attempt: ++captureAttempt })); fs.renameSync(captureFile + '.tmp', captureFile);
  };
  return { dir, addons, inbox, slots, write, outbox, start, release, callCount, messages, advance, strip };
}

function waitClock(fixture, vm, now) {
  return Promise.all([fixture.inbox, ...fixture.slots].map((file, i) => {
    const globalName = i === 0 ? 'WoWAI_Inbox' : 'WoWAI_SlotData';
    return waitInbox(file, vm, () => Number(vm.get(`${globalName}.now`)) >= now, globalName);
  }));
}

function loginClient(vm, now) {
  vm.run(`STUB.epoch = ${now} - math.floor(STUB.now); STUB.FireEvent("ADDON_LOADED", "WoWAI"); STUB.FireEvent("PLAYER_LOGIN"); STUB.RunTimers()`);
}

function deliverSlot(vm, file, seconds) {
  vm.run(`STUB.onLoadAddOn = function(name)\n${fs.readFileSync(file, 'utf8')}\nend; STUB.now = STUB.now + ${seconds}; STUB.Tick()`);
}

test('periodic slot clocks keep an idle real client connected without any agent work', async t => {
  for (const presence of [true, false]) await t.test(presence ? 'with presence files' : 'without a presence directory', async t => {
    const fixture = bridgeSandbox(t, { lastId: 0, sessions: {}, handled: {} }, { clock: true, presence, slots: 3, presenceIntervalMs: 25 });
    const vm = addonVM(true), initial = fixture.advance(0);
    fixture.start([]);
    await waitClock(fixture, vm, initial);
    loginClient(vm, initial);
    deliverSlot(vm, fixture.slots[0], 6);
    assert.equal(vm.get('WoWAI.IsConnected()'), 'true');
    const history = vm.get('#WoWAIDB.chats[1].history');
    for (let step = 0; step < 4; step++) {
      const now = fixture.advance(610);
      await waitClock(fixture, vm, now);
      deliverSlot(vm, fixture.slots[step % fixture.slots.length], 610);
      assert.equal(vm.get('WoWAI.BridgeState()'), 'ok', 'fresh periodic files must maintain consumer-visible liveness over forty idle minutes');
      assert.equal(vm.get('WoWAI.IsConnected()'), 'true');
      assert.equal(vm.get('#WoWAIDB.chats[1].history'), history, 'maintenance must not create conversation turns');
      assert.equal(vm.get('#WoWAI_Inbox.replies'), '0');
      assert.equal(fixture.callCount(), 0, 'clock maintenance must never invoke an agent');
    }
    assert.equal(fs.existsSync(path.join(fixture.addons, 'WoWAI/presence')), presence);
    assert.equal(fs.existsSync(path.join(fixture.dir, 'transcripts.json')), false);
  });
});

test('an idle heartbeat retains the latest completed reply for a client that reads it later', async t => {
  const fixture = bridgeSandbox(t, { lastId: 0, sessions: {}, handled: {} }, { clock: true, slots: 3, presenceIntervalMs: 25 });
  const vm = addonVM(true), initial = fixture.advance(0);
  fixture.start([]);
  await waitClock(fixture, vm, initial);
  loginClient(vm, initial);
  deliverSlot(vm, fixture.slots[0], 6);
  vm.run('WoWAI.Send("The same player question")');
  const chat = vm.get('WoWAIDB.chats[1].id'), nonce = vm.get('WoWAIDB.chats[1].request.nonce'), id = Number(vm.get('WoWAIDB.chats[1].pendingId'));
  const done = waitInbox(fixture.inbox, vm, status => status === 'done');
  fixture.write(fixture.outbox(nonce, chat, id));
  fixture.release(1);
  await done;
  const originalReply = {
    text: vm.get('WoWAI_Inbox.replies[1].text'),
    summary: vm.get('WoWAI_Inbox.replies[1].summary'),
  };
  const messages = fixture.messages(chat);
  const now = fixture.advance(3600);
  await waitClock(fixture, vm, now);
  for (const file of fixture.slots) {
    vm.run(fs.readFileSync(file, 'utf8'));
    assert.equal(vm.get('WoWAI_SlotData.replies[1].nonce'), nonce);
    assert.equal(vm.get('WoWAI_SlotData.replies[1].text'), originalReply.text);
    assert.equal(vm.get('WoWAI_SlotData.replies[1].summary'), originalReply.summary);
  }
  deliverSlot(vm, fixture.slots[1], 3600);
  assert.equal(vm.get('WoWAIDB.chats[1].pendingId'), null, 'the real reply consumer can still complete the original nonce after a long idle');
  assert.equal(vm.get('WoWAIDB.chats[1].history[#WoWAIDB.chats[1].history].text'), originalReply.text);
  assert.equal(vm.get('WoWAI.IsConnected()'), 'true');
  await waitClock(fixture, vm, fixture.advance(610));
  deliverSlot(vm, fixture.slots[2], 610);
  assert.equal(vm.get('#WoWAIDB.chats[1].history'), '2', 'repeated heartbeat copies must not duplicate a delivered assistant turn');
  assert.equal(fixture.callCount(), 1);
  assert.deepEqual(fixture.messages(chat), messages);
});

test('the same immutable hello retries a lost return path from refreshed metadata without agent or transcript turns', async t => {
  // Leave the periodic timer far in the future: only the duplicate hello can refresh these clocks.
  const fixture = bridgeSandbox(t, { lastId: 0, sessions: {}, handled: {} }, { clock: true, capture: true, slots: 3, presenceIntervalMs: 3600000 });
  const vm = addonVM(true), initial = fixture.advance(0);
  const running = fixture.start([]);
  await waitClock(fixture, vm, initial);
  loginClient(vm, initial);
  const packet = () => ['WoWAIDB.session', 'WoWAIDB.hello.chat', 'WoWAIDB.hello.id', 'WoWAIDB.hello.cwd', 'WoWAIDB.hello.flags .. ";c"', 'WoWAIDB.hello.name', 'WoWAIDB.hello.ctx', 'WoWAIDB.hello.text'].map(expr => vm.get(expr)).join('\x1f');
  const hello = packet(), id = Number(vm.get('WoWAIDB.hello.id'));
  const ack = path.join(fixture.addons, 'WoWAI/ack', P.pad3(P.slotNumber(id, fixture.slots.length)) + '.wav');
  fs.mkdirSync(path.dirname(ack));
  fixture.strip(hello, id);
  await waitFor(() => running.output().includes('hello from session') && fs.existsSync(ack) && fs.readFileSync(ack).equals(P.SILENT_WAV));
  // The bridge accepted the hello, but its first clock/ACK never reached the client.
  assert.equal(vm.get('WoWAI.IsConnected()'), 'false');
  const transcripts = fs.readFileSync(path.join(fixture.dir, 'transcripts.json'), 'utf8');
  const state = fs.readFileSync(path.join(fixture.dir, 'state.json'), 'utf8');
  vm.run('STUB.onLoadAddOn = function() WoWAI_SlotData = nil end; STUB.now = STUB.now + 1600; STUB.Tick()');
  assert.equal(vm.get('WoWAI.IsConnected()'), 'false');
  vm.run('WoWAI.Connect()');
  assert.equal(packet(), hello, 'Connect retries the immutable existing request instead of minting another nonce or context');
  fs.writeFileSync(ack, '');
  const refreshed = waitClock(fixture, vm, fixture.advance(1600));
  fixture.strip(packet(), id);
  await refreshed;
  await waitFor(() => fs.readFileSync(ack).equals(P.SILENT_WAV));
  deliverSlot(vm, fixture.slots[1], 6);
  assert.equal(vm.get('WoWAI.IsConnected()'), 'true', 'a same-nonce hello must recover the actual client without restarting Node');
  assert.equal(fixture.callCount(), 0);
  assert.equal(fs.readFileSync(path.join(fixture.dir, 'transcripts.json'), 'utf8'), transcripts);
  assert.equal(fs.readFileSync(path.join(fixture.dir, 'state.json'), 'utf8'), state, 'a duplicate hello cannot mutate request receipts, context or settings');
});

test('an old hello id runs a new nonce, queued reused ids stay distinct, and retries never duplicate turns', async t => {
  const state = { lastId: 146, sessions: {}, handled: { token: { 146: 1 } } };
  const hello = P.jobsFromStrip(146, ['token', 'chat', '146', '', 'h;nonce=hello-000146', 'Chat', ''].join('\x1f'))[0];
  P.markHandled(state, hello);
  const fixture = bridgeSandbox(t, state), vm = addonVM();
  fixture.write(fixture.outbox('question-000146'));
  const firstWorking = waitInbox(fixture.inbox, vm, status => status === 'working');
  const running = fixture.start([]);
  assert.equal(await firstWorking, 'working');
  assert.equal(vm.get('WoWAI_Inbox.replies[1].nonce'), 'question-000146');
  fixture.write(fixture.outbox('question-000146') + '\n-- retry');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(fixture.callCount(), 1, 'a retry while running must not start another agent');
  fixture.write(fixture.outbox('question-000147'));
  await waitFor(() => fs.readFileSync(path.join(fixture.dir, 'bridge.log'), 'utf8').includes('#146@token queued'));
  fixture.write(fixture.outbox('question-000147') + '\n-- queued retry');
  await new Promise(resolve => setTimeout(resolve, 100));
  const secondWorking = waitInbox(fixture.inbox, vm, status => status === 'working' && vm.get('WoWAI_Inbox.replies[1].nonce') === 'question-000147');
  fixture.release(1);
  await secondWorking;
  const done = waitInbox(fixture.inbox, vm, status => status === 'done' && vm.get('WoWAI_Inbox.replies[1].nonce') === 'question-000147');
  fixture.release(2);
  await done;
  running.child.kill(); await running.exited;
  assert.equal(fixture.callCount(), 2);
  assert.equal(fixture.messages().filter(message => message.role === 'user').length, 2);
  assert.equal(fixture.messages().filter(message => message.role === 'assistant').length, 2);
  const retry = fixture.start();
  assert.equal(await retry.exited, 0, retry.output());
  assert.equal(fixture.callCount(), 2, 'a saved outbox retry after restart must not duplicate either turn');
  fixture.write(fixture.outbox('question-000148'));
  fixture.release(3);
  const newTurn = fixture.start();
  assert.equal(await newTurn.exited, 0, newTurn.output());
  assert.equal(fixture.callCount(), 3, 'identical text and numeric id with a new nonce is another player turn');
  assert.equal(fixture.messages().filter(message => message.role === 'user').length, 3);
});

test('nonce-less input cannot finish an old client question, run an AI or poison a later valid request', async t => {
  const fixture = bridgeSandbox(t, { lastId: 146, sessions: {}, handled: { token: {146: 1} } }), vm = addonVM();
  fixture.write(fixture.outbox(null));
  const rejected = fixture.start();
  assert.equal(await rejected.exited, 1, rejected.output());
  assert.equal(fixture.callCount(), 0);
  vm.run(fs.readFileSync(fixture.inbox, 'utf8'));
  assert.equal(vm.get('WoWAI_Inbox.requestProtocol'), '1');
  assert.equal(vm.get('#WoWAI_Inbox.replies'), '0', 'compatibility metadata cannot complete the old pending question');
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.dir, 'state.json'), 'utf8')).handledNonces, undefined);
  fixture.write(fixture.outbox('recovered-000146'));
  fixture.release(1);
  const recovered = fixture.start();
  assert.equal(await recovered.exited, 0, recovered.output());
  assert.equal(fixture.callCount(), 1);
  assert.equal(fixture.messages().filter(message => message.role === 'user').length, 1);
});

test('inject mints a fresh nonce for every invocation and publishes protocol 1 replies', async t => {
  const fixture = bridgeSandbox(t, { lastId: 0, sessions: {}, handled: {} }), vm = addonVM(), nonces = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    fixture.release(attempt);
    const injected = fixture.start(['--inject', 'A deterministic CLI question']);
    assert.equal(await injected.exited, 0, injected.output());
    vm.run(fs.readFileSync(fixture.inbox, 'utf8'));
    assert.equal(vm.get('WoWAI_Inbox.requestProtocol'), '1');
    assert.equal(vm.get('WoWAI_Inbox.replies[1].status'), 'done');
    const nonce = vm.get('WoWAI_Inbox.replies[1].nonce');
    assert.match(nonce, /^[A-Za-z0-9_-]{8,64}$/);
    nonces.push(nonce);
  }
  assert.notEqual(nonces[0], nonces[1]);
  assert.equal(fixture.callCount(), 2);
});
