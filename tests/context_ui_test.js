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
  run('UIParent:SetSize(1280, 900)');
  for (const file of ['Codec.lua', 'Inbox.lua', 'Wowie.lua', 'Context.lua', 'ContextUI.lua']) {
    run(fs.readFileSync(path.join(addon, file), 'utf8'), 'Wowie');
  }
  run(`
    STUB.FireEvent('ADDON_LOADED', 'Wowie')
    STUB.FireEvent('PLAYER_LOGIN')
    function Click(control)
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

test('search, view changes and recycled rows toggle only the displayed permission', () => {
  const v = vm();
  v.run(`
    AddScopes(320)
    WowieContextUI.Show()
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
  v.run(`
    Click(WowieContextTabPrivate)
    EMPTY = #WowieContextPermissions.filtered
    Search('mail')
    PRIVATE = WowieContextPermissions.rows[1].category.id
    Click(WowieContextPermissions.rows[1])
  `);
  assert.equal(v.num('EMPTY'), 0, 'search remains combined with the newly selected view');
  assert.ok(['mail', 'mail_body'].includes(v.value('PRIVATE')));
  assert.deepEqual(v.json('Choices()'), [first, second, 'api:Scope0007', v.value('PRIVATE')].sort());
  assert.equal(v.num('WowieContextUI.Summary().selected'), 4);
  assert.ok(v.num('#WowieContextPermissions.rows') <= v.num('math.ceil(WowieContextScroll:GetHeight() / 64) + 1'));
  assert.equal(v.num('LAST_SUMMARY.selected'), 4);
});

test('selected removal reclamps scrolling and retargets reused rows without losing other choices', () => {
  const v = vm();
  v.run(`
    AddScopes(180)
    WowieContextUI.Show()
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

test('paused sharing keeps editable choices but still blocks real context getters', () => {
  const v = vm();
  v.run(`
    WowieContextUI.Show()
    Click(WowieContextClear)
    Search('carried copper')
    Click(WowieContextPermissions.rows[1].check)
    READS = 0
    function GetMoney() READS = READS + 1; return 12345 end
    Click(WowieContextMaster)
  `);
  assert.deepEqual(v.json('Choices()'), ['money']);
  assert.equal(v.value('WowieContextUI.Summary().enabled'), 'false');
  const denied = v.json("WowieContext.Query({ op = 'snapshot', category = 'money' })");
  assert.equal(denied.ok, false);
  assert.equal(v.num('READS'), 0);
  v.run(`
    Search('identity')
    Click(WowieContextPermissions.rows[1])
  `);
  assert.deepEqual(v.json('Choices()'), ['identity', 'money']);
  assert.equal(v.value('WowieContextPermissions.rows[1].check:GetChecked()'), 'true');
  assert.equal(v.value("WowieContext.IsEnabled('identity')"), 'false');
  assert.equal(v.num('LAST_SUMMARY.selected'), 2);
  v.run('Click(WowieContextMaster)');
  assert.equal(v.value('LAST_SUMMARY.enabled'), 'true');
  assert.equal(v.json("WowieContext.Query({ op = 'snapshot', category = 'money' })").ok, true);
  assert.equal(v.num('READS'), 1);
});

test('summary avoids repeated discovery, reopening discovers late scopes, and clear discards unavailable saved grants', () => {
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
    AddScopes(12)
    WowieContextUI.Show()
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
  v.run('Click(WowieContextDefaults)');
  assert.equal(v.num('LAST_SUMMARY.selected'), 9);
  assert.equal(v.value("WowieContext.IsEnabled('mail_body')"), 'false');
  assert.equal(v.value("WowieContext.IsEnabled('api:Scope0001')"), 'false');
});
