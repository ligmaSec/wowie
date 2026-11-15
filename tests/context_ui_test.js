'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const addon = path.join(__dirname, '../addon/Wowie');
function vm() {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = (code, arg) => {
    if (lauxlib.luaL_loadstring(L, to_luastring(code)) !== lua.LUA_OK) {
      throw new Error(to_jsstring(lua.lua_tostring(L, -1)));
    }
    if (arg !== undefined) lua.lua_pushstring(L, to_luastring(arg));
    if (lua.lua_pcall(L, arg === undefined ? 0 : 1, 0, 0) !== lua.LUA_OK) {
      throw new Error(to_jsstring(lua.lua_tostring(L, -1)));
    }
  };
  const value = expression => {
    run(`RESULT = tostring(${expression})`);
    lua.lua_getglobal(L, to_luastring('RESULT'));
    const result = to_jsstring(lua.lua_tostring(L, -1));
    lua.lua_pop(L, 1);
    return result;
  };
  run(fs.readFileSync(path.join(__dirname, 'wow_stub.lua'), 'utf8'));
  run(`
    UIParent:SetSize(1280, 900)
    -- Capture anchors rather than relying on the stub's non-geometric GetPoint.
    local create = CreateFrame
    CreateFrame = function(...)
      local frame = create(...)
      local setPoint = frame.SetPoint
      frame.SetPoint = function(self, point, relative, relativePoint, x, y)
        if type(relative) == 'number' then
          x, y, relative, relativePoint = relative, relativePoint, self.parent, point
        end
        self.anchors = self.anchors or {}
        self.anchors[point] = { relative or self.parent or UIParent, relativePoint or point, x or 0, y or 0 }
        setPoint(self, point, relative, relativePoint, x, y)
      end
      frame.ClearAllPoints = function(self) self.anchors = {} end
      frame.SetFrameStrata = function(self, strata) self.strata = strata end
      frame.StartMoving = function(self) self.moving = true end
      frame.StopMovingOrSizing = function(self) self.moving = false end
      return frame
    end
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
        result[axis == 1 and 'w' or 'h'] = size
        result[axis == 1 and 'x' or 'y'] = anchors[1] and anchors[1][2] - anchors[1][1] * size or 0
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
  `);
  for (const file of ['Codec.lua', 'Inbox.lua', 'Wowie.lua', 'ReplyView.lua', 'Context.lua', 'ContextUI.lua']) {
    run(fs.readFileSync(path.join(addon, file), 'utf8'), 'Wowie');
  }
  run(`
    STUB.FireEvent('ADDON_LOADED', 'Wowie')
    STUB.FireEvent('PLAYER_LOGIN')
    function Click(control)
      local ancestor = control
      while ancestor do
        assert(ancestor:IsShown(), tostring(control:GetName()) .. " is hidden")
        ancestor = ancestor:GetParent()
      end
      if control.kind == 'CheckButton' then control:SetChecked(not control:GetChecked()) end
      control:GetScript('OnClick')(control)
    end
    function Search(text) WowieContextSearch:SetText(text) end
    function ScrollTo(offset)
      local p = WowieContextPermissions
      local maximum = math.max(0, #p.filtered * 64 - p.scroll:GetHeight())
      p.scroll:SetVerticalScroll(math.min(offset, maximum))
      for _, hook in ipairs(p.scroll.hooks.OnVerticalScroll or {}) do hook(p.scroll, p.scroll:GetVerticalScroll()) end
    end
    function AddScopes(count)
      APIDocumentation = { systems = {} }
      for i = 1, count do
        APIDocumentation.systems[i] = { Name = string.format('Scope%04d', i), Functions = {} }
      end
    end
    function Choices()
      local ids = {}
      for _, category in ipairs(WowieContext.Categories()) do
        if category.enabled then ids[#ids + 1] = category.id end
      end
      table.sort(ids)
      return #ids == 0 and '[]' or WowieContext.Encode(ids)
    end
    NOTIFICATIONS = 0
    function Wowie.UpdateSharingSummary()
      NOTIFICATIONS = NOTIFICATIONS + 1
      LAST_SUMMARY = WowieContextUI.Summary()
    end
  `);
  return { run, value, json: expression => JSON.parse(value(expression)), num: expression => Number(value(expression)) };
}

test('compact presets grant useful built-ins without API hunting and keep private access off', () => {
  const v = vm();
  v.run(`
    AddScopes(20)
    WowieContext.SetEnabled('mail_body', true)
    WowieContext.SetEnabled('macros', true)
    WowieContext.SetEnabled('api:Scope0001', true)
    WowieContextUI.Show()
  `);
  assert.equal(v.value('WowieContext.GetPreset()'), 'custom', 'opening does not overwrite saved permissions');
  assert.equal(v.value('WowieContextDetails:IsShown()'), 'false');
  assert.equal(v.num('#WowieContextPermissions.rows'), 0, 'no API/category rows allocated for the compact workflow');
  v.run('Click(WowieContextRecommended)');
  assert.equal(v.value('WowieContext.GetPreset()'), 'recommended');
  assert.equal(v.value('WowieContextRecommended.isSelected'), 'true');
  for (const category of ['actionbars', 'equipment', 'interaction', 'travel', 'lockouts', 'auctionator']) {
    assert.equal(v.value(`WowieDB.settings.sharing['${category}']`), 'true');
  }
  v.run(`
    PRIVATE_ENABLED = false
    for _, category in ipairs(WowieContext.Categories()) do
      if (category.sensitive or category.id:sub(1, 4) == 'api:') and category.enabled then PRIVATE_ENABLED = true end
    end
  `);
  assert.equal(v.value('PRIVATE_ENABLED'), 'false');
  assert.equal(v.json("WowieContext.Query({ op = 'snapshot', category = 'money' })").ok, true);
  v.run('Click(WowieContextMinimal)');
  assert.deepEqual(v.json('Choices()'), ['identity', 'location']);
  assert.equal(v.value('WowieContext.GetPreset()'), 'minimal');
  assert.equal(v.value('WowieContextMinimal.isSelected'), 'true');
  assert.equal(v.value('WowieContextDetails:IsShown()'), 'false');
  v.run('Click(WowieContextClose); WowieContextUI.Show()');
  assert.deepEqual(v.json('Choices()'), ['identity', 'location'], 'preset persists without an apply/save step');
});

test('delivery changes persist independently of permissions, presets and pause', () => {
  const v = vm();
  v.run(`
    WowieContextUI.Show()
    Click(WowieContextMinimal)
  `);
  assert.equal(v.value('WowieContext.GetDelivery()'), 'smart');
  v.run(`
    Click(WowieContextDeliveryFull)
    Click(WowieContextMaster)
    Click(WowieContextRecommended)
  `);
  assert.equal(v.value('WowieDB.settings.contextDelivery'), 'full');
  assert.equal(v.value('WowieContextDeliveryFull.isSelected'), 'true');
  assert.equal(v.value('WowieContextUI.Summary().enabled'), 'false');
  assert.equal(v.value('WowieContext.GetPreset()'), 'recommended');
  v.run(`
    Click(WowieContextDeliverySmart)
    Click(WowieContextCustomize)
    Click(WowieContextCustomize)
    Click(WowieContextClose)
    WowieContextUI.Show()
  `);
  assert.equal(v.value('WowieDB.settings.contextDelivery'), 'smart');
  assert.equal(v.value('WowieContextDetails:IsShown()'), 'false');
  assert.equal(v.value('WowieContextUI.Summary().enabled'), 'false');
  assert.equal(v.value('WowieContext.GetPreset()'), 'recommended');
});

test('custom search and recycled API rows toggle only their currently displayed permission', () => {
  const v = vm();
  v.run(`
    AddScopes(320)
    WowieContextUI.Show()
    Click(WowieContextCustomize)
    Click(WowieContextClear)
    Click(WowieContextTabAdvanced)
    ScrollTo(64 * 210)
    FIRST = WowieContextPermissions.rows[1].category.id
    Click(WowieContextPermissions.rows[1].check)
    ScrollTo(64 * 250)
    SECOND = WowieContextPermissions.rows[1].category.id
    Click(WowieContextPermissions.rows[1])
    Search('Scope0007')
    FILTERED = WowieContextPermissions.rows[1].category.id
    Click(WowieContextPermissions.rows[1].check)
  `);
  const first = v.value('FIRST');
  const second = v.value('SECOND');
  assert.notEqual(first, second);
  assert.equal(v.value('FILTERED'), 'api:Scope0007');
  assert.deepEqual(v.json('Choices()'), [first, second, 'api:Scope0007'].sort());
  assert.equal(v.value('WowieContext.GetPreset()'), 'custom');
  v.run(`
    Click(WowieContextTabPrivate)
    EMPTY = #WowieContextPermissions.filtered
    Search('mail')
    PRIVATE = WowieContextPermissions.rows[1].category.id
    Click(WowieContextPermissions.rows[1])
  `);
  assert.equal(v.num('EMPTY'), 0, 'search remains scoped to the selected view');
  assert.ok(['mail', 'mail_body'].includes(v.value('PRIVATE')));
  assert.deepEqual(v.json('Choices()'), [first, second, 'api:Scope0007', v.value('PRIVATE')].sort());
  assert.equal(v.num('WowieContextUI.Summary().selected'), 4);
  assert.ok(v.num('#WowieContextPermissions.rows') <= v.num('math.ceil(WowieContextScroll:GetHeight() / 64) + 1'));
  assert.equal(v.num('LAST_SUMMARY.selected'), 4);
  v.run(`
    WowieContextSearch:SetFocus()
    Click(WowieContextCustomize)
  `);
  assert.equal(v.value('WowieContextSearch:HasFocus()'), 'false');
  assert.equal(v.value('WowieContextScroll:IsShown()'), 'false');
  v.run('Click(WowieContextCustomize)');
  assert.equal(v.value('WowieContextSearch:GetText()'), 'mail', 'expanding preserves the custom workflow');
});

test('selected removal reclamps scrolling and retargets reused rows without losing other choices', () => {
  const v = vm();
  v.run(`
    AddScopes(180)
    WowieContextUI.Show()
    Click(WowieContextCustomize)
    Click(WowieContextClear)
    WowieContext.SetEnabled('identity', true)
    for i = 1, 180 do WowieContext.SetEnabled(string.format('api:Scope%04d', i), true) end
    WowieContextUI.Show()
    Click(WowieContextTabSelected)
    ScrollTo(64 * 10000)
    REMOVED = WowieContextPermissions.rows[1].category.id
    BEFORE = WowieContextScroll:GetVerticalScroll()
    Click(WowieContextPermissions.rows[1].check)
    NEXT = WowieContextPermissions.rows[1].category.id
    AFTER = WowieContextScroll:GetVerticalScroll()
    Click(WowieContextPermissions.rows[1])
  `);
  assert.notEqual(v.value('REMOVED'), v.value('NEXT'));
  assert.equal(v.value('WowieDB.settings.sharing[REMOVED]'), 'false');
  assert.equal(v.value('WowieDB.settings.sharing[NEXT]'), 'false');
  assert.equal(v.value("WowieContext.IsEnabled('identity')"), 'true');
  assert.equal(v.num('WowieContextUI.Summary().selected'), 179);
  assert.equal(v.num('#WowieContextPermissions.filtered'), 179);
  assert.ok(v.num('AFTER') < v.num('BEFORE'));
  v.run(`
    Search('Scope0001')
    Click(WowieContextPermissions.rows[1].check)
  `);
  assert.equal(v.num('#WowieContextPermissions.filtered'), 0);
  assert.equal(v.value('WowieContextPermissions.empty:IsShown()'), 'true');
  assert.equal(v.num('WowieContextScroll:GetVerticalScroll()'), 0);
  assert.equal(v.num('LAST_SUMMARY.selected'), 178);
  assert.equal(v.value("WowieContext.IsEnabled('identity')"), 'true');
});

test('paused sharing permits preset and private edits but blocks actual getters until resumed', () => {
  const v = vm();
  v.run(`
    WowieContextUI.Show()
    Click(WowieContextMaster)
    Click(WowieContextMinimal)
    Click(WowieContextCustomize)
    Click(WowieContextClear)
    Search('money')
    Click(WowieContextPermissions.rows[1].check)
    READS = 0
    function GetMoney() READS = READS + 1; return 12345 end
  `);
  assert.deepEqual(v.json('Choices()'), ['money']);
  assert.equal(v.value('WowieContextUI.Summary().enabled'), 'false');
  assert.equal(v.json("WowieContext.Query({ op = 'snapshot', category = 'money' })").ok, false);
  assert.equal(v.num('READS'), 0);
  v.run(`
    Click(WowieContextTabPrivate)
    Search('macros')
    Click(WowieContextPermissions.rows[1])
  `);
  assert.deepEqual(v.json('Choices()'), ['macros', 'money']);
  assert.equal(v.value('WowieContextPermissions.rows[1].check:GetChecked()'), 'true');
  assert.equal(v.value("WowieContext.IsEnabled('macros')"), 'false');
  assert.equal(v.num('LAST_SUMMARY.selected'), 2);
  v.run('Click(WowieContextClose); WowieContextUI.Show(); Click(WowieContextMaster)');
  assert.equal(v.value('LAST_SUMMARY.enabled'), 'true');
  assert.equal(v.json("WowieContext.Query({ op = 'snapshot', category = 'money' })").ok, true);
  assert.equal(v.num('READS'), 1);
  assert.equal(v.value("WowieContext.IsEnabled('macros')"), 'true');
});

test('optional Auctionator status is visible without customization and availability does not change consent', () => {
  const v = vm();
  v.run(`
    Auctionator = nil
    AUCTIONATOR_PRICE_DATABASE = nil
    AuctionatorDB = nil
    WowieContextUI.Show()
    Click(WowieContextRecommended)
    SAVED = WowieDB.settings.sharing.auctionator
  `);
  assert.match(v.value('WowieContextPermissions.auctionator:GetText()'), /Auctionator.*[Uu]navailable/);
  assert.equal(v.value('WowieContextDetails:IsShown()'), 'false');
  assert.equal(v.value('SAVED'), 'true');
  v.run(`
    Click(WowieContextCustomize)
    Search('auctionator')
  `);
  assert.equal(v.value('WowieContextPermissions.rows[1].category.id'), 'auctionator');
  assert.equal(v.value('WowieContextPermissions.rows[1].check:GetChecked()'), 'true');
  assert.match(v.value('WowieContextPermissions.rows[1].label:GetText()'), /[Uu]navailable/);
  v.run(`
    Click(WowieContextPermissions.rows[1])
    Auctionator = { Database = { db = { ['2592'] = { m = 123, l = {}, h = { ['900'] = 123 }, a = {} } } } }
    WowieContextUI.Show()
  `);
  assert.match(v.value('WowieContextPermissions.auctionator:GetText()'), /Available/);
  assert.equal(v.value('WowieDB.settings.sharing.auctionator'), 'false', 'source arrival must not re-grant access');
  assert.equal(v.value('WowieContextPermissions.rows[1].check:GetChecked()'), 'false');
  v.run(`
    Click(WowieContextPermissions.rows[1])
    Auctionator = nil
    WowieContextUI.Show()
  `);
  assert.equal(v.value('WowieDB.settings.sharing.auctionator'), 'true', 'source disappearance preserves the saved permission');
  assert.match(v.value('WowieContextPermissions.auctionator:GetText()'), /[Uu]navailable/);
});

test('summary caches discovery while reopening and customization refresh late scopes; clear revokes stale grants', () => {
  const v = vm();
  v.run(`
    local categories = WowieContext.Categories
    DISCOVERIES = 0
    WowieContext.Categories = function() DISCOVERIES = DISCOVERIES + 1; return categories() end
    WowieContextUI.Summary()
    BASELINE = DISCOVERIES
    for i = 1, 30 do WowieContextUI.Summary() end
  `);
  assert.equal(v.num('DISCOVERIES'), v.num('BASELINE'));
  v.run(`
    WowieContextUI.Show()
    AddScopes(12)
    Click(WowieContextCustomize)
    Click(WowieContextTabAdvanced)
  `);
  assert.equal(v.num('#WowieContextPermissions.filtered'), 12);
  v.run(`
    WowieDB.settings.sharing['api:Unavailable'] = true
    Click(WowieContextClear)
  `);
  assert.equal(v.value("WowieDB.settings.sharing['api:Unavailable'] == nil"), 'true');
  assert.equal(v.num('LAST_SUMMARY.selected'), 0);
  assert.deepEqual(v.json('Choices()'), []);
  v.run('Click(WowieContextCustomize); Click(WowieContextRecommended); Click(WowieContextCustomize)');
  assert.equal(v.value('WowieContext.GetPreset()'), 'recommended');
  assert.equal(v.value("WowieContext.IsEnabled('mail_body')"), 'false');
  assert.equal(v.value("WowieContext.IsEnabled('api:Scope0001')"), 'false');
  v.run('AddScopes(15); Click(WowieContextClose); WowieContextUI.Show()');
  assert.equal(v.num('#WowieContextPermissions.filtered'), 15);
});

test('compact and expanded layouts fit small clients and keep interactive controls disjoint', () => {
  const v = vm();
  for (const [width, height] of [[1280, 900], [800, 600], [640, 480]]) {
    v.run(`
      UIParent:SetSize(${width}, ${height})
      WowieContextUI.Show()
      if WowieContextPermissions.expanded then Click(WowieContextCustomize) end
    `);
    assert.ok(v.num('WowieContextPermissions:GetWidth() * WowieContextPermissions:GetScale()') <= width - 24);
    assert.ok(v.num('WowieContextPermissions:GetHeight() * WowieContextPermissions:GetScale()') <= height - 24);
    for (const id of ['WowieContextMaster', 'WowieContextRecommended', 'WowieContextMinimal', 'WowieContextDeliverySmart', 'WowieContextDeliveryFull', 'WowieContextCustomize', 'WowieContextClose']) {
      assert.equal(v.value(`Inside(${id}, WowieContextPermissions)`), 'true', id);
    }
    assert.equal(v.value('Disjoint(WowieContextRecommended, WowieContextMinimal)'), 'true');
    assert.equal(v.value('Disjoint(WowieContextCustomize, WowieContextClose)'), 'true');
    assert.equal(v.value('Disjoint(WowieContextDeliverySmart, WowieContextDeliveryFull)'), 'true');
    assert.equal(v.value('WowieContextDeliverySmart:IsShown()'), 'true', 'delivery is available without opening the category list');
    assert.equal(v.value('WowieContextClear:IsShown()'), 'false');
    v.run('Click(WowieContextCustomize)');
    assert.ok(v.num('WowieContextPermissions:GetWidth() * WowieContextPermissions:GetScale()') <= width - 24);
    assert.ok(v.num('WowieContextPermissions:GetHeight() * WowieContextPermissions:GetScale()') <= height - 24);
    for (const id of ['WowieContextTabCharacter', 'WowieContextTabPrivate', 'WowieContextTabAdvanced', 'WowieContextTabSelected', 'WowieContextSearch', 'WowieContextClearSearch', 'WowieContextScroll']) {
      assert.equal(v.value(`Inside(${id}, WowieContextDetails)`), 'true', id);
    }
    const pairs = [
      ['TabCharacter', 'TabPrivate'],
      ['TabPrivate', 'TabAdvanced'], ['TabAdvanced', 'TabSelected'],
      ['Search', 'ClearSearch'], ['Scroll', 'Clear'], ['Search', 'Scroll'],
    ];
    for (const [a, b] of pairs) assert.equal(v.value(`Disjoint(WowieContext${a}, WowieContext${b})`), 'true', `${a}/${b}`);
    assert.ok(v.num('WowieContextScroll:GetHeight()') >= 256, 'customization reserves at least four full rows, rather than scaling a mostly-header window');
    assert.ok(v.num('WowieContextScroll:GetHeight() / WowieContextPermissions:GetHeight()') >= 0.49);
    assert.equal(v.value('WowieContextRecommended:IsShown()'), 'false', 'overview is replaced, not stacked above customization');
    assert.equal(v.value('Inside(WowieContextClear, WowieContextPermissions)'), 'true');
    assert.equal(v.value('Disjoint(WowieContextClear, WowieContextClose)'), 'true');
    assert.equal(v.value('Disjoint(WowieContextClear, WowieContextCustomize)'), 'true');
  }
  v.run(`
    UIParent:SetSize(600, 440)
    for _, hook in ipairs(UIParent.hooks.OnSizeChanged or {}) do hook(UIParent) end
  `);
  assert.ok(v.num('WowieContextPermissions:GetWidth() * WowieContextPermissions:GetScale()') <= 576);
  assert.ok(v.num('WowieContextPermissions:GetHeight() * WowieContextPermissions:GetScale()') <= 416);
});

test('sharing raises above the workspace and only its header drags without changing permissions', () => {
  const v = vm();
  v.run(`
    Wowie.Toggle(true)
    WowieInput:SetText("untouched draft")
    WowieContextUI.Show()
    BEFORE = Choices()
    LEVEL = WowieContextPermissions:GetFrameLevel()
    WowieContextHeader:GetScript("OnDragStart")(WowieContextHeader)
  `);
  assert.equal(v.value('WowieContextPermissions.strata'), 'FULLSCREEN_DIALOG');
  assert.equal(v.value('WowieContextPermissions:GetScript("OnDragStart")'), 'nil');
  assert.equal(v.value('WowieContextPermissions.moving'), 'true');
  assert.ok(v.num('WowieContextPermissions:GetFrameLevel()') > v.num('LEVEL'));
  v.run('WowieContextHeader:GetScript("OnDragStop")(WowieContextHeader)');
  assert.equal(v.value('WowieContextPermissions.moving'), 'false');
  assert.equal(v.value('Choices()'), v.value('BEFORE'));
  assert.equal(v.value('WowieInput:GetText()'), 'untouched draft');
});
