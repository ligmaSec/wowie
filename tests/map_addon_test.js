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
  for (const f of ['Codec.lua', 'Inbox.lua', 'WoWAI.lua', 'Map.lua']) run(fs.readFileSync(path.join(ADDON, f), 'utf8'), 'WoWAI');
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
  // The game context reads professions from the same API.
  assert.match(vm.evaluate('WoWAI.GameContext()'), /Professions: Bergbau 50\/75(\n|$)/);
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
