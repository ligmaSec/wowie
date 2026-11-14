// Runs the real Map.lua (with WoWAI.lua) in a Lua VM: syncing layers from the
// bridge, drawing pins on the world map, native waypoint ownership and route
// progression, optional dotted routing, gathering nodes, and /wow-ai map.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const ADDON = path.join(__dirname, '..', 'addon', 'WoWAI');

// Map-specific client stubs: Loch Modan (1432) sits at x .5-.6, y .4-.5 of
// Eastern Kingdoms (1415), which is 10000 x 15000 yards.
const MAP_STUB = `
Enum = { UIMapType = { Continent = 2, Zone = 3 } }
local MAPS = {
  [1432] = { name = "Loch Modan", mapType = 3, parentMapID = 1415 },
  [1415] = { name = "Eastern Kingdoms", mapType = 2, parentMapID = 947 },
  [1411] = { name = "Durotar", mapType = 3, parentMapID = 1414 },
  [1454] = { name = "Orgrimmar", mapType = 4, parentMapID = 1411 },
  [1414] = { name = "Kalimdor", mapType = 2, parentMapID = 947 },
  [947] = { name = "Azeroth", mapType = 1, parentMapID = 0 },
}
C_Map.GetMapInfo = function(id) local m = MAPS[id]; if m then return { name = m.name, mapType = m.mapType, parentMapID = m.parentMapID, mapID = id } end end
C_Map.GetBestMapForUnit = function() return STUB.playerMap or 1432 end
C_Map.GetMapRectOnMap = function(child, parent)
  if child == 1432 and parent == 1415 then return 0.5, 0.6, 0.4, 0.5 end
  if child == 1411 and parent == 1414 then return 0.7, 0.8, 0.2, 0.4 end
  if child == 1454 and parent == 1414 then return 0.71, 0.73, 0.21, 0.23 end
  if child == 1454 and parent == 1411 then return 0.1, 0.3, 0.05, 0.15 end
end
function CreateVector2D(x, y) return { x = x, y = y } end
C_Map.GetWorldPosFromMapPos = function(id, v) if id == 1415 or id == 1414 then return 0, { x = v.x * 10000, y = v.y * 15000 } end end
UiMapPoint = { CreateFromCoordinates = function(map, x, y, z) return { uiMapID = map, position = CreateVector2D(x, y), z = z } end }
C_Map.CanSetUserWaypointOnMap = function() return not STUB.denyWaypoint end
C_Map.GetUserWaypoint = function() return STUB.waypoint end
C_Map.SetUserWaypoint = function(point)
  if STUB.denyWaypoint then return false end
  STUB.waypoint = { uiMapID = point.uiMapID, position = { x = point.position.x, y = point.position.y }, z = point.z }
  STUB.FireEvent("USER_WAYPOINT_UPDATED")
  return true
end
C_Map.ClearUserWaypoint = function() STUB.waypoint = nil; STUB.FireEvent("USER_WAYPOINT_UPDATED") end
C_SuperTrack = {
  IsSuperTrackingUserWaypoint = function() return STUB.superTracked == true and STUB.waypoint ~= nil end,
  SetSuperTrackedUserWaypoint = function(value) STUB.superTracked = value end,
  GetSuperTrackedQuestID = function() return STUB.trackedQuest or 0 end,
  SetSuperTrackedQuestID = function(id) STUB.trackedQuest = id; STUB.superTracked = false end,
}
function Methods_CreateLine() end
local canvas = CreateFrame("Frame", "WorldMapCanvas")
canvas.width, canvas.height = 1000, 700
WorldMapFrame = CreateFrame("Frame", "WorldMapFrame")
WorldMapFrame.shown = true
function WorldMapFrame:GetCanvas() return canvas end
function WorldMapFrame:GetMapID() return STUB.shownMap or 1432 end
function WorldMapFrame:GetCanvasScale() return 1 end
function WorldMapFrame:OnMapChanged() end
function OpenWorldMap(mapID) STUB.shownMap = mapID; WorldMapFrame:Show(); WorldMapFrame:OnMapChanged() end
local T = getmetatable(canvas).__index
MINING, HERBALISM = "Mining", "Herbalism"
`;

function newVM(initialState = '') {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = (code, arg) => {
    if (lauxlib.luaL_loadstring(L, to_luastring(code)) !== lua.LUA_OK) throw new Error('Lua load: ' + to_jsstring(lua.lua_tostring(L, -1)));
    let nargs = 0;
    if (arg !== undefined) { lua.lua_pushstring(L, to_luastring(arg)); nargs = 1; }
    if (lua.lua_pcall(L, nargs, 0, 0) !== lua.LUA_OK) throw new Error('Lua error: ' + to_jsstring(lua.lua_tostring(L, -1)));
  };
  const evaluate = (expr) => {
    run(`local v = (${expr}); if v == nil then RESULT = nil else RESULT = tostring(v) end`);
    lua.lua_getglobal(L, to_luastring('RESULT'));
    const s = lua.lua_isnil(L, -1) ? null : to_jsstring(lua.lua_tolstring(L, -1));
    lua.lua_pop(L, 1);
    return s;
  };
  const num = (expr) => Number(evaluate(expr));
  let stub = fs.readFileSync(path.join(__dirname, 'wow_stub.lua'), 'utf8');
  // Lines are frames too (Frame:CreateLine), and textures can rotate.
  stub += `
function Methods.CreateLine(self, name, layer) local l = NewObjectPublic("Line", name, self); table.insert(self.textures, l); return l end
function Methods.SetVertexColor(self, r, g, b, a) self.vcolor = { r, g, b, a } end
function Methods.SetScale(self, s) self.scale = s end
function Methods.SetAllPoints(self, rel) if rel then self.width, self.height = rel.width, rel.height end end
function Methods.GetFrameLevel(self) return self.level or 1 end
function Methods.SetFrameLevel(self, l) self.level = l end
`;
  stub = stub.replace('local function NewObject(', 'function NewObjectPublic(').replace(/NewObject\(/g, 'NewObjectPublic(');
  run(stub);
  run(MAP_STUB);
  if (initialState) run(initialState);
  for (const f of ['Codec.lua', 'Inbox.lua', 'WoWAI.lua', 'Context.lua', 'ContextUI.lua', 'Map.lua']) run(fs.readFileSync(path.join(ADDON, f), 'utf8'), 'WoWAI');
  run('STUB.FireEvent("ADDON_LOADED", "WoWAI"); STUB.FireEvent("PLAYER_LOGIN")');
  return { run, evaluate, num };
}

// Shown pins on the world map overlay: "x,y,label" (label = the numbered text).
function shownPins(vm) {
  vm.run(`
    local out = {}
    local canvas = WorldMapFrame:GetCanvas()
    local overlay = canvas.children[#canvas.children]
    for _, c in ipairs(overlay.children) do
      if c.kind == "Button" and c.shown then
        local label = c.num and c.num.text or ""
        out[#out + 1] = string.format("%.0f,%.0f,%s,%s", c.x, -c.y, label, c.info and c.info.title or "")
      end
    end
    RESULT = table.concat(out, ";")`);
  const s = vm.evaluate('RESULT');
  return s ? s.split(';') : [];
}

const LAYER = `{ epoch = "e1", version = 1, layers = { { name = "mining", title = "Copper loop", ordered = true, loop = true, points = {
  { 1432, 50, 40, "1. Copper Vein", "ore" }, { 1432, 60, 50, "2. Copper Vein", "ore" }, { 1432, 55, 70, "3. Tin Vein", "ore" } } } } }`;

test('Sync applies a new version once, starts navigation, ignores stale versions', () => {
  const vm = newVM();
  vm.run(`WoWAIMap.Sync(${LAYER})`);
  assert.equal(vm.evaluate('WoWAIMapDB.map.version'), '1');
  assert.equal(vm.evaluate('WoWAIMapDB.nav.layer'), 'mining');
  assert.equal(vm.evaluate('WoWAIMapDB.nav.index'), '1');
  const prints = () => vm.num('#STUB.prints');
  const before = prints();
  vm.run(`WoWAIMap.Sync(${LAYER})`); // same version: nothing
  assert.equal(prints(), before);
  vm.run(`WoWAIMap.Sync({ epoch = "e1", version = 0, layers = {} })`); // older: ignored
  assert.equal(vm.num('#WoWAIMapDB.map.layers'), 1);
  // A new epoch (bridge state reset) replaces, even with a lower version; same content stays quiet.
  vm.run(`local m = ${LAYER}; m.epoch = "e2"; WoWAIMap.Sync(m)`);
  assert.equal(vm.evaluate('WoWAIMapDB.map.epoch'), 'e2');
  assert.equal(prints(), before);
  vm.run(`WoWAIMap.Sync({ epoch = "e2", version = 5, layers = {} })`);
  assert.equal(vm.num('#WoWAIMapDB.map.layers'), 0);
  assert.equal(vm.evaluate('WoWAIMapDB.nav'), null);
});

test('a new route does not take over a route the player is already following', () => {
  const vm = newVM();
  vm.run(`WoWAIMap.Sync(${LAYER})`);
  vm.run('SlashCmdList.WOWAIMAP("nav mining 2")');
  vm.run(`local m = ${LAYER}; m.version = 2; m.layers[2] = { name = "quests", title = "Westfall", ordered = true, loop = false,
    points = { { 1432, 10, 10, "1. Talk", "quest" }, { 1432, 20, 20, "2. Kill", "kill" } } }; WoWAIMap.Sync(m)`);
  assert.equal(vm.evaluate('WoWAIMapDB.nav.layer'), 'mining');
  assert.equal(vm.evaluate('WoWAIMapDB.nav.index'), '2');
  // With nothing being followed, the next route starts by itself.
  vm.run('SlashCmdList.WOWAIMAP("stop")');
  vm.run(`local m = ${LAYER}; m.version = 3; m.layers[1].points[1][4] = "1. Rich Copper"; WoWAIMap.Sync(m)`);
  assert.equal(vm.evaluate('WoWAIMapDB.nav.layer'), 'mining');
  assert.equal(vm.evaluate('WoWAIMapDB.nav.index'), '1');
});

test('a single destination outside the city starts navigation with the world map closed', () => {
  const vm = newVM();
  vm.run(`
    STUB.playerMap, STUB.shownMap = 1454, 1454
    STUB.posX, STUB.posY = 0.5, 0.5
    WorldMapFrame:Hide()
    WoWAIMap.Sync({ epoch = "single", version = 1, layers = {
      { name = "nearby-copper", title = "Nearby Copper", ordered = false, loop = false,
        points = { { 1411, 52.7, 18.2, "Copper Vein area", "ore" } } }
    } })
  `);
  assert.equal(vm.evaluate('WoWAIMapDB.nav.layer'), 'nearby-copper');
  // The point is outside Orgrimmar: it belongs on Durotar, not the city map.
  vm.run('WorldMapFrame:Show(); WoWAIMap.Refresh()');
  assert.deepEqual(shownPins(vm), []);
  vm.run('STUB.shownMap = 1411; WoWAIMap.Refresh()');
  assert.deepEqual(shownPins(vm), ['527,127,,Nearby Copper']);
  vm.run('SlashCmdList.WOWAIMAP("stop"); WoWAIMap.Sync(WoWAIMapDB.map)');
  assert.equal(vm.evaluate('WoWAIMapDB.nav'), null, 'a repeated snapshot must not undo a manual stop');
});

test('single destination auto-navigation respects an active route and continent boundaries', () => {
  const vm = newVM();
  vm.run(`WoWAIMap.Sync(${LAYER}); WoWAIMap.Navigate("mining", 2)`);
  vm.run(`local m = ${LAYER}; m.version = 2
    m.layers[2] = { name = "destination", title = "Copper", ordered = false, loop = false,
      points = { { 1432, 20, 20, "Copper", "ore" } } }
    WoWAIMap.Sync(m)`);
  assert.equal(vm.evaluate('WoWAIMapDB.nav.layer'), 'mining');
  assert.equal(vm.evaluate('WoWAIMapDB.nav.index'), '2', 'a new destination cannot interrupt the current route');
  vm.run(`WoWAIMap.Stop()
    WoWAIMap.Sync({ epoch = "single", version = 1, layers = {
      { name = "far-away", title = "Durotar copper", ordered = false, loop = false,
        points = { { 1411, 52.7, 18.2, "Copper", "ore" } } }
    } })`);
  assert.equal(vm.evaluate('WoWAIMapDB.nav'), null, 'a point on another continent must not start local navigation');
});

test('unordered collections remain world-map pins without choosing an arbitrary navigation target', () => {
  const vm = newVM();
  vm.run(`WoWAIMap.Sync({ epoch = "pois", version = 1, layers = {
    { name = "vendors", title = "Vendors", ordered = false, loop = false,
      points = { { 1432, 20, 20, "First vendor", "vendor" }, { 1432, 80, 80, "Second vendor", "vendor" } } }
  } })`);
  assert.equal(vm.evaluate('WoWAIMapDB.nav'), null);
  assert.deepEqual(shownPins(vm), ['200,140,,Vendors', '800,560,,Vendors']);
});

test('slot data carrying a map reaches the map module', () => {
  const vm = newVM();
  vm.run(`WoWAI_Inbox = { replies = {}, map = ${LAYER} }; STUB.FireEvent("PLAYER_LOGIN")`);
  assert.equal(vm.evaluate('WoWAIMapDB.map.layers[1].title'), 'Copper loop');
});

test('pins land where the points are, on the zone map and on the continent', () => {
  const vm = newVM();
  vm.run(`WoWAIMap.Sync(${LAYER})`);
  vm.run('WoWAIMap.Refresh()');
  let pins = shownPins(vm);
  assert.deepEqual(pins, ['500,280,1,Copper loop', '600,350,2,Copper loop', '550,490,3,Copper loop']);
  vm.run('STUB.shownMap = 1415; WoWAIMap.Refresh()');
  pins = shownPins(vm);
  // 1432 (50,40) -> 1415 (0.55, 0.44) on a 1000x700 canvas.
  assert.equal(pins[0], '550,308,1,Copper loop');
  vm.run('STUB.shownMap = 947; WoWAIMap.Refresh()'); // no rect: nothing drawn
  assert.deepEqual(shownPins(vm), []);
});

test('native waypoints advance on arrival and restore the previous player pin when a route finishes', () => {
  const vm = newVM();
  vm.run(`
    C_Map.SetUserWaypoint(UiMapPoint.CreateFromCoordinates(1432, 0.1, 0.2))
    C_SuperTrack.SetSuperTrackedUserWaypoint(true)
    local m = ${LAYER}; m.layers[1].loop = false; WoWAIMap.Sync(m)
    STUB.posX, STUB.posY = 0.5, 0.4
    STUB.Tick()
  `);
  assert.equal(vm.evaluate('WoWAIMapDB.nav.index'), '2');
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.6);
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.y'), 0.5);
  vm.run('STUB.posX, STUB.posY = 0.6, 0.5; STUB.Tick()');
  assert.equal(vm.evaluate('WoWAIMapDB.nav.index'), '3');
  vm.run('STUB.posX, STUB.posY = 0.55, 0.7; STUB.Tick()');
  assert.equal(vm.evaluate('WoWAIMapDB.nav'), null);
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.1);
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.y'), 0.2);
  assert.equal(vm.evaluate('C_SuperTrack.IsSuperTrackingUserWaypoint()'), 'true');
});

test('a player-selected pin or quest takes priority over addon tracking', () => {
  const vm = newVM();
  vm.run(`WoWAIMap.Sync(${LAYER})
    C_Map.SetUserWaypoint(UiMapPoint.CreateFromCoordinates(1432, 0.15, 0.25))
    STUB.Tick()`);
  assert.equal(vm.evaluate('WoWAIMapDB.nav'), null);
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.15, 'the player pin must not be cleared or overwritten');
  vm.run('WoWAIMap.Navigate("mining"); C_SuperTrack.SetSuperTrackedQuestID(123); STUB.Tick()');
  assert.equal(vm.evaluate('WoWAIMapDB.nav'), null);
  assert.equal(vm.num('C_SuperTrack.GetSuperTrackedQuestID()'), 123);
  assert.equal(vm.evaluate('C_SuperTrack.IsSuperTrackingUserWaypoint()'), 'false', 'stopping must not steal tracking back from the selected quest');
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.15, 'the prior player pin is restored without tracking it');
});

test('native waypoint ownership survives reload without treating the addon pin as a prior player pin', () => {
  const vm = newVM();
  vm.run(`C_Map.SetUserWaypoint(UiMapPoint.CreateFromCoordinates(1432, 0.15, 0.25))
    C_SuperTrack.SetSuperTrackedUserWaypoint(true)
    WoWAIMap.Sync(${LAYER})
    local function Dump(v)
      if type(v) == "table" then
        local rows = {}
        for k, value in pairs(v) do rows[#rows + 1] = "[" .. Dump(k) .. "]=" .. Dump(value) end
        return "{" .. table.concat(rows, ",") .. "}"
      elseif type(v) == "string" then return string.format("%q", v)
      else return tostring(v) end
    end
    SAVED = Dump({ db = WoWAIMapDB, waypoint = C_Map.GetUserWaypoint() })`);
  const reloaded = newVM(`local saved = ${vm.evaluate('SAVED')}; WoWAIMapDB = saved.db
    C_Map.SetUserWaypoint(saved.waypoint); C_SuperTrack.SetSuperTrackedUserWaypoint(true)`);
  reloaded.run('WoWAIMap.UpdateNavigator(); WoWAIMap.Stop()');
  assert.equal(reloaded.num('C_Map.GetUserWaypoint().position.x'), 0.15);
  assert.equal(reloaded.num('C_Map.GetUserWaypoint().position.y'), 0.25);
});

function installRouter(vm) {
  vm.run(`
    STUB.routeEnded = {}
    ShortestPathForever = { API = {
      version = 1,
      Navigate = function(owner, map, x, y, title, kind)
        if InCombatLockdown() then return false end
        STUB.routeEnded[owner] = nil
        STUB.route = { owner = owner, map = map, x = x, y = y, title = title, kind = kind }
        return true
      end,
      CurrentStop = function(owner) return STUB.route and STUB.route.owner == owner and 1 or nil end,
      Ended = function(owner) return STUB.routeEnded[owner] end,
      Active = function() return STUB.route ~= nil end,
      Cancel = function(owner)
        if not STUB.route or STUB.route.owner ~= owner then return false end
        STUB.route = nil; STUB.routeEnded[owner] = "cancelled"; return true
      end,
    } }
  `);
}

test('dotted routing drives arrival, advances the active stop, and yields to another route owner', () => {
  const vm = newVM();
  installRouter(vm);
  vm.run(`WoWAIMap.Sync(${LAYER})
    STUB.posX, STUB.posY = 0.5, 0.4; STUB.Tick()`);
  assert.equal(vm.evaluate('WoWAIMapDB.nav.index'), '1', 'straight-line proximity must not skip a routed stop');
  vm.run('STUB.route = nil; STUB.routeEnded.WoWAI = "arrived"; STUB.Tick()');
  assert.equal(vm.evaluate('WoWAIMapDB.nav.index'), '2');
  assert.equal(vm.evaluate('STUB.route.owner'), 'WoWAI');
  vm.run(`STUB.route = { owner = "OtherAddon" }; STUB.routeEnded.WoWAI = "replaced"
    local m = ${LAYER}; m.version = 2; m.layers[1].points[2][2] = 65; WoWAIMap.Sync(m)`);
  assert.equal(vm.evaluate('WoWAIMapDB.nav'), null, 'a layer update must not retake a route that another addon owns');
  assert.equal(vm.evaluate('STUB.route.owner'), 'OtherAddon');
});

test('automatic tracking leaves another dotted route alone and defers owned routing during combat', () => {
  const vm = newVM();
  installRouter(vm);
  vm.run(`STUB.route = { owner = "OtherAddon" }; WoWAIMap.Sync(${LAYER})`);
  assert.equal(vm.evaluate('WoWAIMapDB.nav'), null);
  assert.equal(vm.evaluate('STUB.route.owner'), 'OtherAddon');
  vm.run(`STUB.route = nil; STUB.combat = true
    function InCombatLockdown() return STUB.combat end
    WoWAIMap.Navigate("mining"); STUB.Tick()`);
  assert.equal(vm.evaluate('STUB.route'), null);
  assert.equal(vm.evaluate('C_Map.GetUserWaypoint()'), null, 'combat must not leave a competing native waypoint');
  vm.run('STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  assert.equal(vm.evaluate('STUB.route.owner'), 'WoWAI');
  vm.run('WoWAIMap.Stop()');
  assert.equal(vm.evaluate('STUB.route'), null);
});

test('a rejected waypoint leaves player tracking intact instead of claiming active navigation', () => {
  const vm = newVM();
  vm.run(`C_Map.SetUserWaypoint(UiMapPoint.CreateFromCoordinates(1432, 0.15, 0.25))
    C_SuperTrack.SetSuperTrackedUserWaypoint(true); STUB.denyWaypoint = true
    WoWAIMap.Sync(${LAYER})`);
  assert.equal(vm.evaluate('WoWAIMapDB.nav'), null);
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.15);
  assert.equal(vm.evaluate('C_SuperTrack.IsSuperTrackingUserWaypoint()'), 'true');
});

test('herb/ore nodes toggle and follow the gathering skill', () => {
  const vm = newVM();
  vm.run(`WoWAINodes = { kinds = { { "Copper Vein", "mining", 1 }, { "Tin Vein", "mining", 65 }, { "Peacebloom", "herbalism", 1 } },
    maps = { [1432] = { [1] = "100200300400", [2] = "500500", [3] = "999999" } } }`);
  vm.run('WoWAIMap.Refresh()');
  assert.equal(shownPins(vm).length, 0, 'off by default');
  vm.run('SlashCmdList.WOWAIMAP("ore on")');
  // No Mining skill line in the stub: every ore shows, flagged as not learned.
  assert.deepEqual(shownPins(vm).map(p => p.split(',').slice(0, 2).join(',') + ',' + p.split(',')[3]), ['100,140,Copper Vein', '300,280,Copper Vein', '500,350,Tin Vein']);
  // With Mining 50 (Forever's C_SkillInfo: one table per line), Tin (65) is filtered out until "filter all".
  // Forever also lists child lines (parentSkillLineID ~= 0) that repeat the parent.
  vm.run(`C_SkillInfo = { GetNumSkillLines = function() return 3 end, GetSkillLineInfo = function(i)
    if i == 1 then return { name = "Professions", isHeader = true, rank = 0, maxRank = 0, skillID = 0, parentSkillLineID = 0 } end
    if i == 3 then return { name = "Bergbau", isHeader = false, rank = 50, maxRank = 75, skillID = 2572, parentSkillLineID = 186 } end
    return { name = "Bergbau", isHeader = false, rank = 50, maxRank = 75, skillID = 186, parentSkillLineID = 0 } end }
    WoWAIMap.Refresh()`);
  assert.equal(shownPins(vm).length, 2);
  vm.run('SlashCmdList.WOWAIMAP("filter all")');
  assert.equal(shownPins(vm).length, 3);
  vm.run('SlashCmdList.WOWAIMAP("herb on")');
  assert.equal(shownPins(vm).length, 4);
  vm.run('SlashCmdList.WOWAIMAP("ore off"); SlashCmdList.WOWAIMAP("herb off")');
  assert.equal(shownPins(vm).length, 0);
});

test('/wow-ai map hide, show, nav and stop', () => {
  const vm = newVM();
  vm.run(`WoWAIMap.Sync(${LAYER})`);
  vm.run('SlashCmdList.WOWAIMAP("hide mining")');
  assert.equal(shownPins(vm).length, 0);
  vm.run('SlashCmdList.WOWAIMAP("show mining")');
  assert.equal(shownPins(vm).length, 3);
  vm.run('SlashCmdList.WOWAIMAP("nav mining 3")');
  assert.equal(vm.evaluate('WoWAIMapDB.nav.index'), '3');
  vm.run('SlashCmdList.WOWAIMAP("stop")');
  assert.equal(vm.evaluate('WoWAIMapDB.nav'), null);
  assert.equal(vm.evaluate('C_Map.GetUserWaypoint()'), null);
  vm.run('SlashCmdList.WOWAIMAP("")'); // status never errors
});

function click(vm, control) {
  vm.run(`local button = ${control}; assert(button:IsEnabled(), "control is disabled"); button:GetScript("OnClick")(button)`);
}

function savedMap(vm) {
  vm.run(`local function Dump(v)
    if type(v) == "table" then
      local rows = {}
      for key, value in pairs(v) do rows[#rows + 1] = "[" .. Dump(key) .. "]=" .. Dump(value) end
      return "{" .. table.concat(rows, ",") .. "}"
    elseif type(v) == "string" then return string.format("%q", v)
    else return tostring(v) end
  end
  SAVED = Dump(WoWAIMapDB)`);
  return `WoWAIMapDB = ${vm.evaluate('SAVED')}`;
}

test('navigation snapshots are cached and changes notify the workspace with the world map closed', () => {
  const vm = newVM();
  vm.run(`WorldMapFrame:Hide()
    local update = WoWAI.UpdateNavigation
    WoWAI.UpdateNavigation = function()
      STUB.navigationUpdates = (STUB.navigationUpdates or 0) + 1
      if update then update() end
    end
    WoWAIMap.Sync(${LAYER})
    FIRST = WoWAIMap.GetNavigationState()
    FIRST_REVISION = FIRST.revision
    FIRST_UPDATES = STUB.navigationUpdates
    WoWAIMap.UpdateNavigator(); WoWAIMap.UpdateNavigator()`);
  assert.equal(vm.evaluate('FIRST == WoWAIMap.GetNavigationState()'), 'true');
  assert.equal(vm.evaluate('FIRST.layers == WoWAIMapDB.map.layers'), 'true');
  assert.equal(vm.evaluate('FIRST.active.point == WoWAIMapDB.map.layers[1].points[1]'), 'true');
  assert.equal(vm.evaluate('STUB.navigationUpdates == FIRST_UPDATES'), 'true');
  vm.run('WoWAIMap.ShowNavigation()');
  assert.equal(vm.evaluate('STUB.focus'), null, 'opening the browser must not take keyboard focus');
  click(vm, 'WoWAINavigationNext');
  assert.equal(vm.evaluate('WoWAIMap.GetNavigationState().active.index'), '2');
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.6);
  assert.equal(vm.evaluate('WoWAIMap.GetNavigationState().revision > FIRST_REVISION'), 'true');
  assert.equal(vm.evaluate('STUB.navigationUpdates > FIRST_UPDATES'), 'true');
  assert.equal(vm.evaluate('WorldMapFrame:IsShown()'), 'false');
  click(vm, 'WoWAINavigationPrevious');
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.5);
});

test('virtual destination buttons resolve rebound rows after scroll, filter and map replacement', () => {
  const vm = newVM();
  vm.run(`local points = {}
    for i = 1, 1500 do points[i] = { 1432, 10 + i % 80, 90, string.format("Destination %04d", i), "poi" } end
    WoWAIMap.Sync({ epoch = "large", version = 1, layers = {
      { name = "internal-collection", title = "Saved places", points = points } } })
    WoWAIMap.ShowNavigation()
    FIRST_ROW = WoWAINavigationPanel.rows[1]
    WoWAINavigationScroll:SetVerticalScroll(999 * 72)`);
  assert.equal(vm.evaluate('WoWAIMapDB.nav'), null, 'browsing does not activate an unordered collection');
  assert.ok(vm.num('#WoWAINavigationPanel.rows') < 20, 'only viewport-sized rows are allocated');
  assert.equal(vm.evaluate('WoWAINavigationPanel.rows[1] == FIRST_ROW'), 'true');
  click(vm, 'WoWAINavigationRow1Navigate');
  assert.equal(vm.evaluate('WoWAIMapDB.nav.index'), '1000');
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.5);
  vm.run('WoWAINavigationSearch:SetText("Destination 1499")');
  assert.equal(vm.num('WoWAINavigationScroll:GetVerticalScroll()'), 0);
  click(vm, 'WoWAINavigationRow1Navigate');
  assert.equal(vm.evaluate('WoWAIMapDB.nav.index'), '1499');
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.69);
  vm.run(`WoWAIMap.Sync({ epoch = "large", version = 2, layers = {
    { name = "replacement", title = "Replacement collection", points = {
      { 1432, 22, 33, "Unrelated", "poi" }, { 1432, 77, 66, "Destination 1499", "poi" } } } } })`);
  click(vm, 'WoWAINavigationRow1Navigate');
  assert.equal(vm.evaluate('WoWAIMapDB.nav.layer'), 'replacement');
  assert.equal(vm.evaluate('WoWAIMapDB.nav.index'), '2');
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.77);
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.y'), 0.66);
  vm.run('WoWAINavigationSearch:SetText("no such place")');
  assert.equal(vm.num('#WoWAINavigationPanel.filtered'), 0);
  assert.equal(vm.evaluate('WoWAINavigationPanel.rows[1].entry'), null);
  assert.equal(vm.evaluate('WoWAINavigationPanel.rows[1]:IsShown()'), 'false');
  assert.equal(vm.evaluate('WoWAIMapDB.nav.index'), '2', 'filtering cannot change the destination');
});

test('route point buttons start at the selected stop and native controls preserve player ownership', () => {
  const vm = newVM();
  vm.run(`C_Map.SetUserWaypoint(UiMapPoint.CreateFromCoordinates(1432, 0.12, 0.23))
    C_SuperTrack.SetSuperTrackedUserWaypoint(true)
    WoWAIMap.Sync(${LAYER}); WoWAIMap.ShowNavigation()`);
  click(vm, 'WoWAINavigationRow3Navigate');
  assert.equal(vm.evaluate('WoWAIMap.GetNavigationState().status'), 'native');
  assert.equal(vm.evaluate('WoWAIMapDB.nav.index'), '3');
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.55);
  click(vm, 'WoWAINavigationNext');
  assert.equal(vm.evaluate('WoWAIMapDB.nav.index'), '1', 'looping routes wrap');
  click(vm, 'WoWAINavigationPrevious');
  assert.equal(vm.evaluate('WoWAIMapDB.nav.index'), '3');
  click(vm, 'WoWAINavigationVisibility');
  assert.equal(vm.evaluate('WoWAIMapDB.hidden.mining'), 'true');
  assert.equal(vm.evaluate('WoWAIMapDB.nav.index'), '3', 'visibility does not stop navigation');
  click(vm, 'WoWAINavigationMap');
  assert.equal(vm.evaluate('WoWAIMapDB.hidden.mining'), null);
  assert.equal(vm.num('STUB.shownMap'), 1432);
  click(vm, 'WoWAINavigationRow1Visibility');
  assert.equal(vm.evaluate('WoWAIMapDB.hidden.mining'), 'true');
  click(vm, 'WoWAINavigationRow1Map');
  assert.equal(vm.evaluate('WoWAIMapDB.hidden.mining'), null);
  click(vm, 'WoWAINavigationStop');
  assert.equal(vm.evaluate('WoWAIMap.GetNavigationState().status'), 'idle');
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.12);
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.y'), 0.23);
  assert.equal(vm.evaluate('C_SuperTrack.IsSuperTrackingUserWaypoint()'), 'true');
});

test('router UI controls defer during combat, finish chosen unordered points, and respect replacement owners', () => {
  const vm = newVM();
  installRouter(vm);
  vm.run(`WoWAIMap.Sync(${LAYER}); WoWAIMap.ShowNavigation()
    STUB.combat = true
    function InCombatLockdown() return STUB.combat == true end`);
  click(vm, 'WoWAINavigationRow2Navigate');
  assert.equal(vm.evaluate('WoWAIMap.GetNavigationState().status'), 'pending');
  assert.equal(vm.evaluate('WoWAIMap.GetNavigationState().active.index'), '2');
  assert.equal(vm.evaluate('STUB.route'), null);
  assert.equal(vm.evaluate('C_Map.GetUserWaypoint()'), null);
  vm.run('STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  assert.equal(vm.evaluate('WoWAIMap.GetNavigationState().status'), 'route');
  assert.equal(vm.num('STUB.route.x'), 0.6);
  click(vm, 'WoWAINavigationPrevious');
  assert.equal(vm.num('STUB.route.x'), 0.5);
  click(vm, 'WoWAINavigationNext');
  assert.equal(vm.num('STUB.route.x'), 0.6);
  vm.run('STUB.route = { owner = "OtherAddon" }; STUB.routeEnded.WoWAI = "replaced"; STUB.Tick()');
  assert.equal(vm.evaluate('WoWAIMap.GetNavigationState().active'), null);
  assert.equal(vm.evaluate('WoWAINavigationStop:IsEnabled()'), 'false');
  vm.run('WoWAIMap.Stop()');
  assert.equal(vm.evaluate('STUB.route.owner'), 'OtherAddon', 'stop only cancels our route');
  vm.run(`STUB.route = nil
    WoWAIMap.Sync({ epoch = "collection", version = 1, layers = {
      { name = "places", title = "Places", loop = true, points = {
        { 1432, 20, 30, "First place", "poi" }, { 1432, 70, 80, "Second place", "poi" } } } } })`);
  click(vm, 'WoWAINavigationRow1Navigate');
  assert.equal(vm.num('STUB.route.x'), 0.2);
  vm.run('STUB.route = nil; STUB.routeEnded.WoWAI = "arrived"; STUB.Tick()');
  assert.equal(vm.evaluate('WoWAIMap.GetNavigationState().active'), null);
  assert.equal(vm.evaluate('STUB.route'), null, 'arrival must not turn an unordered collection into a route');
});

test('a deferred route yields when another owner starts tracking during combat', () => {
  const vm = newVM();
  installRouter(vm);
  vm.run(`WoWAIMap.Sync(${LAYER}); WoWAIMap.ShowNavigation()
    STUB.combat = true; function InCombatLockdown() return STUB.combat == true end`);
  click(vm, 'WoWAINavigationRow1Navigate');
  vm.run('STUB.route = { owner = "OtherAddon" }; STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  assert.equal(vm.evaluate('WoWAIMap.GetNavigationState().active'), null);
  assert.equal(vm.evaluate('STUB.route.owner'), 'OtherAddon');
});

test('active targets normalize on shrink and disappear on empty layers without canceling invalid choices', () => {
  const vm = newVM();
  vm.run(`WoWAIMap.Sync(${LAYER}); WoWAIMap.Navigate("mining", 3); WoWAIMap.ShowNavigation()
    local m = ${LAYER}; m.version = 2; table.remove(m.layers[1].points, 3); WoWAIMap.Sync(m)`);
  assert.equal(vm.evaluate('WoWAIMap.GetNavigationState().active.index'), '2');
  assert.equal(vm.evaluate('WoWAIMap.GetNavigationState().active.total'), '2');
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.6);
  assert.equal(vm.evaluate('WoWAIMap.Navigate("missing", 1)'), 'false');
  assert.equal(vm.evaluate('WoWAIMap.Navigate("mining", 99)'), 'false');
  assert.equal(vm.evaluate('WoWAIMap.GetNavigationState().active.index'), '2');
  vm.run(`WoWAIMap.Sync({ epoch = "e1", version = 3, layers = {
    { name = "empty", title = "Empty", points = {} },
    { name = "mining", title = "Copper loop", ordered = true, points = {} } } })`);
  assert.equal(vm.evaluate('WoWAIMap.GetNavigationState().active'), null);
  assert.equal(vm.evaluate('WoWAIMapDB.nav'), null);
  assert.equal(vm.evaluate('C_Map.GetUserWaypoint()'), null);
  assert.equal(vm.evaluate('WoWAIMap.Navigate("empty")'), 'false');
  assert.equal(vm.num('#WoWAINavigationPanel.filtered'), 0);
  assert.equal(vm.evaluate('WoWAINavigationPanel.empty:IsShown()'), 'true');
});

test('offline saved destinations remain directly usable and stopped state survives loading', () => {
  const vm = newVM(`WoWAIMapDB = { map = ${LAYER}, hidden = { mining = true } }`);
  vm.run('WoWAIMap.ShowNavigation(); STUB.Tick()');
  assert.equal(vm.evaluate('WoWAIMap.GetNavigationState().active'), null, 'opening saved data cannot auto-restart stopped tracking');
  assert.equal(vm.evaluate('WoWAIMapDB.hidden.mining'), 'true');
  click(vm, 'WoWAINavigationRow2Navigate');
  assert.equal(vm.evaluate('WoWAIMapDB.nav.index'), '2');
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.6);
  click(vm, 'WoWAINavigationStop');
  vm.run('STUB.Tick(); WoWAIMap.Sync(WoWAIMapDB.map)');
  assert.equal(vm.evaluate('WoWAIMapDB.nav'), null);
  assert.equal(vm.evaluate('WoWAIMap.GetNavigationState().active'), null);
});

test('empty and unavailable navigation expose honest state and allow retry without disturbing player tracking', () => {
  const vm = newVM();
  vm.run('WoWAIMap.ShowNavigation()');
  assert.equal(vm.evaluate('WoWAIMap.GetNavigationState().status'), 'idle');
  assert.equal(vm.num('#WoWAINavigationPanel.rows'), 0);
  assert.equal(vm.evaluate('WoWAINavigationStop:IsEnabled()'), 'false');
  assert.equal(vm.evaluate('WoWAINavigationNext:IsEnabled()'), 'false');
  assert.equal(vm.evaluate('WoWAINavigationMap:IsEnabled()'), 'false');
  vm.run(`C_Map.SetUserWaypoint(UiMapPoint.CreateFromCoordinates(1432, 0.12, 0.23))
    C_SuperTrack.SetSuperTrackedUserWaypoint(true)
    STUB.denyWaypoint = true; WoWAIMap.Sync(${LAYER})`);
  assert.equal(vm.evaluate('WoWAIMap.GetNavigationState().status'), 'unavailable');
  assert.equal(vm.evaluate('WoWAIMap.GetNavigationState().active'), null);
  assert.equal(vm.evaluate('WoWAIMap.GetNavigationState().message ~= ""'), 'true');
  assert.equal(vm.evaluate('WoWAINavigationStop:IsEnabled()'), 'false');
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.12);
  click(vm, 'WoWAINavigationRow2Navigate');
  assert.equal(vm.evaluate('WoWAIMap.GetNavigationState().status'), 'unavailable');
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.12);
  vm.run('STUB.denyWaypoint = false');
  click(vm, 'WoWAINavigationRow2Navigate');
  assert.equal(vm.evaluate('WoWAIMap.GetNavigationState().status'), 'native');
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.6);
  click(vm, 'WoWAINavigationStop');
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.12);
});

test('native arrival completes only the chosen unordered destination and stop respects a newer player pin', () => {
  const vm = newVM();
  vm.run(`WoWAIMap.Sync({ epoch = "places", version = 1, layers = {
    { name = "places", title = "Places", loop = true, points = {
      { 1432, 20, 30, "First place", "poi" }, { 1432, 70, 80, "Second place", "poi" } } } } })
    WoWAIMap.ShowNavigation()`);
  click(vm, 'WoWAINavigationRow1Navigate');
  vm.run('STUB.posX, STUB.posY = 0.2, 0.3; STUB.Tick()');
  assert.equal(vm.evaluate('WoWAIMap.GetNavigationState().active'), null);
  assert.equal(vm.evaluate('C_Map.GetUserWaypoint()'), null);
  click(vm, 'WoWAINavigationRow2Navigate');
  vm.run(`C_Map.SetUserWaypoint(UiMapPoint.CreateFromCoordinates(1432, 0.31, 0.41))
    C_SuperTrack.SetSuperTrackedUserWaypoint(true)`);
  click(vm, 'WoWAINavigationStop');
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.31);
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.y'), 0.41);
  assert.equal(vm.evaluate('C_SuperTrack.IsSuperTrackingUserWaypoint()'), 'true');
});

test('a serialized UI stop does not reactivate the saved route after reload', () => {
  const vm = newVM();
  vm.run(`WoWAIMap.Sync(${LAYER}); WoWAIMap.ShowNavigation()`);
  click(vm, 'WoWAINavigationStop');
  const reloaded = newVM(savedMap(vm));
  reloaded.run('WoWAIMap.ShowNavigation(); STUB.Tick(); WoWAIMap.Sync(WoWAIMapDB.map)');
  assert.equal(reloaded.evaluate('WoWAIMap.GetNavigationState().active'), null);
  assert.equal(reloaded.evaluate('C_Map.GetUserWaypoint()'), null);
  assert.equal(reloaded.evaluate('WoWAINavigationStop:IsEnabled()'), 'false');
  click(reloaded, 'WoWAINavigationRow2Navigate');
  assert.equal(reloaded.num('C_Map.GetUserWaypoint().position.x'), 0.6);
});

test('router rejection falls back honestly to native tracking or an unavailable state', () => {
  const vm = newVM();
  installRouter(vm);
  vm.run(`ShortestPathForever.API.Navigate = function() return false end
    WoWAIMap.Sync(${LAYER}); WoWAIMap.ShowNavigation()`);
  assert.equal(vm.evaluate('WoWAIMap.GetNavigationState().status'), 'native');
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.5);
  assert.equal(vm.evaluate('STUB.route'), null);
  click(vm, 'WoWAINavigationStop');
  vm.run('STUB.denyWaypoint = true');
  click(vm, 'WoWAINavigationRow3Navigate');
  assert.equal(vm.evaluate('WoWAIMap.GetNavigationState().status'), 'unavailable');
  assert.equal(vm.evaluate('WoWAIMap.GetNavigationState().active'), null);
  assert.equal(vm.evaluate('STUB.route'), null);
  assert.equal(vm.evaluate('C_Map.GetUserWaypoint()'), null);
});

test('adding points converts current position and map pins without altering tracking or sending a request', () => {
  const vm = newVM('STUB.playerMap = 1454; STUB.posX = 0.314159; STUB.posY = 0.271828');
  vm.run(`C_Map.SetUserWaypoint(UiMapPoint.CreateFromCoordinates(1432, 0.12, 0.23))
    C_SuperTrack.SetSuperTrackedUserWaypoint(true)
    WoWAIMap.Sync(${LAYER}); WoWAIMap.Navigate("mining", 2)
    WoWAI.Toggle(true); WoWAIInput:SetText("keep this draft")
    WoWAIMap.ShowNavigation()`);
  click(vm, 'WoWAINavigationAdd');
  vm.run('WoWAINavigationPointName:SetText("My mailbox"); WoWAINavigationPointMap:SetText("unknown")');
  click(vm, 'WoWAINavigationPointSave');
  assert.equal(vm.evaluate('WoWAINavigationPointEditor:IsShown()'), 'true');
  assert.equal(vm.num('#WoWAINavigationPanel.catalog'), 3);
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.6);
  assert.equal(vm.evaluate('WoWAINavigationPointEditor.error:GetText() ~= ""'), 'true');
  vm.run('WoWAINavigationPointMap:SetText("1454"); WoWAINavigationPointX:SetText("100.1")');
  click(vm, 'WoWAINavigationPointSave');
  assert.equal(vm.num('#WoWAINavigationPanel.catalog'), 3, 'out-of-map coordinates must not be saved');
  click(vm, 'WoWAINavigationPointCurrent');
  click(vm, 'WoWAINavigationPointSave');
  assert.equal(vm.evaluate('WoWAINavigationPointEditor:IsShown()'), 'false');
  assert.equal(vm.evaluate('STUB.focus'), null);
  vm.run('WoWAINavigationSearch:SetText("My mailbox")');
  assert.equal(vm.num('#WoWAINavigationPanel.filtered'), 1);
  assert.equal(vm.num('WoWAINavigationPanel.filtered[1].point[1]'), 1454);
  assert.equal(vm.num('WoWAINavigationPanel.filtered[1].point[2]'), 31.4159);
  assert.equal(vm.num('WoWAINavigationPanel.filtered[1].point[3]'), 27.1828);
  assert.equal(vm.evaluate('WoWAIMap.GetNavigationState().active.layer'), 'mining');
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.6, 'saving a point must not start or replace guidance');
  click(vm, 'WoWAINavigationStop');
  click(vm, 'WoWAINavigationAdd');
  vm.run('WoWAINavigationPointName:SetText("My map pin")');
  click(vm, 'WoWAINavigationPointPin');
  click(vm, 'WoWAINavigationPointSave');
  vm.run('WoWAINavigationSearch:SetText("My map pin")');
  assert.equal(vm.num('WoWAINavigationPanel.filtered[1].point[1]'), 1432);
  assert.equal(vm.num('WoWAINavigationPanel.filtered[1].point[2]'), 12);
  assert.equal(vm.num('WoWAINavigationPanel.filtered[1].point[3]'), 23);
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.12);
  assert.equal(vm.evaluate('WoWAIInput:GetText()'), 'keep this draft');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].pendingId'), null);
  assert.equal(vm.num('#WoWAIDB.chats[1].history'), 0);
  vm.run('WoWAIMap.Sync({ epoch = "e1", version = 2, layers = {} })');
  click(vm, 'WoWAINavigationAdd'); // the previously allocated route choice is now gone
  vm.run('WoWAINavigationPointName:SetText("Do not save")');
  click(vm, 'WoWAINavigationPointCancel');
  vm.run('WoWAINavigationSearch:SetText("")');
  assert.equal(vm.num('#WoWAINavigationPanel.catalog'), 2, 'cancel and bridge clearing must keep only the two local saves');
});

test('manually appended route stops retain their destination through source changes, clearing and reload', () => {
  const vm = newVM();
  vm.run(`WoWAIMap.Sync(${LAYER}); WoWAIMap.ShowNavigation()`);
  click(vm, 'WoWAINavigationAdd');
  click(vm, 'WoWAINavigationPointTarget2');
  vm.run(`WoWAINavigationPointName:SetText("Scenic stop")
    WoWAINavigationPointMap:SetText("1432")
    WoWAINavigationPointX:SetText("82"); WoWAINavigationPointY:SetText("92")`);
  click(vm, 'WoWAINavigationPointSave');
  vm.run('WoWAINavigationSearch:SetText("Scenic stop")');
  click(vm, 'WoWAINavigationRow1Navigate');
  assert.equal(vm.evaluate('WoWAIMap.GetNavigationState().active.layer'), 'mining');
  assert.equal(vm.num('WoWAIMap.GetNavigationState().active.index'), 4);
  vm.run(`local m = ${LAYER}; m.version = 2
    table.insert(m.layers[1].points, 2, { 1432, 17, 27, "New source stop", "poi" })
    WoWAIMap.Sync(m)`);
  assert.equal(vm.num('WoWAIMap.GetNavigationState().active.index'), 5);
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.82);
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.y'), 0.92);
  vm.run('WoWAIMap.Sync({ epoch = "e1", version = 3, layers = {} })');
  assert.equal(vm.num('WoWAIMap.GetNavigationState().active.index'), 1);
  assert.equal(vm.num('WoWAIMap.GetNavigationState().active.total'), 1);
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.82);
  click(vm, 'WoWAINavigationStop');
  const reloaded = newVM(savedMap(vm));
  reloaded.run('WoWAIMap.ShowNavigation(); WoWAINavigationSearch:SetText("Scenic stop")');
  assert.equal(reloaded.num('#WoWAINavigationPanel.filtered'), 1);
  click(reloaded, 'WoWAINavigationRow1Navigate');
  assert.equal(reloaded.num('C_Map.GetUserWaypoint().position.x'), 0.82);
  click(reloaded, 'WoWAINavigationRow1Delete');
  reloaded.run('StaticPopupDialogs.WOWAI_MAP_DELETE.OnAccept({}, STUB.popup.data)');
  assert.equal(reloaded.evaluate('WoWAIMap.GetNavigationState().active'), null);
  assert.equal(reloaded.evaluate('C_Map.GetUserWaypoint()'), null);
  assert.equal(reloaded.num('#WoWAINavigationPanel.filtered'), 0);
});

test('delete confirmation targets its original point after row recycling and refuses a replaced snapshot', () => {
  const vm = newVM();
  vm.run(`WoWAIMap.Sync(${LAYER}); WoWAIMap.Stop(); WoWAIMap.ShowNavigation()
    WoWAINavigationSearch:SetText("2. Copper")`);
  click(vm, 'WoWAINavigationRow1Delete');
  assert.equal(vm.num('#WoWAIMap.GetNavigationState().layers[1].points'), 3, 'confirmation must not delete immediately');
  vm.run('WoWAINavigationSearch:SetText("3. Tin")');
  click(vm, 'WoWAINavigationRow1Navigate');
  vm.run('StaticPopupDialogs.WOWAI_MAP_DELETE.OnAccept({}, STUB.popup.data)');
  assert.equal(vm.num('#WoWAIMap.GetNavigationState().layers[1].points'), 2);
  assert.equal(vm.num('WoWAIMap.GetNavigationState().active.index'), 2);
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.55, 'deleting an earlier point must retain the current destination');
  click(vm, 'WoWAINavigationRow1Delete');
  vm.run(`local m = ${LAYER}; m.version = 2
    m.layers[1].points[3] = { 1432, 77, 66, "Replacement", "poi" }
    WoWAIMap.Sync(m)
    StaticPopupDialogs.WOWAI_MAP_DELETE.OnAccept({}, STUB.popup.data)
    WoWAINavigationSearch:SetText("Replacement")`);
  assert.equal(vm.num('#WoWAIMap.GetNavigationState().layers[1].points'), 2, 'stale confirmation must not delete the replacement');
  assert.equal(vm.num('#WoWAINavigationPanel.filtered'), 1);
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.77);
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.y'), 0.66);
  vm.run('WoWAINavigationSearch:SetText("2. Copper")');
  assert.equal(vm.num('#WoWAINavigationPanel.filtered'), 0, 'source updates must not resurrect the earlier deletion');
});

test('deleting a repeated route stop preserves its other occurrence across bridge epochs and reload', () => {
  const source = `{ epoch = "repeat", version = 1, layers = {
    { name = "loop", title = "Repeated crossing", ordered = true, loop = true, points = {
      { 1432, 10, 20, "Crossing", "poi" }, { 1432, 30, 40, "Middle", "poi" },
      { 1432, 10, 20, "Crossing", "poi" }, { 1432, 70, 80, "Finish", "poi" } } } } }`;
  const vm = newVM();
  vm.run(`WoWAIMap.Sync(${source}); WoWAIMap.Navigate("loop", 4); WoWAIMap.ShowNavigation()`);
  click(vm, 'WoWAINavigationRow3Delete');
  vm.run('StaticPopupDialogs.WOWAI_MAP_DELETE.OnAccept({}, STUB.popup.data)');
  assert.equal(vm.num('WoWAIMap.GetNavigationState().active.index'), 3);
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.7);
  vm.run(`local m = ${source}; m.epoch = "new-process"; m.layers[1].title = "Updated crossing"
    WoWAIMap.Sync(m); WoWAIMap.Stop()`);
  const reloaded = newVM(savedMap(vm));
  reloaded.run(`WoWAIMap.Sync(${source}); WoWAIMap.ShowNavigation()`);
  assert.equal(reloaded.num('#WoWAIMap.GetNavigationState().layers[1].points'), 3);
  click(reloaded, 'WoWAINavigationRow1Navigate');
  assert.equal(reloaded.num('C_Map.GetUserWaypoint().position.x'), 0.1);
  click(reloaded, 'WoWAINavigationNext');
  assert.equal(reloaded.num('C_Map.GetUserWaypoint().position.x'), 0.3);
  click(reloaded, 'WoWAINavigationNext');
  assert.equal(reloaded.num('C_Map.GetUserWaypoint().position.x'), 0.7);
});

test('deleting active points releases only owned waypoints and dotted routes', () => {
  const vm = newVM();
  vm.run(`C_Map.SetUserWaypoint(UiMapPoint.CreateFromCoordinates(1432, 0.12, 0.23))
    C_SuperTrack.SetSuperTrackedUserWaypoint(true)
    WoWAIMap.Sync(${LAYER}); WoWAIMap.ShowNavigation()`);
  click(vm, 'WoWAINavigationRow1Delete');
  vm.run('StaticPopupDialogs.WOWAI_MAP_DELETE.OnAccept({}, STUB.popup.data)');
  assert.equal(vm.evaluate('WoWAIMap.GetNavigationState().active'), null);
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.12);
  click(vm, 'WoWAINavigationRow1Navigate');
  vm.run(`C_Map.SetUserWaypoint(UiMapPoint.CreateFromCoordinates(1432, 0.33, 0.44))
    C_SuperTrack.SetSuperTrackedUserWaypoint(true)`);
  click(vm, 'WoWAINavigationRow1Delete');
  vm.run('StaticPopupDialogs.WOWAI_MAP_DELETE.OnAccept({}, STUB.popup.data)');
  assert.equal(vm.evaluate('WoWAIMap.GetNavigationState().active'), null);
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.33);
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.y'), 0.44);
  const routed = newVM();
  installRouter(routed);
  routed.run(`WoWAIMap.Sync(${LAYER}); WoWAIMap.ShowNavigation(); STUB.route = { owner = "OtherAddon" }`);
  click(routed, 'WoWAINavigationRow1Delete');
  routed.run('StaticPopupDialogs.WOWAI_MAP_DELETE.OnAccept({}, STUB.popup.data)');
  assert.equal(routed.evaluate('WoWAIMap.GetNavigationState().active'), null);
  assert.equal(routed.evaluate('STUB.route.owner'), 'OtherAddon');
});
