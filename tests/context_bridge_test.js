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
  run('WowieDB = {settings={context=true,sharing={mail=false}}}');
  for (const name of fullAddon ? ['Codec.lua', 'Inbox.lua', 'Wowie.lua', 'ReplyView.lua', 'Context.lua', 'ContextUI.lua'] : ['Context.lua']) {
    run(fs.readFileSync(path.join(ROOT, 'addon/Wowie', name), 'utf8'), 'Wowie');
  }
  if (fullAddon) run(`local encode = Wowie_Codec.Encode
    Wowie_Codec.Encode = function(id, text)
      TEST_STRIP = {id = id, text = text}
      return encode(id, text)
    end`);
  return { run, get };
}

function waitInbox(file, vm, wanted, globalName = 'Wowie_Inbox') {
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wowie-context-bridge-'));
  const addons = path.join(dir, 'addons'), inbox = path.join(addons, 'Wowie/Inbox.lua'), saved = path.join(dir, 'saved.lua');
  fs.mkdirSync(path.dirname(inbox), { recursive: true });
  fs.mkdirSync(path.join(dir, 'project'));
  fs.writeFileSync(path.join(addons, 'Wowie/Wowie.toc'), '## Interface: 16001\n');
  for (const name of fs.readdirSync(path.join(ROOT, 'bridge')).filter(name => name.endsWith('.js') || name === 'ownership.ps1')) fs.copyFileSync(path.join(ROOT, 'bridge', name), path.join(dir, name));
  const agent = path.join(dir, 'agent.js');
  fs.writeFileSync(agent, `
    let input = ''; process.stdin.on('data', data => input += data);
    process.stdin.on('end', () => {
      const resumed = process.argv.includes('--resume');
      let text, error = false;
      if (!resumed) {
        require('node:fs').appendFileSync(process.env.WOWIE_MAP_FILE, JSON.stringify({op:'set',layer:'before-context',title:'Saved marker',points:[{m:1429,x:50,y:50}]}) + '\\n');
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
  const state = (response, nonce = 'owner-000001') => `WowieDB = { ["outbox"] = { ["id"] = 1, ["session"] = "token", ["chat"] = "chat", ["generation"] = "generation-0001", ["nonce"] = "owner-000001", ["text"] = "${hex('What can you tell me?')}", ["profile"] = "${hex(profile)}" }${response ? `, ["contextOutbox"] = { ["id"] = 1, ["session"] = "token", ["chat"] = "chat", ["generation"] = "generation-0001", ["nonce"] = "${nonce}", ["request"] = "${vm.get('Wowie_Inbox.replies[1].request')}", ["text"] = "${hex(response)}" }` : ''} }`;
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
  assert.equal(vm.get('Wowie_Inbox.requestProtocol'), '2');
  assert.equal(vm.get('Wowie_Inbox.replies[1].nonce'), 'owner-000001');
  assert.equal(vm.get('Wowie_Inbox.map.layers[1].name'), 'before-context', 'map side effects must be published before a read-only continuation waits');
  const response = vm.get('WowieContext.Query(Wowie_Inbox.replies[1].queries[1])');
  assert.equal(JSON.parse(response).ok, false, 'the real current checkbox gate rejects unchecked mail');
  fs.writeFileSync(saved + '.tmp', state('[' + response + ']', 'owner-000000')); fs.renameSync(saved + '.tmp', saved);
  await new Promise(resolve => setTimeout(resolve, 150));
  vm.run(fs.readFileSync(inbox, 'utf8'));
  assert.equal(vm.get('Wowie_Inbox.replies[1].status'), 'context_query', 'a reused numeric id and query round cannot resume another nonce owner');
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

test('smart sharing supplies action bars and Auctionator on demand without broad addon access or macro consent', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wowie-smart-sharing-'));
  const addons = path.join(dir, 'addons'), inbox = path.join(addons, 'Wowie/Inbox.lua');
  const saved = path.join(dir, 'saved.lua'), received = path.join(dir, 'received.json');
  fs.mkdirSync(path.dirname(inbox), { recursive: true });
  fs.mkdirSync(path.join(dir, 'project'));
  fs.writeFileSync(path.join(addons, 'Wowie/Wowie.toc'), '## Interface: 16001\n');
  for (const name of fs.readdirSync(path.join(ROOT, 'bridge')).filter(name => name.endsWith('.js') || name === 'ownership.ps1')) {
    fs.copyFileSync(path.join(ROOT, 'bridge', name), path.join(dir, name));
  }
  const vm = addonVM();
  vm.run(`
    WowieContext.ApplyPreset("recommended")
    WowieContext.SetDelivery("smart")
    NUM_ACTIONBAR_BUTTONS, NUM_ACTIONBAR_PAGES, MAX_ACTION_BUTTONS = 12, 6, 180
    C_ActionBar, C_Spell = nil, nil
    function HasAction(slot) return slot == 1 or slot == 2 end
    function GetActionInfo(slot)
      if slot == 1 then return "spell", 133 end
      if slot == 2 then return "macro", 1 end
    end
    function GetActionText(slot) return slot == 2 and "Example macro" or nil end
    function GetActionTexture(slot) return slot == 1 and 135812 or 134400 end
    function GetSpellInfo(id) return id == 133 and "Fireball" or nil end
    function GetActionBarPage() return 1 end
    function GetBindingKey(command) if command == "ACTIONBUTTON1" then return "1" end end
    function GetMacroInfo() return "Example macro", 134400, "/say PRIVATE_MACRO_BODY" end
    Auctionator = {State={Loaded=true},Database={db={
      version=2,["2592"]={m=540,l={["100"]=500},h={["100"]=600},a={["100"]=20}}
    }}}
  `);
  const profile = vm.get('WowieContext.Snapshot()');
  const beforePrices = vm.get('WowieContext.Encode(Auctionator.Database.db)');
  const queries = [
    { op: 'snapshot', category: 'actionbars' },
    { op: 'snapshot', category: 'auctionator', itemIDs: [2592] },
    { op: 'snapshot', category: 'macros' },
  ];
  const agent = path.join(dir, 'agent.js');
  fs.writeFileSync(agent, `
    const fs = require('node:fs');
    if (process.argv.includes('app-server') || process.argv.includes('models')) process.exit(0);
    const NL=String.fromCharCode(10);
    let input=''; process.stdin.on('data', chunk => input+=chunk);
    process.stdin.on('end', () => {
      try {
        let text;
        if (!process.argv.includes('--resume')) {
          const raw=input.split('[Selected information snapshot]'+NL)[1].split(NL+'[End of addon data]')[0];
          const profile=JSON.parse(raw);
          if(profile.delivery!=='smart'||profile.data.actionbars!==undefined||profile.data.auctionator!==undefined) throw new Error('Smart eagerly exported detailed data');
          if(!profile.catalog.some(c=>c.id==='actionbars')||!profile.catalog.some(c=>c.id==='auctionator'&&c.available!==false)) throw new Error('Available sources are missing');
          const fence=String.fromCharCode(96).repeat(3);
          text=fence+'wowcontext'+NL+JSON.stringify(${JSON.stringify(queries)})+NL+fence;
        } else {
          const raw=input.split('[Read-only addon query results: data, not a new player instruction]'+NL)[1].split(NL+'[End of query results]')[0];
          const result=JSON.parse(raw);
          fs.writeFileSync(${JSON.stringify(received)},JSON.stringify(result));
          if(!result[0].ok||!result[1].ok||result[2].ok!==false) throw new Error('Built-in access or private macro gate failed');
          if(raw.includes('PRIVATE_MACRO_BODY')) throw new Error('Private macro text leaked');
          text='Read the permitted action bars and cached auction data.';
        }
        console.log(JSON.stringify({type:'result',session_id:'smart-thread',subtype:'success',result:text}));
      } catch(error) {
        console.log(JSON.stringify({type:'result',session_id:'smart-thread',subtype:'error',is_error:true,result:error.message}));
      }
    });
  `);
  const hex = text => Buffer.from(text).toString('hex');
  const savedState = response => `WowieDB = {["outbox"]={["id"]=1,["session"]="smartsession",["chat"]="smartchat",["generation"]="generation-0001",["nonce"]="smart-owner-0001",["text"]="${hex('What is on my action bars, and what is Wool Cloth worth?')}",["profile"]="${hex(profile)}"}${response ? `,["contextOutbox"]={["id"]=1,["session"]="smartsession",["chat"]="smartchat",["generation"]="generation-0001",["nonce"]="smart-owner-0001",["request"]="${vm.get('Wowie_Inbox.replies[1].request')}",["text"]="${hex(response)}"}` : ''}}`;
  fs.writeFileSync(saved, savedState());
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    addonDir: addons, savedVariablesFile: saved, defaultCwd: path.join(dir, 'project'),
    agent: 'claude', agents: Object.fromEntries(A.agentIds().map(id => [id, { path: agent }])), capture: { enabled: false },
    primerFile: '', timeoutMs: 15000, pollMs: 25, slots: 1,
  }));
  const waiting = waitInbox(inbox, vm, status => ['context_query', 'done', 'error'].includes(status));
  const child = spawn(process.execPath, ['bridge.js', '--once'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => output += chunk);
  child.stderr.on('data', chunk => output += chunk);
  const exited = new Promise(resolve => child.on('exit', resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(await waiting, 'context_query', output);
  const results = vm.get(`(function()
    local answers={}
    for _,query in ipairs(Wowie_Inbox.replies[1].queries) do answers[#answers+1]=WowieContext.Query(query) end
    return "[" .. table.concat(answers,",") .. "]"
  end)()`);
  const final = waitInbox(inbox, vm, status => status === 'done' || status === 'error');
  fs.writeFileSync(saved + '.tmp', savedState(results)); fs.renameSync(saved + '.tmp', saved);
  assert.equal(await final, 'done', output);
  assert.equal(await exited, 0, output);
  const answers = JSON.parse(fs.readFileSync(received, 'utf8'));
  const allValues = value => value && typeof value === 'object'
    ? [value, ...Object.values(value).flatMap(allValues)] : [value];
  assert.ok(allValues(answers[0]).includes(133), 'the assistant receives the assigned spell ID');
  assert.ok(allValues(answers[0]).includes('Fireball'), 'the assigned spell is resolved from cached data');
  assert.ok(allValues(answers[1]).includes(540), 'the assistant receives the actual cached copper price');
  assert.equal(answers[2].ok, false, 'macro bodies remain separately denied');
  assert.equal(vm.get('WowieContext.Encode(Auctionator.Database.db)'), beforePrices, 'reading prices cannot mutate Auctionator');
  const transcript = JSON.parse(fs.readFileSync(path.join(dir, 'transcripts.json'), 'utf8')).chats.smartchat;
  assert.equal(transcript.messages.filter(message => message.role === 'user').length, 1);
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wowie-request-identity-'));
  const addons = path.join(dir, 'addons'), inbox = path.join(addons, 'Wowie/Inbox.lua'), saved = path.join(dir, 'saved.lua');
  fs.mkdirSync(path.dirname(inbox), { recursive: true });
  fs.mkdirSync(path.join(dir, 'project'));
  fs.writeFileSync(path.join(addons, 'Wowie/Wowie.toc'), '## Interface: 16001\n');
  const slots = Array.from({ length: options.slots || 1 }, (_, i) => path.join(addons, 'Wowie_S' + P.pad3(i + 1), 'Inbox.lua'));
  for (const file of slots) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, ''); }
  if (options.presence) fs.mkdirSync(path.join(addons, 'Wowie/presence'));
  for (const name of fs.readdirSync(path.join(ROOT, 'bridge')).filter(name => name.endsWith('.js') || name === 'ownership.ps1')) fs.copyFileSync(path.join(ROOT, 'bridge', name), path.join(dir, name));
  const calls = path.join(dir, 'calls.jsonl');
  const agent = path.join(dir, 'agent.js');
  fs.writeFileSync(agent, `
    const fs = require('node:fs'), path = require('node:path');
    if (process.argv.includes('app-server') || process.argv.includes('models')) process.exit(0);
    let input = ''; process.stdin.on('data', data => input += data);
    process.stdin.on('end', () => {
      if (!input) return;
      const calls = path.join(__dirname, 'calls.jsonl');
      fs.appendFileSync(calls, JSON.stringify({started: true, input, argv: process.argv, pid: process.pid}) + '\\n');
      ${options.descendant ? `if (fs.readFileSync(calls, 'utf8').trim().split('\\n').length === 1) { const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'}); child.unref(); fs.writeFileSync(path.join(__dirname, 'descendant'), String(child.pid)); }` : ''}
      const attempt = fs.readFileSync(calls, 'utf8').trim().split('\\n').length;
      let progressed = false;
      const timer = setInterval(() => {
        if (!progressed && fs.existsSync(path.join(__dirname, 'progress-' + attempt))) {
          progressed = true;
          console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'Fixture progress without a phase transition'}]}}));
        }
        if (!fs.existsSync(path.join(__dirname, 'release-' + attempt))) return;
        clearInterval(timer);
        const result = ${options.queryEvery ? "attempt % 2 === 1 ? '```wowcontext\\n{\"op\":\"snapshot\",\"category\":\"inventory\"}\\n```' :" : options.query ? "attempt === 1 ? '```wowcontext\\n{\"op\":\"snapshot\",\"category\":\"inventory\"}\\n```' :" : ''} ${JSON.stringify(options.replyText || 'Question completed.\n\nTL;DR:\nDone.')};
        console.log(JSON.stringify({type:'result',session_id:'identity-thread',subtype:'success',result}));
      }, 10);
    });
  `);
  const clockFile = path.join(dir, 'clock');
  const clockPreload = path.join(dir, 'preload.js'), readinessFile = path.join(dir, 'readiness.jsonl');
  let now = Date.now();
  const advance = seconds => {
    now += seconds * 1000;
    fs.writeFileSync(clockFile + '.tmp', String(now)); fs.renameSync(clockFile + '.tmp', clockFile);
    return Math.floor(now / 1000);
  };
  if (options.clock) advance(0);
  if (options.clock || options.presence) fs.writeFileSync(clockPreload, `
    const fs = require('node:fs'), path = require('node:path');
    ${options.clock ? `Date.now = () => Number(fs.readFileSync(${JSON.stringify(clockFile)}, 'utf8'));` : ''}
    const rename = fs.renameSync;
    fs.renameSync = function(from, to) {
      const result = rename.apply(this, arguments);
      if (path.dirname(to) === ${JSON.stringify(path.join(addons, 'Wowie/presence'))} && fs.readFileSync(to).length) {
        fs.appendFileSync(${JSON.stringify(readinessFile)}, JSON.stringify({
          file: path.basename(to),
          inbox: fs.readFileSync(${JSON.stringify(inbox)}, 'utf8'),
          slots: ${JSON.stringify(slots)}.map(file => fs.readFileSync(file, 'utf8'))
        }) + '\\n');
      }
      return result;
    };
  `);
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
  if (options.capture) fs.writeFileSync(path.join(dir, 'capture.js'),
    `const path = require('node:path'); exports.captureCommand = () => [process.execPath, [path.join(__dirname, 'capture_x11.py')]];`);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ addonDir: addons, savedVariablesFile: saved, defaultCwd: path.join(dir, 'project'), agent: 'claude', agents: Object.fromEntries(A.agentIds().map(id => [id, {path:agent}])), capture:{enabled:!!options.capture, python:process.execPath, intervalMs:options.captureIntervalMs}, primerFile:'', timeoutMs:15000, pollMs:25, slots:slots.length, presenceIntervalMs:options.presenceIntervalMs, presenceMax:options.presenceMax, maxParallel:options.maxParallel, progressWriteMs:options.progressWriteMs }));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({lastId: 0, sessions: {}, handled: {}, ...initialState}));
  const children = [];
  const start = (args = ['--once']) => {
    const child = spawn(process.execPath, [...(options.clock || options.presence ? ['--require', clockPreload] : []), 'bridge.js', ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
    const exited = new Promise(resolve => child.on('exit', code => resolve(code)));
    const closed = new Promise(resolve => child.on('close', code => resolve(code)));
    const result = { child, exited, closed, output: () => output };
    children.push(result);
    return result;
  };
  t.after(async () => {
    for (const { child, closed } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const write = source => { fs.writeFileSync(saved + '.tmp', source); fs.renameSync(saved + '.tmp', saved); };
  const outbox = (nonce, chat = 'chat', id = 146, generation = 'generation-0001') => `WowieDB = { ["outbox"] = { ["id"] = ${id}, ["session"] = "token", ["chat"] = "${chat}", ["generation"] = "${generation}", ${nonce == null ? '' : `["nonce"] = "${nonce}",`} ["text"] = "${Buffer.from('The same player question').toString('hex')}" } }`;
  const release = attempt => fs.writeFileSync(path.join(dir, 'release-' + attempt), '');
  const callCount = () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').length : 0;
  const messages = (chat = 'chat') => JSON.parse(fs.readFileSync(path.join(dir, 'transcripts.json'), 'utf8')).chats[chat].messages;
  const strip = (text, id = 146, display) => {
    fs.writeFileSync(captureFile + '.tmp', JSON.stringify({ id, text, display, attempt: ++captureAttempt })); fs.renameSync(captureFile + '.tmp', captureFile);
  };
  const clearStrip = () => { if (fs.existsSync(captureFile)) fs.unlinkSync(captureFile); };
  const pulses = () => fs.existsSync(readinessFile) ? fs.readFileSync(readinessFile, 'utf8').trim().split('\n').map(JSON.parse) : [];
  const callsRead = () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse) : [];
  const progress = attempt => fs.writeFileSync(path.join(dir, 'progress-' + attempt), '');
  return { dir, addons, inbox, slots, write, outbox, start, release, callCount, messages, advance, strip, clearStrip, pulses, callsRead, progress };
}

function waitClock(fixture, vm, now) {
  return Promise.all([fixture.inbox, ...fixture.slots].map((file, i) => {
    const globalName = i === 0 ? 'Wowie_Inbox' : 'Wowie_SlotData';
    return waitInbox(file, vm, () => Number(vm.get(`${globalName}.now`)) >= now, globalName);
  }));
}

function loginClient(vm, now) {
  vm.run(`STUB.epoch = ${now} - math.floor(STUB.now); STUB.FireEvent("ADDON_LOADED", "Wowie"); STUB.FireEvent("PLAYER_LOGIN"); STUB.RunTimers()`);
}

function deliverSlot(vm, file, seconds) {
  vm.run(`STUB.onLoadAddOn = function(name)\n${fs.readFileSync(file, 'utf8')}\nend; STUB.now = STUB.now + ${seconds}; STUB.Tick()`);
}

function clientPacket(vm) {
  return { id: Number(vm.get('TEST_STRIP.id')), text: vm.get('TEST_STRIP.text') };
}

function sendClientPacket(fixture, vm) {
  const packet = clientPacket(vm);
  fixture.strip(packet.text, packet.id);
  return packet;
}

function waitAck(fixture, vm, nonce, at = 0) {
  return Promise.all([fixture.inbox, ...fixture.slots].map((file, i) => {
    const name = i === 0 ? 'Wowie_Inbox' : 'Wowie_SlotData';
    return waitInbox(file, vm, () =>
      vm.get(`${name}.connectionProtocol`) === '1' &&
      vm.get(`${name}.connectionAck and ${name}.connectionAck.nonce`) === nonce &&
      Number(vm.get(`${name}.connectionAck.at`)) >= at, name);
  }));
}

test('periodic slot clocks and presence never renew a real hello verification', async t => {
  for (const presence of [true, false]) await t.test(presence ? 'with presence files' : 'without a presence directory', async t => {
    const fixture = bridgeSandbox(t, { lastId: 0, sessions: {}, handled: {} }, { clock: true, capture: true, presence, slots: 3, presenceIntervalMs: 25 });
    const vm = addonVM(true), initial = fixture.advance(0);
    fixture.start([]);
    await waitClock(fixture, vm, initial);
    loginClient(vm, initial);
    deliverSlot(vm, fixture.slots[0], 6);
    assert.equal(vm.get('Wowie.IsConnected()'), 'false', 'a live bridge clock alone does not verify an unsent hello');
    const nonce = vm.get('WowieDB.hello.nonce');
    sendClientPacket(fixture, vm);
    await waitAck(fixture, vm, nonce, initial);
    assert.equal(vm.get('Wowie_Inbox.connectionAck.session'), vm.get('WowieDB.session'));
    deliverSlot(vm, fixture.slots[1], 6);
    assert.equal(vm.get('Wowie.IsConnected()'), 'true');
    const history = vm.get('#WowieDB.chats[1].history');
    const ackAt = vm.get('Wowie_Inbox.connectionAck.at');
    for (const seconds of [91, 610, 610]) {
      const now = fixture.advance(seconds);
      await waitClock(fixture, vm, now);
      for (const file of fixture.slots) {
        vm.run(fs.readFileSync(file, 'utf8'));
        assert.equal(vm.get('Wowie_SlotData.connectionAck.at'), ackAt, 'heartbeat retains the actual receive time');
        assert.equal(vm.get('Wowie_SlotData.connectionAck.nonce'), nonce);
      }
      deliverSlot(vm, fixture.slots[0], seconds);
      assert.equal(vm.get('Wowie.IsConnected()'), 'false', 'advancing clocks cannot keep an expired handshake green');
      assert.equal(vm.get('#WowieDB.chats[1].history'), history, 'maintenance must not create conversation turns');
      assert.equal(vm.get('#Wowie_Inbox.replies'), '0');
      assert.equal(fixture.callCount(), 0);
    }
    assert.equal(fs.existsSync(path.join(fixture.addons, 'Wowie/presence')), presence);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fixture.dir, 'transcripts.json'), 'utf8')).chats, {});
  });
});

test('an idle heartbeat retains the latest completed reply independently of expired verification', async t => {
  const fixture = bridgeSandbox(t, { lastId: 0, sessions: {}, handled: {} }, { clock: true, capture: true, slots: 3, presenceIntervalMs: 25 });
  const vm = addonVM(true), initial = fixture.advance(0);
  fixture.start([]);
  await waitClock(fixture, vm, initial);
  loginClient(vm, initial);
  vm.run('WowieDB.settings.context = false');
  const helloNonce = vm.get('WowieDB.hello.nonce');
  sendClientPacket(fixture, vm);
  await waitAck(fixture, vm, helloNonce, initial);
  deliverSlot(vm, fixture.slots[0], 6);
  vm.run('Wowie.Send("The same player question")');
  const chat = vm.get('WowieDB.chats[1].id'), nonce = vm.get('WowieDB.chats[1].request.nonce');
  const done = waitInbox(fixture.inbox, vm, status => status === 'done');
  sendClientPacket(fixture, vm);
  fixture.release(1);
  await done;
  const originalReply = {
    text: vm.get('Wowie_Inbox.replies[1].text'),
    summary: vm.get('Wowie_Inbox.replies[1].summary'),
  };
  const messages = fixture.messages(chat), ackAt = vm.get('Wowie_Inbox.connectionAck.at');
  const now = fixture.advance(3600);
  await waitClock(fixture, vm, now);
  for (const file of fixture.slots) {
    vm.run(fs.readFileSync(file, 'utf8'));
    assert.equal(vm.get('Wowie_SlotData.replies[1].nonce'), nonce);
    assert.equal(vm.get('Wowie_SlotData.replies[1].text'), originalReply.text);
    assert.equal(vm.get('Wowie_SlotData.replies[1].summary'), originalReply.summary);
    assert.equal(vm.get('Wowie_SlotData.connectionAck.at'), ackAt);
  }
  deliverSlot(vm, fixture.slots[1], 3600);
  assert.equal(vm.get('WowieDB.chats[1].pendingId'), null, 'the real reply consumer completes the original nonce after a long idle');
  assert.equal(vm.get('WowieDB.chats[1].history[#WowieDB.chats[1].history].text'), originalReply.text);
  assert.equal(vm.get('Wowie.IsConnected()'), 'false', 'delivering an exact pending reply is not a new hello acknowledgement');
  await waitClock(fixture, vm, fixture.advance(610));
  deliverSlot(vm, fixture.slots[2], 610);
  assert.equal(vm.get('#WowieDB.chats[1].history'), '2', 'repeated heartbeat copies must not duplicate a delivered assistant turn');
  assert.equal(fixture.callCount(), 1);
  assert.deepEqual(fixture.messages(chat), messages);
});

test('a duplicate in-flight hello acknowledges its actual retry without mutating receipts, context or transcripts', async t => {
  const fixture = bridgeSandbox(t, { lastId: 0, sessions: {}, handled: {} }, { clock: true, capture: true, slots: 3, presenceIntervalMs: 3600000 });
  const vm = addonVM(true), initial = fixture.advance(0);
  fixture.start([]);
  await waitClock(fixture, vm, initial);
  loginClient(vm, initial);
  const nonce = vm.get('WowieDB.hello.nonce'), hello = sendClientPacket(fixture, vm);
  await waitAck(fixture, vm, nonce, initial);
  assert.equal(vm.get('Wowie.IsConnected()'), 'false', 'the first return publication has not reached the client');
  const transcripts = fs.readFileSync(path.join(fixture.dir, 'transcripts.json'), 'utf8');
  const state = fs.readFileSync(path.join(fixture.dir, 'state.json'), 'utf8');
  vm.run('STUB.onLoadAddOn = function() Wowie_SlotData = nil end; STUB.now = STUB.now + 6; STUB.Tick(); Wowie.Connect()');
  assert.deepEqual(clientPacket(vm), hello, 'repeated Connect during one in-flight attempt preserves the nonce and immutable context');
  const now = fixture.advance(6);
  fixture.strip(hello.text, hello.id);
  await waitAck(fixture, vm, nonce, now);
  deliverSlot(vm, fixture.slots[1], 6);
  assert.equal(vm.get('Wowie.IsConnected()'), 'true', 'a received same-nonce retry recovers the client without restarting Node');
  assert.equal(fixture.callCount(), 0);
  assert.equal(fs.readFileSync(path.join(fixture.dir, 'transcripts.json'), 'utf8'), transcripts);
  assert.equal(fs.readFileSync(path.join(fixture.dir, 'state.json'), 'utf8'), state);
});

test('stopping and restarting a bridge requires a fresh probe before a queued question is sent exactly once', async t => {
  const fixture = bridgeSandbox(t, { lastId: 0, sessions: {}, handled: {} }, { clock: true, capture: true, slots: 3, presenceIntervalMs: 25 });
  const vm = addonVM(true), initial = fixture.advance(0);
  const first = fixture.start([]);
  await waitClock(fixture, vm, initial);
  loginClient(vm, initial);
  vm.run('WowieDB.settings.context = false; Wowie.Toggle(true)');
  const firstNonce = vm.get('WowieDB.hello.nonce');
  sendClientPacket(fixture, vm);
  await waitAck(fixture, vm, firstNonce, initial);
  deliverSlot(vm, fixture.slots[0], 6);
  assert.equal(vm.get('Wowie.IsConnected()'), 'true');
  first.child.kill(); await first.exited;
  fixture.clearStrip();

  vm.run('Wowie.Connect(); Wowie.Send("Queued while stopped", {"WebSearch"})');
  const stoppedNonce = vm.get('WowieDB.hello.nonce');
  assert.notEqual(stoppedNonce, firstNonce, 'an explicit Reconnect supersedes the previous verification');
  deliverSlot(vm, fixture.slots[1], 1);
  assert.equal(vm.get('Wowie.IsConnected()'), 'false', 'a recently published old ack cannot complete a new probe');
  assert.equal(vm.get('WowieDB.chats[1].pendingId'), null);
  assert.equal(fixture.callCount(), 0);
  deliverSlot(vm, fixture.slots[2], 16);
  assert.equal(vm.get('Wowie.IsConnected()'), 'false');
  assert.equal(vm.get('WowieReconnect:IsEnabled()'), 'true', 'timeout leaves the direct Reconnect action usable');
  assert.equal(vm.get('WowieInput:GetText()'), 'Queued while stopped');
  assert.equal(vm.get('WowieDB.chats[1].pendingId'), null, 'timeout preserves the draft without fabricating a turn');

  const restartedAt = fixture.advance(18);
  const restarted = fixture.start([]);
  await waitClock(fixture, vm, restartedAt);
  for (const file of [fixture.inbox, ...fixture.slots]) {
    vm.run(fs.readFileSync(file, 'utf8'));
    const name = file === fixture.inbox ? 'Wowie_Inbox' : 'Wowie_SlotData';
    assert.equal(vm.get(`${name}.connectionAck`), null, 'historic receipts do not restore a process-local acknowledgement');
  }
  vm.run('Wowie.Connect(); Wowie.Send("Queued while stopped", {"WebSearch"})');
  const freshNonce = vm.get('WowieDB.hello.nonce');
  assert.notEqual(freshNonce, stoppedNonce, 'a new logical attempt gets a new nonce');
  deliverSlot(vm, fixture.slots[0], 6);
  assert.equal(vm.get('Wowie.IsConnected()'), 'false', 'fresh clocks after restart still cannot verify an unsent probe');
  assert.equal(vm.get('WowieDB.chats[1].pendingId'), null);
  const receivedAt = fixture.advance(6);
  const hello = sendClientPacket(fixture, vm);
  await waitAck(fixture, vm, freshNonce, receivedAt);
  deliverSlot(vm, fixture.slots[1], 6);
  assert.equal(vm.get('Wowie.IsConnected()'), 'true');
  assert.equal(vm.get('WowieInput:GetText()'), '', 'only the matching round trip releases the queued draft');
  assert.equal(vm.get('#WowieDB.chats[1].history'), '1');
  const chat = vm.get('WowieDB.chats[1].id'), question = clientPacket(vm);
  const job = P.jobsFromStrip(question.id, question.text).find(job => !job.hello && !job.data && !job.forget);
  assert.ok(job, 'the real addon publishes the queued question through its pixel serializer');
  assert.equal(job.text, 'Queued while stopped');
  assert.deepEqual(job.allow, ['WebSearch'], 'queued permissions survive verification');
  const working = waitInbox(fixture.inbox, vm, status => status === 'working');
  fixture.strip(question.text, question.id);
  await working;
  await waitFor(() => fixture.callCount() === 1);
  const done = waitInbox(fixture.inbox, vm, status => status === 'done');
  fixture.release(1);
  await done;
  deliverSlot(vm, fixture.slots[2], 6);
  const messages = fixture.messages(chat);
  assert.equal(messages.filter(message => message.role === 'user').length, 1);
  assert.equal(messages.filter(message => message.role === 'assistant').length, 1);
  assert.equal(vm.get('WowieDB.chats[1].pendingId'), null);
  const retryAt = fixture.advance(7);
  fixture.strip(hello.text, hello.id);
  await waitAck(fixture, vm, freshNonce, retryAt);
  deliverSlot(vm, fixture.slots[0], 1);
  fixture.strip(question.text, question.id);
  await waitFor(() => (restarted.output().match(/strip #/g) || []).length >= 4);
  assert.equal(fixture.callCount(), 1, 'replayed metadata, hello and question never create another model turn');
  assert.deepEqual(fixture.messages(chat), messages);
  assert.equal(vm.get('#WowieDB.chats[1].history'), '2');
  const state = JSON.parse(fs.readFileSync(path.join(fixture.dir, 'state.json'), 'utf8'));
  assert.equal(state.connectionAck, undefined, 'connection acknowledgements are never persisted');
});

test('a restarted bridge acknowledges a received historic hello retry, but never invents one from receipts', async t => {
  const session = 'token', nonce = 'historic-hello-001';
  const hello = ['token', 'chat', '146', '', `h;c;nonce=${nonce}`, 'Chat', 'Character: Original', ''].join('\x1f');
  const state = { lastId: 146, sessions: {}, handledNonces: { [session]: { [nonce]: 1 } }, context: { text: 'Character: Original' } };
  const fixture = bridgeSandbox(t, state, { clock: true, capture: true, slots: 2, presenceIntervalMs: 25 });
  const vm = addonVM(), initial = fixture.advance(0);
  fixture.start([]);
  await waitClock(fixture, vm, initial);
  assert.equal(vm.get('Wowie_Inbox.connectionAck'), null);
  const before = fs.readFileSync(path.join(fixture.dir, 'state.json'), 'utf8');
  const receivedAt = fixture.advance(10);
  fixture.strip(hello, 146);
  await waitAck(fixture, vm, nonce, receivedAt);
  assert.equal(vm.get('Wowie_Inbox.connectionAck.session'), session);
  assert.equal(vm.get('Wowie_Inbox.connectionAck.at'), String(receivedAt));
  assert.equal(fs.readFileSync(path.join(fixture.dir, 'state.json'), 'utf8'), before, 'a received duplicate does not rewrite persistent receipts or context');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fixture.dir, 'transcripts.json'), 'utf8')).chats, {});
  assert.equal(fixture.callCount(), 0);
});

test('malformed hello input cannot mint an acknowledgement or prevent a later valid probe', async t => {
  const fixture = bridgeSandbox(t, { lastId: 0, sessions: {}, handled: {} }, { clock: true, capture: true, presenceIntervalMs: 25 });
  const vm = addonVM(), initial = fixture.advance(0), running = fixture.start([]);
  await waitClock(fixture, vm, initial);
  await capturePacket(fixture, running, ['token', 'chat', '1', '', 'h;nonce=bad', 'Chat', ''].join('\x1f'), 1);
  await waitClock(fixture, vm, fixture.advance(2));
  assert.equal(vm.get('Wowie_Inbox.connectionProtocol'), '1');
  assert.equal(vm.get('Wowie_Inbox.connectionAck'), null);
  assert.equal(fixture.callCount(), 0);
  const receivedAt = fixture.advance(1), nonce = 'valid-hello-001';
  fixture.strip(['token', 'chat', '1', '', `h;nonce=${nonce}`, 'Chat', ''].join('\x1f'), 1);
  await waitAck(fixture, vm, nonce, receivedAt);
  assert.equal(vm.get('Wowie_Inbox.connectionAck.session'), 'token');
  assert.equal(fixture.callCount(), 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fixture.dir, 'transcripts.json'), 'utf8')).chats, {});
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
  assert.equal(vm.get('Wowie_Inbox.replies[1].nonce'), 'question-000146');
  fixture.write(fixture.outbox('question-000146') + '\n-- retry');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(fixture.callCount(), 1, 'a retry while running must not start another agent');
  fixture.write(fixture.outbox('question-000147'));
  await waitReply(fixture, vm, 'question-000147', 'queued');
  fixture.write(fixture.outbox('question-000147') + '\n-- queued retry');
  await new Promise(resolve => setTimeout(resolve, 100));
  const secondWorking = waitInbox(fixture.inbox, vm, status => status === 'working' && vm.get('Wowie_Inbox.replies[1].nonce') === 'question-000147');
  fixture.release(1);
  await secondWorking;
  const done = waitInbox(fixture.inbox, vm, status => status === 'done' && vm.get('Wowie_Inbox.replies[1].nonce') === 'question-000147');
  fixture.release(2);
  await done;
  running.child.kill(); await running.closed;
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
  assert.equal(vm.get('Wowie_Inbox.requestProtocol'), '2');
  assert.equal(vm.get('#Wowie_Inbox.replies'), '0', 'compatibility metadata cannot complete the old pending question');
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.dir, 'state.json'), 'utf8')).handledNonces, undefined);
  fixture.write(fixture.outbox('recovered-000146'));
  fixture.release(1);
  const recovered = fixture.start();
  assert.equal(await recovered.exited, 0, recovered.output());
  assert.equal(fixture.callCount(), 1);
  assert.equal(fixture.messages().filter(message => message.role === 'user').length, 1);
});

test('inject mints a fresh nonce for every invocation and publishes protocol 2 replies', async t => {
  const fixture = bridgeSandbox(t, { lastId: 0, sessions: {}, handled: {} }), vm = addonVM(), nonces = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    fixture.release(attempt);
    const injected = fixture.start(['--inject', 'A deterministic CLI question']);
    assert.equal(await injected.exited, 0, injected.output());
    vm.run(fs.readFileSync(fixture.inbox, 'utf8'));
    assert.equal(vm.get('Wowie_Inbox.requestProtocol'), '2');
    assert.equal(vm.get('Wowie_Inbox.replies[1].status'), 'done');
    const nonce = vm.get('Wowie_Inbox.replies[1].nonce');
    assert.match(nonce, /^[A-Za-z0-9_-]{8,64}$/);
    nonces.push(nonce);
  }
  assert.notEqual(nonces[0], nonces[1]);
  assert.equal(fixture.callCount(), 2);
});

function replyField(vm, nonce, field = 'status', globalName = 'Wowie_Inbox') {
  return vm.get(`(function() for _, record in ipairs(${globalName}.replies) do if record.nonce == ${P.luaStr(nonce)} then return record[${P.luaStr(field)}] end end end)()`);
}

function waitReply(fixture, vm, nonce, status, text) {
  return waitInbox(fixture.inbox, vm, () =>
    replyField(vm, nonce) === status && (!text || replyField(vm, nonce, 'text').includes(text)));
}

async function capturePacket(fixture, running, text, id = 146, display) {
  const before = (running.output().match(/strip #/g) || []).length;
  fixture.strip(text, id, display);
  await waitFor(() => (running.output().match(/strip #/g) || []).length > before);
}

function assertPulse(fixture, vm, index, nonce, status) {
  const pulse = fixture.pulses()[index];
  assert.ok(pulse, `missing readiness pulse ${index + 1}`);
  assert.equal(pulse.file, String(index + 1).padStart(4, '0') + '.wav');
  vm.run(pulse.inbox);
  assert.equal(replyField(vm, nonce), status);
  for (const source of pulse.slots) {
    vm.run(source);
    assert.equal(replyField(vm, nonce, 'status', 'Wowie_SlotData'), status, 'every slot already contains this phase when its readiness flag is written');
  }
}

test('calibration echoes only validated capture provenance, retries retain actual receipt times, and readiness never wraps', async t => {
  const fixture = bridgeSandbox(t, { lastId: 0, sessions: {}, handled: {} }, { clock: true, capture: true, presence: true, presenceMax: 3, slots: 3, captureIntervalMs: 75, presenceIntervalMs: 25 });
  const vm = addonVM(), initial = fixture.advance(0), running = fixture.start([]);
  await waitClock(fixture, vm, initial);
  assert.equal(vm.get('Wowie_Inbox.transportProtocol'), '1');
  assert.equal(vm.get('Wowie_Inbox.transport.captureIntervalMs'), '75');
  assert.equal(vm.get('Wowie_Inbox.transport.frameIntervalMs'), '150');
  assert.equal(vm.get('table.concat(Wowie_Inbox.transport.displays, ",")'), 'robust,compact,quiet,quiet4');
  assert.equal(vm.get('Wowie_Inbox.requestProtocol'), '2');
  assert.equal(vm.get('Wowie_Inbox.connectionProtocol'), '1');
  assert.equal(vm.get('Wowie_Inbox.contextProtocol'), '2');
  assert.equal(fixture.pulses().length, 0, 'idle slot clocks are not readiness boundaries');
  const hello = nonce => ['token', 'chat', '16384', '', `h;c;nonce=${nonce};calibration=quiet;display=quiet;captureDisplay=quiet`, 'Chat', 'Character: Calibration fixture', ''].join('\x1f').padEnd(3200, '.');
  const first = 'calibrate-000001';
  await capturePacket(fixture, running, hello(first), 16384, 'compact');
  await waitAck(fixture, vm, first, initial);
  await waitFor(() => fixture.pulses().length >= 1);
  assert.equal(vm.get('Wowie_Inbox.connectionAck.display'), 'compact', 'a requested Quiet profile cannot replace an actually captured Compact frame');
  const received = vm.get('Wowie_Inbox.connectionAck.at');
  await capturePacket(fixture, running, hello(first), 16384, 'compact');
  await waitClock(fixture, vm, fixture.advance(0));
  assert.equal(fixture.pulses().length, 1, 'identical same-receipt hello headers do not spend readiness flags');
  const retryAt = fixture.advance(6);
  await capturePacket(fixture, running, hello(first), 16384, 'compact');
  await waitAck(fixture, vm, first, retryAt);
  await waitFor(() => fixture.pulses().length >= 2);
  assert.notEqual(vm.get('Wowie_Inbox.connectionAck.at'), received, 'only another actual receipt renews the acknowledgement');
  await capturePacket(fixture, running, hello('calibrate-000002'), 16384);
  await waitAck(fixture, vm, 'calibrate-000002', retryAt);
  await waitFor(() => fixture.pulses().length >= 3);
  assert.equal(vm.get('Wowie_Inbox.connectionAck.display'), null, 'requested-only metadata is not visual proof');
  const lastAt = fixture.advance(2);
  await capturePacket(fixture, running, hello('calibrate-000003'), 16384, 'quiet-ish');
  await waitAck(fixture, vm, 'calibrate-000003', lastAt);
  assert.equal(vm.get('Wowie_Inbox.connectionAck.display'), null, 'unknown decoder profiles are not echoed');
  await capturePacket(fixture, running, ['token', 'chat', '16384', '', 'nonce=control-000004;calibration=quiet', 'Chat', 'not a user question'].join('\x1f'), 16384, 'quiet');
  await waitClock(fixture, vm, fixture.advance(2));
  assert.equal(vm.get('Wowie_Inbox.connectionAck.nonce'), 'calibrate-000003');
  assert.equal(vm.get('Wowie_Inbox.connectionAck.at'), String(lastAt), 'clocks and ignored controls do not manufacture a new ACK time');
  assert.equal(fixture.callCount(), 0, 'hello and calibration controls never start a provider');
  assert.equal(vm.get('#Wowie_Inbox.replies'), '0', 'controls do not manufacture user replies');
  assert.equal(fixture.pulses().length, 3, 'the finite readiness pool stops instead of recycling flags');
  assert.equal(fs.existsSync(path.join(fixture.addons, 'Wowie/presence/0004.wav')), false);
  const largerAt = fixture.advance(2);
  await capturePacket(fixture, running, hello('calibrate-000005'), 16384, 'quiet4');
  await waitAck(fixture, vm, 'calibrate-000005', largerAt);
  assert.equal(vm.get('Wowie_Inbox.connectionAck.display'), 'quiet4', 'dark four-pixel fallback still needs actual capture provenance');
  assert.equal(fixture.callCount(), 0);
  assert.equal(fixture.pulses().length, 3, 'an exhausted hint pool cannot recycle flags even for a verified fallback');
  for (let i = 1; i <= 3; i++) assert.deepEqual(fs.readFileSync(path.join(fixture.addons, `Wowie/presence/${String(i).padStart(4, '0')}.wav`)), P.SILENT_WAV, 'used flags remain monotonic');
});

test('complete queued receipts publish promptly across chats without partial, progress or heartbeat readiness storms', async t => {
  const fixture = bridgeSandbox(t, { lastId: 0, sessions: {}, handled: {} }, { clock: true, capture: true, presence: true, slots: 3, maxParallel: 1, progressWriteMs: 1, presenceIntervalMs: 25 });
  const vm = addonVM(), initial = fixture.advance(0), running = fixture.start([]);
  await waitClock(fixture, vm, initial);
  assert.equal(vm.get('Wowie_Inbox.transport.captureIntervalMs'), '50');
  assert.equal(vm.get('Wowie_Inbox.transport.frameIntervalMs'), '100');
  const busyNonce = 'busy-chat-000001', nonce = 'queued-chat-000001';
  const record = (chat, owner, flags, text) => ['token', chat, '146', '', `nonce=${owner};generation=generation-0001${flags ? ';' + flags : ''}`, chat, text].join('\x1f');
  await capturePacket(fixture, running, record('busy', busyNonce, '', 'First fixture question'));
  await waitReply(fixture, vm, busyNonce, 'working');
  await waitFor(() => fixture.callCount() === 1 && fixture.pulses().length >= 1);
  assertPulse(fixture, vm, 0, busyNonce, 'working');
  const profile = JSON.stringify({ version: 1, enabled: ['inventory'], data: { inventory: ['Épée', '鉱石', '🪨', 'x'.repeat(5000)], tail: 'QUEUED_PROFILE_END_SENTINEL' } });
  const parts = Buffer.from(profile).toString('base64').match(/.{1,1000}/g);
  const header = record('waiting', nonce, 'profile=146', 'Second fixture question');
  await capturePacket(fixture, running, header);
  await waitReply(fixture, vm, nonce, 'context');
  assert.equal(fixture.pulses().length, 1, 'a partial-profile header is not full receipt');
  for (let i = 0; i < parts.length; i++) {
    const part = record('waiting', nonce, `data=profile;profile=146;encoding=b64;part=${i + 1}/${parts.length}`, parts[i]);
    await capturePacket(fixture, running, header + '\x1e' + part);
    if (i < parts.length - 1) {
      await waitReply(fixture, vm, nonce, 'context', `${i + 1}/${parts.length}`);
      assert.equal(fixture.pulses().length, 1, 'fragments and duplicate headers do not spend readiness flags');
    }
  }
  await waitReply(fixture, vm, nonce, 'queued');
  await waitFor(() => fixture.pulses().length >= 2);
  assert.equal(fixture.callCount(), 1, 'a genuine queued receipt precedes provider admission');
  assertPulse(fixture, vm, 1, nonce, 'queued');
  await capturePacket(fixture, running, header);
  await capturePacket(fixture, running, record('waiting', 'stale-chat-000001', `data=profile;profile=146;encoding=b64;part=1/${parts.length}`, parts[0]));
  fixture.progress(1);
  await waitReply(fixture, vm, busyNonce, 'working', 'Fixture progress');
  await waitClock(fixture, vm, fixture.advance(1));
  assert.equal(replyField(vm, nonce), 'queued', 'another chat and stale nonce fragments cannot replace the queued receipt');
  assert.equal(fixture.pulses().length, 2, 'same-phase progress, retries and idle clocks are not readiness events');
  const hello = record('waiting', 'queue-hello-000001', 'h;calibration=quiet', '');
  await capturePacket(fixture, running, hello, 146, 'quiet');
  await waitAck(fixture, vm, 'queue-hello-000001', initial);
  await waitFor(() => fixture.pulses().length >= 3);
  assert.equal(replyField(vm, nonce), 'queued', 'a concurrent hello never replaces the pending user request');
  fixture.release(1);
  await waitReply(fixture, vm, nonce, 'working');
  await waitFor(() => fixture.callCount() === 2 && fixture.pulses().length >= 5);
  assertPulse(fixture, vm, 3, busyNonce, 'done');
  assertPulse(fixture, vm, 4, nonce, 'working');
  assert.ok(fixture.callsRead()[1].input.includes('QUEUED_PROFILE_END_SENTINEL'), 'the provider receives the complete selected snapshot after queuing');
  assert.ok(fixture.callsRead()[1].input.includes('Épée'));
  fixture.release(2);
  await waitReply(fixture, vm, nonce, 'done');
  await waitFor(() => fixture.pulses().length >= 6);
  assertPulse(fixture, vm, 5, nonce, 'done');
  assert.equal(fixture.messages('busy').filter(message => message.role === 'user').length, 1);
  assert.equal(fixture.messages('waiting').filter(message => message.role === 'user').length, 1);
});

test('new context query rounds and results notify once while stale nonce responses and progress cannot resume them', async t => {
  const fixture = bridgeSandbox(t, { lastId: 0, sessions: {}, handled: {} }, { clock: true, presence: true, query: true, slots: 3, progressWriteMs: 1, presenceIntervalMs: 25 });
  const vm = addonVM(), nonce = 'query-owner-000001';
  const profile = JSON.stringify({ version: 1, enabled: ['inventory'], data: { inventory: [] } });
  const hex = text => Buffer.from(text).toString('hex');
  const state = (responseNonce, request) => fixture.outbox(nonce).replace('["text"]', `["profile"] = "${hex(profile)}", ["text"]`).replace(/ } }$/, `${responseNonce ? ` }, ["contextOutbox"] = { ["id"] = 146, ["session"] = "token", ["chat"] = "chat", ["generation"] = "generation-0001", ["nonce"] = "${responseNonce}", ["request"] = "${request || batch}", ["text"] = "${hex('[{"ok":true,"data":{"inventory":[]}}]')}"` : ''} } }`);
  fixture.write(state());
  fixture.start([]);
  await waitReply(fixture, vm, nonce, 'working');
  await waitFor(() => fixture.pulses().length >= 1 && fixture.callCount() === 1);
  assertPulse(fixture, vm, 0, nonce, 'working');
  fixture.release(1);
  await waitReply(fixture, vm, nonce, 'context_query');
  await waitFor(() => fixture.pulses().length >= 2);
  assertPulse(fixture, vm, 1, nonce, 'context_query');
  const batch = replyField(vm, nonce, 'request');
  fixture.write(state('query-stale-000001'));
  await waitClock(fixture, vm, fixture.advance(1));
  assert.equal(replyField(vm, nonce), 'context_query');
  assert.equal(fixture.callCount(), 1, 'a reused numeric id and query round cannot resume another nonce');
  assert.equal(fixture.pulses().length, 2);
  fixture.write(state(nonce, '146-0'));
  await waitClock(fixture, vm, fixture.advance(1));
  assert.equal(fixture.callCount(), 1, 'an old query round cannot resume this owner');
  fixture.write(state(nonce));
  await waitReply(fixture, vm, nonce, 'working');
  await waitFor(() => fixture.pulses().length >= 3 && fixture.callCount() === 2);
  assertPulse(fixture, vm, 2, nonce, 'working');
  fixture.progress(2);
  await waitReply(fixture, vm, nonce, 'working', 'Fixture progress');
  fixture.write(state(nonce) + '\n-- repeated complete response');
  await waitClock(fixture, vm, fixture.advance(1));
  assert.equal(fixture.callCount(), 2);
  assert.equal(fixture.pulses().length, 3);
  fixture.release(2);
  await waitReply(fixture, vm, nonce, 'done');
  await waitFor(() => fixture.pulses().length >= 4);
  assertPulse(fixture, vm, 3, nonce, 'done');
  assert.equal(fixture.messages().filter(message => message.role === 'user').length, 1);
});

test('same-chat queued nonces are not overwritten and older phases cannot replace the latest full receipt', async t => {
  const fixture = bridgeSandbox(t, { lastId: 0, sessions: {}, handled: {} }, { presence: true, maxParallel: 1, progressWriteMs: 1 });
  const vm = addonVM(), first = 'same-chat-000001', second = 'same-chat-000002', third = 'same-chat-000003';
  fixture.write(fixture.outbox(first));
  fixture.start([]);
  await waitReply(fixture, vm, first, 'working');
  await waitFor(() => fixture.callCount() === 1);
  fixture.write(fixture.outbox(second));
  await waitReply(fixture, vm, second, 'queued');
  fixture.write(fixture.outbox(third));
  await waitReply(fixture, vm, third, 'queued');
  fixture.progress(1);
  await new Promise(resolve => setTimeout(resolve, 100));
  vm.run(fs.readFileSync(fixture.inbox, 'utf8'));
  assert.equal(replyField(vm, third), 'queued', 'older running progress cannot overwrite a newer complete receipt');
  fixture.release(1);
  await waitFor(() => fixture.callCount() === 2);
  vm.run(fs.readFileSync(fixture.inbox, 'utf8'));
  assert.equal(replyField(vm, third), 'queued', 'starting an earlier queued nonce cannot overwrite the latest accepted request');
  fixture.release(2);
  await waitReply(fixture, vm, third, 'working');
  await waitFor(() => fixture.callCount() === 3);
  fixture.release(3);
  await waitReply(fixture, vm, third, 'done');
  assert.equal(fixture.messages().filter(message => message.role === 'user').length, 3, 'every fully received queued nonce runs once');
  assert.equal(fixture.messages().filter(message => message.role === 'assistant').length, 3);
});

test('a final validation error publishes nonce-correlated readiness once without launching a provider', async t => {
  const fixture = bridgeSandbox(t, { lastId: 0, sessions: {}, handled: {} }, { presence: true, slots: 3, presenceIntervalMs: 25 });
  const vm = addonVM(), nonce = 'invalid-profile-000001';
  const source = fixture.outbox(nonce).replace('["text"]', `["profile"] = "${Buffer.from('{"version":0}').toString('hex')}", ["text"]`);
  fixture.write(source);
  fixture.start([]);
  await waitReply(fixture, vm, nonce, 'error');
  await waitFor(() => fixture.pulses().length >= 1);
  assertPulse(fixture, vm, 0, nonce, 'error');
  fixture.write(source + '\n-- duplicate rejected request');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(fixture.callCount(), 0);
  assert.equal(fixture.pulses().length, 1, 'replayed errors and idle publications do not spend more flags');
});

function controlState(kind, nonce, target = '', chat = 'chat', generation = 'generation-0001', session = 'token') {
  const flags = kind === 'forget' ? 'd' : `receipt=${kind};target=${target}`;
  const record = [session, chat, '900', '', `${flags};nonce=${nonce};generation=${generation}`, '', ''].join('\x1f');
  return `WowieDB = { ["controlOutbox"] = "${Buffer.from(record).toString('hex')}" }`;
}

async function receipt(fixture, vm, kind, nonce, chat = 'chat', session = 'token') {
  await waitFor(() => {
    if (!fs.existsSync(fixture.inbox)) return false;
    vm.run(fs.readFileSync(fixture.inbox, 'utf8'));
    return vm.get(`(function() for _, r in ipairs(Wowie_Inbox.receipts or {}) do if r.kind == ${P.luaStr(kind)} and r.nonce == ${P.luaStr(nonce)} and r.chat == ${P.luaStr(chat)} and r.session == ${P.luaStr(session)} then return true end end end)()`) === 'true';
  });
}

test('control receipt snapshots stay bounded while old durable acknowledgements remain replayable', async t => {
  const fixture = bridgeSandbox(t, {}), vm = addonVM();
  fixture.start([]);
  for (let i = 0; i < 70; i++) {
    const nonce = `bounded-forget-${String(i).padStart(4, '0')}`;
    fixture.write(controlState('forget', nonce));
    await receipt(fixture, vm, 'forget', nonce);
    assert.ok(Number(vm.get('#Wowie_Inbox.receipts')) <= 64);
  }
  const first = 'bounded-forget-0000';
  assert.equal(vm.get(`(function() for _, r in ipairs(Wowie_Inbox.receipts) do if r.nonce == "${first}" then return true end end return false end)()`), 'false');
  fixture.write(controlState('forget', first));
  await receipt(fixture, vm, 'forget', first);
  assert.ok(Number(vm.get('#Wowie_Inbox.receipts')) <= 64, 'replaying an older acknowledgement keeps the window bounded');
  assert.equal(fixture.callCount(), 0);
});

async function stopBridge(running, signal = 'SIGTERM') {
  running.child.kill(signal);
  await running.closed;
}

function queryState(fixture, nonce, batch, generation = 'generation-0001') {
  return fixture.outbox(nonce, 'chat', 146, generation).replace(/ } }$/, ` }, ["contextOutbox"] = { ["id"]=146, ["session"]="token", ["chat"]="chat", ["generation"]="${generation}", ["nonce"]="${nonce}", ["request"]="${batch}", ["text"]="${Buffer.from('[{"ok":true,"data":{"inventory":[]}}]').toString('hex')}" } }`);
}

test('full final replies survive restart, receipt retries and saved-data rollback without another provider turn', async t => {
  const answer = 'Question completed.\n' + 'Detailed answer preserved across recovery.\n'.repeat(300) + 'End.';
  const fixture = bridgeSandbox(t, {}, {replyText: answer}), vm = addonVM(), nonce = 'replay-owner-0001';
  fixture.write(fixture.outbox(nonce));
  fixture.release(1);
  let running = fixture.start([]);
  await waitReply(fixture, vm, nonce, 'done');
  const text = replyField(vm, nonce, 'text');
  assert.equal(text, answer, 'journal retains the full answer beyond the transcript copy limit');
  await stopBridge(running, 'SIGKILL');
  running = fixture.start([]);
  await waitReply(fixture, vm, nonce, 'done');
  assert.equal(replyField(vm, nonce, 'text'), text);
  fixture.write(controlState('reply', 'reply-receipt-0001', nonce));
  await receipt(fixture, vm, 'reply', 'reply-receipt-0001');
  await stopBridge(running);
  running = fixture.start([]);
  await receipt(fixture, vm, 'reply', 'reply-receipt-0001');
  fixture.write(fixture.outbox(nonce));
  await waitReply(fixture, vm, nonce, 'done');
  assert.equal(replyField(vm, nonce, 'text'), text);
  assert.equal(fixture.callCount(), 1);
  assert.equal(fixture.messages().filter(m => m.role === 'user').length, 1);
});

test('owner death interrupts uncertain work, cleans descendants and resumes durable queued work once', async t => {
  const fixture = bridgeSandbox(t, {}, {maxParallel: 1, descendant: true}), vm = addonVM();
  fixture.write(fixture.outbox('interrupted-owner-0001', 'busy'));
  const running = fixture.start([]);
  await waitFor(() => fixture.callCount() === 1 && fs.existsSync(path.join(fixture.dir, 'descendant')));
  const pids = [fixture.callsRead()[0].pid, Number(fs.readFileSync(path.join(fixture.dir, 'descendant'), 'utf8'))];
  t.after(() => { for (const pid of pids) { try { process.kill(pid); } catch {} } });
  fixture.write(fixture.outbox('queued-owner-0001', 'waiting'));
  await waitReply(fixture, vm, 'queued-owner-0001', 'queued');
  await stopBridge(running, 'SIGKILL');
  await waitFor(() => pids.every(pid => {
    try {
      process.kill(pid, 0);
      // Linux zombies have exited and cannot execute; container init may reap later.
      return process.platform === 'linux' && /\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
    } catch (error) { return error.code === 'ESRCH' || error.code === 'ENOENT'; }
  }));
  fixture.write('WowieDB = {}');
  fixture.release(2);
  fixture.start([]);
  await waitReply(fixture, vm, 'queued-owner-0001', 'done');
  fixture.write(fixture.outbox('interrupted-owner-0001', 'busy'));
  await waitReply(fixture, vm, 'interrupted-owner-0001', 'error');
  assert.equal(fixture.callCount(), 2);
  assert.equal(fixture.messages('waiting').filter(m => m.role === 'user').length, 1);
});

test('durable context waits retain exact batch identity and resume the provider conversation after restart', async t => {
  const fixture = bridgeSandbox(t, {}, {queryEvery: true, clock: true, presenceIntervalMs: 25}), vm = addonVM(), nonce = 'context-recovery-0001';
  fixture.write(withProfile(fixture.outbox(nonce)));
  fixture.release(1);
  const running = fixture.start([]);
  await waitReply(fixture, vm, nonce, 'context_query');
  const batch = replyField(vm, nonce, 'request');
  assert.ok(batch);
  await stopBridge(running);
  fixture.write('WowieDB = {}');
  fixture.start([]);
  await waitReply(fixture, vm, nonce, 'context_query');
  assert.equal(replyField(vm, nonce, 'request'), batch);
  fixture.write(queryState(fixture, nonce, batch));
  await waitFor(() => fixture.callCount() === 2);
  assert.ok(fixture.callsRead()[1].argv.includes('--resume'));
  assert.ok(fixture.callsRead()[1].input.includes('[Read-only addon query results:'));
  fixture.release(2);
  await waitReply(fixture, vm, nonce, 'done');
  fixture.write(withProfile(fixture.outbox('context-recovery-0002')));
  fixture.release(3);
  await waitReply(fixture, vm, 'context-recovery-0002', 'context_query');
  const nextBatch = replyField(vm, 'context-recovery-0002', 'request');
  assert.notEqual(nextBatch, batch);
  fixture.write(queryState(fixture, 'context-recovery-0002', batch));
  await waitClock(fixture, vm, fixture.advance(1));
  assert.equal(fixture.callCount(), 3, 'an old batch cannot resume a newer same-id request');
  assert.equal(replyField(vm, 'context-recovery-0002'), 'context_query');
  fixture.write(queryState(fixture, 'context-recovery-0002', nextBatch));
  fixture.release(4);
  await waitReply(fixture, vm, 'context-recovery-0002', 'done');
  assert.equal(fixture.callCount(), 4);
  assert.equal(fixture.messages().filter(m => m.role === 'user').length, 2);
});

test('superseded providers asking for context cannot block the latest same-chat question', async t => {
  const fixture = bridgeSandbox(t, {}, {query: true, maxParallel: 1}), vm = addonVM();
  fixture.write(withProfile(fixture.outbox('superseded-owner-0001')));
  fixture.start([]);
  await waitFor(() => fixture.callCount() === 1);
  fixture.write(fixture.outbox('latest-owner-000001'));
  await waitReply(fixture, vm, 'latest-owner-000001', 'queued');
  fixture.release(1);
  await waitFor(() => fixture.callCount() === 2);
  fixture.release(2);
  await waitReply(fixture, vm, 'latest-owner-000001', 'done');
  assert.equal(fixture.callCount(), 2);
  assert.ok(!fixture.callsRead()[1].input.includes('[Read-only addon query results:'));
});

test('forget receipts retire queued and late running work, survive retries and isolate a new generation', async t => {
  const fixture = bridgeSandbox(t, {}, {maxParallel: 1}), vm = addonVM();
  fixture.write(fixture.outbox('forgotten-running-0001'));
  let running = fixture.start([]);
  await waitFor(() => fixture.callCount() === 1);
  fixture.write(fixture.outbox('forgotten-queued-0001'));
  await waitReply(fixture, vm, 'forgotten-queued-0001', 'queued');
  const forget = controlState('forget', 'forget-control-0001');
  fixture.write(forget);
  await receipt(fixture, vm, 'forget', 'forget-control-0001');
  fixture.release(1);
  await waitFor(() => {
    try { process.kill(fixture.callsRead()[0].pid, 0); return false; }
    catch (error) { return error.code === 'ESRCH'; }
  });
  await stopBridge(running);
  running = fixture.start([]);
  await receipt(fixture, vm, 'forget', 'forget-control-0001');
  fixture.write(fixture.outbox('fresh-generation-0001', 'chat', 146, 'generation-0002'));
  fixture.release(2);
  await waitReply(fixture, vm, 'fresh-generation-0001', 'done');
  assert.equal(fixture.callCount(), 2);
  assert.ok(!fixture.callsRead()[1].argv.includes('--resume'), 'forgotten provider session must not leak into the new incarnation');
  assert.equal(fixture.messages().filter(m => m.role === 'user').length, 1);
  fixture.write(controlState('forget', 'late-forget-control', '', 'chat', 'generation-0001'));
  await receipt(fixture, vm, 'forget', 'late-forget-control');
  fixture.write(fixture.outbox('after-late-forget', 'chat', 147, 'generation-0002'));
  fixture.release(3);
  await waitReply(fixture, vm, 'after-late-forget', 'done');
  assert.ok(fixture.callsRead()[2].argv.includes('--resume'), 'a late old-generation deletion cannot erase the replacement session');
  assert.equal(fixture.messages().filter(m => m.role === 'user').length, 2);
});

test('only one live bridge owns an installation and owner death permits recovery', async t => {
  const fixture = bridgeSandbox(t, {}), vm = addonVM();
  fixture.write(fixture.outbox('singleton-owner-0001'));
  const first = fixture.start([]);
  await waitFor(() => fixture.callCount() === 1);
  const second = fixture.start([]);
  await waitFor(() => second.child.exitCode !== null || second.child.signalCode !== null);
  assert.notEqual(await second.exited, 0, second.output());
  assert.equal(fixture.callCount(), 1);
  fixture.release(1);
  await waitReply(fixture, vm, 'singleton-owner-0001', 'done');
  await stopBridge(first, 'SIGKILL');
  fixture.write(fixture.outbox('singleton-owner-0002'));
  fixture.release(2);
  fixture.start([]);
  await waitReply(fixture, vm, 'singleton-owner-0002', 'done');
  assert.equal(fixture.callCount(), 2);
});

function withProfile(source) {
  const profile = JSON.stringify({version: 1, enabled: ['inventory'], data: {inventory: []}});
  return source.replace('["text"]', `["profile"]="${Buffer.from(profile).toString('hex')}", ["text"]`);
}

test('profile waits survive restart and forgotten fragments cannot resurrect old generations', async t => {
  const fixture = bridgeSandbox(t, {}, {capture: true}), vm = addonVM(), nonce = 'profile-recovery-0001';
  const record = (owner, flags, text = '') => ['token', 'chat', '146', '', `nonce=${owner};generation=generation-0001;${flags}`, 'Chat', text].join('\x1f');
  let running = fixture.start([]);
  await capturePacket(fixture, running, record(nonce, 'profile=146', 'Read selected inventory'));
  await waitReply(fixture, vm, nonce, 'context');
  fixture.clearStrip();
  await stopBridge(running);
  running = fixture.start([]);
  await waitReply(fixture, vm, nonce, 'context');
  const payload = Buffer.from(JSON.stringify({version: 1, enabled: ['inventory'], data: {inventory: []}})).toString('base64');
  await capturePacket(fixture, running, record(nonce, 'data=profile;profile=146;encoding=b64;part=1/1', payload));
  await waitFor(() => fixture.callCount() === 1);
  fixture.release(1);
  await waitReply(fixture, vm, nonce, 'done');
  const forgotten = 'profile-forgotten-0001';
  await capturePacket(fixture, running, record(forgotten, 'profile=146', 'Never run this'));
  await waitReply(fixture, vm, forgotten, 'context');
  fixture.write(controlState('forget', 'profile-forget-0001'));
  await receipt(fixture, vm, 'forget', 'profile-forget-0001');
  await capturePacket(fixture, running, record(forgotten, 'data=profile;profile=146;encoding=b64;part=1/1', payload));
  await capturePacket(fixture, running, record('unseen-forgotten-0001', '', 'Delayed old question'));
  fixture.write(fixture.outbox('profile-new-generation', 'chat', 146, 'generation-0002'));
  fixture.release(2);
  await waitReply(fixture, vm, 'profile-new-generation', 'done');
  assert.equal(fixture.callCount(), 2);
  assert.ok(!fixture.callsRead()[1].argv.includes('--resume'));
  assert.equal(fixture.messages().filter(m => m.role === 'user').length, 1);
});

test('restore offers survive unrelated publications and restart until their exact acknowledgement', async t => {
  const fixture = bridgeSandbox(t, {}, {capture: true}), vm = addonVM();
  fixture.write(fixture.outbox('restore-original-0001'));
  fixture.release(1);
  let running = fixture.start([]);
  await waitReply(fixture, vm, 'restore-original-0001', 'done');
  fixture.write('WowieDB = {}');
  const hello = index => ['reset-session', 'empty-chat', '500', '', `h;nonce=restore-hello-${String(index).padStart(4, '0')}`, '', ''].join('\x1f');
  await capturePacket(fixture, running, hello(0), 500);
  await waitAck(fixture, vm, 'restore-hello-0000');
  const offer = vm.get('Wowie_Inbox.restore and Wowie_Inbox.restore.id');
  assert.ok(offer);
  assert.equal(vm.get('Wowie_Inbox.restore.chats[1].messages[1].text'), 'The same player question');
  for (let i = 1; i <= 12; i++) {
    await capturePacket(fixture, running, hello(i), 500);
    await waitAck(fixture, vm, `restore-hello-${String(i).padStart(4, '0')}`);
    assert.equal(vm.get('Wowie_Inbox.restore.id'), offer);
  }
  fixture.clearStrip();
  await stopBridge(running);
  running = fixture.start([]);
  await capturePacket(fixture, running, hello(13), 500);
  await waitAck(fixture, vm, 'restore-hello-0013');
  assert.equal(vm.get('Wowie_Inbox.restore.id'), offer);
  fixture.write(controlState('restore', 'wrong-restore-0001', 'wrong-offer-0001', '', 'generation-0001', 'reset-session'));
  await capturePacket(fixture, running, hello(14), 500);
  await waitAck(fixture, vm, 'restore-hello-0014');
  assert.equal(vm.get('Wowie_Inbox.restore.id'), offer);
  fixture.write(controlState('restore', 'right-restore-0001', offer, '', 'generation-0001', 'reset-session'));
  await receipt(fixture, vm, 'restore', 'right-restore-0001', '', 'reset-session');
  assert.equal(vm.get('Wowie_Inbox.restore and Wowie_Inbox.restore.id'), null);
  fixture.clearStrip();
  await stopBridge(running);
  running = fixture.start([]);
  await receipt(fixture, vm, 'restore', 'right-restore-0001', '', 'reset-session');
  await capturePacket(fixture, running, hello(15), 500);
  await waitAck(fixture, vm, 'restore-hello-0015');
  assert.equal(vm.get('Wowie_Inbox.restore and Wowie_Inbox.restore.id'), null);
  assert.equal(fixture.callCount(), 1);
});

test('periodic maintenance reclaims abandoned partial profiles without any completing packet', async t => {
  const fixture = bridgeSandbox(t, {}, {capture: true, clock: true, presenceIntervalMs: 25}), vm = addonVM();
  const running = fixture.start([]);
  await waitClock(fixture, vm, fixture.advance(0));
  const record = (nonce, flags, text) => ['token', 'chat', '146', '', `nonce=${nonce};generation=generation-0001;${flags}`, 'Chat', text].join('\x1f');
  for (let i = 0; i < 64; i++) {
    await capturePacket(fixture, running, record(`orphan-profile-${String(i).padStart(4, '0')}`, 'data=profile;profile=146;encoding=b64;part=1/2', 'eyJ2'));
  }
  await waitClock(fixture, vm, fixture.advance(60));
  // Let the independent maintenance timer run; no further data packet is sent.
  await new Promise(resolve => setTimeout(resolve, 8000));
  const nonce = 'after-orphan-sweep';
  await capturePacket(fixture, running, record(nonce, 'profile=146', 'Read after orphan cleanup'));
  await waitReply(fixture, vm, nonce, 'context');
  const payload = Buffer.from(JSON.stringify({version: 1, enabled: ['inventory'], data: {inventory: []}})).toString('base64');
  await capturePacket(fixture, running, record(nonce, 'data=profile;profile=146;encoding=b64;part=1/1', payload));
  await waitFor(() => fixture.callCount() === 1);
  fixture.release(1);
  await waitReply(fixture, vm, nonce, 'done');
  assert.equal(fixture.callCount(), 1);
});
