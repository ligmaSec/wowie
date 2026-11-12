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

function addonVM() {
  const L = lauxlib.luaL_newstate(); lualib.luaL_openlibs(L);
  const run = code => {
    if (lauxlib.luaL_dostring(L, to_luastring(code)) !== lua.LUA_OK) throw new Error(to_jsstring(lua.lua_tostring(L, -1)));
  };
  const get = expr => {
    run(`local value = (${expr}); RESULT = value == nil and nil or tostring(value)`);
    lua.lua_getglobal(L, to_luastring('RESULT'));
    const result = lua.lua_isnil(L, -1) ? null : to_jsstring(lua.lua_tostring(L, -1)); lua.lua_pop(L, 1); return result;
  };
  run(fs.readFileSync(path.join(ROOT, 'tests/wow_stub.lua'), 'utf8'));
  run('WoWAIDB = {settings={context=true,sharing={mail=false}}}');
  run(fs.readFileSync(path.join(ROOT, 'addon/WoWAI/Context.lua'), 'utf8'));
  return { run, get };
}

function waitInbox(file, vm, wanted) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); watcher.close(); error ? reject(error) : resolve(value); };
    const inspect = () => {
      try {
        if (!fs.existsSync(file)) return;
        vm.run(fs.readFileSync(file, 'utf8'));
        const status = vm.get('WoWAI_Inbox.replies[1] and WoWAI_Inbox.replies[1].status');
        if (wanted(status)) finish(null, status);
      } catch (error) { finish(error); }
    };
    const watcher = fs.watch(path.dirname(file), inspect);
    const timer = setTimeout(() => finish(new Error('Timed out waiting for information-sharing bridge state')), 12000);
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

function bridgeSandbox(t, initialState) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wowai-request-identity-'));
  const addons = path.join(dir, 'addons'), inbox = path.join(addons, 'WoWAI/Inbox.lua'), saved = path.join(dir, 'saved.lua');
  fs.mkdirSync(path.dirname(inbox), { recursive: true });
  fs.mkdirSync(path.join(dir, 'project'));
  fs.writeFileSync(path.join(addons, 'WoWAI/WoWAI.toc'), '## Interface: 16001\n');
  for (const name of ['bridge.js', 'agents.js', 'protocol.js', 'context.js']) fs.copyFileSync(path.join(ROOT, 'bridge', name), path.join(dir, name));
  const calls = path.join(dir, 'calls.jsonl');
  const agent = path.join(dir, 'agent.js');
  fs.writeFileSync(agent, `
    const fs = require('node:fs'), path = require('node:path');
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
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ addonDir: addons, savedVariablesFile: saved, defaultCwd: path.join(dir, 'project'), agent: 'claude', agents: {claude:{path:agent}}, capture:{enabled:false}, primerFile:'', timeoutMs:15000, pollMs:25, slots:1 }));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(initialState));
  const children = [];
  const start = (args = ['--once']) => {
    const child = spawn(process.execPath, ['bridge.js', ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
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
  const outbox = nonce => `WoWAIDB = { ["outbox"] = { ["id"] = 146, ["session"] = "token", ["chat"] = "chat", ${nonce == null ? '' : `["nonce"] = "${nonce}",`} ["text"] = "${Buffer.from('The same player question').toString('hex')}" } }`;
  const release = attempt => fs.writeFileSync(path.join(dir, 'release-' + attempt), '');
  const callCount = () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').length : 0;
  const messages = () => JSON.parse(fs.readFileSync(path.join(dir, 'transcripts.json'), 'utf8')).chats.chat.messages;
  return { dir, inbox, write, outbox, start, release, callCount, messages };
}

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
