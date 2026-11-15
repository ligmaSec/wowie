// Runs the real Map.lua (with Wowie.lua) in a Lua VM: syncing layers from the
// bridge, drawing pins on the world map, native waypoint ownership and route
// progression, optional dotted routing, gathering nodes, and /wowie map.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const ADDON = path.join(__dirname, '..', 'addon', 'Wowie');

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
function WorldMapFrame:PanAndZoomTo(x, y) STUB.mapFocus = { map = self:GetMapID(), x = x, y = y } end
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
function Methods.SetFrameStrata(self, strata) self.strata = strata end
function Methods.StartMoving(self) self.moving = true end
function Methods.StopMovingOrSizing(self) self.moving = false end
local setPoint = Methods.SetPoint
function Methods.SetPoint(self, point, relative, relativePoint, x, y)
  if type(relative) == "number" then
    x, y, relative, relativePoint = relative, relativePoint, self.parent, point
  end
  self.anchors = self.anchors or {}
  self.anchors[point] = { relative or self.parent or UIParent, relativePoint or point, x or 0, y or 0 }
  setPoint(self, point, relative, relativePoint, x, y)
end
function Methods.ClearAllPoints(self) self.anchors = {} end
local fractions = {
  TOPLEFT = {0, 0}, TOP = {.5, 0}, TOPRIGHT = {1, 0},
  LEFT = {0, .5}, CENTER = {.5, .5}, RIGHT = {1, .5},
  BOTTOMLEFT = {0, 1}, BOTTOM = {.5, 1}, BOTTOMRIGHT = {1, 1},
}
function Bounds(frame)
  if frame == UIParent then return { x = 0, y = 0, w = frame:GetWidth(), h = frame:GetHeight() } end
  local axes = { {}, {} }
  for point, anchor in pairs(frame.anchors or {}) do
    local r, f, rf = Bounds(anchor[1]), fractions[point], fractions[anchor[2]]
    axes[1][#axes[1] + 1] = { f[1], r.x + rf[1] * r.w + anchor[3] }
    axes[2][#axes[2] + 1] = { f[2], r.y + rf[2] * r.h - anchor[4] }
  end
  local result = {}
  for axis, anchors in ipairs(axes) do
    local size = axis == 1 and frame:GetWidth() or frame:GetHeight()
    for _, a in ipairs(anchors) do
      for _, b in ipairs(anchors) do
        if a[1] ~= b[1] then size = (b[2] - a[2]) / (b[1] - a[1]) end
      end
    end
    result[axis == 1 and "w" or "h"] = size
    result[axis == 1 and "x" or "y"] = anchors[1] and anchors[1][2] - anchors[1][1] * size or 0
  end
  return result
end
function Disjoint(a, b)
  a, b = Bounds(a), Bounds(b)
  return a.x + a.w <= b.x or b.x + b.w <= a.x or a.y + a.h <= b.y or b.y + b.h <= a.y
end
function Inside(child, parent)
  local c, p = Bounds(child), Bounds(parent)
  return c.x >= p.x and c.y >= p.y and c.x + c.w <= p.x + p.w and c.y + c.h <= p.y + p.h
end
local showPopup = StaticPopup_Show
function StaticPopup_Show(which, text, second, data)
  local popup = showPopup(which, text, second, data)
  STUB.popup.text = text
  return popup
end
`;
  stub = stub.replace('local function NewObject(', 'function NewObjectPublic(').replace(/NewObject\(/g, 'NewObjectPublic(');
  run(stub);
  run(MAP_STUB);
  if (initialState) run(initialState);
  for (const f of ['Codec.lua', 'Inbox.lua', 'Wowie.lua', 'ReplyView.lua', 'Context.lua', 'ContextUI.lua', 'Map.lua']) run(fs.readFileSync(path.join(ADDON, f), 'utf8'), 'Wowie');
  run('STUB.FireEvent("ADDON_LOADED", "Wowie"); STUB.FireEvent("PLAYER_LOGIN")');
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
  vm.run(`WowieMap.Sync(${LAYER})`);
  assert.equal(vm.evaluate('WowieMapDB.map.version'), '1');
  assert.equal(vm.evaluate('WowieMapDB.nav.layer'), 'mining');
  assert.equal(vm.evaluate('WowieMapDB.nav.index'), '1');
  const prints = () => vm.num('#STUB.prints');
  const before = prints();
  vm.run(`WowieMap.Sync(${LAYER})`); // same version: nothing
  assert.equal(prints(), before);
  vm.run(`WowieMap.Sync({ epoch = "e1", version = 0, layers = {} })`); // older: ignored
  assert.equal(vm.num('#WowieMapDB.map.layers'), 1);
  // A new epoch (bridge state reset) replaces, even with a lower version; same content stays quiet.
  vm.run(`local m = ${LAYER}; m.epoch = "e2"; WowieMap.Sync(m)`);
  assert.equal(vm.evaluate('WowieMapDB.map.epoch'), 'e2');
  assert.equal(prints(), before);
  vm.run(`WowieMap.Sync({ epoch = "e2", version = 5, layers = {} })`);
  assert.equal(vm.num('#WowieMapDB.map.layers'), 0);
  assert.equal(vm.evaluate('WowieMapDB.nav'), null);
});

test('a new route does not take over a route the player is already following', () => {
  const vm = newVM();
  vm.run(`WowieMap.Sync(${LAYER})`);
  vm.run('SlashCmdList.WOWIEMAP("nav mining 2")');
  vm.run(`local m = ${LAYER}; m.version = 2; m.layers[2] = { name = "quests", title = "Westfall", ordered = true, loop = false,
    points = { { 1432, 10, 10, "1. Talk", "quest" }, { 1432, 20, 20, "2. Kill", "kill" } } }; WowieMap.Sync(m)`);
  assert.equal(vm.evaluate('WowieMapDB.nav.layer'), 'mining');
  assert.equal(vm.evaluate('WowieMapDB.nav.index'), '2');
  // With nothing being followed, the next route starts by itself.
  vm.run('SlashCmdList.WOWIEMAP("stop")');
  vm.run(`local m = ${LAYER}; m.version = 3; m.layers[1].points[1][4] = "1. Rich Copper"; WowieMap.Sync(m)`);
  assert.equal(vm.evaluate('WowieMapDB.nav.layer'), 'mining');
  assert.equal(vm.evaluate('WowieMapDB.nav.index'), '1');
});

test('a single destination outside the city starts navigation with the world map closed', () => {
  const vm = newVM();
  vm.run(`
    STUB.playerMap, STUB.shownMap = 1454, 1454
    STUB.posX, STUB.posY = 0.5, 0.5
    WorldMapFrame:Hide()
    WowieMap.Sync({ epoch = "single", version = 1, layers = {
      { name = "nearby-copper", title = "Nearby Copper", ordered = false, loop = false,
        points = { { 1411, 52.7, 18.2, "Copper Vein area", "ore" } } }
    } })
  `);
  assert.equal(vm.evaluate('WowieMapDB.nav.layer'), 'nearby-copper');
  // The point is outside Orgrimmar: it belongs on Durotar, not the city map.
  vm.run('WorldMapFrame:Show(); WowieMap.Refresh()');
  assert.deepEqual(shownPins(vm), []);
  vm.run('STUB.shownMap = 1411; WowieMap.Refresh()');
  assert.deepEqual(shownPins(vm), ['527,127,,Nearby Copper']);
  vm.run('SlashCmdList.WOWIEMAP("stop"); WowieMap.Sync(WowieMapDB.map)');
  assert.equal(vm.evaluate('WowieMapDB.nav'), null, 'a repeated snapshot must not undo a manual stop');
});

test('single destination auto-navigation respects an active route and continent boundaries', () => {
  const vm = newVM();
  vm.run(`WowieMap.Sync(${LAYER}); WowieMap.Navigate("mining", 2)`);
  vm.run(`local m = ${LAYER}; m.version = 2
    m.layers[2] = { name = "destination", title = "Copper", ordered = false, loop = false,
      points = { { 1432, 20, 20, "Copper", "ore" } } }
    WowieMap.Sync(m)`);
  assert.equal(vm.evaluate('WowieMapDB.nav.layer'), 'mining');
  assert.equal(vm.evaluate('WowieMapDB.nav.index'), '2', 'a new destination cannot interrupt the current route');
  vm.run(`WowieMap.Stop()
    WowieMap.Sync({ epoch = "single", version = 1, layers = {
      { name = "far-away", title = "Durotar copper", ordered = false, loop = false,
        points = { { 1411, 52.7, 18.2, "Copper", "ore" } } }
    } })`);
  assert.equal(vm.evaluate('WowieMapDB.nav'), null, 'a point on another continent must not start local navigation');
});

test('unordered collections remain world-map pins without choosing an arbitrary navigation target', () => {
  const vm = newVM();
  vm.run(`WowieMap.Sync({ epoch = "pois", version = 1, layers = {
    { name = "vendors", title = "Vendors", ordered = false, loop = false,
      points = { { 1432, 20, 20, "First vendor", "vendor" }, { 1432, 80, 80, "Second vendor", "vendor" } } }
  } })`);
  assert.equal(vm.evaluate('WowieMapDB.nav'), null);
  assert.deepEqual(shownPins(vm), ['200,140,,Vendors', '800,560,,Vendors']);
});

test('slot data carrying a map reaches the map module', () => {
  const vm = newVM();
  vm.run(`Wowie_Inbox = { replies = {}, map = ${LAYER} }; STUB.FireEvent("PLAYER_LOGIN")`);
  assert.equal(vm.evaluate('WowieMapDB.map.layers[1].title'), 'Copper loop');
});

test('pins land where the points are, on the zone map and on the continent', () => {
  const vm = newVM();
  vm.run(`WowieMap.Sync(${LAYER})`);
  vm.run('WowieMap.Refresh()');
  let pins = shownPins(vm);
  assert.deepEqual(pins, ['500,280,1,Copper loop', '600,350,2,Copper loop', '550,490,3,Copper loop']);
  vm.run('STUB.shownMap = 1415; WowieMap.Refresh()');
  pins = shownPins(vm);
  // 1432 (50,40) -> 1415 (0.55, 0.44) on a 1000x700 canvas.
  assert.equal(pins[0], '550,308,1,Copper loop');
  vm.run('STUB.shownMap = 947; WowieMap.Refresh()'); // no rect: nothing drawn
  assert.deepEqual(shownPins(vm), []);
});

test('native waypoints advance on arrival and restore the previous player pin when a route finishes', () => {
  const vm = newVM();
  vm.run(`
    C_Map.SetUserWaypoint(UiMapPoint.CreateFromCoordinates(1432, 0.1, 0.2))
    C_SuperTrack.SetSuperTrackedUserWaypoint(true)
    local m = ${LAYER}; m.layers[1].loop = false; WowieMap.Sync(m)
    STUB.posX, STUB.posY = 0.5, 0.4
    STUB.Tick()
  `);
  assert.equal(vm.evaluate('WowieMapDB.nav.index'), '2');
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.6);
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.y'), 0.5);
  vm.run('STUB.posX, STUB.posY = 0.6, 0.5; STUB.Tick()');
  assert.equal(vm.evaluate('WowieMapDB.nav.index'), '3');
  vm.run('STUB.posX, STUB.posY = 0.55, 0.7; STUB.Tick()');
  assert.equal(vm.evaluate('WowieMapDB.nav'), null);
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.1);
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.y'), 0.2);
  assert.equal(vm.evaluate('C_SuperTrack.IsSuperTrackingUserWaypoint()'), 'true');
});

test('a player-selected pin or quest takes priority over addon tracking', () => {
  const vm = newVM();
  vm.run(`WowieMap.Sync(${LAYER})
    C_Map.SetUserWaypoint(UiMapPoint.CreateFromCoordinates(1432, 0.15, 0.25))
    STUB.Tick()`);
  assert.equal(vm.evaluate('WowieMapDB.nav'), null);
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.15, 'the player pin must not be cleared or overwritten');
  vm.run('WowieMap.Navigate("mining"); C_SuperTrack.SetSuperTrackedQuestID(123); STUB.Tick()');
  assert.equal(vm.evaluate('WowieMapDB.nav'), null);
  assert.equal(vm.num('C_SuperTrack.GetSuperTrackedQuestID()'), 123);
  assert.equal(vm.evaluate('C_SuperTrack.IsSuperTrackingUserWaypoint()'), 'false', 'stopping must not steal tracking back from the selected quest');
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.15, 'the prior player pin is restored without tracking it');
});

test('native waypoint ownership survives reload without treating the addon pin as a prior player pin', () => {
  const vm = newVM();
  vm.run(`C_Map.SetUserWaypoint(UiMapPoint.CreateFromCoordinates(1432, 0.15, 0.25))
    C_SuperTrack.SetSuperTrackedUserWaypoint(true)
    WowieMap.Sync(${LAYER})
    local function Dump(v)
      if type(v) == "table" then
        local rows = {}
        for k, value in pairs(v) do rows[#rows + 1] = "[" .. Dump(k) .. "]=" .. Dump(value) end
        return "{" .. table.concat(rows, ",") .. "}"
      elseif type(v) == "string" then return string.format("%q", v)
      else return tostring(v) end
    end
    SAVED = Dump({ db = WowieMapDB, waypoint = C_Map.GetUserWaypoint() })`);
  const reloaded = newVM(`local saved = ${vm.evaluate('SAVED')}; WowieMapDB = saved.db
    C_Map.SetUserWaypoint(saved.waypoint); C_SuperTrack.SetSuperTrackedUserWaypoint(true)`);
  reloaded.run('WowieMap.UpdateNavigator(); WowieMap.Stop()');
  assert.equal(reloaded.num('C_Map.GetUserWaypoint().position.x'), 0.15);
  assert.equal(reloaded.num('C_Map.GetUserWaypoint().position.y'), 0.25);
});

function installRouter(vm, version = 1) {
  vm.run(`
    STUB.routeEnded = {}
    ShortestPathForever = { API = {
      version = ${version},
      Navigate = function(owner, map, x, y, title, kind)
        if InCombatLockdown() then return false end
        STUB.routeEnded[owner] = nil
        STUB.route = { owner = owner, map = map, x = x, y = y, title = title, kind = kind }
        return true
      end,
      CurrentStop = function(owner)
        if STUB.route and STUB.route.owner == owner then return 1 end
        return nil, ${version === 2 ? '"none"' : 'nil'}
      end,
      Ended = function(owner)
        if STUB.routeEnded[owner] then return STUB.routeEnded[owner], GetTime() end
        return nil, ${version === 2 ? '"none"' : 'nil'}
      end,
      Active = function() return STUB.route ~= nil end,
      Cancel = function(owner)
        if not STUB.route or STUB.route.owner ~= owner then return false end
        STUB.route = nil; STUB.routeEnded[owner] = "cancelled"; return true
      end,
    } }
  `);
}

test('Navigate uses installed ShortestPathForever v2 instead of silently falling back to a native pin', () => {
  const vm = newVM();
  vm.run(`WowieMap.Sync(${LAYER}); WowieMap.ShowNavigation()`);
  assert.equal(vm.evaluate('WowieMap.GetNavigationState().status'), 'native');
  installRouter(vm, 2);
  click(vm, 'WowieNavigationRow2Navigate');
  assert.equal(vm.evaluate('WowieMap.GetNavigationState().status'), 'route');
  assert.equal(vm.evaluate('STUB.route.owner'), 'Wowie');
  assert.equal(vm.num('STUB.route.map'), 1432);
  assert.equal(vm.num('STUB.route.x'), 0.6);
  assert.equal(vm.num('STUB.route.y'), 0.5);
  assert.equal(vm.evaluate('WowieMapDB.waypoint'), null, 'native fallback must not compete with the dotted route');
  assert.equal(vm.evaluate('C_Map.GetUserWaypoint()'), null);
  assert.equal(vm.evaluate('WowieMap.GetNavigationState().message'), '');
  vm.run('STUB.route=nil; STUB.routeEnded.Wowie="arrived"; WowieMap.UpdateNavigator()');
  assert.equal(vm.num('WowieMap.GetNavigationState().active.index'), 3);
  assert.equal(vm.num('STUB.route.x'), 0.55);
  click(vm, 'WowieNavigationStop');
  assert.equal(vm.evaluate('STUB.route'), null);
  assert.equal(vm.evaluate('WowieMap.GetNavigationState().active'), null);
  click(vm, 'WowieNavigationRow1Navigate');
  vm.run('STUB.route={owner="OtherAddon"}; STUB.routeEnded.Wowie="replaced"; WowieMap.UpdateNavigator()');
  assert.equal(vm.evaluate('WowieMap.GetNavigationState().active'), null);
  assert.equal(vm.evaluate('STUB.route.owner'), 'OtherAddon', 'v2 cancellation cannot erase another addon route');
});

test('v2 navigation selected in combat waits and then starts the requested dotted route', () => {
  const vm = newVM();
  installRouter(vm, 2);
  vm.run(`WowieMap.Sync(${LAYER}); WowieMap.Stop(); WowieMap.ShowNavigation()
    STUB.combat=true; function InCombatLockdown() return STUB.combat end`);
  click(vm, 'WowieNavigationRow3Navigate');
  assert.equal(vm.evaluate('WowieMap.GetNavigationState().status'), 'pending');
  assert.equal(vm.evaluate('STUB.route'), null);
  assert.equal(vm.evaluate('C_Map.GetUserWaypoint()'), null);
  vm.run('STUB.combat=false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  assert.equal(vm.evaluate('WowieMap.GetNavigationState().status'), 'route');
  assert.equal(vm.num('STUB.route.x'), 0.55);
});

for (const failure of ['unsupported', 'incomplete', 'declined']) {
test(`waypoint-only fallback reports ${failure} routing rather than implying dotted guidance`, () => {
  const vm = newVM();
  installRouter(vm, failure === 'unsupported' ? 999 : 2);
  if (failure === 'incomplete') vm.run('ShortestPathForever.API.Navigate=nil');
  if (failure === 'declined') vm.run('ShortestPathForever.API.Navigate=function() return false end');
  vm.run(`WowieMap.Sync(${LAYER}); WowieMap.ShowNavigation()`);
  click(vm, 'WowieNavigationRow2Navigate');
  assert.equal(vm.evaluate('WowieMap.GetNavigationState().status'), 'native');
  assert.equal(vm.evaluate('STUB.route'), null);
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.6);
  const reason = vm.evaluate('WowieMap.GetNavigationState().message');
  assert.match(reason, new RegExp(failure, 'i'));
  assert.ok(vm.evaluate('WowieNavigationActive.status:GetText()').includes(reason), 'the panel exposes the routing limitation');
});
}

test('dotted routing drives arrival, advances the active stop, and yields to another route owner', () => {
  const vm = newVM();
  installRouter(vm);
  vm.run(`WowieMap.Sync(${LAYER})
    STUB.posX, STUB.posY = 0.5, 0.4; STUB.Tick()`);
  assert.equal(vm.evaluate('WowieMapDB.nav.index'), '1', 'straight-line proximity must not skip a routed stop');
  vm.run('STUB.route = nil; STUB.routeEnded.Wowie = "arrived"; STUB.Tick()');
  assert.equal(vm.evaluate('WowieMapDB.nav.index'), '2');
  assert.equal(vm.evaluate('STUB.route.owner'), 'Wowie');
  vm.run(`STUB.route = { owner = "OtherAddon" }; STUB.routeEnded.Wowie = "replaced"
    local m = ${LAYER}; m.version = 2; m.layers[1].points[2][2] = 65; WowieMap.Sync(m)`);
  assert.equal(vm.evaluate('WowieMapDB.nav'), null, 'a layer update must not retake a route that another addon owns');
  assert.equal(vm.evaluate('STUB.route.owner'), 'OtherAddon');
});

test('automatic tracking leaves another dotted route alone and defers owned routing during combat', () => {
  const vm = newVM();
  installRouter(vm);
  vm.run(`STUB.route = { owner = "OtherAddon" }; WowieMap.Sync(${LAYER})`);
  assert.equal(vm.evaluate('WowieMapDB.nav'), null);
  assert.equal(vm.evaluate('STUB.route.owner'), 'OtherAddon');
  vm.run(`STUB.route = nil; STUB.combat = true
    function InCombatLockdown() return STUB.combat end
    WowieMap.Navigate("mining"); STUB.Tick()`);
  assert.equal(vm.evaluate('STUB.route'), null);
  assert.equal(vm.evaluate('C_Map.GetUserWaypoint()'), null, 'combat must not leave a competing native waypoint');
  vm.run('STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  assert.equal(vm.evaluate('STUB.route.owner'), 'Wowie');
  vm.run('WowieMap.Stop()');
  assert.equal(vm.evaluate('STUB.route'), null);
});

test('a rejected waypoint leaves player tracking intact instead of claiming active navigation', () => {
  const vm = newVM();
  vm.run(`C_Map.SetUserWaypoint(UiMapPoint.CreateFromCoordinates(1432, 0.15, 0.25))
    C_SuperTrack.SetSuperTrackedUserWaypoint(true); STUB.denyWaypoint = true
    WowieMap.Sync(${LAYER})`);
  assert.equal(vm.evaluate('WowieMapDB.nav'), null);
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.15);
  assert.equal(vm.evaluate('C_SuperTrack.IsSuperTrackingUserWaypoint()'), 'true');
});

test('herb/ore nodes toggle and follow the gathering skill', () => {
  const vm = newVM();
  vm.run(`WowieNodes = { kinds = { { "Copper Vein", "mining", 1 }, { "Tin Vein", "mining", 65 }, { "Peacebloom", "herbalism", 1 } },
    maps = { [1432] = { [1] = "100200300400", [2] = "500500", [3] = "999999" } } }`);
  vm.run('WowieMap.Refresh()');
  assert.equal(shownPins(vm).length, 0, 'off by default');
  vm.run('SlashCmdList.WOWIEMAP("ore on")');
  // No Mining skill line in the stub: every ore shows, flagged as not learned.
  assert.deepEqual(shownPins(vm).map(p => p.split(',').slice(0, 2).join(',') + ',' + p.split(',')[3]), ['100,140,Copper Vein', '300,280,Copper Vein', '500,350,Tin Vein']);
  // With Mining 50 (Forever's C_SkillInfo: one table per line), Tin (65) is filtered out until "filter all".
  // Forever also lists child lines (parentSkillLineID ~= 0) that repeat the parent.
  vm.run(`C_SkillInfo = { GetNumSkillLines = function() return 3 end, GetSkillLineInfo = function(i)
    if i == 1 then return { name = "Professions", isHeader = true, rank = 0, maxRank = 0, skillID = 0, parentSkillLineID = 0 } end
    if i == 3 then return { name = "Bergbau", isHeader = false, rank = 50, maxRank = 75, skillID = 2572, parentSkillLineID = 186 } end
    return { name = "Bergbau", isHeader = false, rank = 50, maxRank = 75, skillID = 186, parentSkillLineID = 0 } end }
    WowieMap.Refresh()`);
  assert.equal(shownPins(vm).length, 2);
  vm.run('SlashCmdList.WOWIEMAP("filter all")');
  assert.equal(shownPins(vm).length, 3);
  vm.run('SlashCmdList.WOWIEMAP("herb on")');
  assert.equal(shownPins(vm).length, 4);
  vm.run('SlashCmdList.WOWIEMAP("ore off"); SlashCmdList.WOWIEMAP("herb off")');
  assert.equal(shownPins(vm).length, 0);
});

test('/wowie map hide, show, nav and stop', () => {
  const vm = newVM();
  vm.run(`WowieMap.Sync(${LAYER})`);
  vm.run('SlashCmdList.WOWIEMAP("hide mining")');
  assert.equal(shownPins(vm).length, 0);
  vm.run('SlashCmdList.WOWIEMAP("show mining")');
  assert.equal(shownPins(vm).length, 3);
  vm.run('SlashCmdList.WOWIEMAP("nav mining 3")');
  assert.equal(vm.evaluate('WowieMapDB.nav.index'), '3');
  vm.run('SlashCmdList.WOWIEMAP("stop")');
  assert.equal(vm.evaluate('WowieMapDB.nav'), null);
  assert.equal(vm.evaluate('C_Map.GetUserWaypoint()'), null);
  vm.run('SlashCmdList.WOWIEMAP("")'); // status never errors
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
  SAVED = Dump(WowieMapDB)`);
  return `WowieMapDB = ${vm.evaluate('SAVED')}`;
}

test('navigation snapshots are cached and changes notify the workspace with the world map closed', () => {
  const vm = newVM();
  vm.run(`WorldMapFrame:Hide()
    local update = Wowie.UpdateNavigation
    Wowie.UpdateNavigation = function()
      STUB.navigationUpdates = (STUB.navigationUpdates or 0) + 1
      if update then update() end
    end
    WowieMap.Sync(${LAYER})
    FIRST = WowieMap.GetNavigationState()
    FIRST_REVISION = FIRST.revision
    FIRST_UPDATES = STUB.navigationUpdates
    WowieMap.UpdateNavigator(); WowieMap.UpdateNavigator()`);
  assert.equal(vm.evaluate('FIRST == WowieMap.GetNavigationState()'), 'true');
  assert.equal(vm.evaluate('FIRST.layers == WowieMapDB.map.layers'), 'true');
  assert.equal(vm.evaluate('FIRST.active.point == WowieMapDB.map.layers[1].points[1]'), 'true');
  assert.equal(vm.evaluate('STUB.navigationUpdates == FIRST_UPDATES'), 'true');
  vm.run('WowieMap.ShowNavigation()');
  assert.equal(vm.evaluate('STUB.focus'), null, 'opening the browser must not take keyboard focus');
  click(vm, 'WowieNavigationNext');
  assert.equal(vm.evaluate('WowieMap.GetNavigationState().active.index'), '2');
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.6);
  assert.equal(vm.evaluate('WowieMap.GetNavigationState().revision > FIRST_REVISION'), 'true');
  assert.equal(vm.evaluate('STUB.navigationUpdates > FIRST_UPDATES'), 'true');
  assert.equal(vm.evaluate('WorldMapFrame:IsShown()'), 'false');
  click(vm, 'WowieNavigationPrevious');
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.5);
});

test('virtual destination buttons resolve rebound rows after scroll, filter and map replacement', () => {
  const vm = newVM();
  vm.run(`local points = {}
    for i = 1, 1500 do points[i] = { 1432, 10 + i % 80, 90, string.format("Destination %04d", i), "poi" } end
    WowieMap.Sync({ epoch = "large", version = 1, layers = {
      { name = "internal-collection", title = "Saved places", points = points } } })
    WowieMap.ShowNavigation()
    FIRST_ROW = WowieNavigationPanel.rows[1]
    WowieNavigationScroll:SetVerticalScroll(999 * 124)`);
  assert.equal(vm.evaluate('WowieMapDB.nav'), null, 'browsing does not activate an unordered collection');
  assert.ok(vm.num('#WowieNavigationPanel.rows') < 20, 'only viewport-sized rows are allocated');
  assert.equal(vm.evaluate('WowieNavigationPanel.rows[1] == FIRST_ROW'), 'true');
  click(vm, 'WowieNavigationRow1Navigate');
  assert.equal(vm.evaluate('WowieMapDB.nav.index'), '1000');
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.5);
  vm.run('WowieNavigationSearch:SetText("Destination 1499")');
  assert.equal(vm.num('WowieNavigationScroll:GetVerticalScroll()'), 0);
  click(vm, 'WowieNavigationRow1Navigate');
  assert.equal(vm.evaluate('WowieMapDB.nav.index'), '1499');
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.69);
  vm.run(`WowieMap.Sync({ epoch = "large", version = 2, layers = {
    { name = "replacement", title = "Replacement collection", points = {
      { 1432, 22, 33, "Unrelated", "poi" }, { 1432, 77, 66, "Destination 1499", "poi" } } } } })`);
  click(vm, 'WowieNavigationRow1Navigate');
  assert.equal(vm.evaluate('WowieMapDB.nav.layer'), 'replacement');
  assert.equal(vm.evaluate('WowieMapDB.nav.index'), '2');
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.77);
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.y'), 0.66);
  vm.run('WowieNavigationSearch:SetText("no such place")');
  assert.equal(vm.num('#WowieNavigationPanel.filtered'), 0);
  assert.equal(vm.evaluate('WowieNavigationPanel.rows[1].entry'), null);
  assert.equal(vm.evaluate('WowieNavigationPanel.rows[1]:IsShown()'), 'false');
  assert.equal(vm.evaluate('WowieMapDB.nav.index'), '2', 'filtering cannot change the destination');
});

test('route point buttons start at the selected stop and native controls preserve player ownership', () => {
  const vm = newVM();
  vm.run(`C_Map.SetUserWaypoint(UiMapPoint.CreateFromCoordinates(1432, 0.12, 0.23))
    C_SuperTrack.SetSuperTrackedUserWaypoint(true)
    WowieMap.Sync(${LAYER}); WowieMap.ShowNavigation()`);
  click(vm, 'WowieNavigationRow3Navigate');
  assert.equal(vm.evaluate('WowieMap.GetNavigationState().status'), 'native');
  assert.equal(vm.evaluate('WowieMapDB.nav.index'), '3');
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.55);
  click(vm, 'WowieNavigationNext');
  assert.equal(vm.evaluate('WowieMapDB.nav.index'), '1', 'looping routes wrap');
  click(vm, 'WowieNavigationPrevious');
  assert.equal(vm.evaluate('WowieMapDB.nav.index'), '3');
  click(vm, 'WowieNavigationVisibility');
  assert.equal(vm.evaluate('WowieMapDB.hidden.mining'), 'true');
  assert.equal(vm.evaluate('WowieMapDB.nav.index'), '3', 'visibility does not stop navigation');
  click(vm, 'WowieNavigationMap');
  assert.equal(vm.evaluate('WowieMapDB.hidden.mining'), null);
  assert.equal(vm.num('STUB.shownMap'), 1432);
  click(vm, 'WowieNavigationRow1Visibility');
  assert.equal(vm.evaluate('WowieMapDB.hidden.mining'), 'true');
  click(vm, 'WowieNavigationRow1Map');
  assert.equal(vm.evaluate('WowieMapDB.hidden.mining'), null);
  click(vm, 'WowieNavigationStop');
  assert.equal(vm.evaluate('WowieMap.GetNavigationState().status'), 'idle');
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.12);
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.y'), 0.23);
  assert.equal(vm.evaluate('C_SuperTrack.IsSuperTrackingUserWaypoint()'), 'true');
});

test('router UI controls defer during combat, finish chosen unordered points, and respect replacement owners', () => {
  const vm = newVM();
  installRouter(vm);
  vm.run(`WowieMap.Sync(${LAYER}); WowieMap.ShowNavigation()
    STUB.combat = true
    function InCombatLockdown() return STUB.combat == true end`);
  click(vm, 'WowieNavigationRow2Navigate');
  assert.equal(vm.evaluate('WowieMap.GetNavigationState().status'), 'pending');
  assert.equal(vm.evaluate('WowieMap.GetNavigationState().active.index'), '2');
  assert.equal(vm.evaluate('STUB.route'), null);
  assert.equal(vm.evaluate('C_Map.GetUserWaypoint()'), null);
  vm.run('STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  assert.equal(vm.evaluate('WowieMap.GetNavigationState().status'), 'route');
  assert.equal(vm.num('STUB.route.x'), 0.6);
  click(vm, 'WowieNavigationPrevious');
  assert.equal(vm.num('STUB.route.x'), 0.5);
  click(vm, 'WowieNavigationNext');
  assert.equal(vm.num('STUB.route.x'), 0.6);
  vm.run('STUB.route = { owner = "OtherAddon" }; STUB.routeEnded.Wowie = "replaced"; STUB.Tick()');
  assert.equal(vm.evaluate('WowieMap.GetNavigationState().active'), null);
  assert.equal(vm.evaluate('WowieNavigationStop:IsEnabled()'), 'false');
  vm.run('WowieMap.Stop()');
  assert.equal(vm.evaluate('STUB.route.owner'), 'OtherAddon', 'stop only cancels our route');
  vm.run(`STUB.route = nil
    WowieMap.Sync({ epoch = "collection", version = 1, layers = {
      { name = "places", title = "Places", loop = true, points = {
        { 1432, 20, 30, "First place", "poi" }, { 1432, 70, 80, "Second place", "poi" } } } } })`);
  click(vm, 'WowieNavigationRow1Navigate');
  assert.equal(vm.num('STUB.route.x'), 0.2);
  vm.run('STUB.route = nil; STUB.routeEnded.Wowie = "arrived"; STUB.Tick()');
  assert.equal(vm.evaluate('WowieMap.GetNavigationState().active'), null);
  assert.equal(vm.evaluate('STUB.route'), null, 'arrival must not turn an unordered collection into a route');
});

test('a deferred route yields when another owner starts tracking during combat', () => {
  const vm = newVM();
  installRouter(vm);
  vm.run(`WowieMap.Sync(${LAYER}); WowieMap.Stop(); WowieMap.ShowNavigation()
    STUB.combat = true; function InCombatLockdown() return STUB.combat == true end`);
  click(vm, 'WowieNavigationRow1Navigate');
  vm.run('STUB.route = { owner = "OtherAddon" }; STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  assert.equal(vm.evaluate('WowieMap.GetNavigationState().active'), null);
  assert.equal(vm.evaluate('STUB.route.owner'), 'OtherAddon');
});

test('active targets normalize on shrink and disappear on empty layers without canceling invalid choices', () => {
  const vm = newVM();
  vm.run(`WowieMap.Sync(${LAYER}); WowieMap.Navigate("mining", 3); WowieMap.ShowNavigation()
    local m = ${LAYER}; m.version = 2; table.remove(m.layers[1].points, 3); WowieMap.Sync(m)`);
  assert.equal(vm.evaluate('WowieMap.GetNavigationState().active.index'), '2');
  assert.equal(vm.evaluate('WowieMap.GetNavigationState().active.total'), '2');
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.6);
  assert.equal(vm.evaluate('WowieMap.Navigate("missing", 1)'), 'false');
  assert.equal(vm.evaluate('WowieMap.Navigate("mining", 99)'), 'false');
  assert.equal(vm.evaluate('WowieMap.GetNavigationState().active.index'), '2');
  vm.run(`WowieMap.Sync({ epoch = "e1", version = 3, layers = {
    { name = "empty", title = "Empty", points = {} },
    { name = "mining", title = "Copper loop", ordered = true, points = {} } } })`);
  assert.equal(vm.evaluate('WowieMap.GetNavigationState().active'), null);
  assert.equal(vm.evaluate('WowieMapDB.nav'), null);
  assert.equal(vm.evaluate('C_Map.GetUserWaypoint()'), null);
  assert.equal(vm.evaluate('WowieMap.Navigate("empty")'), 'false');
  assert.equal(vm.num('#WowieNavigationPanel.filtered'), 0);
  assert.equal(vm.evaluate('WowieNavigationPanel.empty:IsShown()'), 'true');
});

test('offline saved destinations remain directly usable and stopped state survives loading', () => {
  const vm = newVM(`WowieMapDB = { map = ${LAYER}, hidden = { mining = true } }`);
  vm.run('WowieMap.ShowNavigation(); STUB.Tick()');
  assert.equal(vm.evaluate('WowieMap.GetNavigationState().active'), null, 'opening saved data cannot auto-restart stopped tracking');
  assert.equal(vm.evaluate('WowieMapDB.hidden.mining'), 'true');
  click(vm, 'WowieNavigationRow2Navigate');
  assert.equal(vm.evaluate('WowieMapDB.nav.index'), '2');
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.6);
  click(vm, 'WowieNavigationStop');
  vm.run('STUB.Tick(); WowieMap.Sync(WowieMapDB.map)');
  assert.equal(vm.evaluate('WowieMapDB.nav'), null);
  assert.equal(vm.evaluate('WowieMap.GetNavigationState().active'), null);
});

test('empty and unavailable navigation expose honest state and allow retry without disturbing player tracking', () => {
  const vm = newVM();
  vm.run('WowieMap.ShowNavigation()');
  assert.equal(vm.evaluate('WowieMap.GetNavigationState().status'), 'idle');
  assert.equal(vm.num('#WowieNavigationPanel.rows'), 0);
  assert.equal(vm.evaluate('WowieNavigationStop:IsEnabled()'), 'false');
  assert.equal(vm.evaluate('WowieNavigationNext:IsEnabled()'), 'false');
  assert.equal(vm.evaluate('WowieNavigationMap:IsEnabled()'), 'false');
  vm.run(`C_Map.SetUserWaypoint(UiMapPoint.CreateFromCoordinates(1432, 0.12, 0.23))
    C_SuperTrack.SetSuperTrackedUserWaypoint(true)
    STUB.denyWaypoint = true; WowieMap.Sync(${LAYER})`);
  assert.equal(vm.evaluate('WowieMap.GetNavigationState().status'), 'unavailable');
  assert.equal(vm.evaluate('WowieMap.GetNavigationState().active'), null);
  assert.equal(vm.evaluate('WowieMap.GetNavigationState().message ~= ""'), 'true');
  assert.equal(vm.evaluate('WowieNavigationStop:IsEnabled()'), 'false');
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.12);
  click(vm, 'WowieNavigationRow2Navigate');
  assert.equal(vm.evaluate('WowieMap.GetNavigationState().status'), 'unavailable');
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.12);
  vm.run('STUB.denyWaypoint = false');
  click(vm, 'WowieNavigationRow2Navigate');
  assert.equal(vm.evaluate('WowieMap.GetNavigationState().status'), 'native');
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.6);
  click(vm, 'WowieNavigationStop');
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.12);
});

test('native arrival completes only the chosen unordered destination and stop respects a newer player pin', () => {
  const vm = newVM();
  vm.run(`WowieMap.Sync({ epoch = "places", version = 1, layers = {
    { name = "places", title = "Places", loop = true, points = {
      { 1432, 20, 30, "First place", "poi" }, { 1432, 70, 80, "Second place", "poi" } } } } })
    WowieMap.ShowNavigation()`);
  click(vm, 'WowieNavigationRow1Navigate');
  vm.run('STUB.posX, STUB.posY = 0.2, 0.3; STUB.Tick()');
  assert.equal(vm.evaluate('WowieMap.GetNavigationState().active'), null);
  assert.equal(vm.evaluate('C_Map.GetUserWaypoint()'), null);
  click(vm, 'WowieNavigationRow2Navigate');
  vm.run(`C_Map.SetUserWaypoint(UiMapPoint.CreateFromCoordinates(1432, 0.31, 0.41))
    C_SuperTrack.SetSuperTrackedUserWaypoint(true)`);
  click(vm, 'WowieNavigationStop');
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.31);
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.y'), 0.41);
  assert.equal(vm.evaluate('C_SuperTrack.IsSuperTrackingUserWaypoint()'), 'true');
});

test('a serialized UI stop does not reactivate the saved route after reload', () => {
  const vm = newVM();
  vm.run(`WowieMap.Sync(${LAYER}); WowieMap.ShowNavigation()`);
  click(vm, 'WowieNavigationStop');
  const reloaded = newVM(savedMap(vm));
  reloaded.run('WowieMap.ShowNavigation(); STUB.Tick(); WowieMap.Sync(WowieMapDB.map)');
  assert.equal(reloaded.evaluate('WowieMap.GetNavigationState().active'), null);
  assert.equal(reloaded.evaluate('C_Map.GetUserWaypoint()'), null);
  assert.equal(reloaded.evaluate('WowieNavigationStop:IsEnabled()'), 'false');
  click(reloaded, 'WowieNavigationRow2Navigate');
  assert.equal(reloaded.num('C_Map.GetUserWaypoint().position.x'), 0.6);
});

test('router rejection falls back honestly to native tracking or an unavailable state', () => {
  const vm = newVM();
  installRouter(vm);
  vm.run(`ShortestPathForever.API.Navigate = function() return false end
    WowieMap.Sync(${LAYER}); WowieMap.ShowNavigation()`);
  assert.equal(vm.evaluate('WowieMap.GetNavigationState().status'), 'native');
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.5);
  assert.equal(vm.evaluate('STUB.route'), null);
  click(vm, 'WowieNavigationStop');
  vm.run('STUB.denyWaypoint = true');
  click(vm, 'WowieNavigationRow3Navigate');
  assert.equal(vm.evaluate('WowieMap.GetNavigationState().status'), 'unavailable');
  assert.equal(vm.evaluate('WowieMap.GetNavigationState().active'), null);
  assert.equal(vm.evaluate('STUB.route'), null);
  assert.equal(vm.evaluate('C_Map.GetUserWaypoint()'), null);
});

test('adding points converts current position and map pins without altering tracking or sending a request', () => {
  const vm = newVM('STUB.playerMap = 1454; STUB.posX = 0.314159; STUB.posY = 0.271828');
  vm.run(`C_Map.SetUserWaypoint(UiMapPoint.CreateFromCoordinates(1432, 0.12, 0.23))
    C_SuperTrack.SetSuperTrackedUserWaypoint(true)
    WowieMap.Sync(${LAYER}); WowieMap.Navigate("mining", 2)
    Wowie.Toggle(true); WowieInput:SetText("keep this draft")
    WowieMap.ShowNavigation()`);
  click(vm, 'WowieNavigationAdd');
  vm.run('WowieNavigationPointName:SetText("My mailbox"); WowieNavigationPointMap:SetText("unknown")');
  click(vm, 'WowieNavigationPointSave');
  assert.equal(vm.evaluate('WowieNavigationPointEditor:IsShown()'), 'true');
  assert.equal(vm.num('#WowieNavigationPanel.catalog'), 3);
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.6);
  assert.equal(vm.evaluate('WowieNavigationPointEditor.error:GetText() ~= ""'), 'true');
  vm.run('WowieNavigationPointMap:SetText("1454"); WowieNavigationPointX:SetText("100.1")');
  click(vm, 'WowieNavigationPointSave');
  assert.equal(vm.num('#WowieNavigationPanel.catalog'), 3, 'out-of-map coordinates must not be saved');
  click(vm, 'WowieNavigationPointCurrent');
  click(vm, 'WowieNavigationPointSave');
  assert.equal(vm.evaluate('WowieNavigationPointEditor:IsShown()'), 'false');
  assert.equal(vm.evaluate('STUB.focus'), null);
  vm.run('WowieNavigationSearch:SetText("My mailbox")');
  assert.equal(vm.num('#WowieNavigationPanel.filtered'), 1);
  assert.equal(vm.num('WowieNavigationPanel.filtered[1].point[1]'), 1454);
  assert.equal(vm.num('WowieNavigationPanel.filtered[1].point[2]'), 31.4159);
  assert.equal(vm.num('WowieNavigationPanel.filtered[1].point[3]'), 27.1828);
  assert.equal(vm.evaluate('WowieMap.GetNavigationState().active.layer'), 'mining');
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.6, 'saving a point must not start or replace guidance');
  click(vm, 'WowieNavigationStop');
  click(vm, 'WowieNavigationAdd');
  vm.run('WowieNavigationPointName:SetText("My map pin")');
  click(vm, 'WowieNavigationPointPin');
  click(vm, 'WowieNavigationPointSave');
  vm.run('WowieNavigationSearch:SetText("My map pin")');
  assert.equal(vm.num('WowieNavigationPanel.filtered[1].point[1]'), 1432);
  assert.equal(vm.num('WowieNavigationPanel.filtered[1].point[2]'), 12);
  assert.equal(vm.num('WowieNavigationPanel.filtered[1].point[3]'), 23);
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.12);
  assert.equal(vm.evaluate('WowieInput:GetText()'), 'keep this draft');
  assert.equal(vm.evaluate('WowieDB.chats[1].pendingId'), null);
  assert.equal(vm.num('#WowieDB.chats[1].history'), 0);
  vm.run('WowieMap.Sync({ epoch = "e1", version = 2, layers = {} })');
  click(vm, 'WowieNavigationAdd'); // the previously allocated route choice is now gone
  vm.run('WowieNavigationPointName:SetText("Do not save")');
  click(vm, 'WowieNavigationPointCancel');
  vm.run('WowieNavigationSearch:SetText("")');
  assert.equal(vm.num('#WowieNavigationPanel.catalog'), 2, 'cancel and bridge clearing must keep only the two local saves');
});

test('manually appended route stops retain their destination through source changes, clearing and reload', () => {
  const vm = newVM();
  vm.run(`WowieMap.Sync(${LAYER}); WowieMap.ShowNavigation()`);
  click(vm, 'WowieNavigationAdd');
  click(vm, 'WowieNavigationPointTarget2');
  vm.run(`WowieNavigationPointName:SetText("Scenic stop")
    WowieNavigationPointMap:SetText("1432")
    WowieNavigationPointX:SetText("82"); WowieNavigationPointY:SetText("92")`);
  click(vm, 'WowieNavigationPointSave');
  vm.run('WowieNavigationSearch:SetText("Scenic stop")');
  click(vm, 'WowieNavigationRow1Navigate');
  assert.equal(vm.evaluate('WowieMap.GetNavigationState().active.layer'), 'mining');
  assert.equal(vm.num('WowieMap.GetNavigationState().active.index'), 4);
  vm.run(`local m = ${LAYER}; m.version = 2
    table.insert(m.layers[1].points, 2, { 1432, 17, 27, "New source stop", "poi" })
    WowieMap.Sync(m)`);
  assert.equal(vm.num('WowieMap.GetNavigationState().active.index'), 5);
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.82);
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.y'), 0.92);
  vm.run('WowieMap.Sync({ epoch = "e1", version = 3, layers = {} })');
  assert.equal(vm.num('WowieMap.GetNavigationState().active.index'), 1);
  assert.equal(vm.num('WowieMap.GetNavigationState().active.total'), 1);
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.82);
  click(vm, 'WowieNavigationStop');
  const reloaded = newVM(savedMap(vm));
  reloaded.run('WowieMap.ShowNavigation(); WowieNavigationSearch:SetText("Scenic stop")');
  assert.equal(reloaded.num('#WowieNavigationPanel.filtered'), 1);
  click(reloaded, 'WowieNavigationRow1Navigate');
  assert.equal(reloaded.num('C_Map.GetUserWaypoint().position.x'), 0.82);
  click(reloaded, 'WowieNavigationRow1Delete');
  reloaded.run('StaticPopupDialogs.WOWIE_MAP_DELETE.OnAccept({}, STUB.popup.data)');
  assert.equal(reloaded.evaluate('WowieMap.GetNavigationState().active'), null);
  assert.equal(reloaded.evaluate('C_Map.GetUserWaypoint()'), null);
  assert.equal(reloaded.num('#WowieNavigationPanel.filtered'), 0);
});

test('delete confirmation targets its original point after row recycling and refuses a replaced snapshot', () => {
  const vm = newVM();
  vm.run(`WowieMap.Sync(${LAYER}); WowieMap.Stop(); WowieMap.ShowNavigation()
    WowieNavigationSearch:SetText("2. Copper")`);
  click(vm, 'WowieNavigationRow1Delete');
  assert.equal(vm.num('#WowieMap.GetNavigationState().layers[1].points'), 3, 'confirmation must not delete immediately');
  assert.match(vm.evaluate('STUB.popup.text'), /2\. Copper[\s\S]*Copper loop[\s\S]*Loch Modan/);
  assert.equal(vm.evaluate('STUB.popup.data.layer'), 'mining');
  assert.equal(vm.num('STUB.popup.data.index'), 2);
  vm.run('WowieNavigationSearch:SetText("3. Tin")');
  click(vm, 'WowieNavigationRow1Navigate');
  vm.run('StaticPopupDialogs.WOWIE_MAP_DELETE.OnAccept({}, STUB.popup.data)');
  assert.equal(vm.num('#WowieMap.GetNavigationState().layers[1].points'), 2);
  assert.equal(vm.num('WowieMap.GetNavigationState().active.index'), 2);
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.55, 'deleting an earlier point must retain the current destination');
  click(vm, 'WowieNavigationRow1Delete');
  vm.run(`local m = ${LAYER}; m.version = 2
    m.layers[1].points[3] = { 1432, 77, 66, "Replacement", "poi" }
    WowieMap.Sync(m)
    StaticPopupDialogs.WOWIE_MAP_DELETE.OnAccept({}, STUB.popup.data)
    WowieNavigationSearch:SetText("Replacement")`);
  assert.equal(vm.num('#WowieMap.GetNavigationState().layers[1].points'), 2, 'stale confirmation must not delete the replacement');
  assert.equal(vm.num('#WowieNavigationPanel.filtered'), 1);
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.77);
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.y'), 0.66);
  vm.run('WowieNavigationSearch:SetText("2. Copper")');
  assert.equal(vm.num('#WowieNavigationPanel.filtered'), 0, 'source updates must not resurrect the earlier deletion');
});

test('navigation and point editor fit small clients with full-width labels and disjoint actions', () => {
  const vm = newVM();
  vm.run(`WowieMap.Sync(${LAYER}); WowieMap.Stop()`);
  for (const [width, height] of [[1280, 900], [800, 600], [640, 480]]) {
    vm.run(`UIParent:SetSize(${width}, ${height}); WowieMap.ShowNavigation()`);
    assert.ok(vm.num('WowieNavigationPanel:GetWidth() * WowieNavigationPanel:GetEffectiveScale()') <= width - 24);
    assert.ok(vm.num('WowieNavigationPanel:GetHeight() * WowieNavigationPanel:GetEffectiveScale()') <= height - 24);
    for (const id of ['Active', 'Previous', 'Next', 'Stop', 'Map', 'Visibility', 'Add', 'Close', 'Search', 'Clear', 'Scroll']) {
      assert.equal(vm.evaluate(`Inside(WowieNavigation${id}, WowieNavigationPanel)`), 'true', id);
    }
    for (const [a, b] of [['Add', 'Close'], ['Previous', 'Next'], ['Next', 'Stop'], ['Stop', 'Map'], ['Map', 'Visibility'], ['Active', 'Search'], ['Search', 'Clear'], ['Search', 'Scroll']]) {
      assert.equal(vm.evaluate(`Disjoint(WowieNavigation${a}, WowieNavigation${b})`), 'true', `${a}/${b}`);
    }
    vm.run('ROW = WowieNavigationPanel.rows[1]');
    assert.ok(vm.num('Bounds(ROW.label).w / Bounds(ROW).w') > 0.9, 'buttons no longer consume the destination label width');
    for (const control of ['label', 'detail', 'navigate', 'map', 'visibility', 'delete']) {
      assert.equal(vm.evaluate(`Inside(ROW.${control}, ROW)`), 'true', control);
    }
    for (const [a, b] of [['label', 'detail'], ['detail', 'navigate'], ['navigate', 'map'], ['map', 'visibility'], ['visibility', 'delete']]) {
      assert.equal(vm.evaluate(`Disjoint(ROW.${a}, ROW.${b})`), 'true', `${a}/${b}`);
    }
    assert.equal(vm.evaluate('WowieMap.GetNavigationState().active'), null, 'layout does not start navigation');
    click(vm, 'WowieNavigationAdd');
    assert.ok(vm.num('WowieNavigationPointEditor:GetWidth() * WowieNavigationPointEditor:GetEffectiveScale()') <= width - 24);
    assert.ok(vm.num('WowieNavigationPointEditor:GetHeight() * WowieNavigationPointEditor:GetEffectiveScale()') <= height - 24);
    assert.ok(vm.num('WowieNavigationPointEditor:GetFrameLevel()') > vm.num('WowieNavigationPanel:GetFrameLevel()'));
    for (const id of ['Name', 'Map', 'X', 'Y', 'Targets', 'Current', 'Pin', 'Save', 'Cancel']) {
      assert.equal(vm.evaluate(`Inside(WowieNavigationPoint${id}, WowieNavigationPointEditor)`), 'true', id);
    }
    for (const [a, b] of [['Name', 'Map'], ['Targets', 'Map'], ['Map', 'X'], ['X', 'Y'], ['Targets', 'Current'], ['Current', 'Pin'], ['Pin', 'Save'], ['Save', 'Cancel']]) {
      assert.equal(vm.evaluate(`Disjoint(WowieNavigationPoint${a}, WowieNavigationPoint${b})`), 'true', `${a}/${b}`);
    }
    assert.equal(vm.evaluate('Disjoint(WowieNavigationPointTarget1, WowieNavigationPointTarget2)'), 'true', 'target buttons have a full-height row pitch');
    assert.equal(vm.evaluate('Disjoint(WowieNavigationPointEditor.error, WowieNavigationPointSave)'), 'true', 'validation text cannot cover save');
    click(vm, 'WowieNavigationPointCancel');
  }
});

test('navigation modal headers alone drag, resizing preserves editor fields and closing clears focus', () => {
  const vm = newVM();
  vm.run(`WowieMap.Sync(${LAYER}); WowieMap.ShowNavigation()`);
  click(vm, 'WowieNavigationAdd');
  vm.run(`
    WowieNavigationPointName:SetText("Keep this destination")
    WowieNavigationPointTarget2:GetScript("OnClick")(WowieNavigationPointTarget2)
    WowieNavigationPointX:SetText("42")
    UIParent:SetSize(600, 440)
    for _, hook in ipairs(UIParent.hooks.OnSizeChanged or {}) do hook(UIParent) end
  `);
  for (const [panel, header] of [['WowieNavigationPanel', 'WowieNavigationHeader'], ['WowieNavigationPointEditor', 'WowieNavigationPointHeader']]) {
    assert.equal(vm.evaluate(`${panel}.strata`), 'FULLSCREEN_DIALOG');
    assert.equal(vm.evaluate(`${panel}:GetScript("OnDragStart")`), null);
    assert.ok(vm.num(`${panel}:GetWidth() * ${panel}:GetEffectiveScale()`) <= 576);
    assert.ok(vm.num(`${panel}:GetHeight() * ${panel}:GetEffectiveScale()`) <= 416);
    vm.run(`${header}:GetScript("OnDragStart")(${header})`);
    assert.equal(vm.evaluate(`${panel}.moving`), 'true');
    vm.run(`${header}:GetScript("OnDragStop")(${header})`);
    assert.equal(vm.evaluate(`${panel}.moving`), 'false');
  }
  assert.equal(vm.evaluate('WowieNavigationPointName:GetText()'), 'Keep this destination');
  assert.equal(vm.evaluate('WowieNavigationPointX:GetText()'), '42');
  assert.equal(vm.evaluate('WowieNavigationPointEditor.target'), 'mining');
  assert.equal(vm.evaluate('WowieMap.GetNavigationState().active.index'), '1');
  click(vm, 'WowieNavigationClose');
  assert.equal(vm.evaluate('WowieNavigationPointEditor:IsShown()'), 'false');
  assert.equal(vm.evaluate('STUB.focus'), null);
});

test('deleting a repeated route stop preserves its other occurrence across bridge epochs and reload', () => {
  const source = `{ epoch = "repeat", version = 1, layers = {
    { name = "loop", title = "Repeated crossing", ordered = true, loop = true, points = {
      { 1432, 10, 20, "Crossing", "poi" }, { 1432, 30, 40, "Middle", "poi" },
      { 1432, 10, 20, "Crossing", "poi" }, { 1432, 70, 80, "Finish", "poi" } } } } }`;
  const vm = newVM();
  vm.run(`WowieMap.Sync(${source}); WowieMap.Navigate("loop", 4); WowieMap.ShowNavigation()`);
  click(vm, 'WowieNavigationRow3Delete');
  vm.run('StaticPopupDialogs.WOWIE_MAP_DELETE.OnAccept({}, STUB.popup.data)');
  assert.equal(vm.num('WowieMap.GetNavigationState().active.index'), 3);
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.7);
  vm.run(`local m = ${source}; m.epoch = "new-process"; m.layers[1].title = "Updated crossing"
    WowieMap.Sync(m); WowieMap.Stop()`);
  const reloaded = newVM(savedMap(vm));
  reloaded.run(`WowieMap.Sync(${source}); WowieMap.Stop(); WowieMap.ShowNavigation()`);
  assert.equal(reloaded.num('#WowieMap.GetNavigationState().layers[1].points'), 3);
  click(reloaded, 'WowieNavigationRow1Navigate');
  assert.equal(reloaded.num('C_Map.GetUserWaypoint().position.x'), 0.1);
  click(reloaded, 'WowieNavigationNext');
  assert.equal(reloaded.num('C_Map.GetUserWaypoint().position.x'), 0.3);
  click(reloaded, 'WowieNavigationNext');
  assert.equal(reloaded.num('C_Map.GetUserWaypoint().position.x'), 0.7);
});

test('deleting active points releases only owned waypoints and dotted routes', () => {
  const vm = newVM();
  vm.run(`C_Map.SetUserWaypoint(UiMapPoint.CreateFromCoordinates(1432, 0.12, 0.23))
    C_SuperTrack.SetSuperTrackedUserWaypoint(true)
    WowieMap.Sync(${LAYER}); WowieMap.ShowNavigation()`);
  click(vm, 'WowieNavigationRow1Delete');
  vm.run('StaticPopupDialogs.WOWIE_MAP_DELETE.OnAccept({}, STUB.popup.data)');
  assert.equal(vm.evaluate('WowieMap.GetNavigationState().active'), null);
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.12);
  click(vm, 'WowieNavigationRow1Navigate');
  vm.run(`C_Map.SetUserWaypoint(UiMapPoint.CreateFromCoordinates(1432, 0.33, 0.44))
    C_SuperTrack.SetSuperTrackedUserWaypoint(true)`);
  click(vm, 'WowieNavigationRow1Delete');
  vm.run('StaticPopupDialogs.WOWIE_MAP_DELETE.OnAccept({}, STUB.popup.data)');
  assert.equal(vm.evaluate('WowieMap.GetNavigationState().active'), null);
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.33);
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.y'), 0.44);
  const routed = newVM();
  installRouter(routed);
  routed.run(`WowieMap.Sync(${LAYER}); WowieMap.ShowNavigation(); STUB.route = { owner = "OtherAddon" }`);
  click(routed, 'WowieNavigationRow1Delete');
  routed.run('StaticPopupDialogs.WOWIE_MAP_DELETE.OnAccept({}, STUB.popup.data)');
  assert.equal(routed.evaluate('WowieMap.GetNavigationState().active'), null);
  assert.equal(routed.evaluate('STUB.route.owner'), 'OtherAddon');
});

for (const backend of ['native', 1, 2]) {
test(`an active destination button toggles navigation off without deleting points (${backend})`, () => {
  const vm = newVM();
  if (backend !== 'native') installRouter(vm, backend);
  vm.run(`C_Map.SetUserWaypoint(UiMapPoint.CreateFromCoordinates(1432,0.12,0.23))
    C_SuperTrack.SetSuperTrackedUserWaypoint(true)
    WowieMap.Sync(${LAYER}); WowieMap.Stop(); WowieMap.ShowNavigation()`);
  click(vm, 'WowieNavigationRow2Navigate');
  assert.equal(vm.num('WowieMap.GetNavigationState().active.index'), 2);
  click(vm, 'WowieNavigationRow2Navigate');
  assert.equal(vm.evaluate('WowieMap.GetNavigationState().active'), null);
  assert.equal(vm.evaluate('STUB.route'), null);
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.12, 'stopping restores only the previous player waypoint');
  assert.equal(vm.num('#WowieMap.GetNavigationState().layers[1].points'), 3);
  click(vm, 'WowieNavigationRow2Navigate');
  assert.equal(vm.num('WowieMap.GetNavigationState().active.index'), 2, 'the stopped destination can be started again');
  click(vm, 'WowieNavigationRow3Navigate');
  assert.equal(vm.num('WowieMap.GetNavigationState().active.index'), 3, 'a different destination starts instead of stopping');
});
}

test('stopping the active row cancels deferred guidance without taking a replacement route', () => {
  const vm = newVM();
  installRouter(vm, 2);
  vm.run(`WowieMap.Sync(${LAYER}); WowieMap.Stop(); WowieMap.ShowNavigation()
    STUB.combat=true; function InCombatLockdown() return STUB.combat end`);
  click(vm, 'WowieNavigationRow2Navigate');
  assert.equal(vm.evaluate('WowieMap.GetNavigationState().status'), 'pending');
  vm.run('STUB.route={owner="OtherAddon"}');
  click(vm, 'WowieNavigationRow2Navigate');
  vm.run('STUB.combat=false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  assert.equal(vm.evaluate('WowieMap.GetNavigationState().active'), null);
  assert.equal(vm.evaluate('STUB.route.owner'), 'OtherAddon');
});

test('On map focuses destination coordinates without changing guidance or the message draft', () => {
  const vm = newVM();
  vm.run(`WowieMap.Sync(${LAYER}); WowieMap.Navigate("mining",2)
    Wowie.Toggle(true); WowieInput:SetText("keep this message")
    WowieMap.ShowNavigation(); WorldMapFrame:Hide()`);
  click(vm, 'WowieNavigationRow3Map');
  vm.run('STUB.Advance(0)');
  assert.equal(vm.num('STUB.mapFocus.map'), 1432);
  assert.equal(vm.num('STUB.mapFocus.x'), 0.55);
  assert.equal(vm.num('STUB.mapFocus.y'), 0.7);
  assert.equal(vm.num('WowieMap.GetNavigationState().active.index'), 2);
  assert.equal(vm.num('C_Map.GetUserWaypoint().position.x'), 0.6, 'view focus cannot replace the active waypoint');
  assert.equal(vm.evaluate('WowieNavigationPanel:IsShown()'), 'false', 'the navigation window must not cover the destination map');
  assert.equal(vm.evaluate('WowieFrame:IsShown()'), 'false');
  assert.equal(vm.evaluate('WowieMini:IsShown()'), 'true');
  assert.equal(vm.evaluate('WowieInput:GetText()'), 'keep this message');
});

test('stitched OpenMap focuses through its public world-coordinate API and preserves the route', () => {
  const vm = newVM();
  installRouter(vm, 2);
  vm.run(`WowieMap.Sync(${LAYER}); WowieMap.Navigate("mining",2); WowieMap.ShowNavigation()
    ROUTE=STUB.route; NATIVE_PANS=0
    WorldMapFrame.PanAndZoomTo=function() NATIVE_PANS=NATIVE_PANS+1; error("native pan is blocked by OpenMap") end
    OpenMapAPI={major=1,version=4,
      IsStitched=function() return true end,
      WorldFromMap=function(map,x,y) if map==1432 then return 0.2+x*0.1,0.3+y*0.2 end end,
      GetView=function() return 0.5,0.5,3 end,
      ShowWorld=function(u,v,zoom) STUB.stitchedView={u=u,v=v,zoom=zoom}; return true end
    }`);
  click(vm, 'WowieNavigationRow3Map');
  vm.run('STUB.Advance(0)');
  assert.equal(vm.num('STUB.stitchedView.u'), 0.255);
  assert.equal(vm.num('STUB.stitchedView.v'), 0.44);
  assert.ok(vm.num('STUB.stitchedView.zoom') >= 5, 'destination focus should show zone-scale detail, not the whole world');
  assert.equal(vm.num('NATIVE_PANS'), 0);
  assert.equal(vm.evaluate('STUB.route==ROUTE'), 'true');
  vm.run('WowieMap.ShowNavigation()');
  click(vm, 'WowieNavigationMap');
  vm.run('STUB.Advance(0)');
  assert.equal(vm.num('STUB.stitchedView.u'), 0.26, 'the active-card map action focuses the active destination');
});

test('a deferred map focus cannot reopen a closed map or overwrite a newer focus request', () => {
  const vm = newVM();
  vm.run(`WowieMap.Sync(${LAYER}); WowieMap.Stop(); WowieMap.ShowNavigation()`);
  click(vm, 'WowieNavigationRow1Map');
  vm.run('WowieMap.ShowNavigation()');
  click(vm, 'WowieNavigationRow3Map');
  vm.run('STUB.Advance(0)');
  assert.equal(vm.num('STUB.mapFocus.x'), 0.55);
  vm.run('WowieMap.ShowNavigation(); STUB.mapFocus=nil');
  click(vm, 'WowieNavigationRow1Map');
  vm.run('WorldMapFrame:Hide(); STUB.Advance(0)');
  assert.equal(vm.evaluate('STUB.mapFocus'), null);
  assert.equal(vm.evaluate('WorldMapFrame:IsShown()'), 'false');
  assert.equal(vm.evaluate('WowieMap.GetNavigationState().active'), null);
});
