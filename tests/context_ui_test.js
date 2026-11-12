'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const addon = path.join(__dirname, '../addon/WoWAI');
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
  run('UIParent:SetSize(1280, 900)');
  for (const file of ['Codec.lua', 'Inbox.lua', 'WoWAI.lua', 'Context.lua', 'ContextUI.lua']) {
    run(fs.readFileSync(path.join(addon, file), 'utf8'), 'WoWAI');
  }
  run(`
    STUB.FireEvent('ADDON_LOADED', 'WoWAI')
    STUB.FireEvent('PLAYER_LOGIN')
    function Click(control)
      if control.kind == 'CheckButton' then control:SetChecked(not control:GetChecked()) end
      control:GetScript('OnClick')(control)
    end
    function Search(text) WoWAIContextSearch:SetText(text) end
    function ScrollTo(offset)
      local p = WoWAIContextPermissions
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
      for _, category in ipairs(WoWAIContext.Categories()) do
        if category.enabled then ids[#ids + 1] = category.id end
      end
      table.sort(ids)
      return #ids == 0 and '[]' or WoWAIContext.Encode(ids)
    end
    NOTIFICATIONS = 0
    function WoWAI.UpdateSharingSummary()
      NOTIFICATIONS = NOTIFICATIONS + 1
      LAST_SUMMARY = WoWAIContextUI.Summary()
    end
  `);
  return { run, value, json: expression => JSON.parse(value(expression)), num: expression => Number(value(expression)) };
}

test('search, view changes and recycled rows toggle only the displayed permission', () => {
  const v = vm();
  v.run(`
    AddScopes(320)
    WoWAIContextUI.Show()
    Click(WoWAIContextClear)
    Click(WoWAIContextTabAdvanced)
    ScrollTo(64 * 210)
    FIRST = WoWAIContextPermissions.rows[1].category.id
    Click(WoWAIContextPermissions.rows[1].check)
    ScrollTo(64 * 250)
    SECOND = WoWAIContextPermissions.rows[1].category.id
    Click(WoWAIContextPermissions.rows[1])
    Search('Scope0007')
    FILTERED = WoWAIContextPermissions.rows[1].category.id
    Click(WoWAIContextPermissions.rows[1].check)
  `);
  const first = v.value('FIRST');
  const second = v.value('SECOND');
  assert.notEqual(first, second);
  assert.equal(v.value('FILTERED'), 'api:Scope0007');
  assert.deepEqual(v.json('Choices()'), [first, second, 'api:Scope0007'].sort());
  v.run(`
    Click(WoWAIContextTabPrivate)
    EMPTY = #WoWAIContextPermissions.filtered
    Search('mail')
    PRIVATE = WoWAIContextPermissions.rows[1].category.id
    Click(WoWAIContextPermissions.rows[1])
  `);
  assert.equal(v.num('EMPTY'), 0, 'search remains combined with the newly selected view');
  assert.ok(['mail', 'mail_body'].includes(v.value('PRIVATE')));
  assert.deepEqual(v.json('Choices()'), [first, second, 'api:Scope0007', v.value('PRIVATE')].sort());
  assert.equal(v.num('WoWAIContextUI.Summary().selected'), 4);
  assert.ok(v.num('#WoWAIContextPermissions.rows') <= v.num('math.ceil(WoWAIContextScroll:GetHeight() / 64) + 1'));
  assert.equal(v.num('LAST_SUMMARY.selected'), 4);
});

test('selected removal reclamps scrolling and retargets reused rows without losing other choices', () => {
  const v = vm();
  v.run(`
    AddScopes(180)
    WoWAIContextUI.Show()
    Click(WoWAIContextClear)
    WoWAIContext.SetEnabled('identity', true)
    for i = 1, 180 do WoWAIContext.SetEnabled(string.format('api:Scope%04d', i), true) end
    WoWAIContextUI.Show()
    Click(WoWAIContextTabSelected)
    ScrollTo(64 * 10000)
    REMOVED = WoWAIContextPermissions.rows[1].category.id
    BEFORE = WoWAIContextScroll:GetVerticalScroll()
    Click(WoWAIContextPermissions.rows[1].check)
    NEXT = WoWAIContextPermissions.rows[1].category.id
    AFTER = WoWAIContextScroll:GetVerticalScroll()
    Click(WoWAIContextPermissions.rows[1])
  `);
  assert.notEqual(v.value('REMOVED'), v.value('NEXT'));
  assert.equal(v.value('WoWAIDB.settings.sharing[REMOVED]'), 'false');
  assert.equal(v.value('WoWAIDB.settings.sharing[NEXT]'), 'false');
  assert.equal(v.value("WoWAIContext.IsEnabled('identity')"), 'true');
  assert.equal(v.num('WoWAIContextUI.Summary().selected'), 179);
  assert.equal(v.num('#WoWAIContextPermissions.filtered'), 179);
  assert.ok(v.num('AFTER') < v.num('BEFORE'));
  v.run(`
    Search('Scope0001')
    Click(WoWAIContextPermissions.rows[1].check)
  `);
  assert.equal(v.num('#WoWAIContextPermissions.filtered'), 0);
  assert.equal(v.value('WoWAIContextPermissions.empty:IsShown()'), 'true');
  assert.equal(v.num('WoWAIContextScroll:GetVerticalScroll()'), 0);
  assert.equal(v.num('LAST_SUMMARY.selected'), 178);
  assert.equal(v.value("WoWAIContext.IsEnabled('identity')"), 'true');
});

test('paused sharing keeps editable choices but still blocks real context getters', () => {
  const v = vm();
  v.run(`
    WoWAIContextUI.Show()
    Click(WoWAIContextClear)
    Search('carried copper')
    Click(WoWAIContextPermissions.rows[1].check)
    READS = 0
    function GetMoney() READS = READS + 1; return 12345 end
    Click(WoWAIContextMaster)
  `);
  assert.deepEqual(v.json('Choices()'), ['money']);
  assert.equal(v.value('WoWAIContextUI.Summary().enabled'), 'false');
  const denied = v.json("WoWAIContext.Query({ op = 'snapshot', category = 'money' })");
  assert.equal(denied.ok, false);
  assert.equal(v.num('READS'), 0);
  v.run(`
    Search('identity')
    Click(WoWAIContextPermissions.rows[1])
  `);
  assert.deepEqual(v.json('Choices()'), ['identity', 'money']);
  assert.equal(v.value('WoWAIContextPermissions.rows[1].check:GetChecked()'), 'true');
  assert.equal(v.value("WoWAIContext.IsEnabled('identity')"), 'false');
  assert.equal(v.num('LAST_SUMMARY.selected'), 2);
  v.run('Click(WoWAIContextMaster)');
  assert.equal(v.value('LAST_SUMMARY.enabled'), 'true');
  assert.equal(v.json("WoWAIContext.Query({ op = 'snapshot', category = 'money' })").ok, true);
  assert.equal(v.num('READS'), 1);
});

test('summary avoids repeated discovery, reopening discovers late scopes, and clear discards unavailable saved grants', () => {
  const v = vm();
  v.run(`
    local categories = WoWAIContext.Categories
    DISCOVERIES = 0
    WoWAIContext.Categories = function() DISCOVERIES = DISCOVERIES + 1; return categories() end
    WoWAIContextUI.Summary()
    BASELINE = DISCOVERIES
    for i = 1, 30 do WoWAIContextUI.Summary() end
  `);
  assert.equal(v.num('DISCOVERIES'), v.num('BASELINE'));
  v.run(`
    AddScopes(12)
    WoWAIContextUI.Show()
    Click(WoWAIContextTabAdvanced)
  `);
  assert.equal(v.num('#WoWAIContextPermissions.filtered'), 12);
  v.run(`
    WoWAIDB.settings.sharing['api:Unavailable'] = true
    Click(WoWAIContextClear)
  `);
  assert.equal(v.value("WoWAIDB.settings.sharing['api:Unavailable'] == nil"), 'true');
  assert.equal(v.num('LAST_SUMMARY.selected'), 0);
  assert.deepEqual(v.json('Choices()'), []);
  v.run('Click(WoWAIContextDefaults)');
  assert.equal(v.num('LAST_SUMMARY.selected'), 9);
  assert.equal(v.value("WoWAIContext.IsEnabled('mail_body')"), 'false');
  assert.equal(v.value("WoWAIContext.IsEnabled('api:Scope0001')"), 'false');
});
