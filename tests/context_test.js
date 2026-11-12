'use strict';
// Isolated real-Context.lua VM tests; no live client, main addon or transport.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');
const source = fs.readFileSync(path.join(__dirname, '../addon/WoWAI/Context.lua'), 'utf8');

function vm(setup = '') {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = code => {
    if (lauxlib.luaL_loadstring(L, to_luastring(code)) !== lua.LUA_OK ||
        lua.lua_pcall(L, 0, 0, 0) !== lua.LUA_OK) {
      throw new Error(to_jsstring(lua.lua_tostring(L, -1)));
    }
  };
  const evaluate = expression => {
    run(`RESULT = (${expression})`);
    lua.lua_getglobal(L, to_luastring('RESULT'));
    const result = lua.lua_isnil(L, -1) ? null : to_jsstring(lua.lua_tolstring(L, -1));
    lua.lua_pop(L, 1);
    return result;
  };
  run(`
    CLOCK = 123456
    function GetServerTime() return CLOCK end
    function issecurevariable(owner, name) return not (TAINTED and TAINTED[name]) end
    function issecretvalue(value) return type(value) == 'table' and rawget(value, 'SECRET') == true end
    EVENTS = {}
    function CreateFrame()
      local frame = {}
      function frame:RegisterEvent(event) EVENTS[event] = self end
      function frame:SetScript(_, script) self.script = script end
      return frame
    end
    function Fire(event) if EVENTS[event] then EVENTS[event].script(EVENTS[event], event) end end
    WoWAI = {}
    ${setup}
  `);
  run(source);
  lua.lua_pushlightuserdata(L, {});
  lua.lua_setglobal(L, to_luastring('OPAQUE'));
  return {
    run, evaluate,
    json: expression => JSON.parse(evaluate(expression)),
    query: request => JSON.parse(evaluate(`WoWAIContext.Query(${request})`)),
    snapshot: () => JSON.parse(evaluate('WoWAIContext.Snapshot()')),
    only: (...ids) => run(`
      for _, category in ipairs(WoWAIContext.Categories()) do WoWAIContext.SetEnabled(category.id, false) end
      ${ids.map(id => `WoWAIContext.SetEnabled(${JSON.stringify(id)}, true)`).join('\n')}
    `),
  };
}
function entries(response) {
  assert.equal(response.ok, true, response.error);
  return response.value.items;
}
function scalar(response) {
  assert.equal(response.ok, true, response.error);
  assert.equal(response.value.kind, 'scalar');
  return response.value.value;
}
const API_SETUP = `
  CALLS, CONSTRUCTORS = 0, 0
  C_Item = {
    GetCount = function() CALLS = CALLS + 1; return 7 end,
    GetItemInfo = function(id) CALLS = CALLS + 1; return { id = id, label = 'item' } end,
    GetOptional = function(first, second) CALLS = CALLS + 1; return first, second end,
    GetLocation = function(location) CALLS = CALLS + 1; return location.bag, location.slot end,
    GetVector = function(point) CALLS = CALLS + 1; return point.x + point.y end,
    GetMapPoint = function(point) CALLS = CALLS + 1; return point.mapID end,
    GetEnum = function(value) CALLS = CALLS + 1; return value end,
    GetRecord = function(value) CALLS = CALLS + 1; return value.id end,
    SetItem = function() error('mutator invoked') end,
    GetAndClear = function() error('mutating getter invoked') end,
    GetScript = function() error('unsafe getter invoked') end,
    GetSecret = function() return { public = 5, private = { SECRET = true, text = 'NEVER-LEAK' } } end,
    GetLarge = function() local t = {}; for i = 1, 1200 do t[i] = i end; return t end,
    GetNil = function() return nil, 9 end,
    GetFailure = function() error('PRIVATE-ERROR-TEXT') end,
  }
  function GetGlobalCount() CALLS = CALLS + 1; return 42 end
  function UnitSetRole() error('protected action invoked') end
  function RunScript() error('script invoked') end
  function GetInboxText() error('mail read mutation invoked') end
  Enum = { TestMode = { Player = 1, Pet = 2 } }
  local numberReturn = { { Name = 'value', Type = 'number' } }
  local function f(name, args, returns) return { Name = name, Arguments = args, Returns = returns or numberReturn } end
  APIDocumentation = { systems = {
    { Name = 'Item', Namespace = 'C_Item', Functions = {
      f('GetCount'), f('GetItemInfo', { { Name = 'itemID', Type = 'number' } }),
      f('GetOptional', { { Name = 'first', Type = 'number', Nilable = true }, { Name = 'second', Type = 'number' } }),
      f('GetLocation', { { Name = 'location', Type = 'ItemLocation' } }),
      f('GetVector', { { Name = 'point', Type = 'vector2' } }),
      f('GetMapPoint', { { Name = 'point', Type = 'UiMapPoint' } }),
      f('GetEnum', { { Name = 'mode', Type = 'TestMode', Default = 'Player' } }),
      f('GetRecord', { { Name = 'record', Type = 'TestRecord' } }),
      f('SetItem'), f('GetAndClear'), f('GetScript'), f('GetSecret'), f('GetLarge'),
      f('GetNil', nil, { { Name = 'missing', Type = 'number', Nilable = true }, { Name = 'present', Type = 'number' } }),
      f('GetFailure'),
    } },
    { Name = 'PlayerInfo', Functions = { f('GetGlobalCount'), f('UnitSetRole'), f('RunScript'), f('GetInboxText') } },
  }, tables = { { Name = 'TestRecord', Type = 'Structure', Fields = { { Name = 'id', Type = 'number' }, { Name = 'note', Type = 'string', Nilable = true } } } } }
  ItemLocation = {}
  function ItemLocation:CreateFromBagAndSlot(bag, slot) CONSTRUCTORS = CONSTRUCTORS + 1; return { bag = bag, slot = slot } end
  function ItemLocation:CreateFromEquipmentSlot(slot) CONSTRUCTORS = CONSTRUCTORS + 1; return { equipmentSlot = slot } end
  function CreateVector2D(x, y) CONSTRUCTORS = CONSTRUCTORS + 1; return { x = x, y = y } end
  UiMapPoint = {}
  function UiMapPoint.CreateFromCoordinates(mapID, x, y) CONSTRUCTORS = CONSTRUCTORS + 1; return { mapID = mapID, x = x, y = y } end
`;

test('conservative persistent choices and independent master switch', () => {
  const v = vm(API_SETUP);
  const categories = v.json('WoWAIContext.Encode(WoWAIContext.Categories())');
  const defaults = categories.filter(c => c.enabled).map(c => c.id);
  assert.deepEqual(defaults, ['identity', 'location', 'money', 'equipment', 'inventory', 'spells', 'professions', 'talents', 'quests']);
  for (const id of ['bank', 'mail', 'mail_body', 'chat', 'guild', 'friends', 'group', 'target', 'ui', 'addons', 'api:C_Item', 'api:PlayerInfo']) {
    const c = categories.find(c => c.id === id);
    assert.ok(c, id); assert.equal(c.enabled, false); assert.equal(c.sensitive, true);
  }
  v.run(`WoWAIContext.SetEnabled('inventory', false); WoWAIContext.SetEnabled('mail', true); WoWAIDB.settings.context = false`);
  assert.equal(v.evaluate("tostring(WoWAIContext.IsEnabled('mail'))"), 'false');
  assert.equal(v.json('WoWAIContext.Encode(WoWAIContext.Categories())').find(c => c.id === 'mail').enabled, true);
  assert.deepEqual(v.snapshot().enabled, []);
  assert.deepEqual(v.snapshot().data, {});
  assert.equal(v.evaluate('WoWAIContext.Summary()'), '');
  v.run('WoWAIDB.settings.context = true');
  assert.equal(v.evaluate("tostring(WoWAIContext.IsEnabled('inventory'))"), 'false');
  assert.equal(v.query("{op='api',name='C_Item.GetCount'}").ok, false);
  v.run('WoWAIContext.ResetDefaults()');
  assert.equal(v.evaluate("tostring(WoWAIContext.IsEnabled('inventory'))"), 'true');
  assert.equal(v.evaluate("tostring(WoWAIContext.IsEnabled('mail'))"), 'false');
});

test('disabled snapshots, summaries and queries never call data providers', () => {
  const v = vm(`CALLS=0; function GetMoney() CALLS=CALLS+1; return 10 end; function UnitName() error('identity must not run') end`);
  v.only();
  assert.deepEqual(v.snapshot().data, {});
  assert.equal(v.evaluate('WoWAIContext.Summary()'), '');
  assert.equal(v.query("{op='snapshot',category='money'}").ok, false);
  assert.equal(v.evaluate('tostring(CALLS)'), '0');
  v.run("WoWAIContext.SetEnabled('money',true)");
  const profile = v.snapshot();
  assert.deepEqual(profile.enabled, ['money']);
  assert.equal(profile.data.money.copper, 10);
});

test('a snapshot and its short summary describe the same captured values, without stale reuse next turn', () => {
  const v = vm('BALANCE=10000; function GetMoney() BALANCE=BALANCE+1; return BALANCE end');
  v.only('money');
  v.run('PROFILE, SUMMARY = WoWAIContext.Snapshot()');
  const first = v.json('PROFILE').data.money.copper;
  assert.ok(v.evaluate('SUMMARY').includes(String(first)));
  v.run('PROFILE, SUMMARY = WoWAIContext.Snapshot()');
  const next = v.json('PROFILE').data.money.copper;
  assert.ok(next > first);
  assert.ok(v.evaluate('SUMMARY').includes(String(next)));
  v.only();
  v.run('PROFILE, SUMMARY = WoWAIContext.Snapshot()');
  assert.deepEqual(v.json('PROFILE').data, {});
  assert.equal(v.evaluate('SUMMARY'), '');
});

test('full inventory preserves every slot, carried stack total, bag link and equipped slot', () => {
  const v = vm(`
    NUM_TOTAL_EQUIPPED_BAG_SLOTS=5; KEYRING_CONTAINER=-2; INVSLOT_LAST_EQUIPPED=19
    C_Container = {
      GetContainerNumSlots=function(bag) if bag==0 then return 300 elseif bag==1 or bag==5 or bag==-2 then return 1 else return 0 end end,
      GetContainerNumFreeSlots=function() return 0,0 end,
      ContainerIDToInventoryID=function(bag) return 19+bag end,
      GetContainerItemInfo=function(bag,slot)
        if bag==0 and slot==150 then return nil end
        return {itemID=77,stackCount=bag==0 and 2 or (bag==1 and 3 or (bag==5 and 4 or 1)),hyperlink='item:77'}
      end,
    }
    function GetInventoryItemID(_,slot) if slot==1 then return 88 elseif slot>=20 then return 99 end end
    function GetInventoryItemLink(_,slot) if slot==1 then return 'item:88' elseif slot>=20 then return 'item:99' end end
    function GetInventoryItemCount() return 1 end
    function GetInventoryItemDurability() return 5,10 end
    C_Item={GetItemInfo=function(id) if id==88 then return nil end; return 'Cached item','item:77',2,12,1,'Trade Goods','Cloth',20 end}
  `);
  v.only('inventory', 'equipment');
  const data = v.snapshot().data;
  assert.equal(data.inventory.bags.length, 7);
  const bag = data.inventory.bags.find(b => b.bag === 0);
  assert.equal(bag.slots.length, 300);
  assert.equal(bag.slots[149].empty, true);
  assert.equal(bag.slots[299].slot, 300);
  assert.equal(bag.slots[299].link, 'item:77');
  assert.equal(data.inventory.itemCounts['77'], 606);
  assert.equal(data.inventory.bags.find(b => b.bag === 5).link, 'item:99');
  assert.equal(data.equipment.slots.length, 20);
  assert.equal(data.equipment.slots[1].itemID, 88);
  assert.equal(data.equipment.slots[1].details.status, 'unavailable');
  assert.equal(data.equipment.slots[2].empty, true);
  const page = v.query("{op='snapshot',category='inventory',path={'bags',1,'slots'},offset=295,limit=5}");
  assert.equal(page.value.total, 300); assert.equal(page.value.complete, true);
  assert.equal(page.value.items.length, 5); assert.equal(page.value.items[4].slot, 300);
});

test('modern spellbooks include hidden skill lines, future/offspec spells, flyouts and pet spells', () => {
  const v = vm(`
    Enum={SpellBookSpellBank={Player=0,Pet=1},SpellBookItemType={Spell=1,FutureSpell=2,Flyout=4}}
    C_SpellBook={
      GetNumSpellBookSkillLines=function() return 2 end,
      GetSpellBookSkillLineInfo=function(i) return {name='Line '..i,itemIndexOffset=i==1 and 0 or 3,numSpellBookItems=i==1 and 3 or 2,shouldHide=i==2} end,
      GetSpellBookItemInfo=function(slot,bank) return {itemType=(bank==0 and slot==2) and 2 or ((bank==0 and slot==3) and 4 or 1),actionID=slot==3 and 99 or 1000+slot,spellID=1000+slot,isOffSpec=bank==0 and slot==5} end,
      GetSpellBookItemName=function(slot,bank) return (bank==1 and 'Pet ' or 'Spell ')..slot,'Rank '..slot end,
      GetSpellBookItemLink=function(slot) return 'spell:'..(1000+slot) end,
      GetSpellBookItemLevelLearned=function(slot) return slot*10 end,
      HasPetSpells=function() return 2,'Pet' end,
      IsSpellKnown=function(id) return id~=1005 end,
    }
    function GetFlyoutInfo() return 'Flyout','Description',2,true end
    function GetFlyoutSlotInfo(i,j) return 2000+j,nil,j==1,'Flyout '..j end
  `);
  v.only('spells');
  const d = v.snapshot().data.spells;
  assert.equal(d.player.length, 5); assert.equal(d.pet.length, 2);
  assert.equal(d.skillLines[1].shouldHide, true);
  assert.equal(d.player[1].future, true); assert.equal(d.player[1].known, false);
  assert.equal(d.player[4].offSpec, true); assert.equal(d.player[4].known, false);
  assert.equal(d.player[2].flyout.length, 2); assert.equal(d.player[2].flyout[1].known, false);
  assert.equal(d.player[0].rank, 'Rank 1'); assert.equal(d.pet[1].name, 'Pet 2');
});

test('legacy bag and spell APIs retain counts, ranks and future distinction', () => {
  const v = vm(`
    NUM_BAG_SLOTS=0
    function GetContainerNumSlots() return 1 end
    function GetContainerNumFreeSlots() return 0,0 end
    function GetContainerItemInfo() return 'texture',12,false,1,false,false,'item:17',false,false,17 end
    function GetItemInfo() return 'Legacy item','item:17' end
    function GetNumSpellTabs() return 1 end
    function GetSpellTabInfo() return 'General',nil,0,2 end
    function GetSpellBookItemInfo(slot) return slot==2 and 'FUTURESPELL' or 'SPELL',200+slot end
    function GetSpellBookItemName(slot) return 'Legacy '..slot,'Rank 3' end
    function GetSpellLink(slot) return 'spell:'..slot end
    function HasPetSpells() return 0 end
    function IsSpellKnown() return true end
  `);
  v.only('inventory', 'spells');
  const d = v.snapshot().data;
  assert.equal(d.inventory.itemCounts['17'], 12);
  assert.equal(d.spells.player[0].rank, 'Rank 3');
  assert.equal(d.spells.player[1].known, false);
  assert.equal(d.spells.player[1].future, true);
});

test('skills preserve normalized professions plus detailed secondary/weapon/child lines', () => {
  const v = vm(`
    function WoWAI.SkillLines() return {{name='Alchemy',rank=125,maxRank=150},{name='Fishing',rank=20,maxRank=75},{name='Swords',rank=80,maxRank=100}} end
    C_SkillInfo={GetNumSkillLines=function() return 4 end,GetSkillLineInfo=function(i) return {name=({'Alchemy','Fishing','Swords','Child'})[i],skillID=i,rank=i*20,maxRank=150,parentSkillLineID=i==4 and 1 or 0} end}
    TradeSkillFrame={IsShown=function() return false end}
    C_TradeSkillUI={GetAllRecipeIDs=function() error('closed recipe provider invoked') end}
  `);
  v.only('professions');
  const d = v.snapshot().data.professions;
  assert.equal(d.skills.length, 3); assert.equal(d.skills[2].name, 'Swords');
  assert.equal(d.skillDetails.length, 4); assert.equal(d.skillDetails[3].parentSkillLineID, 1);
  assert.equal(d.recipes.status, 'closed');
  assert.match(v.evaluate('WoWAIContext.Summary()'), /Fishing 20\/75/);
});

test('unknown or closed windows are explicit and never read cached bank/mail contents', () => {
  const v = vm(`
    BANKREADS,MAILREADS=0,0
    C_Container={GetContainerNumSlots=function() BANKREADS=BANKREADS+1;return 0 end,GetContainerNumFreeSlots=function() return 0 end}
    function GetInboxNumItems() MAILREADS=MAILREADS+1; return 0,0 end
  `);
  v.only('bank', 'mail');
  assert.equal(v.snapshot().data.bank.status, 'unknown');
  assert.equal(v.snapshot().data.mail.status, 'unknown');
  assert.equal(v.evaluate('tostring(BANKREADS+MAILREADS)'), '0');
  v.run("Fire('BANKFRAME_CLOSED'); Fire('MAIL_CLOSED')");
  assert.equal(v.snapshot().data.bank.status, 'closed');
  assert.equal(v.snapshot().data.mail.status, 'closed');
  assert.equal(v.evaluate('tostring(BANKREADS+MAILREADS)'), '0');
  v.run("Fire('BANKFRAME_OPENED'); Fire('MAIL_SHOW')");
  assert.ok(v.snapshot().data.bank.bags.length > 0);
  assert.equal(v.snapshot().data.mail.status, 'available');
});

test('missing optional APIs and restricted providers report unavailable data without crashing', () => {
  const v = vm();
  v.only('inventory', 'spells', 'money', 'identity');
  const d = v.snapshot().data;
  assert.equal(d.inventory.status, 'unavailable');
  assert.equal(d.spells.status, 'unavailable');
  assert.equal(d.money.status, 'unavailable');
  assert.equal(d.identity.status, 'partial');
  assert.ok(d.identity.unavailable.includes('GetBuildInfo unavailable'));
  v.run("function GetMoney() error('PRIVATE-ERROR') end");
  assert.doesNotMatch(v.evaluate('WoWAIContext.Snapshot()'), /PRIVATE-ERROR/);
});

test('documented native namespace and global-system getters are discoverable, never eagerly invoked', () => {
  const v = vm(API_SETUP);
  v.only('api:C_Item', 'api:PlayerInfo');
  const d = v.snapshot();
  assert.equal(d.data['api:C_Item'].status, 'query-only');
  assert.equal(v.evaluate('tostring(CALLS)'), '0');
  const catalog = entries(v.query("{op='catalog',category='api:C_Item',search='GetItemInfo'}"));
  assert.equal(catalog.length, 1); assert.equal(catalog[0].arguments[0].type, 'number');
  assert.equal(catalog[0].category, 'api:C_Item');
  assert.equal(scalar(v.query("{op='api',name='C_Item.GetCount',path={'returns',1,'value'}}")), 7);
  assert.equal(scalar(v.query("{op='api',name='GetGlobalCount',path={'returns',1,'value'}}")), 42);
  assert.equal(scalar(v.query("{op='api',name='C_Item.GetItemInfo',args={13},path={'returns',1,'value','id'}}")), 13);
  v.run("WoWAIContext.SetEnabled('api:C_Item',false)");
  assert.equal(v.query("{op='api',name='C_Item.GetCount',category='api:PlayerInfo'}").ok, false);
  assert.equal(v.evaluate('tostring(CALLS)'), '3');
});

test('mutators, script/debug getters, undocumented and tainted implementations are rejected', () => {
  const v = vm(API_SETUP);
  v.only('api:C_Item', 'api:PlayerInfo');
  for (const name of ['C_Item.SetItem', 'C_Item.GetAndClear', 'C_Item.GetScript', 'RunScript', 'UnitSetRole', 'GetInboxText', 'os.execute', 'C_Item.NoSuchGetter']) {
    assert.equal(v.query(`{op='api',name=${JSON.stringify(name)}}`).ok, false, name);
  }
  const names = entries(v.query("{op='catalog',category='api:C_Item'}")).map(f => f.name);
  assert.ok(!names.includes('C_Item.SetItem')); assert.ok(!names.includes('C_Item.GetScript'));
  v.run("TAINTED={GetCount=true}");
  assert.equal(v.query("{op='api',name='C_Item.GetCount'}").ok, false);
  assert.equal(v.evaluate('tostring(CALLS)'), '0');
});

test('typed arguments, nullable holes, enum defaults and structures validate before native calls', () => {
  const v = vm(API_SETUP);
  v.only('api:C_Item');
  assert.equal(scalar(v.query("{op='api',name='C_Item.GetOptional',args={[2]=8,n=2},path={'returns',2,'value'}}")), 8);
  assert.equal(scalar(v.query("{op='api',name='C_Item.GetEnum',path={'returns',1,'value'}}")), 1);
  assert.equal(scalar(v.query("{op='api',name='C_Item.GetEnum',args={'Pet'},path={'returns',1,'value'}}")), 2);
  assert.equal(scalar(v.query("{op='api',name='C_Item.GetRecord',args={{id=23}},path={'returns',1,'value'}}")), 23);
  assert.equal(scalar(v.query("{op='api',name='C_Item.GetLocation',args={{type='ItemLocation',bag=0,slot=4}},path={'returns',2,'value'}}")), 4);
  assert.equal(scalar(v.query("{op='api',name='C_Item.GetVector',args={{type='Vector2D',x=.2,y=.3}},path={'returns',1,'value'}}")), .5);
  assert.equal(scalar(v.query("{op='api',name='C_Item.GetMapPoint',args={{type='UiMapPoint',mapID=1453,x=.2,y=.3}},path={'returns',1,'value'}}")), 1453);
  const calls = v.evaluate('tostring(CALLS)');
  for (const request of [
    "{op='api',name='C_Item.GetItemInfo',args={'not-a-number'}}",
    "{op='api',name='C_Item.GetCount',args={1}}",
    "{op='api',name='C_Item.GetRecord',args={{id=1,extra=true}}}",
    "{op='api',name='C_Item.GetEnum',args={'invalid'}}",
    "{op='api',name='C_Item.GetLocation',args={{type='ItemLocation',bag=0,slot=0}}}",
    "{op='api',name='C_Item.GetOptional',args={n=5}}",
    "{op='api',name='C_Item.GetCount',args={function() end}}",
  ]) assert.equal(v.query(request).ok, false, request);
  assert.equal(v.evaluate('tostring(CALLS)'), calls);
  v.run("WoWAIContext.SetEnabled('api:C_Item',false)");
  const constructors = v.evaluate('tostring(CONSTRUCTORS)');
  assert.equal(v.query("{op='api',name='C_Item.GetLocation',args={{type='ItemLocation',bag=0,slot=2}}}").ok, false);
  assert.equal(v.evaluate('tostring(CONSTRUCTORS)'), constructors);
});

test('secret values, inaccessible tables, cycles, userdata and metamethods cannot leak or crash serialization', () => {
  const v = vm(`
    local cyclic = {}; cyclic.self=cyclic
    VALUE={public='fine',secret={SECRET=true,text='NEVER-LEAK'},cycle=cyclic,unsupported=function() end}
    setmetatable(VALUE,{__pairs=function() error('must not run') end,__tostring=function() error('must not run') end})
  `);
  const text = v.evaluate('WoWAIContext.Encode(VALUE)');
  assert.doesNotMatch(text, /NEVER-LEAK/);
  const value = JSON.parse(text);
  assert.equal(value.public, 'fine'); assert.equal(value.secret.status, 'unavailable');
  assert.equal(value.cycle.self.reason, 'cycle'); assert.equal(value.unsupported.status, 'unavailable');
  assert.equal(v.json('WoWAIContext.Encode(OPAQUE)').status, 'unavailable');
  v.run("function canaccesstable(t) return t ~= VALUE end");
  assert.equal(v.json('WoWAIContext.Encode(VALUE)').reason, 'inaccessible table');
});

test('API returns preserve nil positions, redact secrets and hide exception text', () => {
  const v = vm(API_SETUP);
  v.only('api:C_Item');
  const missing = entries(v.query("{op='api',name='C_Item.GetNil',path={'returns'}}"));
  assert.equal(missing.length, 2); assert.equal(missing[0].isNil, true); assert.equal(missing[1].value, 9);
  const secretResult = v.query("{op='api',name='C_Item.GetSecret',path={'returns',1,'value','private'}}");
  assert.equal(secretResult.ok, true); assert.doesNotMatch(JSON.stringify(secretResult), /NEVER-LEAK/);
  const failure = v.query("{op='api',name='C_Item.GetFailure'}");
  assert.equal(failure.ok, false); assert.doesNotMatch(JSON.stringify(failure), /PRIVATE-ERROR-TEXT/);
});

test('nested large API results paginate with explicit totals, completion and stable offsets', () => {
  const v = vm(API_SETUP);
  v.only('api:C_Item');
  const first = v.query("{op='api',name='C_Item.GetLarge',path={'returns',1,'value'},limit=500}");
  assert.equal(first.value.total, 1200); assert.equal(first.value.items.length, 500);
  assert.equal(first.value.complete, false); assert.equal(first.nextOffset, 500);
  const last = v.query("{op='api',name='C_Item.GetLarge',path={'returns',1,'value'},offset=1000,limit=500}");
  assert.equal(last.value.items.length, 200); assert.equal(last.value.items[199], 1200);
  assert.equal(last.value.complete, true); assert.equal(last.nextOffset, undefined);
  assert.equal(v.query("{op='api',name='C_Item.GetLarge',limit=501}").ok, false);
  assert.equal(v.query("{op='api',name='C_Item.GetCount',path={'missing'}}").ok, false);
});

test('addon tables and frame getters require separate sensitive permissions and cannot execute scripts', () => {
  const v = vm(`
    TABLE_CALLS, FRAME_CALLS=0,0
    SavedPrivate={name='private',nested={value=8},secret={SECRET=true,text='NEVER-LEAK'}}
    setmetatable(SavedPrivate,{__index=function() TABLE_CALLS=TABLE_CALLS+1; return 'invented' end})
    WorldMapFrame={GetMapID=function() FRAME_CALLS=FRAME_CALLS+1;return 1453 end,SetMapID=function() error('setter') end,GetScript=function() error('script getter') end}
    EvilFrame=setmetatable({}, {__index=function() TABLE_CALLS=TABLE_CALLS+1;error('untrusted method resolver') end})
  `);
  v.only();
  assert.equal(v.query("{op='table',path={'SavedPrivate'}}").ok, false);
  assert.equal(v.query("{op='frame',frame='WorldMapFrame',method='GetMapID'}").ok, false);
  assert.equal(v.evaluate('tostring(FRAME_CALLS)'), '0');
  v.run("WoWAIContext.SetEnabled('addons',true);WoWAIContext.SetEnabled('ui',true)");
  assert.equal(scalar(v.query("{op='table',path={'SavedPrivate','nested','value'}}")), 8);
  assert.equal(v.query("{op='table',path={'SavedPrivate','missing'}}").ok, false);
  assert.equal(v.evaluate('tostring(TABLE_CALLS)'), '0');
  assert.equal(scalar(v.query("{op='frame',frame='WorldMapFrame',method='GetMapID',path={'returns',1,'value'}}")), 1453);
  for (const method of ['SetMapID', 'GetScript', 'Click', 'RunScript']) assert.equal(v.query(`{op='frame',frame='WorldMapFrame',method='${method}'}`).ok, false);
  assert.equal(v.query("{op='frame',frame='EvilFrame',method='GetMapID'}").ok, false);
  assert.equal(v.evaluate('tostring(TABLE_CALLS)'), '0');
  assert.doesNotMatch(JSON.stringify(v.query("{op='table',path={'SavedPrivate'}}")), /NEVER-LEAK/);
});

test('summary respects every category, never leaks social fields and stays within 900 UTF-8 bytes', () => {
  const v = vm(`
    function GetBuildInfo() return '1.60.2','123','date',16001 end
    function UnitName() return 'Hero' end
    function GetRealmName() return 'Realm' end
    function UnitLevel() return 60 end
    function UnitRace() return 'Human' end
    function UnitClass() return 'Mage' end
    function UnitFactionGroup() return 'Alliance' end
    function GetZoneText() return 'Stormwind' end
    function GetSubZoneText() return 'Trade District' end
    function GetMoney() return 999 end
    function GetGuildInfo() error('unselected guild must not run') end
    function WoWAI.SkillLines() local t={};for i=1,100 do t[i]={name=string.rep('é',15)..i,rank=20,maxRank=75} end;return t end
  `);
  v.only('identity', 'location', 'money', 'professions');
  const text = v.evaluate('WoWAIContext.Summary()');
  assert.match(text, /World of Warcraft: Forever/); assert.match(text, /Hero/); assert.match(text, /Stormwind/);
  assert.ok(Buffer.byteLength(text) <= 900);
  v.only('money');
  assert.equal(v.evaluate('WoWAIContext.Summary()'), 'Copper: 999');
  v.run('CLOCK=123457');
  assert.equal(v.snapshot().capturedAt, 123457);
});

test('missing native documentation is explicit and late-loaded documentation is discovered', () => {
  const v = vm();
  assert.equal(v.query("{op='catalog'}").documentationStatus, 'unavailable');
  assert.match(v.query("{op='catalog',category='api:C_Item'}").error, /documentation unavailable/);
  v.run(API_SETUP);
  v.run("WoWAIContext.SetEnabled('api:C_Item',true)");
  assert.equal(v.query("{op='catalog',category='api:C_Item'}").documentationStatus, 'available');
  assert.equal(scalar(v.query("{op='api',name='C_Item.GetCount',path={'returns',1,'value'}}")), 7);
});

test('mail bodies require their explicit opt-in and open mailbox; snapshots retain every body', () => {
  const v = vm(`
    BODY_READS,LOADED=0,3
    function GetInboxNumItems() return LOADED,LOADED end
    function GetInboxHeaderInfo(index) return nil,'stationery','Sender','Subject '..index end
    function GetInboxItem() return nil end
    function GetInboxText(index) BODY_READS=BODY_READS+1;return 'PRIVATE BODY '..index,'stationery',false end
  `);
  v.only('mail');
  v.run("Fire('MAIL_SHOW')");
  const headers = v.snapshot();
  assert.equal(headers.data.mail.entries.length, 3);
  assert.equal(headers.data.mail_body, undefined);
  assert.equal(headers.data.mail.entries[0].body, undefined);
  assert.equal(v.evaluate('tostring(BODY_READS)'), '0');
  assert.equal(v.query("{op='snapshot',category='mail_body'}").ok, false);
  v.only('mail_body');
  assert.equal(v.evaluate('WoWAIContext.Summary()'), '');
  v.run("Fire('MAIL_CLOSED')");
  assert.equal(v.snapshot().data.mail_body.status, 'closed');
  assert.equal(v.evaluate('tostring(BODY_READS)'), '0');
  v.run("Fire('MAIL_SHOW');LOADED=650");
  const full = v.snapshot();
  assert.deepEqual(full.enabled, ['mail_body']);
  assert.equal(full.data.mail_body.entries.length, 650);
  assert.equal(full.data.mail_body.entries[649].text, 'PRIVATE BODY 650');
  assert.equal(full.data.mail_body.entries[0].returns['2'], 'stationery');
  assert.match(full.data.mail_body.sideEffect, /marks messages as read/);
  const page = v.query("{op='snapshot',category='mail_body',path={'entries'},offset=500,limit=100}");
  assert.equal(page.value.total, 650);
  assert.equal(page.value.complete, false);
  assert.equal(page.nextOffset, 600);
  assert.equal(page.value.items[0].text, 'PRIVATE BODY 501');
  const reads = v.evaluate('tostring(BODY_READS)');
  v.run("WoWAIContext.SetEnabled('mail_body',false)");
  assert.equal(v.query("{op='snapshot',category='mail_body'}").ok, false);
  assert.equal(v.snapshot().data.mail_body, undefined);
  assert.equal(v.evaluate('tostring(BODY_READS)'), reads);
});

test('native mail-body getter needs namespace plus current explicit mail_body permission', () => {
  const v = vm(API_SETUP + `
    BODY_READS=0
    function GetInboxText(index) BODY_READS=BODY_READS+1;return 'PRIVATE BODY '..index end
    local funcs=APIDocumentation.systems[2].Functions
    funcs[#funcs].Arguments={{Name='inboxIndex',Type='luaIndex'}}
    function SendMail() error('send invoked') end
    function DeleteInboxItem() error('delete invoked') end
    function TakeInboxMoney() error('take invoked') end
    for _,name in ipairs({'SendMail','DeleteInboxItem','TakeInboxMoney'}) do
      funcs[#funcs+1]={Name=name,Returns={{Name='result',Type='bool'}}}
    end
  `);
  v.only('mail', 'api:PlayerInfo');
  v.run("Fire('MAIL_SHOW')");
  assert.equal(v.query("{op='api',name='GetInboxText',args={1}}").ok, false);
  assert.equal(v.evaluate('tostring(BODY_READS)'), '0');
  const catalog = entries(v.query("{op='catalog',category='api:PlayerInfo',search='GetInboxText'}"));
  assert.equal(catalog[0].requiredPermission, 'mail_body');
  assert.match(catalog[0].sideEffect, /marks messages as read/);
  v.run("WoWAIContext.SetEnabled('mail_body',true)");
  assert.equal(scalar(v.query("{op='api',name='GetInboxText',args={1},path={'returns',1,'value'}}")), 'PRIVATE BODY 1');
  v.run("WoWAIContext.SetEnabled('mail_body',false)");
  assert.equal(v.query("{op='api',name='GetInboxText',args={1}}").ok, false);
  v.run("WoWAIContext.SetEnabled('mail_body',true);Fire('MAIL_CLOSED')");
  assert.equal(v.query("{op='api',name='GetInboxText',args={1}}").ok, false);
  v.run("Fire('MAIL_SHOW');WoWAIDB.settings.context=false");
  assert.equal(v.query("{op='api',name='GetInboxText',args={1}}").ok, false);
  v.run("WoWAIDB.settings.context=true;WoWAIContext.SetEnabled('api:PlayerInfo',false)");
  assert.equal(v.query("{op='api',name='GetInboxText',args={1}}").ok, false);
  v.run("WoWAIContext.SetEnabled('api:PlayerInfo',true)");
  for (const name of ['SendMail', 'DeleteInboxItem', 'TakeInboxMoney']) {
    assert.equal(v.query(`{op='api',name='${name}'}`).ok, false);
  }
  assert.equal(v.evaluate('tostring(BODY_READS)'), '1');
});

test('advanced Unit namespace exposes documented non-player data getters but never Unit actions', () => {
  const v = vm(`
    UNIT_READS,UNIT_ACTIONS=0,0
    function UnitName(token) UNIT_READS=UNIT_READS+1;return 'Name of '..token,'OtherRealm' end
    function UnitHealth(token,predicted) UNIT_READS=UNIT_READS+1;assert(token=='target');assert(predicted==true);return 5432 end
    function UnitPosition(token) UNIT_READS=UNIT_READS+1;assert(token=='focus');return 10,20,30,1453 end
    function UnitStat(token,index) UNIT_READS=UNIT_READS+1;assert(token=='party1');return index*10,index*11,1,0 end
    function UnitSetRole() UNIT_ACTIONS=UNIT_ACTIONS+1;return true end
    function UnitSwitchToVehicleSeat() UNIT_ACTIONS=UNIT_ACTIONS+1;return true end
    function UnitUnapprovedAction() UNIT_ACTIONS=UNIT_ACTIONS+1;return true end
    local function arg(name,typ) return {Name=name,Type=typ} end
    local function ret(name,typ) return {Name=name,Type=typ} end
    APIDocumentation={systems={{Name='Unit',Functions={
      {Name='UnitName',Arguments={arg('unit','UnitToken')},Returns={ret('name','cstring'),ret('realm','cstring')}},
      {Name='UnitHealth',Arguments={arg('unit','UnitTokenPvPRestrictedForAddOns'),{Name='usePredicted',Type='bool',Default=true}},Returns={ret('health','number')}},
      {Name='UnitPosition',Arguments={arg('unit','UnitToken')},Returns={ret('x','number'),ret('y','number'),ret('z','number'),ret('mapID','number')}},
      {Name='UnitStat',Arguments={arg('unit','UnitToken'),arg('index','luaIndex')},Returns={ret('current','number'),ret('effective','number'),ret('positive','number'),ret('negative','number')}},
      {Name='UnitSetRole',Arguments={arg('unit','UnitToken'),arg('role','string')},Returns={ret('result','bool')}},
      {Name='UnitSwitchToVehicleSeat',Arguments={arg('unit','UnitToken'),arg('seat','luaIndex')},Returns={ret('result','bool')}},
      {Name='UnitUnapprovedAction',Returns={ret('result','bool')}},
    }}}}
  `);
  const choices = v.json('WoWAIContext.Encode(WoWAIContext.Categories())');
  assert.equal(choices.find(c => c.id === 'api:Unit').enabled, false);
  assert.equal(v.query("{op='api',name='UnitName',args={'mouseover'}}").ok, false);
  assert.equal(v.evaluate('tostring(UNIT_READS)'), '0');
  v.only('api:Unit');
  const names = entries(v.query("{op='catalog',category='api:Unit'}")).map(f => f.name);
  for (const name of ['UnitName', 'UnitHealth', 'UnitPosition', 'UnitStat']) assert.ok(names.includes(name), name);
  for (const name of ['UnitSetRole', 'UnitSwitchToVehicleSeat', 'UnitUnapprovedAction']) assert.ok(!names.includes(name), name);
  const name = v.query("{op='api',name='UnitName',category='identity',args={'mouseover'},path={'returns',1,'value'}}");
  assert.equal(name.category, 'api:Unit');
  assert.equal(scalar(name), 'Name of mouseover');
  assert.equal(scalar(v.query("{op='api',name='UnitHealth',args={'target'},path={'returns',1,'value'}}")), 5432);
  assert.equal(scalar(v.query("{op='api',name='UnitPosition',args={'focus'},path={'returns',4,'value'}}")), 1453);
  assert.equal(scalar(v.query("{op='api',name='UnitStat',args={'party1',3},path={'returns',2,'value'}}")), 33);
  for (const name of ['UnitSetRole', 'UnitSwitchToVehicleSeat', 'UnitUnapprovedAction']) {
    assert.equal(v.query(`{op='api',name='${name}',args={'target','TANK'}}`).ok, false);
  }
  assert.equal(v.evaluate('tostring(UNIT_ACTIONS)'), '0');
  assert.equal(v.evaluate('tostring(UNIT_READS)'), '4');
  v.run("WoWAIContext.SetEnabled('api:Unit',false)");
  assert.equal(v.query("{op='api',name='UnitName',args={'focus'}}").ok, false);
  assert.equal(v.evaluate('tostring(UNIT_READS)'), '4');
});

test('location snapshot identifies normalized map coordinates and gates summary collection', () => {
  const v = vm(`
    LOCATION_READS=0
    function GetZoneText() LOCATION_READS=LOCATION_READS+1;return 'Stormwind' end
    function GetSubZoneText() return 'Trade District' end
    C_Map={
      GetBestMapForUnit=function() return 1453 end,
      GetPlayerMapPosition=function() return {x=.251,y=.502} end,
      GetMapInfo=function() return {name='Stormwind'} end,
    }
  `);
  v.only('location');
  const position = v.snapshot().data.location;
  assert.equal(position.coordinateUnits, 'normalized 0..1');
  assert.equal(position.mapID, 1453);
  assert.equal(position.x, .251); assert.equal(position.y, .502);
  const text = v.evaluate('WoWAIContext.Summary()');
  assert.ok(Buffer.byteLength(text) <= 900);
  v.run("WoWAIContext.SetEnabled('location',false)");
  const reads = v.evaluate('tostring(LOCATION_READS)');
  assert.equal(v.evaluate('WoWAIContext.Summary()'), '');
  assert.equal(v.snapshot().data.location, undefined);
  assert.equal(v.evaluate('tostring(LOCATION_READS)'), reads);
});

test('missing API namespaces never resolve similarly named legacy globals', () => {
  const v = vm(`
    LEGACY_READS=0
    function GetItemInfo() LEGACY_READS=LEGACY_READS+1;return 'Legacy item' end
    APIDocumentation={systems={{Name='Missing',Namespace='C_Missing',Functions={
      {Name='GetItemInfo',Returns={{Name='name',Type='string'}}},
    }}}}
  `);
  v.only('api:C_Missing');
  assert.deepEqual(entries(v.query("{op='catalog',category='api:C_Missing'}")), []);
  assert.equal(v.query("{op='api',name='C_Missing.GetItemInfo'}").ok, false);
  assert.equal(v.evaluate('tostring(LEGACY_READS)'), '0');
});

test('native item identifiers and item-location predicates work under their declared client types', () => {
  const v = vm(API_SETUP + `
    for _, f in ipairs(APIDocumentation.systems[1].Functions) do
      if f.Name == 'GetItemInfo' then f.Arguments[1].Type = 'ItemInfo' end
    end
    C_Item.GetItemInfo = function(item)
      CALLS = CALLS + 1
      if item == 2140 or item == 'item:2140' then return {name='Fine Longsword',quality=2} end
    end
    C_Item.DoesItemExist = function(location) CALLS = CALLS + 1;return location.bag == 0 and location.slot == 4 end
    APIDocumentation.systems[1].Functions[#APIDocumentation.systems[1].Functions+1] = {
      Name='DoesItemExist',Arguments={{Name='location',Type='EmptiableItemLocation'}},Returns={{Name='exists',Type='bool'}},
    }
  `);
  v.only('api:C_Item');
  assert.equal(scalar(v.query("{op='api',name='C_Item.GetItemInfo',args={2140},path={'returns',1,'value','name'}}")), 'Fine Longsword');
  assert.equal(scalar(v.query("{op='api',name='C_Item.GetItemInfo',args={'item:2140'},path={'returns',1,'value','quality'}}")), 2);
  assert.equal(scalar(v.query("{op='api',name='C_Item.DoesItemExist',args={{type='ItemLocation',bag=0,slot=4}},path={'returns',1,'value'}}")), true);
  const calls = v.evaluate('tostring(CALLS)');
  assert.equal(v.query("{op='api',name='C_Item.GetItemInfo',args={{}}}").ok, false);
  assert.equal(v.evaluate('tostring(CALLS)'), calls, 'invalid identifier objects must not invoke the getter');
  v.run("WoWAIContext.SetEnabled('api:C_Item',false)");
  assert.equal(v.query("{op='api',name='C_Item.GetItemInfo',args={2140}}").ok, false);
  assert.equal(v.evaluate('tostring(CALLS)'), calls, 'revoked item access must not invoke the getter');
});
