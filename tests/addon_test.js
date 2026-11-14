// Runs the real addon Lua (Codec.lua + WoWAI.lua) in a Lua VM with a stub
// WoW API (wow_stub.lua) and drives it through a session: login, hello, a sent
// message read back off the pixel strip, a reply delivered through a slot, the
// bridge's default folder and agent, a chat that picks another agent, a
// permission denial with Allow, and a restore.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fengari = require('fengari');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;
const P = require('../bridge/protocol');
const A = require('../bridge/agents');
const ContextProtocol = require('../bridge/context');
const zlib = require('node:zlib');

const ADDON = path.join(__dirname, '..', 'addon', 'WoWAI');
const CELLS_PER_ROW = 200;

function newVM(nativeEncoding = false) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = (code, arg) => {
    if (lauxlib.luaL_loadstring(L, to_luastring(code)) !== lua.LUA_OK) throw new Error('Lua load: ' + to_jsstring(lua.lua_tostring(L, -1)));
    let nargs = 0;
    if (arg !== undefined) { lua.lua_pushstring(L, to_luastring(arg)); nargs = 1; }
    if (lua.lua_pcall(L, nargs, 0, 0) !== lua.LUA_OK) throw new Error('Lua error: ' + to_jsstring(lua.lua_tostring(L, -1)));
  };
  // Evaluate an expression and bring it back as a string (or nil).
  const evaluate = (expr) => {
    run(`local v = (${expr}); if v == nil then RESULT = nil else RESULT = tostring(v) end`);
    lua.lua_getglobal(L, to_luastring('RESULT'));
    const isNil = lua.lua_isnil(L, -1);
    const s = isNil ? null : to_jsstring(lua.lua_tolstring(L, -1));
    lua.lua_pop(L, 1);
    return s;
  };
  const num = (expr) => Number(evaluate(expr));
  run(fs.readFileSync(path.join(__dirname, 'wow_stub.lua'), 'utf8'));
  if (nativeEncoding) {
    run('Enum = Enum or {}; Enum.CompressionMethod = {Deflate=0,Zlib=1,Gzip=2}; Enum.CompressionLevel = {OptimizeForSpeed=1}');
    lua.lua_newtable(L);
    const encoders = {
      CompressString: state => [zlib.deflateRawSync, zlib.deflateSync, zlib.gzipSync][lua.lua_tointeger(state, 2)](Buffer.from(lua.lua_tolstring(state, 1)), {level: 1}),
      EncodeBase64: state => Buffer.from(Buffer.from(lua.lua_tolstring(state, 1)).toString('base64')),
    };
    for (const [name, encode] of Object.entries(encoders)) {
      lua.lua_pushjsfunction(L, state => {
        const bytes = encode(state);
        lua.lua_pushlstring(state, bytes, bytes.length);
        return 1;
      });
      lua.lua_setfield(L, -2, to_luastring(name));
    }
    lua.lua_setglobal(L, to_luastring('C_EncodingUtil'));
  }
  for (const f of ['Codec.lua', 'Inbox.lua', 'WoWAI.lua', 'Context.lua', 'ContextUI.lua']) run(fs.readFileSync(path.join(ADDON, f), 'utf8'), 'WoWAI');
  return { run, evaluate, num };
}

// Read the strip the addon drew, exactly like capture.ps1: 3 bits per cell,
// [C7 1A] [id] [len] [payload] [fletcher]. Returns { id, text } or null.
function decodeStrip(vm) {
  if (vm.evaluate('WoWAIStrip and WoWAIStrip.shown') !== 'true') return null;
  vm.run(`
    local source, lastRow = {}, 0
    local cell = WoWAIStrip.cell or 4
    local threshold = WoWAIStrip.display:match("^quiet") and (48 / 255) or 0.5
    for _, t in ipairs(WoWAIStrip.textures) do
      if t.shown and t.color then
        local c, r = math.floor(t.x / cell), math.floor(-t.y / cell)
        source[r * ${CELLS_PER_ROW} + c] = (t.color[1] >= threshold and 4 or 0) + (t.color[2] >= threshold and 2 or 0) + (t.color[3] >= threshold and 1 or 0)
        lastRow = math.max(lastRow, r)
      end
    end
    local _, height = GetPhysicalScreenSize()
    local pixelsPerUnit = WoWAIStrip:GetEffectiveScale() * height * GetScreenDPIScale() / 768
    local parts = {}
    for r = 0, math.min(48, math.ceil((lastRow + 1) * pixelsPerUnit)) - 1 do
      for c = 0, ${CELLS_PER_ROW} - 1 do
        -- Sample physical cell centers; an incorrect native scale still corrupts decoding.
        local sc, sr = math.floor((c + 0.5) / pixelsPerUnit), math.floor((r + 0.5) / pixelsPerUnit)
        parts[#parts + 1] = tostring(sc < ${CELLS_PER_ROW} and source[sr * ${CELLS_PER_ROW} + sc] or 0)
      end
    end
    RESULT = table.concat(parts, ",")`);
  const cells = vm.evaluate('RESULT').split(',').map(Number);
  const bytes = [];
  let acc = 0, nbits = 0;
  for (let i = 0; i < cells.length; i++) {
    acc = (acc << 3) | (cells[i] || 0); nbits += 3;
    while (nbits >= 8) { bytes.push((acc >> (nbits - 8)) & 0xff); nbits -= 8; acc &= (1 << nbits) - 1; }
  }
  assert.equal(bytes[0], 0xc7); assert.equal(bytes[1], 0x1a);
  const id = bytes[2] * 256 + bytes[3];
  const len = bytes[4] * 256 + bytes[5];
  let s1 = 0, s2 = 0;
  for (let k = 2; k < 6 + len; k++) { s1 = (s1 + bytes[k]) % 255; s2 = (s2 + s1) % 255; }
  assert.equal(bytes[6 + len], s1, 'fletcher s1'); assert.equal(bytes[7 + len], s2, 'fletcher s2');
  return { id, text: Buffer.from(bytes.slice(6, 6 + len)).toString('utf8') };
}

function stripRecords(vm) {
  const frame = decodeStrip(vm);
  if (!frame) return [];
  return frame.text.split('\x1E').map(r => {
    const p = r.split('\x1F');
    const withCtx = p[4].split(';').includes('c'); // a "c" flag means field 7 is the game context
    const rec = { session: p[0], chat: p[1], id: Number(p[2]), cwd: p[3], flags: p[4], name: p[5], text: p.slice(withCtx ? 7 : 6).join('\x1F') };
    if (withCtx) rec.ctx = p[6];
    return rec;
  });
}

// Auto-send and multipart timers can run in the same native frame; observe the
// complete rotation instead of assuming the question is the current fragment.
function questionRecord(vm, text) {
  for (let i = 0; i < 100; i++) {
    const record = stripRecords(vm).find(r => r.text === text && !P.parseFlags(r.flags).data);
    if (record) return record;
    vm.run('STUB.now = STUB.now + 0.5; STUB.Tick()');
  }
  assert.fail('question was not published during a complete strip rotation');
}

// Make the next LoadAddOn deliver this slot data (a Lua table literal body).
function nextSlot(vm, luaBody, requestProtocol = 1) {
  vm.run(`STUB.onLoadAddOn = function(name) WoWAI_SlotData = ${luaBody}; WoWAI_SlotData.contextProtocol = WoWAI_SlotData.contextProtocol or 2; WoWAI_SlotData.requestProtocol = ${requestProtocol === null ? 'nil' : requestProtocol} end`);
}

function login(vm) {
  vm.run('STUB.FireEvent("ADDON_LOADED", "WoWAI")');
  vm.run('STUB.FireEvent("PLAYER_LOGIN")');
}

// Simulate an acknowledgement of the hello actually emitted on the wire, not
// a clock-only heartbeat. Capturing identity now keeps later publications stable.
function nextAck(vm, body = '{ now = time(), cwd = "", replies = {} }', requestProtocol = 1) {
  const hello = stripRecords(vm).find(r => P.parseFlags(r.flags).hello);
  assert.ok(hello, 'an outbound hello must precede its acknowledgement');
  const nonce = P.parseFlags(hello.flags).nonce;
  nextSlot(vm, `(function() local d = ${body}; d.connectionProtocol = 1; d.connectionAck = {session=${P.luaStr(hello.session)},nonce=${P.luaStr(nonce)},at=time()}; return d end)()`, requestProtocol);
}

// Let the bridge answer the login challenge.
function connect(vm) {
  vm.run('STUB.RunTimers()'); // C_Timer.After(3, SayHello)
  nextAck(vm);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()'); // hello poll 5 s later
  assert.equal(vm.evaluate('WoWAI.IsConnected()'), 'true', 'connected after the hello slot');
}

function loadedSlots(vm) {
  return vm.num('(function() local n = 0; for name in pairs(STUB.loaded) do if name:match("^WoWAI_S%d%d%d$") then n = n + 1 end end; return n end)()');
}

const FAST_TRANSPORT = 'transportProtocol=1, transport={displays={"robust","compact","quiet","quiet4"},frameIntervalMs=100,captureIntervalMs=50}';

function wake(vm) {
  vm.run(`STUB.wake = (STUB.wake or 0) + 1
    STUB.sounds[string.format("Interface\\\\AddOns\\\\WoWAI\\\\presence\\\\%04d.wav", STUB.wake)] = true`);
}

function connectFast(vm, transport = FAST_TRANSPORT) {
  vm.run('STUB.sounds["Interface\\\\AddOns\\\\WoWAI\\\\ctl\\\\valid.wav"] = true');
  login(vm);
  vm.run('STUB.Advance(3.01)');
  nextAck(vm, `{now=time(),replies={},${transport}}`);
  wake(vm);
  vm.run('STUB.Advance(0.11)');
  assert.equal(vm.evaluate('WoWAI.IsConnected()'), 'true');
}

function chooseDisplay(vm, display, save = true) {
  vm.run(`WoWAI.ShowDefaults()
    local b = WoWAIPixelDisplay${display[0].toUpperCase() + display.slice(1)}; b:GetScript("OnClick")(b)
    local action = ${save ? 'WoWAIDefaultsSave' : 'WoWAIDefaultsCancel'}; action:GetScript("OnClick")(action)`);
}

function acknowledgeDisplay(vm, display) {
  const record = stripRecords(vm).find(r => P.parseFlags(r.flags).calibration);
  assert.ok(record, 'a full-size native display probe must be on the wire');
  const nonce = P.parseFlags(record.flags).nonce;
  nextSlot(vm, `{now=time(),connectionProtocol=1,connectionAck={session=${P.luaStr(record.session)},nonce=${P.luaStr(nonce)},at=time(),display=${P.luaStr(display)}},replies={},${FAST_TRANSPORT}}`);
  wake(vm);
  vm.run('STUB.Advance(0.11)');
}

test('addon loads, builds its UI and creates a first chat', () => {
  const vm = newVM();
  login(vm);
  assert.equal(vm.num('#WoWAIDB.chats'), 1);
  assert.equal(vm.evaluate('WoWAIDB.chats[1].name'), 'Chat 1');
  assert.equal(vm.evaluate('WoWAIFrame ~= nil'), 'true');
  assert.equal(vm.evaluate('WoWAIMini ~= nil'), 'true');
  assert.equal(vm.evaluate('SlashCmdList.WOWAI ~= nil'), 'true');
  assert.deepEqual([1, 2, 3, 4, 5].map(i => vm.evaluate('SLASH_WOWAI' + i)), ['/wow-ai', '/wowai', '/wow-claude', '/ai', '/ask'], 'the old command name and the short forms are aliases');
  assert.equal(vm.evaluate('SlashCmdList.WOWAIASK'), null, '/ai is an alias of the one command, not a handler of its own');
});

test('navigation is safely unavailable when the map module is not loaded', () => {
  const vm = newVM();
  vm.run('WoWAI.UpdateNavigation()'); // Safe even before PLAYER_LOGIN builds the header.
  login(vm);
  vm.run('WoWAI.Toggle(true); WoWAIInput:SetText("keep this draft")');
  assert.equal(vm.evaluate('WoWAINavigation:IsShown()'), 'true');
  assert.equal(vm.evaluate('WoWAINavigation:IsEnabled()'), 'false');
  vm.run('WoWAINavigation:GetScript("OnClick")(WoWAINavigation); WoWAI.UpdateNavigation()');
  assert.equal(vm.evaluate('WoWAINavigationPanel'), null, 'no substitute navigation UI is invented');
  assert.equal(vm.evaluate('WoWAIInput:GetText()'), 'keep this draft');
  assert.equal(vm.evaluate('WoWAIDB.hello'), null, 'opening navigation cannot initiate a connection check');
  assert.equal(vm.evaluate('WoWAIDB.outbox'), null);
});

test('real map navigation opens offline and updates independently of discussion, drafts and sharing', () => {
  const vm = newVM();
  vm.run(fs.readFileSync(path.join(ADDON, 'Map.lua'), 'utf8'), 'WoWAI');
  vm.run(`
    WoWAIMapDB = { map = { epoch = "saved", version = 1, layers = {
      { name = "opaque-layer-42", title = "Darkshire errands", ordered = false, points = {
        {1431, 30, 40, "Town hall", "poi"}, {1431, 50, 60, "Scarlet Raven inn", "vendor"}
      } }
    } } }
    UiMapPoint = { CreateFromCoordinates = function(mapID, x, y)
      return {uiMapID=mapID, position={x=x,y=y}}
    end }
    C_Map.GetUserWaypoint = function() return STUB.waypoint end
    C_Map.SetUserWaypoint = function(point) STUB.waypoint = point; return true end
    C_Map.ClearUserWaypoint = function() STUB.waypoint = nil end
    C_SuperTrack = {
      SetSuperTrackedUserWaypoint = function(value) STUB.tracked = value end,
      IsSuperTrackingUserWaypoint = function() return STUB.tracked == true end
    }
  `);
  login(vm);
  vm.run(`
    WoWAI.Toggle(true)
    table.insert(WoWAIDB.chats[1].history, {role="assistant",text="Keep this selectable answer"})
    WoWAI.Render()
    WoWAIInput:SetText("  preserve my next question  ")
    WoWAIMessageText1:SetFocus()
    WoWAIMessageText1:HighlightText(5, 14)
    ORIGINAL_CHAT, ORIGINAL_HISTORY = WoWAIDB.chats[1], WoWAIDB.chats[1].history
    ORIGINAL_MAP, ORIGINAL_LAYERS = WoWAIMapDB.map, WoWAIMapDB.map.layers
    ORIGINAL_SHARING = WoWAIDB.settings.context
    ORIGINAL_SCROLL, ORIGINAL_COMPOSER = WoWAIScroll:GetHeight(), WoWAIInput:GetHeight()
    function WoWAI.Render() error("navigation must not rebuild the discussion") end
    function WoWAI.GameContext() error("navigation must not collect character context") end
    function WoWAIContext.Snapshot() error("navigation must not collect shared information") end
    function WoWAI.Send() error("navigation must not submit an AI request") end
  `);
  assert.equal(vm.evaluate('WoWAINavigation:IsEnabled()'), 'true');
  assert.equal(vm.evaluate('WoWAINavigationPanel'), null, 'the navigation window remains lazy');
  vm.run('WoWAINavigation:GetScript("OnClick")(WoWAINavigation)');
  assert.equal(vm.evaluate('WoWAINavigationPanel:IsShown()'), 'true', 'the header opens the actual map navigation window');
  vm.run('WoWAIMap.Navigate("opaque-layer-42", 2)');
  assert.equal(vm.evaluate('WoWAIMap.GetNavigationState().status'), 'native');
  assert.equal(vm.num('STUB.waypoint.position.x'), 0.5, 'tracking uses the chosen saved destination');
  assert.match(vm.evaluate('WoWAINavigation:GetText()'), /Scarlet Raven inn/);
  assert.doesNotMatch(vm.evaluate('WoWAINavigation:GetText()'), /opaque-layer/);
  assert.match(vm.evaluate('WoWAINavigation.navigationBody'), /2 of 2[\s\S]*native waypoint/i);
  vm.run('WoWAIMap.Stop(); WoWAI.UpdateNavigation()');
  assert.equal(vm.evaluate('STUB.waypoint'), null, 'stopping releases navigation rather than leaving phantom tracking');
  assert.doesNotMatch(vm.evaluate('WoWAINavigation:GetText()'), /Scarlet Raven inn/);
  assert.match(vm.evaluate('WoWAINavigation.navigationBody'), /No active destination/);
  assert.equal(vm.evaluate('WoWAIMessageText1:HasFocus()'), 'true');
  assert.equal(vm.num('WoWAIMessageText1.highlightStart'), 5);
  assert.equal(vm.num('WoWAIMessageText1.highlightEnd'), 14);
  assert.equal(vm.evaluate('WoWAIInput:GetText()'), '  preserve my next question  ');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].draft'), '  preserve my next question  ');
  assert.equal(vm.evaluate('WoWAIDB.chats[1] == ORIGINAL_CHAT and WoWAIDB.chats[1].history == ORIGINAL_HISTORY'), 'true');
  assert.equal(vm.evaluate('WoWAIMapDB.map == ORIGINAL_MAP and WoWAIMapDB.map.layers == ORIGINAL_LAYERS'), 'true', 'navigation does not rebuild saved layer data');
  assert.equal(vm.evaluate('WoWAIDB.settings.context == ORIGINAL_SHARING'), 'true');
  assert.equal(vm.evaluate('WoWAIScroll:GetHeight() == ORIGINAL_SCROLL and WoWAIInput:GetHeight() == ORIGINAL_COMPOSER'), 'true');
  assert.equal(vm.evaluate('WoWAIDB.hello'), null);
  assert.equal(vm.evaluate('WoWAIDB.outbox'), null);
});

test('hello goes out on the strip after login', () => {
  const vm = newVM();
  login(vm);
  vm.run('STUB.RunTimers()'); // C_Timer.After(3, SayHello)
  const recs = stripRecords(vm);
  assert.equal(recs.length, 1);
  assert.match(recs[0].flags, /^h;nonce=[A-Za-z0-9_-]{8,64};c$/, 'a hello always carries its identity and game context');
  assert.equal(recs[0].text, '');
  assert.equal(recs[0].session, vm.evaluate('WoWAIDB.session'));
});

test('hello remains readable in physical pixels across DPI and UI-scale changes', () => {
  const vm = newVM();
  vm.run('STUB.screenHeight = 1080; STUB.dpiScale = 1354 / 1080; UIParent:SetScale(0.89)');
  login(vm);
  vm.run('STUB.RunTimers()');
  const hello = stripRecords(vm);
  assert.match(hello[0].flags, /^h;nonce=[A-Za-z0-9_-]{8,64};c$/);
  assert.equal(hello[0].session, vm.evaluate('WoWAIDB.session'));

  vm.run('STUB.screenHeight = 1440; STUB.dpiScale = 1.5; UIParent:SetScale(1.1); STUB.FireEvent("UI_SCALE_CHANGED")');
  assert.deepEqual(stripRecords(vm), hello, 'an already visible hello stays readable after changing monitors');
});

test('outbound records replace field separators inside user text', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('WoWAI.Send("wire" .. string.char(30, 31) .. "safe")');
  const rec = stripRecords(vm).find(r => r.text === 'wire  safe');
  assert.ok(rec, 'the record keeps the full message as one wire field');
});

test('the game context describes the character and rides on the hello, then only when it changes or is turned off', () => {
  const vm = newVM();
  login(vm);
  vm.run('STUB.RunTimers()');
  const hello = stripRecords(vm)[0];
  // The bridge answers the hello: the context is now known to be on its side.
  nextAck(vm);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('WoWAI.IsConnected()'), 'true');
  vm.run('WoWAI.Send("hello world")');
  let rec = stripRecords(vm).find(r => r.text === 'hello world');
  assert.equal(rec.ctx, undefined);
  assert.equal(vm.evaluate('WoWAIDB.outbox.ctx'), null);
  // Moving to another zone changes it, so the next message (from another chat,
  // the first one is still waiting) carries the new version.
  vm.run('STUB.zone = "Elwynn Forest"; STUB.subzone = ""; STUB.posX = 0.1; WoWAI.NewChat("Second"); WoWAI.Send("where am I")');
  rec = stripRecords(vm).find(r => r.text === 'where am I');
  assert.equal(Buffer.from(vm.evaluate('WoWAIDB.outbox.ctx'), 'hex').toString('utf8'), rec.ctx, 'the reload path carries it too');
  // Turning it off sends an empty context at once (a hello), so the bridge drops what it had.
  vm.run('SlashCmdList.WOWAI("context off")');
  assert.equal(vm.evaluate('WoWAIDB.settings.context'), 'false');
  const off = stripRecords(vm).filter(r => r.flags.split(';').includes('h'));
  assert.equal(off.length, 1);
  assert.equal(off[0].ctx, '');
});

for (const [mode, nativeEncoding] of [['base64 without native codecs', false], ['native zlib/base64', true]]) {
test(`complete selected inventory crosses pixel frames without UTF-8 loss or clipping (${mode})`, () => {
  const vm = newVM(nativeEncoding);
  login(vm);
  connect(vm);
  vm.run(`
    C_Container = {
      GetContainerNumSlots = function(bag) return bag == 0 and 96 or 0 end,
      GetContainerItemInfo = function(bag, slot) return {itemID=20000+slot,stackCount=slot,hyperlink="item:" .. (20000+slot)} end,
    }
    C_Item.GetItemInfo = function(id) return "Épée 鉱石 " .. id, "item:" .. id, 2 end
    WoWAI.Send("read every carried item")
  `);
  const original = stripRecords(vm).find(r => r.text === 'read every carried item');
  const receiver = new ContextProtocol.Transfers();
  let complete;
  for (let i = 0; i < 500 && !complete; i++) {
    vm.run('STUB.now = STUB.now + 0.5; STUB.Tick()');
    const frame = decodeStrip(vm);
    if (!frame) continue;
    for (const packet of P.jobsFromStrip(frame.id, frame.text)) {
      if (packet.data === 'profile') {
        assert.equal(packet.nonce, vm.evaluate('WoWAIDB.chats[1].request.nonce'), 'every profile part belongs to the immutable request');
        const result = receiver.add(packet);
        if (result.text) complete = JSON.parse(result.text);
      }
    }
  }
  assert.ok(complete, 'a snapshot larger than the strip is delivered, not merely its first frame');
  const backpack = complete.data.inventory.bags.find(bag => bag.bag === 0);
  assert.equal(backpack.slots.length, 96);
  assert.equal(backpack.slots[95].details.name, 'Épée 鉱石 20096');
  assert.equal(complete.data.inventory.itemCounts['20096'], 96);
  assert.equal(Number(P.parseFlags(original.flags).profile), original.id);
});
}

test('incoming agent information queries use current checkbox permissions, not the earlier snapshot permission', () => {
  const vm = newVM(true);
  login(vm);
  connect(vm);
  vm.run('WoWAI.Send("check my money")');
  const chat = vm.evaluate('WoWAIDB.chats[1].id'), id = vm.num('WoWAIDB.chats[1].pendingId');
  vm.run('WoWAIContext.SetEnabled("money", false); STUB.moneyReads = 0; function GetMoney() STUB.moneyReads = STUB.moneyReads + 1; return 987 end');
  nextSlot(vm, `{ now=time(), replies={ {chat="${chat}",id=${id},nonce="${vm.evaluate('WoWAIDB.chats[1].request.nonce')}",status="context_query",request="${id}-1",text="Reading",queries={{op="snapshot",category="money"}}} } }`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  const nonce = vm.evaluate('WoWAIDB.chats[1].request.nonce');
  assert.equal(vm.evaluate('WoWAIDB.contextOutbox.nonce'), nonce);
  assert.equal(vm.evaluate('WoWAIDB.chats[1].queryReply.nonce'), nonce);
  assert.equal(vm.num('STUB.moneyReads'), 0, 'revoked private data must not be read');
  const receiver = new ContextProtocol.Transfers();
  let response;
  for (let i = 0; i < 20 && !response; i++) {
    const frame = decodeStrip(vm);
    if (frame) for (const packet of P.jobsFromStrip(frame.id, frame.text)) {
      if (packet.data === 'query') {
        assert.equal(packet.nonce, nonce, 'query parts keep the question identity');
        const result = receiver.add(packet); if (result.text) response = JSON.parse(result.text);
      }
    }
    if (!response) vm.run('STUB.now = STUB.now + 0.5; STUB.Tick()');
  }
  assert.equal(response[0].ok, false);
  assert.equal(vm.num('WoWAIDB.chats[1].pendingId'), id, 'an information query is not a finished assistant answer');
  const savedQuery = vm.evaluate('WoWAIDB.contextOutbox.text');
  login(vm);
  const retransmission = P.jobsFromStrip(decodeStrip(vm).id, decodeStrip(vm).text).find(packet => packet.data === 'query');
  assert.equal(retransmission.nonce, nonce, 'query reload reuses the owner nonce');
  assert.equal(vm.evaluate('WoWAIDB.contextOutbox.text'), savedQuery);
});

test('a shift-clicked link lands in the focused input and is sent as its name plus tooltip', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  const link = '|cff1eff00|Hitem:2140:0:0:0:0:0:0:0:60:0:0|h[Fine Longsword]|h|r';
  vm.run(`STUB.tooltips["item:2140:0:0:0:0:0:0:0:60:0:0"] = { "Fine Longsword", { "Main Hand", "Sword" }, { "17 - 33 Damage", "Speed 2.70" }, "Requires Level 14" }`);
  // Without focus the link is left alone (shift-click keeps its normal meaning).
  vm.run(`WoWAIInput:SetText("is this good for me? "); WoWAIInput:ClearFocus(); ChatFrameUtil.InsertLink("${link}")`);
  assert.equal(vm.evaluate('WoWAIInput:GetText()'), 'is this good for me? ');
  // The client's own path (bags, spellbook, quest log all end here): ChatFrameUtil.InsertLink.
  vm.run(`WoWAIInput:SetFocus(); ChatFrameUtil.InsertLink("${link}")`);
  assert.equal(vm.evaluate('WoWAIInput:GetText()'), 'is this good for me? ' + link);
  // The old global name is not hooked as well, so nothing is inserted twice.
  vm.run(`ChatEdit_InsertLink("${link}")`);
  assert.equal(vm.evaluate('WoWAIInput:GetText()'), 'is this good for me? ' + link + link, 'the alias reaches the one hook exactly once');
  vm.run(`WoWAIInput:SetText("is this good for me? ${link}")`);
  vm.run('WoWAI.SendFromInput()');
  const expected = [
    'is this good for me? [Fine Longsword]',
    '',
    '--- Linked from the game ---',
    '[Fine Longsword] item 2140 (Uncommon)',
    '  Fine Longsword',
    '  Main Hand  Sword',
    '  17 - 33 Damage  Speed 2.70',
    '  Requires Level 14',
  ].join('\n');
  const rec = stripRecords(vm).find(r => r.text.startsWith('is this good'));
  assert.equal(rec.text, expected);
  assert.equal(vm.evaluate('WoWAIDB.chats[1].history[#WoWAIDB.chats[1].history].text'), expected, 'the transcript shows what was sent');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].name'), 'Is this good for me');
  // Bare links (no colour) and repeated links: one block each, tooltip or not.
  vm.run('RESULT = (WoWAI.ExpandLinks("x |Hspell:1978|h[Serpent Sting]|h y |Hspell:1978|h[Serpent Sting]|h"))');
  assert.equal(vm.evaluate('RESULT'), 'x [Serpent Sting] y [Serpent Sting]\n\n--- Linked from the game ---\n[Serpent Sting] spell 1978');
  vm.run('RESULT, COUNT = WoWAI.ExpandLinks("plain text | with a pipe")');
  assert.equal(vm.evaluate('RESULT'), 'plain text | with a pipe');
  assert.equal(vm.evaluate('COUNT'), '0');
});

test('deleting a chat tells the bridge to forget it, and a restore never brings it back', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('WoWAI.NewChat("Second")');
  assert.equal(vm.num('#WoWAIDB.chats'), 2);
  const gone = vm.evaluate('WoWAIDB.chats[2].id');
  vm.run(`WoWAI.DeleteChat("${gone}")`);
  assert.equal(vm.num('#WoWAIDB.chats'), 1);
  // A forget record for that chat is on the strip and remembered until acked.
  const rec = stripRecords(vm).find(r => r.flags.split(';').includes('d'));
  assert.ok(rec, 'forget record on the strip');
  assert.equal(rec.chat, gone);
  assert.equal(rec.text, '');
  assert.equal(vm.evaluate(`WoWAIDB.forget["${gone}"] ~= nil`), 'true');
  // A restore that still lists the chat is ignored for it.
  const token = vm.evaluate('WoWAIDB.session');
  nextSlot(vm, `{ now = time(), cwd = "", replies = {}, restore = { token = "${token}", chats = { { id = "${gone}", name = "Second", cwd = "", messages = { { role = "user", text = "old", id = 1, t = 1 } } } } } }`);
  vm.run('WoWAI.Connect(); STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.num('#WoWAIDB.chats'), 1, 'deleted chat not restored');
  // The bridge acks the forget record: it leaves the strip and the memory.
  const slot = String(rec.id).padStart(3, '0');
  vm.run(`STUB.sounds["Interface\\\\AddOns\\\\WoWAI\\\\ack\\\\${slot}.wav"] = true; STUB.Tick()`);
  assert.equal(vm.evaluate(`WoWAIDB.forget["${gone}"]`), null, 'forgotten once acked');
  assert.ok(!stripRecords(vm).find(r => r.flags.split(';').includes('d')), 'forget record left the strip');
});

test('Send and Reconnect stay visible, timeout preserves the draft and enables another check', () => {
  const vm = newVM();
  login(vm);
  vm.run('WoWAI.Toggle(true); WoWAIInput:SetText("fix the bug"); WoWAI.SendFromInput()');
  assert.equal(vm.evaluate('WoWAISend:IsShown()'), 'true');
  assert.equal(vm.evaluate('WoWAIReconnect:IsShown()'), 'true');
  assert.equal(vm.evaluate('WoWAIReconnect:IsEnabled()'), 'false');
  assert.equal(vm.evaluate('WoWAIConnect'), null, 'obsolete swap-only widget is removed');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].pendingId'), null);
  const first = stripRecords(vm)[0];
  vm.run('WoWAI.Connect()');
  assert.deepEqual(stripRecords(vm)[0], first, 'a pending attempt does not mint a second nonce or drop intent');
  vm.run('STUB.now = STUB.now + 20; STUB.Tick()');
  assert.equal(vm.evaluate('WoWAI.IsConnected()'), 'false');
  assert.equal(vm.evaluate('WoWAIInput:GetText()'), 'fix the bug');
  assert.equal(vm.evaluate('WoWAIReconnect:IsEnabled()'), 'true');
  assert.equal(vm.evaluate('WoWAISend:IsShown()'), 'true');
  assert.match(vm.evaluate('WoWAIDB.chats[1].draft'), /fix the bug/);
  vm.run('WoWAIReconnect.scripts.OnClick(WoWAIReconnect)');
  assert.notEqual(P.parseFlags(stripRecords(vm)[0].flags).nonce, P.parseFlags(first.flags).nonce);
  nextAck(vm);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('WoWAI.IsConnected()'), 'true');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].pendingId'), null, 'plain Reconnect does not send a timed-out draft');
  vm.run('WoWAISend.scripts.OnClick(WoWAISend)');
  assert.ok(stripRecords(vm).some(r => r.text === 'fix the bug'));
});

test('a matching fresh acknowledgement sends the queued intent once and preserves permissions', () => {
  const vm = newVM();
  login(vm);
  vm.run('WoWAI.Toggle(true); WoWAI.Send("fix the bug", {"Bash(cargo:*)"}); WoWAI.Connect()');
  nextAck(vm);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('WoWAI.IsConnected()'), 'true');
  const id = vm.num('WoWAIDB.chats[1].pendingId');
  const request = vm.evaluate('WoWAIDB.chats[1].request.nonce');
  assert.ok(id >= 1);
  assert.equal(vm.evaluate('WoWAIInput:GetText()'), '');
  assert.deepEqual(P.parseFlags(questionRecord(vm, 'fix the bug').flags).allow, ['Bash(cargo:*)']);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick(); WoWAI.Connect()');
  assert.equal(vm.evaluate('WoWAI.IsConnected()'), 'false', 'manual Reconnect immediately invalidates prior success');
  assert.equal(vm.evaluate('WoWAIReconnect:IsShown()'), 'true');
  nextAck(vm);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.num('WoWAIDB.chats[1].pendingId'), id);
  assert.equal(vm.evaluate('WoWAIDB.chats[1].request.nonce'), request);
  assert.equal(vm.num('(function() local n=0; for _,m in ipairs(WoWAIDB.chats[1].history) do if m.role=="user" then n=n+1 end end; return n end)()'), 1);
});

for (const invalid of ['missing protocol', 'missing ack', 'wrong nonce', 'wrong session', 'missing at', 'nonnumeric at', 'old ack', 'future ack', 'future clock', 'stale clock', 'missing clock']) {
test(`a fresh probe rejects ${invalid} without sending queued text`, () => {
  const vm = newVM();
  login(vm);
  vm.run('WoWAI.Send("retain this draft")');
  const hello = stripRecords(vm)[0], nonce = P.parseFlags(hello.flags).nonce;
  const fields = {
    protocol: '1', ack: true, session: P.luaStr(hello.session), nonce: P.luaStr(nonce),
    at: 'time()', now: 'time()',
  };
  if (invalid === 'missing protocol') fields.protocol = 'nil';
  if (invalid === 'missing ack') fields.ack = false;
  if (invalid === 'wrong nonce') fields.nonce = '"not_this_challenge"';
  if (invalid === 'wrong session') fields.session = '"another_session"';
  if (invalid === 'missing at') fields.at = 'nil';
  if (invalid === 'nonnumeric at') fields.at = '"now"';
  if (invalid === 'old ack') fields.at = 'time() - 60';
  if (invalid === 'future ack') fields.at = 'time() + 1';
  if (invalid === 'future clock') fields.now = 'time() + 3';
  if (invalid === 'stale clock') fields.now = 'time() - 16';
  if (invalid === 'missing clock') fields.now = 'nil';
  const ack = fields.ack ? `{session=${fields.session},nonce=${fields.nonce},at=${fields.at}}` : 'nil';
  nextSlot(vm, `{now=${fields.now},connectionProtocol=${fields.protocol},connectionAck=${ack},replies={}}`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('WoWAI.IsConnected()'), 'false');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].pendingId'), null);
  assert.equal(vm.evaluate('WoWAIInput:GetText()'), 'retain this draft');
  vm.run('STUB.now = STUB.now + 10; STUB.Tick()');
  assert.equal(vm.evaluate('WoWAIReconnect:IsEnabled()'), 'true');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].pendingId'), null);
});
}

test('a stopped responder cannot reuse recent clocks, cached sounds or the old matching acknowledgement', () => {
  const vm = newVM();
  vm.run('STUB.sounds["Interface\\\\AddOns\\\\WoWAI\\\\ctl\\\\valid.wav"] = true');
  login(vm);
  connect(vm);
  const oldSession = vm.evaluate('WoWAIDB.session');
  // The first hello is acknowledged, so capture its identity from the saved
  // slot publication before replacing it with a stopped responder's snapshot.
  vm.run('STUB.onLoadAddOn("cache"); STUB.cached = WoWAI_SlotData');
  vm.run('WoWAI.Connect(); WoWAI.Send("must not send")');
  const fresh = stripRecords(vm).find(r => P.parseFlags(r.flags).hello);
  assert.equal(fresh.session, oldSession);
  vm.run(`
    STUB.sounds["Interface\\\\AddOns\\\\WoWAI\\\\ack\\\\${String(fresh.id).padStart(3, '0')}.wav"] = true
    STUB.sounds["Interface\\\\AddOns\\\\WoWAI\\\\presence\\\\0001.wav"] = true
    STUB.onLoadAddOn = function() WoWAI_SlotData = STUB.cached end
    STUB.Tick()
  `);
  assert.equal(vm.evaluate('WoWAI.IsConnected()'), 'false', 'previous success is already invalidated before polling');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('WoWAI.IsConnected()'), 'false', 'a still-fresh cached clock cannot authenticate a different nonce');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].pendingId'), null);
  assert.ok(stripRecords(vm).some(r => r.id === fresh.id), 'cached numeric ACK cannot retire the challenge');
  vm.run('STUB.now = STUB.now + 10; STUB.Tick()');
  assert.equal(vm.evaluate('WoWAIReconnect:IsEnabled()'), 'true');
  assert.equal(vm.evaluate('WoWAIInput:GetText()'), 'must not send');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].pendingId'), null);
});

for (const sounds of [false, true]) {
test(`verification expires after 90 seconds with ${sounds ? 'advancing sounds' : 'clock fallback'} and Send checks automatically`, () => {
  const vm = newVM();
  if (sounds) vm.run('STUB.sounds["Interface\\\\AddOns\\\\WoWAI\\\\ctl\\\\valid.wav"] = true');
  login(vm);
  connect(vm);
  vm.run('STUB.onLoadAddOn("cache"); STUB.lastAck = WoWAI_SlotData.connectionAck');
  // Heartbeats republish the same actual receipt time even though now advances.
  nextSlot(vm, '{now=time(),connectionProtocol=1,connectionAck=STUB.lastAck,replies={}}');
  for (let k = 1; k <= 3; k++) {
    if (sounds) vm.run(`STUB.sounds[string.format("Interface\\\\AddOns\\\\WoWAI\\\\presence\\\\%04d.wav", ${k})] = true`);
    vm.run('STUB.now = STUB.now + 30; STUB.Tick()');
  }
  assert.equal(vm.evaluate('WoWAI.IsConnected()'), 'false');
  assert.equal(vm.evaluate('WoWAI.BridgeState()'), 'unknown', 'idle does not assert live or dead');
  assert.equal(vm.evaluate('WoWAISend:IsShown()'), 'true');
  assert.equal(vm.evaluate('WoWAIReconnect:IsEnabled()'), 'true');
  vm.run('WoWAI.SetAgent("codex"); WoWAI.SetModel("code-model"); WoWAI.Send("after idle")');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].pendingId'), null);
  nextAck(vm);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  const request = questionRecord(vm, 'after idle');
  assert.equal(P.parseFlags(request.flags).agent, 'codex');
  assert.equal(P.parseFlags(request.flags).model, 'code-model');
  assert.ok(vm.evaluate('WoWAIDB.chats[1].request.profile'));
});
}

test('bounded idle maintenance never renews a completed handshake from later clock publications', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('STUB.onLoadAddOn("cache"); STUB.lastAck = WoWAI_SlotData.connectionAck');
  nextSlot(vm, '{now=time(),connectionProtocol=1,connectionAck=STUB.lastAck,replies={}}');
  for (let i = 0; i < 4; i++) {
    vm.run('STUB.now = STUB.now + 600; STUB.Tick()');
    assert.equal(vm.evaluate('WoWAI.IsConnected()'), 'false');
    assert.equal(vm.evaluate('WoWAI.BridgeState()'), 'unknown');
  }
  assert.equal(loadedSlots(vm), 5, 'one maintenance read per ten minutes, without authenticating a new send');
});

test('pending probe retries and reload keep identity but require a newly received acknowledgement', () => {
  const vm = newVM();
  login(vm);
  vm.run('STUB.RunTimers(); WoWAIInput:SetText("  untouched draft  ")');
  const hello = stripRecords(vm)[0];
  const nonce = P.parseFlags(hello.flags).nonce;
  vm.run('STUB.oldAckAt = time(); STUB.now = STUB.now + 2');
  login(vm);
  vm.run('STUB.RunTimers()');
  assert.deepEqual(stripRecords(vm)[0], hello);
  nextSlot(vm, `{now=time(),connectionProtocol=1,connectionAck={session=${P.luaStr(hello.session)},nonce=${P.luaStr(nonce)},at=STUB.oldAckAt},replies={}}`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick(); WoWAI.Connect()');
  assert.equal(vm.evaluate('WoWAI.IsConnected()'), 'false', 'the pre-reload ack predates this attempt');
  assert.deepEqual(stripRecords(vm)[0], hello, 'pending retransmits preserve the same wire operation');
  nextAck(vm);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('WoWAI.IsConnected()'), 'true');
  assert.equal(vm.evaluate('WoWAIInput:GetText()'), '  untouched draft  ');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].pendingId'), null);
});

for (const clock of ['stale', 'missing']) {
test(`Check reply auto-verifies without losing a pending request; ${clock} cached replies still deliver`, () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('WoWAI.Send("original request")');
  const id = vm.num('WoWAIDB.chats[1].pendingId');
  const nonce = vm.evaluate('WoWAIDB.chats[1].request.nonce');
  const profile = vm.evaluate('WoWAIDB.chats[1].request.profile');
  const chat = vm.evaluate('WoWAIDB.activeChat');
  vm.run('STUB.oldClock = time(); STUB.now = STUB.now + 100');
  nextSlot(vm, `{${clock === 'stale' ? 'now=STUB.oldClock,' : ''}replies={{chat="${chat}",id=${id},nonce="${nonce}",status="working",text="cached progress"}}}`);
  vm.run('WoWAIInput:SetText("next draft"); WoWAISend.scripts.OnClick(WoWAISend)');
  assert.equal(vm.evaluate('WoWAI.IsConnected()'), 'false');
  assert.equal(vm.evaluate('WoWAIReconnect:IsEnabled()'), 'false', 'Check reply also starts a connection check');
  assert.equal(vm.evaluate('WoWAISend:GetText()'), 'Check reply');
  assert.equal(vm.num('WoWAIDB.chats[1].pendingId'), id);
  assert.equal(vm.evaluate('WoWAIDB.chats[1].request.nonce'), nonce);
  assert.equal(vm.evaluate('WoWAIDB.chats[1].request.profile'), profile);
  nextSlot(vm, `{${clock === 'stale' ? 'now=STUB.oldClock,' : ''}replies={{chat="${chat}",id=${id},nonce="${nonce}",status="done",text="stored answer"}}}`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].pendingId'), null);
  assert.equal(vm.evaluate('WoWAI.IsConnected()'), 'false', 'stored delivery is not a fresh connection');
  assert.equal(vm.evaluate('WoWAIInput:GetText()'), 'next draft');
  assert.equal(vm.num('(function() local n=0; for _,m in ipairs(WoWAIDB.chats[1].history) do if m.text=="stored answer" then n=n+1 end end; return n end)()'), 1);
});
}

test('the Folder... menu item (right-click a chat) opens a prompt that sets the chat folder like /wow-ai cd', () => {
  const vm = newVM();
  login(vm);
  vm.run('WoWAI.FolderPrompt()');
  assert.equal(vm.evaluate('STUB.popup.which'), 'WOWAI_FOLDER');
  assert.equal(vm.evaluate('STUB.popup.data.cwd'), '');
  // Accept the dialog the way the game would: an edit box holding the new path.
  vm.run(`
    local dialog = { editBox = { GetText = function() return "  ..\\\\realms " end } }
    StaticPopupDialogs.WOWAI_FOLDER.OnAccept(dialog, STUB.popup.data)`);
  assert.equal(vm.evaluate('WoWAIDB.chats[1].cwd'), '..\\realms');
  assert.ok(vm.evaluate('WoWAIDB.chats[1].history[#WoWAIDB.chats[1].history].text').includes('relative to'));
  vm.run('WoWAI.FolderPrompt()');
  assert.equal(vm.evaluate('STUB.popup.data.cwd'), '..\\realms', 'prompt is prefilled with the current folder');
  // A full path gets no "relative to" note; empty goes back to the default.
  vm.run('WoWAI.SetFolder("C:\\\\other")');
  assert.ok(!vm.evaluate('WoWAIDB.chats[1].history[#WoWAIDB.chats[1].history].text').includes('relative to'));
  vm.run('WoWAI.SetFolder("")');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].cwd'), '');
});

test('a sent message is encoded on the strip with the chat folder, then a slot reply finishes it', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('SlashCmdList.WOWAI("cd realms")');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].cwd'), 'realms');
  vm.run('WoWAI.Send("hello world")');
  const chatId = vm.evaluate('WoWAIDB.chats[1].id');
  const id = vm.num('WoWAIDB.chats[1].pendingId');
  assert.ok(id >= 1);
  const rec = stripRecords(vm).find(r => r.text === 'hello world');
  assert.ok(rec, 'message record on the strip');
  assert.equal(rec.chat, chatId);
  assert.equal(rec.id, id);
  assert.equal(rec.cwd, 'realms');
  // The chat took its title from the first message.
  assert.equal(vm.evaluate('WoWAIDB.chats[1].name'), 'Hello world');

  nextSlot(vm, `{ now = time(), cwd = "C:\\\\proj", replies = { { chat = "${chatId}", id = ${id}, nonce = "${vm.evaluate('WoWAIDB.chats[1].request.nonce')}", status = "done", text = "hi back", cwd = "x", session = "s" } } }`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()'); // first scheduled poll is 5 s after sending
  assert.equal(vm.evaluate('WoWAIDB.chats[1].pendingId'), null);
  assert.equal(vm.evaluate('WoWAIDB.chats[1].history[#WoWAIDB.chats[1].history].role'), 'assistant');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].history[#WoWAIDB.chats[1].history].text'), 'hi back');
  assert.ok(vm.evaluate('table.concat(STUB.prints, "\\n")').includes('hi back'), 'reply echoed to the game chat');
  assert.equal(vm.evaluate('WoWAIStrip.shown'), 'false', 'strip cleared once nothing is pending');

  // The bridge's default folder arrived with the slot and is what "/wow-ai cd" reports.
  vm.run('SlashCmdList.WOWAI("cd")');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].cwd'), '');
  assert.ok(vm.evaluate('WoWAIDB.chats[1].history[#WoWAIDB.chats[1].history].text').includes('C:\\proj'));
});

test('a denied reply shows Allow, and Allow resends with the rules as flags', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('WoWAI.Send("search for it")');
  const chatId = vm.evaluate('WoWAIDB.chats[1].id');
  const id = vm.num('WoWAIDB.chats[1].pendingId');
  nextSlot(vm, `{ now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${id}, nonce = "${vm.evaluate('WoWAIDB.chats[1].request.nonce')}", status = "done", text = "need permission", denied = { "WebSearch", "Bash(cargo:*)" } } } }`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].history[#WoWAIDB.chats[1].history].denied[2]'), 'Bash(cargo:*)');
  vm.run(`WoWAI.Allow("${chatId}", { "WebSearch", "Bash(cargo:*)" })`);
  const rec = stripRecords(vm).find(r => r.flags.includes('allow='));
  assert.ok(rec, 'allow record on the strip');
  assert.deepEqual(P.parseFlags(rec.flags).allow, ['WebSearch', 'Bash(cargo:*)']);
  assert.equal(rec.id, id + 1);
});

test('a chat can pick its agent: the strip says so, replies are labelled by their writer, unknown names are refused', () => {
  const vm = newVM();
  login(vm);
  // The hello slot carries the bridge's default agent and the ones it knows.
  vm.run('STUB.RunTimers()');
  const slot = replies => `{ now = time(), cwd = "", agent = "claude", agents = { "claude", "codex", "grok" }, replies = { ${replies || ''} } }`;
  nextAck(vm, slot());
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('WoWAI.IsConnected()'), 'true');
  // Without an agent of its own the chat sends no agent flag, and the reply is labelled Claude.
  vm.run('WoWAI.Send("hello")');
  const chatId = vm.evaluate('WoWAIDB.chats[1].id');
  let rec = stripRecords(vm).find(r => r.text === 'hello');
  assert.equal(vm.evaluate('WoWAIDB.outbox.agent'), null);
  const id = vm.num('WoWAIDB.chats[1].pendingId');
  nextSlot(vm, slot(`{ chat = "${chatId}", id = ${id}, nonce = "${vm.evaluate('WoWAIDB.chats[1].request.nonce')}", status = "done", text = "hi", agent = "claude" }`));
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].history[#WoWAIDB.chats[1].history].role'), 'assistant');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].history[#WoWAIDB.chats[1].history].agent'), 'claude');
  assert.ok(vm.evaluate('table.concat(STUB.prints, "\\n")').includes('[Claude · '), 'the game chat echo names the agent');
  // Switch this chat to Codex: the next message carries agent=codex, on both transports.
  vm.run('SlashCmdList.WOWAI("agent Codex")');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].agent'), 'codex');
  assert.ok(vm.evaluate('WoWAIDB.chats[1].history[#WoWAIDB.chats[1].history].text').includes('agent set to Codex'));
  vm.run('WoWAI.Send("now with codex")');
  rec = stripRecords(vm).find(r => r.text === 'now with codex');
  assert.equal(P.parseFlags(rec.flags).agent, 'codex');
  assert.equal(vm.evaluate('WoWAIDB.outbox.agent'), 'codex');
  const id2 = vm.num('WoWAIDB.chats[1].pendingId');
  nextSlot(vm, slot(`{ chat = "${chatId}", id = ${id2}, nonce = "${vm.evaluate('WoWAIDB.chats[1].request.nonce')}", status = "done", text = "codex here", agent = "codex" }`));
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].history[#WoWAIDB.chats[1].history].agent'), 'codex');
  assert.ok(vm.evaluate('table.concat(STUB.prints, "\\n")').includes('[Codex · '));
  // Resend keeps the agent flag.
  vm.run('WoWAI.Send("again")');
  vm.run('WoWAI.Resend()');
  assert.equal(P.parseFlags(stripRecords(vm).find(r => r.text === 'again').flags).agent, 'codex');
  vm.run('SlashCmdList.WOWAI("cancel")');
  // A name the bridge did not list is refused; "default" goes back to the bridge's.
  vm.run('SlashCmdList.WOWAI("agent gemini")');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].agent'), 'codex');
  assert.ok(vm.evaluate('WoWAIDB.chats[1].history[#WoWAIDB.chats[1].history].text').includes('Unknown agent "gemini"'));
  vm.run('SlashCmdList.WOWAI("agent default")');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].agent'), '');
  assert.ok(vm.evaluate('WoWAIDB.chats[1].history[#WoWAIDB.chats[1].history].text').includes('agent reset to the bridge\'s default: Claude'));
  // A new chat inherits the agent, like the folder.
  vm.run('WoWAI.SetAgent("codex"); WoWAI.NewChat("Second")');
  assert.equal(vm.evaluate('WoWAIDB.chats[2].agent'), 'codex');
});

test('selector changes leave an in-flight request unchanged when resent, including after transport state is rebuilt', () => {
  const vm = newVM();
  login(vm);
  vm.run('STUB.RunTimers()');
  const options = A.selectionOptions({ agents: { codex: { models: ['code-model', 'review-model'] } } });
  vm.run(`STUB.onLoadAddOn = function()
    ${P.luaTable('WoWAI_SlotData', [], { now: vm.num('time()') * 1000, requestProtocol: 1, contextProtocol: 2, connectionProtocol: 1, connectionAck: { session: vm.evaluate('WoWAIDB.session'), nonce: P.parseFlags(stripRecords(vm).find(r => P.parseFlags(r.flags).hello).flags).nonce, at: vm.num('time()') }, agent: 'claude', agents: A.agentIds(), agentOptions: options })}
  end`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick(); WoWAI.Toggle(true)');
  vm.run(`
    function Pick(key, value)
      WoWAI.ShowSelection(key)
      for _, item in ipairs(WoWAISelectionMenu.items) do
        if item.shown and item.value == value then item.scripts.OnClick(item); return end
      end
      error("missing selection: " .. key .. "=" .. value)
    end
    Pick("agent", "codex")
    Pick("model", "code-model")
    Pick("reasoning", "high")
    WoWAI.Send("original request")
  `);
  const original = stripRecords(vm).find(r => r.text === 'original request');
  const job = P.jobsFromStrip(original.id, [original.session, original.chat, original.id, original.cwd, original.flags, original.name, original.text].join('\x1f'))[0];
  assert.equal(job.agent, 'codex');
  assert.equal(job.model, 'code-model');
  assert.equal(job.reasoning, 'high');
  vm.run('Pick("model", "review-model"); Pick("reasoning", "low"); WoWAI.Resend()');
  assert.deepEqual(stripRecords(vm).find(r => r.id === original.id), original, 'resending keeps the original run choices, not the current selectors');
  // Login rebuilds run.outbound: the SavedVariables snapshot must carry the choices.
  vm.run('STUB.FireEvent("PLAYER_LOGIN"); WoWAI.Resend()');
  assert.deepEqual(stripRecords(vm).find(r => r.id === original.id), original, 'the request survives loss of transient transport state');
  connect(vm);
  vm.run('SlashCmdList.WOWAI("cancel"); WoWAI.Send("next request")');
  const next = stripRecords(vm).find(r => r.text === 'next request');
  const nextFlags = P.parseFlags(next.flags);
  assert.equal(nextFlags.model, 'review-model');
  assert.equal(nextFlags.reasoning, 'low');
});

function connectAgentOptions(vm) {
  vm.run('STUB.RunTimers()');
  const agentOptions = A.selectionOptions({ agents: {
    claude: { model: 'sonnet' },
    codex: { models: ['code-model', 'review-model'] },
    agy: { models: ['gemini-model'] },
  } });
  vm.run(`STUB.onLoadAddOn = function()
    ${P.luaTable('WoWAI_SlotData', [], { now: vm.num('time()') * 1000, requestProtocol: 1, contextProtocol: 2, connectionProtocol: 1, connectionAck: { session: vm.evaluate('WoWAIDB.session'), nonce: P.parseFlags(stripRecords(vm).find(r => P.parseFlags(r.flags).hello).flags).nonce, at: vm.num('time()') }, agent: 'claude', agents: A.agentIds(), agentOptions })}
  end`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
}

function pickSelection(vm, key, value, defaults = false) {
  const row = defaults ? 'WoWAIDefaultSelectors' : 'WoWAISelectors';
  vm.run(`
    local b = ${row}.buttons[${P.luaStr(key)}]
    b.scripts.OnClick(b)
    for _, item in ipairs(WoWAISelectionMenu.items) do
      if item.shown and item.value == ${P.luaStr(value)} then item.scripts.OnClick(item); return end
    end
    error("missing ${key} selection")
  `);
}

test('addon defaults persist, per-chat choices win, and changing defaults cannot rewrite an in-flight request', () => {
  const vm = newVM();
  login(vm);
  connectAgentOptions(vm);
  vm.run('WoWAI.ShowDefaults()');
  pickSelection(vm, 'agent', 'codex', true);
  pickSelection(vm, 'model', 'code-model', true);
  pickSelection(vm, 'reasoning', 'high', true);
  vm.run('WoWAI.SaveDefaults(); WoWAI.Send("inherited original")');
  const original = stripRecords(vm).find(r => r.text === 'inherited original');
  assert.equal(P.parseFlags(original.flags).agent, 'codex');
  assert.equal(P.parseFlags(original.flags).model, 'code-model');
  assert.equal(P.parseFlags(original.flags).reasoning, 'high');
  vm.run('STUB.FireEvent("ADDON_LOADED", "WoWAI"); STUB.FireEvent("PLAYER_LOGIN")');
  connectAgentOptions(vm);
  assert.equal(vm.evaluate('WoWAIDB.settings.defaults.model'), 'code-model', 'initialization preserves saved defaults');
  vm.run('WoWAI.ShowDefaults()');
  pickSelection(vm, 'model', 'review-model', true);
  pickSelection(vm, 'reasoning', 'low', true);
  vm.run('WoWAI.SaveDefaults(); WoWAI.Resend()');
  assert.deepEqual(stripRecords(vm).find(r => r.id === original.id), original, 'pending settings are frozen even when addon defaults change');
  vm.run('SlashCmdList.WOWAI("cancel"); WoWAI.Send("new defaults")');
  const flags = text => P.parseFlags(stripRecords(vm).find(r => r.text === text).flags);
  assert.equal(flags('new defaults').model, 'review-model');
  assert.equal(flags('new defaults').reasoning, 'low');
  vm.run('SlashCmdList.WOWAI("cancel"); WoWAI.ShowDefaults()');
  pickSelection(vm, 'model', '', true);
  pickSelection(vm, 'reasoning', '', true);
  vm.run('WoWAI.SaveDefaults(); WoWAI.Send("cleared defaults")');
  assert.equal(flags('cleared defaults').newSession, true, 'cleared overrides cannot stick inside a resumed CLI');
  assert.equal(flags('cleared defaults').model, undefined);
  assert.equal(flags('cleared defaults').reasoning, undefined);
  vm.run('SlashCmdList.WOWAI("cancel"); WoWAI.SetModel("per-chat-model"); WoWAI.SetReasoning("high"); WoWAI.Send("per-chat choices")');
  assert.equal(flags('per-chat choices').model, 'per-chat-model');
  assert.equal(flags('per-chat choices').reasoning, 'high');
});

test('default agent changes preserve provider-specific chat choices, and cancelled defaults stay unapplied', () => {
  const vm = newVM();
  login(vm);
  connectAgentOptions(vm);
  vm.run('WoWAI.ShowDefaults()');
  pickSelection(vm, 'agent', 'codex', true);
  pickSelection(vm, 'model', 'code-model', true);
  pickSelection(vm, 'reasoning', 'high', true);
  vm.run('WoWAI.SaveDefaults(); WoWAI.SetModel("codex-only-model"); WoWAI.ShowDefaults()');
  pickSelection(vm, 'agent', 'agy', true);
  pickSelection(vm, 'model', 'gemini-model', true);
  pickSelection(vm, 'reasoning', 'low', true);
  vm.run('WoWAI.SaveDefaults(); WoWAI.Send("preserved override")');
  const flags = text => P.parseFlags(stripRecords(vm).find(r => r.text === text).flags);
  assert.equal(flags('preserved override').agent, 'codex', 'an agent-specific override must not be sent to the new default provider');
  assert.equal(flags('preserved override').model, 'codex-only-model');
  assert.equal(flags('preserved override').reasoning, undefined, 'Antigravity reasoning does not leak into an explicit Codex chat');
  assert.equal(flags('preserved override').newSession, true, 'the old inherited effort is cleared in the CLI too');
  vm.run('SlashCmdList.WOWAI("cancel"); WoWAI.SetAgent("default"); WoWAI.ShowDefaults()');
  pickSelection(vm, 'agent', 'claude', true);
  pickSelection(vm, 'model', 'opus', true);
  vm.run('WoWAIDefaultsCancel:GetScript("OnClick")(WoWAIDefaultsCancel); WoWAI.NewChat("Uses defaults"); WoWAI.Send("after cancel")');
  assert.equal(flags('after cancel').agent, 'agy');
  assert.equal(flags('after cancel').model, 'gemini-model');
  assert.equal(flags('after cancel').reasoning, 'low');
  vm.run('SlashCmdList.WOWAI("cancel"); WoWAI.SetAgent("claude"); WoWAI.Send("other provider")');
  assert.equal(flags('other provider').agent, 'claude');
  assert.equal(flags('other provider').model, undefined, 'another agent uses its own bridge default');
  assert.equal(flags('other provider').reasoning, undefined);
});

test('replies saved under the old "claude" role are read as assistant replies from Claude', () => {
  const vm = newVM();
  vm.run('WoWAIDB = { chats = { { id = "c1", name = "Old", cwd = "", history = { { role = "user", text = "q", id = 1, t = 1 }, { role = "claude", text = "a", id = 1, t = 2 } }, unread = 0, created = 1 } }, activeChat = "c1", settings = {} }');
  login(vm);
  assert.equal(vm.evaluate('WoWAIDB.chats[1].history[2].role'), 'assistant');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].history[2].agent'), 'claude');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].agent'), '');
});

test('free text that starts with a command word is sent as a message; exact commands still run', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  const sent = text => !!stripRecords(vm).find(r => r.text === text);
  const last = () => vm.evaluate('WoWAIDB.chats[1].history[#WoWAIDB.chats[1].history].text');
  // "delete the unused imports" is a message, not /wow-ai delete; "cancel" alone is the command.
  vm.run('SlashCmdList.WOWAI("delete the unused imports")');
  assert.equal(vm.num('#WoWAIDB.chats'), 1, 'no chat deleted');
  assert.ok(sent('delete the unused imports'));
  vm.run('SlashCmdList.WOWAI("cancel")');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].pendingId'), null, 'cancel ran as a command');
  // "help me with this macro" is a message; "help" alone prints the help.
  vm.run('SlashCmdList.WOWAI("help me with this macro")');
  assert.ok(sent('help me with this macro'));
  vm.run('SlashCmdList.WOWAI("cancel")');
  vm.run('SlashCmdList.WOWAI("help")');
  assert.ok(last().includes('/wow-ai cd'));
  // One-word arguments keep their command; more words make it a message.
  vm.run('SlashCmdList.WOWAI("agent codex")');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].agent'), 'codex');
  vm.run('SlashCmdList.WOWAI("agent smith says hi")');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].agent'), 'codex');
  assert.ok(sent('agent smith says hi'));
  vm.run('SlashCmdList.WOWAI("cancel")');
  // Enumerated arguments: "context off" is the command, "context matters here" a message.
  vm.run('SlashCmdList.WOWAI("context off")');
  assert.equal(vm.evaluate('WoWAIDB.settings.context'), 'false');
  nextAck(vm);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  vm.run('SlashCmdList.WOWAI("context matters here")');
  assert.ok(sent('context matters here'));
  vm.run('SlashCmdList.WOWAI("cancel")');
  // "reset the counter" and "clear the cache" are messages; the transcript survives.
  vm.run('SlashCmdList.WOWAI("clear the cache")');
  assert.ok(sent('clear the cache'));
  assert.ok(vm.num('#WoWAIDB.chats[1].history') > 1, 'clear did not run');
  vm.run('SlashCmdList.WOWAI("cancel")');
  vm.run('SlashCmdList.WOWAI("reset the counter")');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].resetNext'), null);
  assert.ok(sent('reset the counter'));
  vm.run('SlashCmdList.WOWAI("cancel")');
  // A chat can still be picked by number or name; "chat with me about it" is a message.
  vm.run('SlashCmdList.WOWAI("new Realms")');
  vm.run('SlashCmdList.WOWAI("chat 1")');
  assert.equal(vm.evaluate('WoWAIDB.activeChat'), vm.evaluate('WoWAIDB.chats[1].id'));
  vm.run('SlashCmdList.WOWAI("chat realms")');
  assert.equal(vm.evaluate('WoWAIDB.activeChat'), vm.evaluate('WoWAIDB.chats[2].id'));
  vm.run('SlashCmdList.WOWAI("chat with me about it")');
  assert.ok(sent('chat with me about it'));
  // /ai alone toggles the window.
  vm.run('WoWAI.Toggle(false); SlashCmdList.WOWAI("")');
  assert.equal(vm.evaluate('WoWAIFrame.shown'), 'true');
});

test('/wow-ai reset marks the next message as a new session', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('SlashCmdList.WOWAI("reset")');
  vm.run('WoWAI.Send("start over")');
  const rec = stripRecords(vm).find(r => r.text === 'start over');
  assert.equal(P.parseFlags(rec.flags).newSession, true);
  assert.equal(vm.evaluate('WoWAIDB.chats[1].resetNext'), null);
});

test('game chat echo: the summary by default, the first lines without one, the whole reply with "echo full"', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  assert.equal(vm.evaluate('WoWAIDB.settings.echo'), 'summary', 'summary echo is the default');
  const chatId = vm.evaluate('WoWAIDB.chats[1].id');
  const prints = () => vm.evaluate('table.concat(STUB.prints, "\\n")');
  const reply = (text, summary) => {
    vm.run('STUB.prints = {}');
    vm.run('WoWAI.Send("do it")');
    const id = vm.num('WoWAIDB.chats[1].pendingId');
    const sum = summary === undefined ? '' : `, summary = "${summary}"`;
    nextSlot(vm, `{ now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${id}, nonce = "${vm.evaluate('WoWAIDB.chats[1].request.nonce')}", status = "done", text = "${text}", agent = "claude"${sum} } } }`);
    vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
    assert.equal(vm.evaluate('WoWAIDB.chats[1].pendingId'), null);
  };

  // With a summary only the summary is printed; the window keeps the whole reply.
  reply('Long line one\\nLong line two\\nLong line three\\n\\nTL;DR: Renamed foo.\\nTests pass.', 'Renamed foo.\\nTests pass.');
  let out = prints();
  assert.ok(out.includes('[Claude · ') && out.includes('Renamed foo.') && out.includes('Tests pass.'), 'summary lines printed: ' + out);
  assert.ok(!out.includes('Long line one'), 'the body stays out of the game chat');
  assert.ok(out.includes('[open]'), 'the open link is there');
  assert.ok(vm.evaluate('WoWAIDB.chats[1].history[#WoWAIDB.chats[1].history].text').includes('Long line three'), 'the window has the full reply');

  // Without a summary: the first two lines, then a hint that there is more.
  reply('Line one\\nLine two\\nLine three\\nLine four');
  out = prints();
  assert.ok(out.includes('Line one') && out.includes('Line two'), 'first two lines: ' + out);
  assert.ok(!out.includes('Line three'), 'third line held back');
  assert.ok(out.includes('click [open]'), 'hint to open the window');

  // A short reply without a summary needs no hint.
  reply('Just this');
  out = prints();
  assert.ok(out.includes('Just this') && !out.includes('click [open] to read'), out);

  // "echo full" prints everything, as before.
  vm.run('SlashCmdList.WOWAI("echo full")');
  assert.equal(vm.evaluate('WoWAIDB.settings.echo'), 'full');
  reply('Line one\\nLine two\\nLine three\\n\\nTL;DR: Short.', 'Short.');
  out = prints();
  assert.ok(out.includes('Line one') && out.includes('Line three') && out.includes('TL;DR: Short.'), out);
  vm.run('SlashCmdList.WOWAI("echo summary")');
  assert.equal(vm.evaluate('WoWAIDB.settings.echo'), 'summary');
  vm.run('SlashCmdList.WOWAI("echo bogus")');
  assert.equal(vm.evaluate('WoWAIDB.settings.echo'), 'summary', 'an unknown mode is ignored');

  // An install that still had the old default saved moves to summary once; a mode picked on purpose stays.
  const vm2 = newVM();
  vm2.run('WoWAIDB = { settings = { echo = "full" } }');
  login(vm2);
  assert.equal(vm2.evaluate('WoWAIDB.settings.echo'), 'summary');
  const vm3 = newVM();
  vm3.run('WoWAIDB = { settings = { echo = "short" } }');
  login(vm3);
  assert.equal(vm3.evaluate('WoWAIDB.settings.echo'), 'short');
  const vm4 = newVM();
  vm4.run('WoWAIDB = { settings = { echo = "full", echoV2 = true } }');
  login(vm4);
  assert.equal(vm4.evaluate('WoWAIDB.settings.echo'), 'full');
});

test('a restore bundle addressed to this session adds the missing chats once', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('WoWAI.Send("hi")');
  const chatId = vm.evaluate('WoWAIDB.chats[1].id');
  const id = vm.num('WoWAIDB.chats[1].pendingId');
  const token = vm.evaluate('WoWAIDB.session');
  const bundle = `restore = { token = "${token}", chats = { { id = "old1", name = "Old work", cwd = "C:\\\\old", messages = { { role = "user", id = 1, t = 1, text = "q" }, { role = "claude", id = 1, t = 2, text = "a" } } } } }`;
  nextSlot(vm, `{ now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${id}, nonce = "${vm.evaluate('WoWAIDB.chats[1].request.nonce')}", status = "done", text = "ok" } }, ${bundle} }`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.num('#WoWAIDB.chats'), 2);
  assert.equal(vm.evaluate('WoWAIDB.chats[1].id'), 'old1');
  assert.equal(vm.num('#WoWAIDB.chats[1].history'), 2);
  // An older bridge's transcript says "claude"; it is read as an assistant reply from Claude.
  assert.equal(vm.evaluate('WoWAIDB.chats[1].history[2].role'), 'assistant');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].history[2].agent'), 'claude');
  assert.equal(vm.evaluate('WoWAIDB.restored'), 'true');
  // A second bundle with the same token is ignored.
  vm.run('WoWAI.Send("again")');
  const id2 = vm.num('WoWAIDB.chats[2].pendingId');
  nextSlot(vm, `{ now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${id2}, nonce = "${vm.evaluate('WoWAIDB.chats[2].request.nonce')}", status = "done", text = "ok" } }, ${bundle.replace('old1', 'old2')} }`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.num('#WoWAIDB.chats'), 2);
});

test('chat management commands: new, chat, rename, delete, clear, copy', () => {
  const vm = newVM();
  login(vm);
  vm.run('SlashCmdList.WOWAI("new Realms")');
  assert.equal(vm.num('#WoWAIDB.chats'), 2);
  assert.equal(vm.evaluate('WoWAIDB.chats[2].name'), 'Realms');
  assert.equal(vm.evaluate('WoWAIDB.activeChat'), vm.evaluate('WoWAIDB.chats[2].id'));
  vm.run('SlashCmdList.WOWAI("chat 1")');
  assert.equal(vm.evaluate('WoWAIDB.activeChat'), vm.evaluate('WoWAIDB.chats[1].id'));
  vm.run('SlashCmdList.WOWAI("rename Stuff")');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].name'), 'Stuff');
  vm.run('SlashCmdList.WOWAI("help")');
  assert.ok(vm.evaluate('WoWAIDB.chats[1].history[1].text').includes('/wow-ai cd'));
  vm.run('SlashCmdList.WOWAI("clear")');
  assert.equal(vm.num('#WoWAIDB.chats[1].history'), 0);
  vm.run('SlashCmdList.WOWAI("delete")');
  assert.equal(vm.num('#WoWAIDB.chats'), 1);
  assert.equal(vm.evaluate('WoWAIDB.chats[1].name'), 'Realms');
  // The copy box builds with a proper backdrop (the stub fails on SetBackdrop(nil)).
  vm.run('WoWAI.ShowCopy("some reply")');
  assert.equal(vm.evaluate('WoWAICopy.shown'), 'true');
  assert.equal(vm.evaluate('WoWAICopyBox.text'), 'some reply');
});

test('chat actions target the chosen conversation and deletion waits for confirmation', () => {
  const vm = newVM();
  login(vm);
  vm.run('SlashCmdList.WOWAI("new Realms")');
  const first = vm.evaluate('WoWAIDB.chats[1].id');
  const second = vm.evaluate('WoWAIDB.chats[2].id');
  assert.equal(vm.evaluate('WoWAIDB.activeChat'), second);
  // The menu opens for the row's chat, not the active one, and toggles closed on a second open.
  vm.run(`WoWAI.ShowChatMenu("${first}", WoWAIFrame)`);
  assert.equal(vm.evaluate('WoWAIChatMenu.shown'), 'true');
  assert.equal(vm.evaluate('WoWAIChatMenu.chatId'), first);
  vm.run(`WoWAI.ShowChatMenu("${first}", WoWAIFrame)`);
  assert.equal(vm.evaluate('WoWAIChatMenu.shown'), 'false');
  // Rename and Folder prompts target the chat they were opened for.
  vm.run(`WoWAI.RenamePrompt("${first}")`);
  assert.equal(vm.evaluate('STUB.popup.which'), 'WOWAI_RENAME');
  assert.equal(vm.evaluate('STUB.popup.data.id'), first);
  vm.run(`
    local dialog = { editBox = { GetText = function() return "Old stuff" end } }
    StaticPopupDialogs.WOWAI_RENAME.OnAccept(dialog, STUB.popup.data)`);
  assert.equal(vm.evaluate('WoWAIDB.chats[1].name'), 'Old stuff');
  assert.equal(vm.evaluate('WoWAIDB.chats[2].name'), 'Realms');
  vm.run(`WoWAI.FolderPrompt("${first}")`);
  assert.equal(vm.evaluate('STUB.popup.which'), 'WOWAI_FOLDER');
  assert.equal(vm.evaluate('STUB.popup.data.id'), first);
  // Delete asks first: nothing happens until OK, then only that chat goes and the active one stays.
  vm.run(`WoWAI.ConfirmDelete("${first}")`);
  assert.equal(vm.evaluate('STUB.popup.which'), 'WOWAI_DELETE');
  assert.equal(vm.num('#WoWAIDB.chats'), 2);
  vm.run('StaticPopupDialogs.WOWAI_DELETE.OnAccept({}, STUB.popup.data)');
  assert.equal(vm.num('#WoWAIDB.chats'), 1);
  assert.equal(vm.evaluate('WoWAIDB.chats[1].id'), second);
  assert.equal(vm.evaluate('WoWAIDB.activeChat'), second);
  // Deleting the last chat clears it instead of removing it.
  vm.run(`WoWAI.ConfirmDelete("${second}")`);
  vm.run('StaticPopupDialogs.WOWAI_DELETE.OnAccept({}, STUB.popup.data)');
  assert.equal(vm.num('#WoWAIDB.chats'), 1);
  assert.equal(vm.evaluate('WoWAIDB.chats[1].name'), 'Chat 1');
});

test('minimize collapses to the mini bar and back; the mini bar X hides everything', () => {
  const vm = newVM();
  login(vm);
  vm.run('WoWAI.Toggle(true)');
  assert.equal(vm.evaluate('WoWAIFrame.shown'), 'true');
  vm.run('WoWAI.Minimize(true)');
  assert.equal(vm.evaluate('WoWAIFrame.shown'), 'false');
  assert.equal(vm.evaluate('WoWAIMini.shown'), 'true');
  assert.equal(vm.evaluate('WoWAIDB.settings.minimized'), 'true');
  vm.run('WoWAI.Minimize(false)');
  assert.equal(vm.evaluate('WoWAIFrame.shown'), 'true');
  assert.equal(vm.evaluate('WoWAIMini.shown'), 'false');
  vm.run('WoWAI.Toggle(false)');
  assert.equal(vm.evaluate('WoWAIFrame.shown'), 'false');
  assert.equal(vm.evaluate('WoWAIMini.shown'), 'false');
  assert.equal(vm.evaluate('WoWAIDB.settings.shown'), 'false');
});

test('reload mode writes the outbox for the bridge instead of drawing the strip', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('SlashCmdList.WOWAI("mode reload")');
  vm.run('SlashCmdList.WOWAI("reset")');
  vm.run('WoWAI.Send("via reload", { "WebSearch", "Bash(git:*)" })');
  assert.equal(vm.evaluate('STUB.reloaded'), 'true');
  assert.equal(vm.evaluate('WoWAIDB.outbox.newSession'), 'true');
  assert.equal(vm.evaluate('WoWAIDB.outbox.text'), Buffer.from('via reload').toString('hex'));
  assert.equal(vm.evaluate('WoWAIDB.outbox.nonce'), vm.evaluate('WoWAIDB.chats[1].request.nonce'));
  assert.equal(Buffer.from(vm.evaluate('WoWAIDB.outbox.allow'), 'hex').toString('utf8'), 'WebSearch\x1fBash(git:*)');
  assert.equal(decodeStrip(vm), null);
});

test('rolling the saved counter back to a hello creates a distinct question identity', () => {
  const vm = newVM();
  login(vm);
  vm.run('STUB.RunTimers()');
  const hello = stripRecords(vm)[0];
  connect(vm);
  vm.run(`WoWAIDB.lastSeq = ${hello.id - 1}; WoWAI.Send("same counter, new question")`);
  const question = stripRecords(vm).find(r => r.text === 'same counter, new question');
  assert.equal(question.id, hello.id);
  assert.notEqual(P.parseFlags(question.flags).nonce, P.parseFlags(hello.flags).nonce);
  assert.equal(P.parseFlags(question.flags).nonce, vm.evaluate('WoWAIDB.outbox.nonce'));
  assert.match(vm.evaluate('WoWAIDB.outbox.nonce'), /^[A-Za-z0-9_-]{8,64}$/);
});

test('old reply nonces and numeric sound acks cannot acknowledge or finish a reused question ID', () => {
  const vm = newVM();
  vm.run('STUB.sounds["Interface\\\\AddOns\\\\WoWAI\\\\ctl\\\\valid.wav"] = true');
  login(vm);
  connect(vm);
  vm.run('WoWAIDB.settings.context = false; WoWAI.Send("first question")');
  const first = stripRecords(vm).find(r => r.text === 'first question');
  const oldNonce = P.parseFlags(first.flags).nonce;
  vm.run(`SlashCmdList.WOWAI("cancel"); WoWAIDB.lastSeq = ${first.id - 1}; WoWAI.Send("new question")`);
  const current = stripRecords(vm).find(r => r.text === 'new question');
  const nonce = P.parseFlags(current.flags).nonce;
  assert.equal(current.id, first.id);
  assert.notEqual(nonce, oldNonce);
  vm.run(`STUB.sounds["Interface\\\\AddOns\\\\WoWAI\\\\ack\\\\${String(first.id).padStart(3, '0')}.wav"] = true; STUB.Tick()`);
  assert.ok(stripRecords(vm).some(r => r.text === 'new question'), 'cached numeric ack leaves the question on the strip');
  for (const status of ['working', 'context', 'context_query', 'done', 'error']) {
    nextSlot(vm, `{ now=time(), replies={{chat="${current.chat}",id=${current.id},nonce="${oldNonce}",status="${status}",text="stale",request="old-query",queries={{op="snapshot",category="money"}}}} }`);
    vm.run('WoWAI.Send("")');
    assert.equal(vm.num('WoWAIDB.chats[1].pendingId'), current.id, status);
    assert.equal(vm.evaluate('WoWAIDB.chats[1].snapshotAcked'), null, status);
    assert.equal(vm.evaluate('WoWAIDB.chats[1].queryReply'), null, status);
    assert.equal(vm.evaluate('WoWAIDB.chats[1].progress'), null, status);
    assert.ok(stripRecords(vm).some(r => r.text === 'new question'), status);
  }
  nextSlot(vm, `{now=time(),replies={{chat="${current.chat}",id=${current.id},status="done",text="nonce missing"}}}`);
  vm.run('WoWAI.Send("")');
  assert.equal(vm.num('WoWAIDB.chats[1].pendingId'), current.id, 'nonce-less old bridge replies are ignored');
  nextSlot(vm, `{now=time(),replies={{chat="${current.chat}",id=${current.id + 1},nonce="${nonce}",status="done",text="wrong numeric ID"}}}`);
  vm.run('WoWAI.Send("")');
  assert.equal(vm.num('WoWAIDB.chats[1].pendingId'), current.id, 'the numeric ID must also match');
  nextSlot(vm, `{now=time(),replies={{chat="${current.chat}",id=${current.id},nonce="${nonce}",status="done",text="current answer"}}}`);
  vm.run('WoWAI.Send("")');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].pendingId'), null);
  assert.equal(vm.evaluate('WoWAIDB.chats[1].history[#WoWAIDB.chats[1].history].text'), 'current answer');
});

test('normal retries and UI reloads preserve their nonce and immutable snapshot', () => {
  const vm = newVM(true);
  login(vm);
  connect(vm);
  vm.run('WoWAI.Send("keep this request")');
  const first = stripRecords(vm).find(r => r.text === 'keep this request');
  const profile = vm.evaluate('WoWAIDB.chats[1].request.profile');
  const nonce = P.parseFlags(first.flags).nonce;
  vm.run('WoWAI.Resend()');
  assert.deepEqual(stripRecords(vm).find(r => r.text === first.text), first);
  login(vm);
  assert.deepEqual(stripRecords(vm).find(r => r.text === first.text), first, 'reload resumes without a manual resend');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].request.profile'), profile);
  assert.equal(vm.evaluate('WoWAIDB.chats[1].request.nonce'), nonce);
  assert.equal(vm.evaluate('WoWAIDB.outbox.nonce'), nonce);
  assert.equal(vm.num('(function() local n=0; for _,m in ipairs(WoWAIDB.chats[1].history) do if m.role=="user" then n=n+1 end end; return n end)()'), 1);
});

for (const source of ['immutable request', 'reload outbox']) {
test(`legacy pending migration resumes its full original profile and tuple from ${source}`, () => {
  const vm = newVM(true);
  login(vm);
  connectAgentOptions(vm);
  pickSelection(vm, 'agent', 'codex');
  pickSelection(vm, 'model', 'code-model');
  pickSelection(vm, 'reasoning', 'high');
  vm.run(`
    C_Container = {
      GetContainerNumSlots = function(bag) return bag == 0 and 96 or 0 end,
      GetContainerItemInfo = function(bag, slot) return {itemID=30000+slot,stackCount=slot,hyperlink="item:" .. (30000+slot)} end,
    }
    C_Item.GetItemInfo = function(id) return "Épée 鉱石 " .. id, "item:" .. id, 2 end
    SlashCmdList.WOWAI("cd original-folder")
    SlashCmdList.WOWAI("reset")
    WoWAI.Send("resume the original question", {"WebSearch", "Bash(git:*)"})
  `);
  const first = stripRecords(vm).find(r => r.text === 'resume the original question');
  const profile = vm.evaluate('WoWAIDB.chats[1].request.profile');
  const originalFlags = P.parseFlags(first.flags);
  delete originalFlags.nonce;
  assert.equal(JSON.parse(profile).data.inventory.bags.find(b => b.bag === 0).slots.length, 96);
  vm.run(`
    local c = WoWAIDB.chats[1]
    c.request.nonce = nil
    c.request.flags = c.request.flags:gsub("nonce=[A-Za-z0-9_-]+;?", "")
    WoWAIDB.outbox.nonce = nil
    c.snapshotAcked = true
    c.queryReply = { request = "legacy-query", text = "[]" }
    WoWAIDB.contextOutbox = {id=c.pendingId,chat=c.id,request="legacy-query",text="5b5d"}
    c.cwd, c.agent, c.model, c.reasoning = "changed-folder", "claude", "changed-model", "low"
    WoWAIContext.Snapshot = function() error("migration must not recollect a snapshot") end
  `);
  if (source === 'reload outbox') vm.run('WoWAIDB.chats[1].request = nil');
  else vm.run('WoWAIDB.outbox.profile = nil');
  login(vm);
  const migrated = stripRecords(vm).find(r => r.text === first.text);
  assert.ok(migrated, 'the stuck question resumes automatically');
  assert.equal(migrated.id, first.id);
  assert.equal(migrated.session, first.session);
  assert.equal(migrated.chat, first.chat);
  assert.equal(migrated.cwd, first.cwd);
  const migratedFlags = P.parseFlags(migrated.flags);
  const nonce = migratedFlags.nonce;
  delete migratedFlags.nonce;
  assert.deepEqual(migratedFlags, originalFlags);
  assert.match(nonce, /^[A-Za-z0-9_-]{8,64}$/);
  assert.equal(vm.evaluate('WoWAIDB.chats[1].request.profile'), profile);
  assert.equal(Buffer.from(vm.evaluate('WoWAIDB.outbox.profile'), 'hex').toString('utf8'), profile);
  assert.equal(vm.evaluate('WoWAIDB.outbox.nonce'), nonce);
  assert.equal(vm.evaluate('WoWAIDB.chats[1].snapshotAcked'), null);
  assert.equal(vm.evaluate('WoWAIDB.chats[1].queryReply'), null);
  assert.equal(vm.evaluate('WoWAIDB.contextOutbox'), null);
  login(vm);
  assert.equal(vm.evaluate('WoWAIDB.chats[1].request.nonce'), nonce, 'migration runs exactly once');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].request.profile'), profile);
  assert.equal(stripRecords(vm).find(r => r.text === first.text).flags, migrated.flags);
});
}

test('hello and forget retries preserve their persisted operation identities', () => {
  const vm = newVM();
  login(vm);
  vm.run('STUB.RunTimers()');
  const hello = stripRecords(vm)[0];
  login(vm);
  vm.run('STUB.RunTimers()');
  assert.deepEqual(stripRecords(vm)[0], hello, 'a hello retried after reload keeps its identity');
  vm.run('WoWAI.NewChat("Delete me")');
  const chat = vm.evaluate('WoWAIDB.chats[2].id');
  vm.run(`WoWAI.DeleteChat("${chat}")`);
  const forget = stripRecords(vm).find(r => r.flags.split(';').includes('d'));
  const nonce = P.parseFlags(forget.flags).nonce;
  assert.match(nonce, /^[A-Za-z0-9_-]{8,64}$/);
  assert.equal(vm.evaluate(`WoWAIDB.forget["${chat}"].nonce`), nonce);
  login(vm);
  vm.run('STUB.RunTimers()');
  assert.deepEqual(stripRecords(vm).find(r => r.flags.split(';').includes('d')), forget);
});

for (const version of [null, 0, 2]) {
test(`new questions require advertised request protocol 1 (received ${version})`, () => {
  const vm = newVM();
  login(vm);
  vm.run('STUB.RunTimers()');
  nextAck(vm, '{now=time(),contextProtocol=2,replies={}}', version);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick(); WoWAI.Send("retain this draft")');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].pendingId'), null);
  assert.equal(vm.evaluate('WoWAIDB.outbox'), null);
  assert.equal(vm.evaluate('WoWAIInput:GetText()'), 'retain this draft');
  assert.match(vm.evaluate('WoWAIDB.chats[1].history[#WoWAIDB.chats[1].history].text'), /updating\/restarting/);
  vm.run('WoWAI.Connect()');
  nextAck(vm, '{now=time(),contextProtocol=2,replies={}}');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick(); WoWAI.Send("retain this draft")');
  assert.ok(stripRecords(vm).some(r => r.text === 'retain this draft'));
});
}

test('a migrated pending question without Sharing also resumes automatically once', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('WoWAIDB.settings.context = false; WoWAI.Send("resume without a profile")');
  const first = stripRecords(vm).find(r => r.text === 'resume without a profile');
  vm.run(`
    local c = WoWAIDB.chats[1]
    c.request.nonce = nil
    c.request.flags = c.request.flags:gsub("nonce=[A-Za-z0-9_-]+;?", "")
    c.snapshotAcked = true
    WoWAIDB.outbox.nonce = nil
  `);
  login(vm);
  const resumed = stripRecords(vm).find(r => r.text === first.text);
  assert.ok(resumed);
  assert.equal(resumed.id, first.id);
  assert.equal(vm.evaluate('WoWAIDB.chats[1].request.profile'), null);
  assert.match(P.parseFlags(resumed.flags).nonce, /^[A-Za-z0-9_-]{8,64}$/);
  assert.equal(vm.evaluate('WoWAIDB.chats[1].resumePending'), null, 'one-time migration resume is consumed');
});

test('composer shortcuts add newlines, send explicitly, and release focus without losing text', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('WoWAI.Toggle(true); BEFORE = WoWAIDB.lastSeq; WoWAIStarter1:GetScript("OnClick")(WoWAIStarter1)');
  assert.equal(vm.num('WoWAIDB.lastSeq'), vm.num('BEFORE'), 'a starter only fills the composer');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].pendingId'), null);
  assert.ok(vm.evaluate('WoWAIInput:GetText()'));
  vm.run(`
    WoWAIInput:SetText("one"); WoWAIInput:SetCursorPosition(3);
    STUB.shift = true; WoWAIInput:GetScript("OnEnterPressed")(WoWAIInput);
    WoWAIInput:Insert("two")
  `);
  assert.equal(vm.evaluate('WoWAIInput:GetText()'), 'one\ntwo');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].pendingId'), null, 'Shift+Enter does not submit');
  vm.run('STUB.shift = false; WoWAIInput:GetScript("OnEnterPressed")(WoWAIInput)');
  assert.ok(stripRecords(vm).some(r => r.text === 'one\ntwo'));
  assert.equal(vm.evaluate('WoWAIInput:GetText()'), '');
  assert.equal(vm.evaluate('STUB.focus'), null);
  vm.run('WoWAIInput:SetText("keep this"); WoWAIInput:SetFocus(); WoWAIInput:GetScript("OnEscapePressed")(WoWAIInput)');
  assert.equal(vm.evaluate('WoWAIInput:GetText()'), 'keep this');
  assert.equal(vm.evaluate('STUB.focus'), null);
  assert.equal(vm.evaluate('WoWAIFrame:IsShown()'), 'true');
});

test('drafts preserve multiline whitespace through chat switches and reload initialization', () => {
  const vm = newVM();
  login(vm);
  const draft = '  first line\n    indented line\n';
  vm.run(`WoWAIInput:SetText(${P.luaStr(draft)}); FIRST = WoWAIDB.activeChat; WoWAI.NewChat("Second")`);
  assert.equal(vm.evaluate('WoWAIDB.chats[1].draft'), draft);
  vm.run('WoWAIInput:SetText("second draft"); WoWAI.SwitchChat(FIRST)');
  assert.equal(vm.evaluate('WoWAIInput:GetText()'), draft);
  assert.equal(vm.evaluate('WoWAIDB.chats[2].draft'), 'second draft');
  vm.run('STUB.FireEvent("ADDON_LOADED", "WoWAI"); STUB.FireEvent("PLAYER_LOGIN")');
  assert.equal(vm.evaluate('WoWAIInput:GetText()'), draft);
  assert.equal(vm.evaluate('WoWAIDB.chats[1].draft'), draft, 'the active draft remains saved too');
});

test('checking a pending reply preserves the next draft and never submits it automatically', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('WoWAI.Send("first question")');
  const id = vm.num('WoWAIDB.chats[1].pendingId');
  const nonce = vm.evaluate('WoWAIDB.chats[1].request.nonce');
  const chat = vm.evaluate('WoWAIDB.activeChat');
  const draft = '  next question\n  with indentation  ';
  vm.run(`WoWAIInput:SetText(${P.luaStr(draft)}); BEFORE = WoWAIDB.lastSeq; WoWAIInput:GetScript("OnEnterPressed")(WoWAIInput)`);
  assert.equal(vm.evaluate('WoWAIInput:GetText()'), draft);
  assert.equal(vm.evaluate('WoWAIDB.chats[1].draft'), draft);
  nextSlot(vm, `{now=time(),replies={{chat="${chat}",id=${id},nonce="${nonce}",status="done",text="first answer"}}}`);
  vm.run('WoWAIInput:GetScript("OnEnterPressed")(WoWAIInput)');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].pendingId'), null);
  assert.equal(vm.evaluate('WoWAIInput:GetText()'), draft);
  assert.equal(vm.num('WoWAIDB.lastSeq'), vm.num('BEFORE'), 'reply checks cannot submit the next draft');
  vm.run('WoWAICancelWait:GetScript("OnClick")(WoWAICancelWait)');
  assert.equal(vm.evaluate('WoWAIInput:GetText()'), draft);
});

test('filtered conversation rows retain their target IDs and a no-match search changes no data', () => {
  const vm = newVM();
  login(vm);
  vm.run('for i = 2, 16 do WoWAI.NewChat("Project " .. i) end');
  assert.equal(vm.evaluate('WoWAIChatRow16:IsShown()'), 'true', 'all saved conversations have scrollable rows');
  vm.run('WoWAIChatSearch:SetText("project 12")');
  assert.equal(vm.evaluate('WoWAIChatRow1.chatId'), vm.evaluate('WoWAIDB.chats[12].id'));
  assert.equal(vm.evaluate('WoWAIChatRow2:IsShown()'), 'false');
  vm.run('WoWAIChatRowMenu1:GetScript("OnClick")(WoWAIChatRowMenu1)');
  assert.equal(vm.evaluate('WoWAIChatMenu.chatId'), vm.evaluate('WoWAIDB.chats[12].id'));
  vm.run('WoWAIChatRow1:GetScript("OnClick")(WoWAIChatRow1, "LeftButton")');
  assert.equal(vm.evaluate('WoWAIDB.activeChat'), vm.evaluate('WoWAIDB.chats[12].id'));
  vm.run('WoWAIChatSearch:SetText("nothing matches this")');
  assert.equal(vm.evaluate('WoWAIChatRow1:IsShown()'), 'false');
  assert.equal(vm.num('#WoWAIDB.chats'), 16);
  vm.run('WoWAIChatSearch:SetText("")');
  assert.equal(vm.evaluate('WoWAIChatRow16.chatId'), vm.evaluate('WoWAIDB.chats[16].id'));
});

test('transcript redraws preserve reading position, remember each chat, and follow only at latest', () => {
  const vm = newVM();
  login(vm);
  vm.run(`
    FIRST = WoWAIDB.activeChat;
    table.insert(WoWAIDB.chats[1].history, {role="assistant",text="older reply"});
    STUB.transcriptRange = 1000;
    WoWAIScroll.GetVerticalScrollRange = function() return STUB.transcriptRange end;
    WoWAIScroll.UpdateScrollChildRect = function()
      if STUB.nextTranscriptRange then STUB.transcriptRange = STUB.nextTranscriptRange; STUB.nextTranscriptRange = nil end
    end;
    WoWAIScroll:SetVerticalScroll(120); WoWAI.Render()
  `);
  assert.equal(vm.num('WoWAIScroll:GetVerticalScroll()'), 120);
  vm.run('table.insert(WoWAIDB.chats[1].history, {role="assistant",text="another reply"}); STUB.nextTranscriptRange = 1200; WoWAI.Render(); STUB.RunTimers()');
  assert.equal(vm.num('WoWAIScroll:GetVerticalScroll()'), 120, 'a new message must not yank an older transcript');
  assert.equal(vm.evaluate('WoWAILatest:IsShown()'), 'true');
  vm.run('WoWAI.NewChat("Other"); WoWAI.SwitchChat(FIRST)');
  assert.equal(vm.num('WoWAIScroll:GetVerticalScroll()'), 120);
  vm.run('WoWAILatest:GetScript("OnClick")(WoWAILatest)');
  assert.equal(vm.num('WoWAIScroll:GetVerticalScroll()'), 1200);
  vm.run('STUB.nextTranscriptRange = 1400; WoWAI.Render()');
  assert.equal(vm.num('WoWAIScroll:GetVerticalScroll()'), 1400);
  assert.equal(vm.evaluate('WoWAILatest:IsShown()'), 'false');
});

test('scroll controls bound wheel and drag positions and reclamp when content shrinks', () => {
  const vm = newVM();
  login(vm);
  vm.run(`
    STUB.scrollMaximum = 600
    WoWAIScroll.GetVerticalScrollRange = function() return STUB.scrollMaximum end
    function ResizeScrollContent()
      for _, hook in ipairs(WoWAIScroll.hooks.OnScrollRangeChanged or {}) do hook(WoWAIScroll, 0, STUB.scrollMaximum) end
    end
    ResizeScrollContent()
    WoWAIScroll:GetScript("OnMouseWheel")(WoWAIScroll, -1)
  `);
  assert.ok(vm.num('WoWAIScroll:GetVerticalScroll()') > 0);
  vm.run('WoWAIScroll.bar:SetValue(500)');
  assert.equal(vm.num('WoWAIScroll:GetVerticalScroll()'), 500);
  vm.run('WoWAIScroll:GetScript("OnMouseWheel")(WoWAIScroll, -1000)');
  assert.equal(vm.num('WoWAIScroll:GetVerticalScroll()'), 600);
  vm.run('WoWAIScroll:GetScript("OnMouseWheel")(WoWAIScroll, 1000)');
  assert.equal(vm.num('WoWAIScroll:GetVerticalScroll()'), 0);
  vm.run('WoWAIScroll.bar:SetValue(500); STUB.scrollMaximum = 100; ResizeScrollContent()');
  assert.equal(vm.num('WoWAIScroll:GetVerticalScroll()'), 100);
  assert.equal(vm.num('WoWAIScroll.bar:GetValue()'), 100);
  vm.run('STUB.scrollMaximum = 0; ResizeScrollContent()');
  assert.equal(vm.num('WoWAIScroll:GetVerticalScroll()'), 0);
  assert.equal(vm.evaluate('WoWAIScroll.bar:IsShown()'), 'false');
});

test('discussion selection is in place, read only and stable across redraws', () => {
  const vm = newVM();
  login(vm);
  const text = '  Épée | literal pipes\n    indented answer\nlast line  ';
  vm.run(`
    WoWAI.Toggle(true)
    table.insert(WoWAIDB.chats[1].history, {role="assistant",text=${P.luaStr(text)}})
    WoWAI.Render()
    WoWAIMessageText1:SetFocus()
    WoWAIMessageText1:HighlightText(4, 16)
    local up = WoWAIMessageText1:GetParent():GetScript("OnMouseUp")
    if up then up(WoWAIMessageText1:GetParent(), "LeftButton") end
    WoWAI.Render()
  `);
  assert.equal(vm.evaluate('WoWAIMessageText1:GetText()'), text);
  assert.equal(vm.evaluate('WoWAIMessageText1:HasFocus()'), 'true');
  assert.equal(vm.num('WoWAIMessageText1.highlightStart'), 4);
  assert.equal(vm.num('WoWAIMessageText1.highlightEnd'), 16);
  assert.equal(vm.evaluate('WoWAICopy and WoWAICopy:IsShown()'), null, 'selection cannot require a modal copy window');
  vm.run('WoWAIMessageText1:SetText("accidental typing or paste")');
  assert.equal(vm.evaluate('WoWAIMessageText1:GetText()'), text);
  assert.equal(vm.evaluate('WoWAIDB.chats[1].history[1].text'), text);
  vm.run('WoWAIMessageText1:GetScript("OnEscapePressed")(WoWAIMessageText1)');
  assert.equal(vm.evaluate('WoWAIMessageText1:HasFocus()'), 'false');
  assert.equal(vm.evaluate('WoWAIFrame:IsShown()'), 'true', 'selection escape releases focus without closing the workspace');
});

test('recycled discussion bodies clear selections before binding another message', () => {
  const vm = newVM();
  login(vm);
  vm.run(`
    WoWAI.Toggle(true)
    table.insert(WoWAIDB.chats[1].history, {role="assistant",text="first answer"})
    WoWAI.Render()
    WoWAIMessageText1:SetFocus()
    WoWAIMessageText1:HighlightText(0, 5)
    WoWAI.NewChat("Second")
    table.insert(WoWAIDB.chats[2].history, {role="assistant",text="second answer"})
    WoWAI.Render()
  `);
  assert.equal(vm.evaluate('WoWAIMessageText1:GetText()'), 'second answer');
  assert.equal(vm.evaluate('WoWAIMessageText1:HasFocus()'), 'false');
  assert.equal(vm.evaluate('WoWAIMessageText1.highlightStart'), null);
  assert.equal(vm.evaluate('WoWAIMessageText1.highlightEnd'), null);
});

test('wrapped replies contain their painted text and actions after width changes', () => {
  const vm = newVM();
  vm.run(`
    -- A glyph line's painted advance is not the font's nominal point size.
    function PaintedHeight(text, width, size, spacing)
      local columns = math.max(1, math.floor(width / (size * 0.52)))
      local lines = 0
      for line in (text .. "\\n"):gmatch("(.-)\\n") do
        local characters = #line:gsub("[\\128-\\191]", "")
        lines = lines + math.max(1, math.ceil(characters / columns))
      end
      return lines * size * 1.6 + math.max(0, lines - 1) * spacing
    end
    local label = WoWAI.UI.Label
    WoWAI.UI.Label = function(...)
      local region = label(...)
      region.GetStringHeight = function(self)
        local _, size = self:GetFont()
        return PaintedHeight(self:GetText():gsub("||", "|"), self:GetWidth(), size, self:GetSpacing())
      end
      return region
    end
  `);
  login(vm);
  const text = 'A long wrapped reply with blank paragraphs.\n\n'
    + 'Mining and crafting advice '.repeat(18)
    + '\n\n[Reference](https://example.invalid/' + 'long-path-'.repeat(28) + ')\n\n'
    + 'Literal | text and Épée 鉱石.\n\nFinal paragraph must stay inside the card.';
  vm.run(`
    STUB.replyWidth = 640
    WoWAIScroll.GetWidth = function() return STUB.replyWidth end
    table.insert(WoWAIDB.chats[1].history, {role="user",text="question"})
    table.insert(WoWAIDB.chats[1].history, {role="assistant",text=${P.luaStr(text)},denied={"WebSearch"}})
    WoWAI.Toggle(true)
  `);
  const extent = () => vm.num('(function() local b=WoWAIMessageText2; local _,size=b:GetFont(); return PaintedHeight(b:GetText(),b:GetWidth(),size,b:GetSpacing()) end)()');
  assert.ok(vm.num('WoWAIMessageText2:GetHeight()') >= extent(), 'the entire painted reply fits its selectable region');
  assert.ok(vm.num('WoWAIMessageText2:GetParent():GetHeight()') >= extent() + 30, 'permission controls have room below the painted text');
  assert.equal(vm.evaluate('WoWAIMessageText2:GetText()'), text, 'measurement escapes cannot alter selectable text');
  vm.run('table.insert(WoWAIDB.chats[1].history, {role="user",text="next message"})');
  for (const width of [280, 700, 420]) {
    vm.run(`STUB.replyWidth=${width}; WoWAI.Render()`);
    const painted = extent();
    assert.ok(vm.num('WoWAIMessageText2:GetHeight()') >= painted, `wrapped text fits at width ${width}`);
    assert.ok(vm.num('WoWAIMessageText2:GetParent():GetHeight()') >= painted, `card encloses the reply at width ${width}`);
    assert.ok(vm.num('-WoWAIMessageText3:GetParent().y') >= vm.num('-WoWAIMessageText2:GetParent().y') + painted, 'the following message starts after the full reply');
    assert.equal(vm.evaluate('WoWAIMessageText2:GetText()'), text);
  }
});

test('readiness acknowledges promptly without scheduled or cached hints consuming idle slots', () => {
  const vm = newVM();
  connectFast(vm);
  assert.equal(loadedSlots(vm), 1);
  assert.equal(decodeStrip(vm), null, 'a verified hello stops drawing immediately, not on the next maintenance tick');
  vm.run('STUB.Advance(120)');
  assert.equal(loadedSlots(vm), 1, 'idle readiness checks cannot consume reply slots');
  assert.equal(vm.evaluate('WoWAI.IsConnected()'), 'false', 'frequent readiness checks cannot renew historical verification');
});

test('negotiated fast uploads preserve complete selected data and stop on queued full receipt', () => {
  const vm = newVM(true);
  connectFast(vm);
  vm.run(`C_Container = {
      GetContainerNumSlots=function(bag) return bag == 0 and 96 or 0 end,
      GetContainerItemInfo=function(bag,slot) return {itemID=20000+slot,stackCount=slot,hyperlink="item:" .. (20000+slot)} end,
    }
    C_Item.GetItemInfo=function(id) return "Épée 鉱石 " .. id, "item:" .. id, 2 end
    WoWAI.Send("fast complete inventory")`);
  const original = stripRecords(vm).find(r => r.text === 'fast complete inventory');
  assert.ok(original);
  const start = vm.num('GetTime()');
  const receiver = new ContextProtocol.Transfers();
  let complete, parts;
  for (let i = 0; i < 200 && !complete; i++) {
    for (const packet of P.jobsFromStrip(0, decodeStrip(vm).text)) {
      if (!packet.data) continue;
      parts = packet.parts;
      const result = receiver.add(packet);
      if (result.text) complete = result.text;
    }
    if (!complete) vm.run('STUB.Advance(0.05)');
  }
  assert.ok(complete, 'fast pacing must deliver all selected data rather than clipping it');
  assert.equal(complete, vm.evaluate('WoWAIDB.chats[1].request.profile'));
  // The first data frame also waits for the service ticker's phase; capture samples every 50ms.
  assert.ok(vm.num('GetTime()') - start <= (parts + 1) * 0.1 + 0.051, 'a complete upload must follow negotiated 100ms pacing, including startup and capture sampling');
  const flags = P.parseFlags(original.flags);
  nextSlot(vm, `{now=time(),replies={{chat=${P.luaStr(original.chat)},id=${original.id},nonce=${P.luaStr(flags.nonce)},status="queued",text="Waiting for a worker"}},${FAST_TRANSPORT}}`);
  wake(vm);
  vm.run('STUB.Advance(0.11)');
  assert.equal(decodeStrip(vm), null, 'complete queued receipt ends the upload before an AI worker is available');
  assert.equal(vm.num('WoWAIDB.chats[1].pendingId'), original.id);
  assert.equal(vm.evaluate('WoWAIDB.chats[1].request.profile'), complete);
});

test('cached numeric reply sounds cannot drain slots while a nonce-matched job is working', () => {
  const vm = newVM();
  connectFast(vm);
  vm.run('WoWAI.Send("long working request")');
  const record = stripRecords(vm).find(r => r.text === 'long working request');
  const nonce = P.parseFlags(record.flags).nonce;
  nextSlot(vm, `{now=time(),replies={{chat=${P.luaStr(record.chat)},id=${record.id},nonce=${P.luaStr(nonce)},status="working",text="Still working"}},${FAST_TRANSPORT}}`);
  vm.run(`STUB.sounds[string.format("Interface\\\\AddOns\\\\WoWAI\\\\sig\\\\%03d.wav", ((${record.id}-1)%200)+1)] = true
    STUB.Advance(60)`);
  assert.ok(loadedSlots(vm) < 12, 'a cached sound must not cause 600 fast slot reads');
  assert.equal(vm.num('WoWAIDB.chats[1].pendingId'), record.id);
  assert.equal(vm.evaluate('WoWAIDB.chats[1].request.nonce'), nonce);
});

for (const display of ['compact', 'quiet']) {
test(`${display} is enabled only after a full-size nonce- and capture-profile-matched calibration`, () => {
  const vm = newVM();
  connectFast(vm);
  vm.run('WoWAI.Toggle(true); WoWAIInput:SetText("preserve this draft")');
  chooseDisplay(vm, display, false);
  assert.equal(vm.evaluate('WoWAIDB.settings.pixelDisplay'), 'robust', 'Cancel cannot persist or preview a different transport');
  assert.equal(decodeStrip(vm), null);
  chooseDisplay(vm, display);
  const probe = decodeStrip(vm);
  assert.equal(Buffer.byteLength(probe.text), 3200, 'calibration must exercise the whole canvas');
  assert.equal(vm.num('WoWAIStrip.cell'), 2);
  assert.equal(vm.evaluate('WoWAIStrip.display'), display);
  assert.equal(vm.num('#WoWAIDB.chats[1].history'), 0, 'calibration never creates a user/AI turn');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].pendingId'), null);
  acknowledgeDisplay(vm, display);
  assert.equal(decodeStrip(vm), null);
  vm.run('WoWAI.Send("after calibration")');
  assert.equal(vm.evaluate('WoWAIStrip.display'), display);
  assert.equal(vm.num('WoWAIStrip.cell'), 2);
  const sent = stripRecords(vm).find(r => r.text === 'after calibration');
  assert.ok(sent);
  assert.equal(vm.evaluate('WoWAIInput:GetText()'), 'preserve this draft');
});
}

for (const failure of ['wrong profile', 'wrong nonce', 'stale snapshot']) {
test(`calibration ${failure} falls back without rewriting the pending request or looping probes`, () => {
  const vm = newVM();
  connectFast(vm);
  vm.run('WoWAI.Send("keep this pending request")');
  const question = questionRecord(vm, 'keep this pending request');
  const snapshot = vm.evaluate('WoWAIDB.chats[1].request.profile');
  const requestNonce = vm.evaluate('WoWAIDB.chats[1].request.nonce');
  chooseDisplay(vm, 'quiet');
  const calibration = stripRecords(vm).find(r => P.parseFlags(r.flags).calibration);
  const calibrationNonce = P.parseFlags(calibration.flags).nonce;
  const display = failure === 'wrong profile' ? 'robust' : 'quiet';
  const nonce = failure === 'wrong nonce' ? 'wrong-probe-nonce' : calibrationNonce;
  const clock = failure === 'stale snapshot' ? 'time()-60' : 'time()';
  nextSlot(vm, `{now=${clock},connectionProtocol=1,connectionAck={session=${P.luaStr(calibration.session)},nonce=${P.luaStr(nonce)},at=time(),display=${P.luaStr(display)}},replies={},${FAST_TRANSPORT}}`);
  wake(vm);
  vm.run('STUB.Advance(10)'); // both dark candidates must finish before declaring Robust fallback
  assert.equal(vm.evaluate('WoWAIStrip.display'), 'robust');
  assert.equal(vm.evaluate('WoWAIDB.settings.pixelDisplay'), 'quiet', 'fallback is visible state, not a silent preference rewrite');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].request.profile'), snapshot);
  assert.equal(vm.evaluate('WoWAIDB.chats[1].request.nonce'), requestNonce);
  assert.equal(vm.num('WoWAIDB.chats[1].pendingId'), question.id);
  const after = vm.num('WoWAIDB.lastSeq');
  vm.run('STUB.Advance(10)');
  assert.equal(vm.num('WoWAIDB.lastSeq'), after, 'failed display checks cannot continuously create new controls');
});
}

test('a successful quiet display is invalidated and recalibrated after native scale changes', () => {
  const vm = newVM();
  connectFast(vm);
  chooseDisplay(vm, 'quiet');
  acknowledgeDisplay(vm, 'quiet');
  vm.run('STUB.dpiScale=1.5; STUB.FireEvent("UI_SCALE_CHANGED"); STUB.Advance(0.11)');
  const probe = stripRecords(vm).find(r => P.parseFlags(r.flags).calibration);
  assert.ok(probe, 'a changed physical grid needs a new captured calibration');
  acknowledgeDisplay(vm, 'quiet');
  vm.run('WoWAI.Send("scaled quiet send")');
  assert.equal(vm.evaluate('WoWAIStrip.display'), 'quiet');
  assert.ok(stripRecords(vm).some(r => r.text === 'scaled quiet send'));
});

test('filtered two-pixel Quiet falls back to verified dark four-pixel cells and rechecks remembered geometry', () => {
  const vm = newVM();
  connectFast(vm);
  vm.run('WoWAI.Send("preserve the pending data during display negotiation")');
  const request = questionRecord(vm, 'preserve the pending data during display negotiation');
  const profile = vm.evaluate('WoWAIDB.chats[1].request.profile');
  const nonce = vm.evaluate('WoWAIDB.chats[1].request.nonce');
  chooseDisplay(vm, 'quiet');
  vm.run('STUB.Advance(4.1)');
  const larger = stripRecords(vm).find(r => P.parseFlags(r.flags).calibration);
  assert.equal(P.parseFlags(larger.flags).calibration, 'quiet4');
  assert.equal(vm.num('WoWAIStrip.cell'), 4);
  assert.equal(Buffer.byteLength(decodeStrip(vm).text), 3200);
  acknowledgeDisplay(vm, 'quiet4');
  assert.equal(vm.evaluate('WoWAIDB.settings.pixelDisplay'), 'quiet');
  assert.equal(vm.evaluate('WoWAIStrip.display'), 'quiet4');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].request.profile'), profile);
  assert.equal(vm.evaluate('WoWAIDB.chats[1].request.nonce'), nonce);
  assert.equal(vm.num('WoWAIDB.chats[1].pendingId'), request.id);
  vm.run('WoWAI.Connect()');
  nextAck(vm, `{now=time(),replies={},${FAST_TRANSPORT}}`);
  wake(vm);
  vm.run('STUB.Advance(0.11)');
  const repeated = stripRecords(vm).find(r => P.parseFlags(r.flags).calibration);
  assert.equal(P.parseFlags(repeated.flags).calibration, 'quiet4', 'remembered geometry should not repeat a known-unreadable small-grid attempt');
  assert.notEqual(P.parseFlags(repeated.flags).nonce, P.parseFlags(larger.flags).nonce, 'remembered dimensions still need fresh native proof');
  acknowledgeDisplay(vm, 'quiet4');
  assert.equal(vm.evaluate('WoWAIStrip.display'), 'quiet4');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].request.nonce'), nonce);
});
