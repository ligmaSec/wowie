-- Read-only character context. No commands, scripts, requests or protected actions.
WoWAIContext = {}
local Context = WoWAIContext
local unpack = unpack or table.unpack
local function pack(...) return { n = select("#", ...), ... } end
local function secret(v)
	if type(issecretvalue) == "function" then
		local ok, result = pcall(issecretvalue, v)
		if not ok or result then return true end
	end
	if type(canaccessvalue) == "function" then
		local ok, result = pcall(canaccessvalue, v)
		if not ok or not result then return true end
	end
	return false
end
local function marker(reason) return { status = "unavailable", reason = reason } end
local arrayTags = setmetatable({}, { __mode = "k" })
local function array(t) t = t or {}; arrayTags[t] = true; return t end
-- Copy raw fields only: neither addon metamethods nor userdata tostring can run.
local function clean(v, seen, depth)
	if secret(v) then return marker("secret or inaccessible value") end
	local kind = type(v)
	if kind == "nil" or kind == "boolean" or kind == "string" then return v end
	if kind == "number" then
		if v ~= v or v == math.huge or v == -math.huge then return marker("non-finite number") end
		return v
	end
	if kind ~= "table" then return marker("unsupported " .. kind) end
	if type(canaccesstable) == "function" then
		local ok, accessible = pcall(canaccesstable, v)
		if not ok or not accessible then return marker("inaccessible table") end
	end
	seen = seen or {}; depth = depth or 0
	if seen[v] then return marker("cycle") end
	if depth >= 64 then return marker("maximum nesting depth") end
	seen[v] = true
	local result = {}; if arrayTags[v] then array(result) end
	for k, item in next, v do
		if not secret(k) and (type(k) == "string" or type(k) == "number") then
			result[k] = clean(item, seen, depth + 1)
		end
	end
	seen[v] = nil
	return result
end
local escapes = { ['"'] = '\\"', ['\\'] = '\\\\', ['\b'] = '\\b', ['\f'] = '\\f', ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t' }
local function quote(s)
	return '"' .. s:gsub('[%z\1-\31\\"]', function(c) return escapes[c] or string.format("\\u%04x", string.byte(c)) end) .. '"'
end
local function isArray(t)
	local n, count = #t, 0
	for k in next, t do
		if type(k) ~= "number" or k < 1 or k > n or k % 1 ~= 0 then return false end
		count = count + 1
	end
	return count == n and (n > 0 or arrayTags[t])
end
local function json(v)
	local kind = type(v)
	if kind == "nil" then return "null" end
	if kind == "boolean" or kind == "number" then return tostring(v) end
	if kind == "string" then return quote(v) end
	local out = {}
	if isArray(v) then
		for i = 1, #v do out[#out + 1] = json(v[i]) end
		return "[" .. table.concat(out, ",") .. "]"
	end
	local keys = {}; for k in next, v do keys[#keys + 1] = k end
	table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
	for _, k in ipairs(keys) do out[#out + 1] = quote(tostring(k)) .. ":" .. json(v[k]) end
	return "{" .. table.concat(out, ",") .. "}"
end
function Context.Encode(value)
	local ok, result = pcall(function() return json(clean(value)) end)
	if ok then return result end
	return '{"status":"unavailable","reason":"inaccessible value"}'
end
local function db()
	WoWAIDB = WoWAIDB or {}; WoWAIDB.settings = WoWAIDB.settings or {}
	local settings = WoWAIDB.settings
	if settings.context == nil then settings.context = true end
	settings.sharing = settings.sharing or {}
	return settings
end
local definitions, byID, providers = {}, {}, {}
local function category(id, label, description, default, sensitive)
	local d = { id = id, label = label, description = description, default = default == true, sensitive = sensitive == true }
	definitions[#definitions + 1] = d; byID[id] = d
end
category("identity", "Character identity", "Game/client, name, realm, race, class, faction, level and experience.", true)
category("location", "Location and world", "Zone, coordinates, instance, difficulty and world time.", true)
category("money", "Money", "Carried copper balance.", true)
category("equipment", "Equipped gear", "Every equipment slot, item link/count, durability and cached item details.", true)
category("inventory", "Carried inventory", "All backpack, bag, reagent-bag and keyring slots and carried stack totals; no bank.", true)
category("spells", "Player and pet spellbooks", "All spellbook skill lines, learned/future/off-spec spells, ranks, links and flyouts.", true)
category("professions", "Professions and skills", "All profession, secondary and weapon skills; recipes when the profession window is open.", true)
category("talents", "Talents and specialization", "Talent tabs/ranks and current specialization or trait configuration.", true)
category("quests", "Quest log", "Visible quest-log entries, objectives and completion state; does not expand collapsed headers.", true)
category("reputation", "Reputation", "Visible faction standings; collapsed headers are not expanded.")
category("auras", "Player auras", "Current buffs/debuffs, possibly restricted by the client.")
category("pet", "Pet", "Active pet identity, health, power and action bar.")
category("target", "Target and focus", "Identity, resources and inspectable state of target/focus.", false, true)
category("group", "Party and raid", "Roster, roles, names and unit state.", false, true)
category("currency", "Currencies", "Visible currency-list entries and balances; does not expand headers.")
category("achievements", "Achievements", "Achievement categories, entries, criteria and points, where supported.")
category("collections", "Collections", "Mounts, pets and toys available in the client's collection APIs.")
category("bank", "Bank", "Personal bank slots only while the bank window is open; overlaps advanced container APIs.", false, true)
category("mail", "Mailbox", "Inbox headers and attachments while the mail window is open. Does not grant message-body access; select the separate mail-body permission.", false, true)
category("mail_body", "Mail message bodies (reading marks messages as read)", "Explicitly permits fetching private inbox message text while the mailbox is open. Reading marks messages as read. Separate from mail headers and advanced API namespaces; never sends, deletes or takes mail.", false, true)
category("chat", "Chat history", "Currently buffered messages in chat frames, including private conversations.", false, true)
category("guild", "Guild", "Cached guild roster, public/officer notes and guild information; no roster refresh request.", false, true)
category("friends", "Friends and Battle.net", "Cached friends, presence and Battle.net identities; no refresh requests.", false, true)
category("combat", "Combat state", "Player combat, health, power, stats, speed and threat.")
category("ui", "UI and frames", "Visible UI state and allowlisted frame getters; may overlap any character/social category.", false, true)
category("addons", "Addon/global tables", "Inspect arbitrary raw addon/global data tables. Broad access can overlap every other category and expose saved private data.", false, true)
local docsAttempted = false
local apiIndex, schemas = {}, {}
local function resolve(namespace, name)
	local owner = _G
	if namespace ~= nil then owner = rawget(_G, namespace) end
	if type(owner) ~= "table" then return nil end
	return rawget(owner, name), owner
end
local function rawMethod(object, name)
	local seen = {}
	while (type(object) == "table" or type(object) == "userdata") and not seen[object] do
		seen[object] = true
		if type(object) == "table" then
			local fn = rawget(object, name)
			if fn ~= nil then return fn, object end
		end
		local mt = getmetatable(object)
		if type(mt) ~= "table" then return nil end
		-- Never run an addon-defined __index function to resolve a requested getter.
		object = rawget(mt, "__index")
	end
end
local blockedSystems = { Debug = true, Script = true, Console = true, RestrictedActions = true }
-- Unit getters do not follow Get*/Is* naming. These are reviewed data readers
-- from UnitDocumentation.lua plus classic aura readers, not a blanket Unit*
-- grant (UnitSetRole and UnitSwitchToVehicleSeat are gameplay actions).
local unitReaders = {}
for name in string.gmatch([[
UnitAffectingCombat UnitAlliedRaceInfo UnitArmor UnitAttackPower UnitAttackSpeed
UnitBattlePetLevel UnitBattlePetSpeciesID UnitBattlePetType UnitCanAssist UnitCanAttack UnitCanCooperate UnitCanPetBattle
UnitCastingDuration UnitCastingInfo UnitChannelDuration UnitChannelInfo UnitChromieTimeID
UnitClass UnitClassBase UnitClassFromGUID UnitClassification UnitControllingVehicle UnitCreatureFamily UnitCreatureID UnitCreatureType
UnitDamage UnitDefenseSkill UnitDetailedThreatSituation UnitDistanceSquared UnitEffectiveLevel
UnitEmpoweredChannelDuration UnitEmpoweredStageDurations UnitEmpoweredStagePercentages UnitExists UnitFactionGroup UnitFullName UnitGUID
UnitGetDetailedHealPrediction UnitGetIncomingHeals UnitGetTotalAbsorbs UnitGetTotalHealAbsorbs UnitGroupRolesAssigned UnitGroupRolesAssignedEnum UnitHPPerStamina
UnitHasEffectivelyTankAura UnitHasLootInteraction UnitHasMouseoverHighlight UnitHasPowerType UnitHasRelicSlot UnitHasVehiclePlayerFrameUI UnitHasVehicleUI
UnitHealthMax UnitHealthMissing UnitHealthPercent UnitHealth UnitHonor UnitHonorLevel UnitHonorMax
UnitInAnyGroup UnitInBattleground UnitInOtherParty UnitInParty UnitInPartyIsAI UnitInPartyShard UnitInRaid UnitInRange UnitInSubgroup UnitInVehicle UnitInVehicleControlSeat UnitInVehicleHidesPetFrame
UnitIsAFK UnitIsBattlePet UnitIsBattlePetCompanion UnitIsBossMob UnitIsCharmed UnitIsConnected UnitIsControlling UnitIsCorpse UnitIsDND
UnitIsDead UnitIsDeadOrGhost UnitIsEnemy UnitIsFeignDeath UnitIsFriend UnitIsGameObject UnitIsGhost UnitIsGroupAssistant UnitIsGroupLeader UnitIsHumanPlayer
UnitIsInInteractRange UnitIsInMyGuild UnitIsInteractable UnitIsLieutenant UnitIsMercenary UnitIsMinion UnitIsNPCAsPlayer UnitIsOtherPlayersBattlePet UnitIsOtherPlayersPet
UnitIsOwnerOrControllerOfUnit UnitIsPVP UnitIsPVPFreeForAll UnitIsPVPSanctuary UnitIsPlayer UnitIsPlayerControlledOrGroupMember UnitIsPossessed UnitIsQuestBoss UnitIsRaidOfficer
UnitIsSameServer UnitIsTapDenied UnitIsTrivial UnitIsUnconscious UnitIsUnit UnitIsVisible UnitIsWildBattlePet
UnitLeadsAnyGroup UnitLevel UnitName UnitNameFromGUID UnitNameUnmodified UnitNameplateShowsWidgetsOnly UnitNumPowerBarTimers UnitOnTaxi UnitOwnerGUID UnitPVPName
UnitPartialPower UnitPercentHealthFromGUID UnitPhaseReason UnitPlayerControlled UnitPlayerOrPetInParty UnitPlayerOrPetInRaid UnitPosition
UnitPower UnitPowerBarID UnitPowerBarTimerInfo UnitPowerDisplayMod UnitPowerMax UnitPowerMissing UnitPowerPercent UnitPowerType UnitPvpClassification
UnitQuestTrivialLevelRange UnitQuestTrivialLevelRangeScaling UnitRace UnitRangedAttackPower UnitRangedDamage UnitReaction UnitRealmRelationship UnitResistance
UnitSelectionColor UnitSelectionType UnitSex UnitSexBase UnitShouldDisplayName UnitShouldDisplaySpellTargetName UnitSpellHaste UnitSpellTargetClass UnitSpellTargetName UnitStagger UnitStat
UnitTargetsVehicleInRaidUI UnitThreatLeadSituation UnitThreatPercentageOfLead UnitThreatSituation UnitTokenFromGUID UnitTreatAsPlayerForDisplay UnitTrialBankedLevels UnitTrialXP
UnitUsingVehicle UnitVehicleSeatCount UnitVehicleSeatInfo UnitVehicleSkin UnitWeaponAttackPower UnitWidgetSet UnitXP UnitXPMax UnitAura UnitBuff UnitDebuff
]], "%S+") do unitReaders[name] = true end
local function readable(name, system)
	if type(name) ~= "string" or blockedSystems[system] then return false end
	-- GetInboxText is a separately gated exception: its read-status side effect
	-- requires the explicit mail_body permission, even with a broad API namespace.
	local prefix = name:match("^([A-Z][a-z]+)")
	if not unitReaders[name] and prefix ~= "Get" and prefix ~= "Is" and prefix ~= "Has" and prefix ~= "Can" and prefix ~= "Read"
		and prefix ~= "Does" and prefix ~= "Are" and prefix ~= "Should" then return false end
	for _, word in ipairs({ "AndClear", "AndReset", "AndRemove", "AndConsume", "AndDelete", "AndMark" }) do
		if name:find(word, 1, true) then return false end
	end
	local lower = name:lower()
	for _, word in ipairs({ "script", "console", "debug", "function", "environment", "metatable", "loadstring", "execute", "securecmd", "attribute" }) do
		if lower:find(word, 1, true) then return false end
	end
	return true
end
local function trusted(fn, owner, name)
	if type(fn) ~= "function" then return false end
	if type(issecurevariable) == "function" then
		local ok, secure = pcall(issecurevariable, owner, name)
		return ok and secure == true
	end
	if debug and type(debug.getinfo) == "function" then
		local ok, info = pcall(debug.getinfo, fn, "S")
		return ok and info and info.what == "C"
	end
	-- Some clients omit both inspection APIs; official documentation remains the allowlist.
	return true
end
local function discover()
	if not docsAttempted then
		docsAttempted = true
		local loader = C_AddOns and C_AddOns.LoadAddOn or LoadAddOn
		if type(loader) == "function" and not APIDocumentation then pcall(loader, "Blizzard_APIDocumentation") end
		if type(loader) == "function" then pcall(loader, "Blizzard_APIDocumentationGenerated") end
	end
	apiIndex, schemas = {}, {}
	local documentation = APIDocumentation
	if type(documentation) ~= "table" then return end
	for _, schema in ipairs(documentation.tables or {}) do if schema.Name then schemas[schema.Name] = schema end end
	for _, system in ipairs(documentation.systems or {}) do
		local namespace = system.Namespace
		if namespace == "" then namespace = nil end
		local systemID = namespace or system.Name
		if type(systemID) == "string" and systemID:match("^[%w_]+$") then
			local id = "api:" .. systemID
			if not byID[id] then
				category(id, "API: " .. systemID, "Advanced documented read-only getters in " .. systemID .. ". Broad scope may overlap any snapshot permission, including sensitive data. Queries only; never eagerly collected.", false, true)
			end
			for _, schema in ipairs(system.Tables or {}) do if schema.Name then schemas[schema.Name] = schema end end
			for _, f in ipairs(system.Functions or {}) do
				if readable(f.Name, system.Name) and type(f.Returns) == "table" and #f.Returns > 0 then
					local name = namespace and (namespace .. "." .. f.Name) or f.Name
					local fn, owner = resolve(namespace, f.Name)
					if trusted(fn, owner, f.Name) then apiIndex[name] = { name = name, category = id, namespace = namespace, shortName = f.Name, metadata = f, fn = fn, requiredPermission = f.Name == "GetInboxText" and "mail_body" or nil } end
				end
			end
		end
	end
end
function Context.IsEnabled(id)
	local settings = db()
	if not settings.context then return false end
	local definition = byID[id]
	if not definition and type(id) == "string" and id:sub(1, 4) == "api:" then discover(); definition = byID[id] end
	if not definition then return false end
	local selected = settings.sharing[id]
	if selected == nil then return definition.default end
	return selected == true
end
function Context.Categories()
	discover()
	local result = array()
	for _, d in ipairs(definitions) do
		local selected = db().sharing[d.id]
		if selected == nil then selected = d.default end
		result[#result + 1] = { id = d.id, label = d.label, description = d.description, sensitive = d.sensitive, enabled = selected == true }
	end
	return result
end
function Context.SetEnabled(id, enabled)
	if type(id) ~= "string" then return false end
	if not byID[id] then discover() end
	if not byID[id] then return false end
	db().sharing[id] = enabled == true
	return true
end
function Context.ResetDefaults() db().sharing = {} end
local issues
local function call(fn, ...)
	if type(fn) ~= "function" then return nil end
	local args = pack(...)
	local ok, values = pcall(function() return clean(pack(fn(unpack(args, 1, args.n)))) end)
	if not ok then
		if issues then issues[#issues + 1] = "getter failed or restricted" end
		return nil
	end
	return unpack(values, 1, values.n)
end
local function get(path, ...)
	local namespace, name = path:match("^([%w_]+)%.([%w_]+)$")
	local fn = namespace and resolve(namespace, name) or rawget(_G, path)
	if type(fn) ~= "function" then
		if issues then issues[#issues + 1] = path .. " unavailable" end
		return nil
	end
	return call(fn, ...)
end
local function exists(path)
	local namespace, name = path:match("^([%w_]+)%.([%w_]+)$")
	return type(namespace and resolve(namespace, name) or rawget(_G, path)) == "function"
end
local function choose(modern, legacy) if exists(modern) then return modern end return legacy end
local function count(v) return type(v) == "number" and math.max(0, math.floor(v)) or 0 end
local function available(fields) fields = fields or {}; fields.status = "available"; return fields end
local function now() local t = call(GetServerTime) or call(time); return type(t) == "number" and t or 0 end
local function unit(token)
	local present = get("UnitExists", token)
	if present == false then return { status = "unavailable", reason = "unit absent", unit = token } end
	return available({ unit = token, name = get("UnitName", token), guid = get("UnitGUID", token), level = get("UnitLevel", token), race = get("UnitRace", token), class = get("UnitClass", token), faction = get("UnitFactionGroup", token), health = get("UnitHealth", token), maxHealth = get("UnitHealthMax", token), power = get("UnitPower", token), maxPower = get("UnitPowerMax", token), powerType = get("UnitPowerType", token), dead = get("UnitIsDeadOrGhost", token), role = get("UnitGroupRolesAssigned", token) })
end
providers.identity = function()
	local version, build, date, interface = get("GetBuildInfo")
	local game = "World of Warcraft"
	if type(interface) == "number" and interface >= 16000 and interface < 20000 then game = game .. ": Forever" end
	return available({ game = game, client = version, build = build, buildDate = date, interface = interface, name = get("UnitName", "player"), realm = get("GetRealmName"), level = get("UnitLevel", "player"), race = get("UnitRace", "player"), class = get("UnitClass", "player"), faction = get("UnitFactionGroup", "player"), sex = get("UnitSex", "player"), xp = get("UnitXP", "player"), xpMax = get("UnitXPMax", "player"), restedXP = get("GetXPExhaustion") })
end
providers.location = function()
	local id = get("C_Map.GetBestMapForUnit", "player")
	local position = id and get("C_Map.GetPlayerMapPosition", id, "player")
	local x, y
	if type(position) == "table" then x, y = position.x, position.y end
	if not x and exists("GetPlayerMapPosition") then x, y = get("GetPlayerMapPosition", "player") end
	local name, instanceType, difficultyID, difficulty, maxPlayers, _, _, instanceID = get("GetInstanceInfo")
	return available({ zone = get("GetZoneText"), subZone = get("GetSubZoneText"), mapID = id, map = id and get("C_Map.GetMapInfo", id), x = x, y = y, coordinateUnits = "normalized 0..1", coordinatesStatus = type(x) == "number" and type(y) == "number" and "available" or "unavailable", instance = { name = name, type = instanceType, difficultyID = difficultyID, difficulty = difficulty, maxPlayers = maxPlayers, id = instanceID }, worldTime = array({ get("GetGameTime") }), indoors = get("IsIndoors"), resting = get("IsResting") })
end
providers.money = function() local copper = get("GetMoney"); if copper == nil then return marker("money API unavailable") end; return available({ copper = copper }) end
local function itemDetails(id)
	if not id then return nil end
	local name, link, quality, level, minLevel, class, subclass, maxStack, equipSlot, texture, sellPrice = get(choose("C_Item.GetItemInfo", "GetItemInfo"), id)
	if not name then return { status = "unavailable", reason = "item details not cached" } end
	return available({ name = name, link = link, quality = quality, level = level, minLevel = minLevel, class = class, subclass = subclass, maxStack = maxStack, equipSlot = equipSlot, texture = texture, sellPrice = sellPrice })
end
providers.equipment = function()
	if not exists("GetInventoryItemLink") and not exists("GetInventoryItemID") then return marker("equipment APIs unavailable") end
	local slots = array()
	for slot = 0, (INVSLOT_LAST_EQUIPPED or 19) do
		local id, link = get("GetInventoryItemID", "player", slot), get("GetInventoryItemLink", "player", slot)
		local durability, maxDurability = get("GetInventoryItemDurability", slot)
		slots[#slots + 1] = { slot = slot, itemID = id, link = link, count = get("GetInventoryItemCount", "player", slot), empty = not id and not link, durability = durability, maxDurability = maxDurability, details = itemDetails(id or link) }
	end
	return available({ slots = slots })
end
local function containers(bagIDs)
	local slotsAPI = choose("C_Container.GetContainerNumSlots", "GetContainerNumSlots")
	if not exists(slotsAPI) then return marker("container APIs unavailable") end
	local bags, totals = array(), {}
	for _, bagID in ipairs(bagIDs) do
		local size = get(slotsAPI, bagID)
		local bag = { bag = bagID, size = size, slots = array(), status = type(size) == "number" and "available" or "unavailable" }
		local inventorySlot
		if bagID > 0 and exists(choose("C_Container.ContainerIDToInventoryID", "ContainerIDToInventoryID")) then
			inventorySlot = get(choose("C_Container.ContainerIDToInventoryID", "ContainerIDToInventoryID"), bagID)
		end
		if type(inventorySlot) == "number" then
			bag.inventorySlot = inventorySlot
			bag.itemID = exists("GetInventoryItemID") and get("GetInventoryItemID", "player", inventorySlot) or nil
			bag.link = exists("GetInventoryItemLink") and get("GetInventoryItemLink", "player", inventorySlot) or nil
		end
		local free, family = get(choose("C_Container.GetContainerNumFreeSlots", "GetContainerNumFreeSlots"), bagID)
		bag.freeSlots, bag.family = free, family
		for slot = 1, count(size) do
			local info
			if exists("C_Container.GetContainerItemInfo") then info = get("C_Container.GetContainerItemInfo", bagID, slot)
			else
				local texture, amount, locked, quality, readableItem, lootable, link, filtered, noValue, id = get("GetContainerItemInfo", bagID, slot)
				if texture or id or link then info = { iconFileID = texture, stackCount = amount, isLocked = locked, quality = quality, isReadable = readableItem, hasLoot = lootable, hyperlink = link, isFiltered = filtered, hasNoValue = noValue, itemID = id } end
			end
			local entry = { bag = bagID, slot = slot, empty = info == nil }
			if type(info) == "table" then
				entry.info = info; entry.itemID = info.itemID; entry.count = info.stackCount; entry.link = info.hyperlink
			end
			if not entry.itemID and exists(choose("C_Container.GetContainerItemID", "GetContainerItemID")) then entry.itemID = get(choose("C_Container.GetContainerItemID", "GetContainerItemID"), bagID, slot) end
			if not entry.link and exists(choose("C_Container.GetContainerItemLink", "GetContainerItemLink")) then entry.link = get(choose("C_Container.GetContainerItemLink", "GetContainerItemLink"), bagID, slot) end
			if entry.itemID or entry.link then
				entry.empty = false; entry.details = itemDetails(entry.itemID or entry.link)
				if entry.count == nil then entry.countStatus = "unavailable" end
				if type(entry.itemID) == "number" and type(entry.count) == "number" then local key = tostring(entry.itemID); totals[key] = (totals[key] or 0) + entry.count end
			end
			bag.slots[#bag.slots + 1] = entry
		end
		bags[#bags + 1] = bag
	end
	return available({ bags = bags, itemCounts = totals, countsScope = "only these containers, excluding equipped items" })
end
providers.inventory = function()
	local ids = {}; local last = NUM_TOTAL_EQUIPPED_BAG_SLOTS or NUM_BAG_SLOTS or 4
	for id = 0, last do ids[#ids + 1] = id end
	local keyring = KEYRING_CONTAINER or (Enum and Enum.BagIndex and Enum.BagIndex.Keyring)
	if type(keyring) == "number" then ids[#ids + 1] = keyring end
	return containers(ids)
end
local windows = {}
if type(CreateFrame) == "function" then
	local frame = CreateFrame("Frame")
	for _, event in ipairs({ "BANKFRAME_OPENED", "BANKFRAME_CLOSED", "MAIL_SHOW", "MAIL_CLOSED", "TRADE_SKILL_SHOW", "TRADE_SKILL_CLOSE" }) do pcall(frame.RegisterEvent, frame, event) end
	frame:SetScript("OnEvent", function(_, event)
		if event == "BANKFRAME_OPENED" then windows.bank = true elseif event == "BANKFRAME_CLOSED" then windows.bank = false
		elseif event == "MAIL_SHOW" then windows.mail = true elseif event == "MAIL_CLOSED" then windows.mail = false
		elseif event == "TRADE_SKILL_SHOW" then windows.professions = true elseif event == "TRADE_SKILL_CLOSE" then windows.professions = false end
	end)
end
local function windowOpen(id, frameName)
	if windows[id] ~= nil then return windows[id] end
	local frame = rawget(_G, frameName)
	if frame and type(frame.IsShown) == "function" then return call(frame.IsShown, frame) == true end
	return nil
end
providers.bank = function()
	local open = windowOpen("bank", "BankFrame")
	if not open then return { status = open == false and "closed" or "unknown", reason = "bank window must be open; cached contents are not assumed current" } end
	local ids = { BANK_CONTAINER or -1 }
	local first = (NUM_TOTAL_EQUIPPED_BAG_SLOTS or NUM_BAG_SLOTS or 4) + 1
	for i = first, first + (NUM_BANKBAGSLOTS or 7) - 1 do ids[#ids + 1] = i end
	if type(REAGENTBANK_CONTAINER) == "number" then ids[#ids + 1] = REAGENTBANK_CONTAINER end
	return containers(ids)
end
local function spellEntry(slot, bank, modern)
	local entry = { slot = slot, bank = bank }
	local kind, id, spellID
	if modern then
		entry.info = get("C_SpellBook.GetSpellBookItemInfo", slot, bank)
		if type(entry.info) == "table" then kind, id, spellID = entry.info.itemType, entry.info.actionID, entry.info.spellID end
		if not kind then kind, id, spellID = get("C_SpellBook.GetSpellBookItemType", slot, bank) end
		entry.name, entry.rank = get("C_SpellBook.GetSpellBookItemName", slot, bank)
		entry.link = get("C_SpellBook.GetSpellBookItemLink", slot, bank)
		entry.learnedAtLevel = get("C_SpellBook.GetSpellBookItemLevelLearned", slot, bank)
	else
		kind, id = get("GetSpellBookItemInfo", slot, bank)
		entry.name, entry.rank = get("GetSpellBookItemName", slot, bank)
		entry.link = get("GetSpellLink", slot, bank)
		spellID = id
	end
	entry.itemType, entry.actionID, entry.spellID = kind, id, spellID
	local types = Enum and Enum.SpellBookItemType or {}
	entry.future = kind == "FUTURESPELL" or (types.FutureSpell ~= nil and kind == types.FutureSpell)
	entry.offSpec = type(entry.info) == "table" and entry.info.isOffSpec or false
	if entry.future then entry.known = false
	elseif type(spellID or id) == "number" and exists("IsSpellKnown") then entry.known = get("IsSpellKnown", spellID or id, bank == "pet" or (Enum and Enum.SpellBookSpellBank and bank == Enum.SpellBookSpellBank.Pet))
	elseif type(spellID or id) == "number" and exists("C_SpellBook.IsSpellKnown") then entry.known = get("C_SpellBook.IsSpellKnown", spellID or id, bank)
	else entry.knownStatus = "unavailable" end
	if kind == "FLYOUT" or (types.Flyout ~= nil and kind == types.Flyout) then
		local _, _, n = get("GetFlyoutInfo", id); entry.flyout = array()
		for i = 1, count(n) do local sid, override, known, name, slotSpecID = get("GetFlyoutSlotInfo", id, i); entry.flyout[#entry.flyout + 1] = { slot = i, spellID = sid, overrideSpellID = override, known = known, name = name, specID = slotSpecID } end
	end
	return entry
end
providers.spells = function()
	local modern = exists("C_SpellBook.GetNumSpellBookSkillLines")
	if not modern and not exists("GetNumSpellTabs") then return marker("spellbook APIs unavailable") end
	local playerBank = modern and Enum and Enum.SpellBookSpellBank and Enum.SpellBookSpellBank.Player or BOOKTYPE_SPELL or "spell"
	local petBank = modern and Enum and Enum.SpellBookSpellBank and Enum.SpellBookSpellBank.Pet or BOOKTYPE_PET or "pet"
	local lines, player, pet, seen = array(), array(), array(), {}
	local n = get(modern and "C_SpellBook.GetNumSpellBookSkillLines" or "GetNumSpellTabs")
	for i = 1, count(n) do
		local line
		if modern then line = get("C_SpellBook.GetSpellBookSkillLineInfo", i)
		else local name, icon, offset, numSpells, isGuild, offSpecID = get("GetSpellTabInfo", i); line = { name = name, iconID = icon, itemIndexOffset = offset, numSpellBookItems = numSpells, isGuild = isGuild, offSpecID = offSpecID } end
		if type(line) == "table" then
			line.index = i; lines[#lines + 1] = line
			for slot = count(line.itemIndexOffset or line.offset) + 1, count(line.itemIndexOffset or line.offset) + count(line.numSpellBookItems or line.numSpells) do
				if not seen[slot] then local entry = spellEntry(slot, playerBank, modern); entry.skillLine = i; player[#player + 1] = entry; seen[slot] = true end
			end
		end
	end
	local petCount = get(choose("C_SpellBook.HasPetSpells", "HasPetSpells"))
	for slot = 1, count(petCount) do pet[#pet + 1] = spellEntry(slot, petBank, modern) end
	return available({ skillLines = lines, player = player, pet = pet, petStatus = type(petCount) == "number" and "available" or "unavailable or no pet", includesFutureSpells = true })
end
providers.professions = function()
	local lines = WoWAI and type(WoWAI.SkillLines) == "function" and call(WoWAI.SkillLines) or nil
	if not lines then
		lines = array()
		local modern = exists("C_SkillInfo.GetNumSkillLines")
		for i = 1, count(get(modern and "C_SkillInfo.GetNumSkillLines" or "GetNumSkillLines")) do
			if modern then lines[#lines + 1] = get("C_SkillInfo.GetSkillLineInfo", i)
			else local name, header, expanded, rank, temporary, modifier, maxRank = get("GetSkillLineInfo", i); lines[#lines + 1] = { name = name, isHeader = header, isExpanded = expanded, rank = rank, temporary = temporary, modifier = modifier, maxRank = maxRank } end
		end
	end
	array(lines)
	local skillDetails = lines
	if exists("C_SkillInfo.GetNumSkillLines") then
		skillDetails = array()
		for i = 1, count(get("C_SkillInfo.GetNumSkillLines")) do
			local info = get("C_SkillInfo.GetSkillLineInfo", i)
			if type(info) == "table" then info.index = i; skillDetails[#skillDetails + 1] = info end
		end
	end
	local professionSlots = array()
	if exists("GetProfessions") then
		local slots = pack(get("GetProfessions"))
		for i = 1, slots.n do if slots[i] then
			local name, icon, rank, maxRank, numAbilities, offset, skillLine, modifier, specIndex, specOffset = get("GetProfessionInfo", slots[i])
			professionSlots[#professionSlots + 1] = { slot = i, index = slots[i], name = name, icon = icon, rank = rank, maxRank = maxRank, numAbilities = numAbilities, spellOffset = offset, skillLine = skillLine, modifier = modifier, specIndex = specIndex, specOffset = specOffset }
		end end
	end
	local recipes = { status = "closed", reason = "profession window must be open" }
	local ready = windowOpen("professions", "TradeSkillFrame")
	if ready == nil and exists("C_TradeSkillUI.IsTradeSkillReady") then ready = get("C_TradeSkillUI.IsTradeSkillReady") end
	if ready then
		recipes = available({ entries = array() })
		if exists("C_TradeSkillUI.GetAllRecipeIDs") then
			for _, id in ipairs(get("C_TradeSkillUI.GetAllRecipeIDs") or {}) do recipes.entries[#recipes.entries + 1] = { recipeID = id, info = get("C_TradeSkillUI.GetRecipeInfo", id), schematic = exists("C_TradeSkillUI.GetRecipeSchematic") and get("C_TradeSkillUI.GetRecipeSchematic", id, false) or nil } end
		elseif exists("GetNumTradeSkills") then
			for i = 1, count(get("GetNumTradeSkills")) do local name, kind, availableCount, expanded = get("GetTradeSkillInfo", i); recipes.entries[#recipes.entries + 1] = { index = i, name = name, type = kind, available = availableCount, expanded = expanded, link = get("GetTradeSkillRecipeLink", i) } end
		else recipes = marker("recipe APIs unavailable") end
	elseif ready == nil then recipes.status = "unknown" end
	return available({ skills = lines, skillDetails = skillDetails, professions = professionSlots, recipes = recipes, skillScope = "all exposed skill lines including profession, secondary, class and weapon skills; collapsed lines remain as exposed" })
end
providers.talents = function()
	local tabs = array()
	for tab = 1, count(get("GetNumTalentTabs")) do
		local name, icon, points, background = get("GetTalentTabInfo", tab)
		local row = { index = tab, name = name, icon = icon, points = points, background = background, talents = array() }
		for i = 1, count(get("GetNumTalents", tab)) do local tname, texture, tier, column, rank, maxRank, exceptional, prerequisite = get("GetTalentInfo", tab, i); row.talents[#row.talents + 1] = { index = i, name = tname, texture = texture, tier = tier, column = column, rank = rank, maxRank = maxRank, exceptional = exceptional, prerequisite = prerequisite, link = exists("GetTalentLink") and get("GetTalentLink", tab, i) or nil } end
		tabs[#tabs + 1] = row
	end
	local spec = exists("GetSpecialization") and get("GetSpecialization") or nil
	local configID = exists("C_ClassTalents.GetActiveConfigID") and get("C_ClassTalents.GetActiveConfigID") or nil
	local config = configID and get("C_Traits.GetConfigInfo", configID)
	local trees = array()
	if type(config) == "table" then
		for _, treeID in ipairs(config.treeIDs or {}) do
			local tree = { treeID = treeID, nodes = array() }
			for _, nodeID in ipairs(get("C_Traits.GetTreeNodes", treeID) or {}) do tree.nodes[#tree.nodes + 1] = { nodeID = nodeID, info = get("C_Traits.GetNodeInfo", configID, nodeID) } end
			trees[#trees + 1] = tree
		end
	end
	return available({ tabs = tabs, specialization = spec, specializationInfo = spec and pack(get("GetSpecializationInfo", spec)), configID = configID, config = config, trees = trees })
end
providers.quests = function()
	local modern = exists("C_QuestLog.GetNumQuestLogEntries")
	local entries = array()
	local n, total = get(modern and "C_QuestLog.GetNumQuestLogEntries" or "GetNumQuestLogEntries")
	for i = 1, count(n) do
		local entry
		if modern then entry = get("C_QuestLog.GetInfo", i)
		else local title, level, tag, groupSize, header, collapsed, complete, frequency, questID = get("GetQuestLogTitle", i); entry = { title = title, level = level, tag = tag, groupSize = groupSize, isHeader = header, isCollapsed = collapsed, isComplete = complete, frequency = frequency, questID = questID } end
		if type(entry) == "table" then
			entry.index = i
			if not entry.isHeader then
				if modern and entry.questID and exists("C_QuestLog.GetQuestObjectives") then entry.objectives = get("C_QuestLog.GetQuestObjectives", entry.questID)
				else entry.objectives = array(); for j = 1, count(get("GetNumQuestLeaderBoards", i)) do local text, kind, finished = get("GetQuestLogLeaderBoard", j, i); entry.objectives[#entry.objectives + 1] = { text = text, type = kind, finished = finished } end end
			end
			entries[#entries + 1] = entry
		end
	end
	return available({ entries = entries, totalQuests = total, scope = "currently exposed quest log; collapsed headers are not expanded" })
end
providers.reputation = function()
	local modern = exists("C_Reputation.GetNumFactions")
	local entries = array()
	for i = 1, count(get(modern and "C_Reputation.GetNumFactions" or "GetNumFactions")) do
		local row
		if modern then row = get("C_Reputation.GetFactionDataByIndex", i)
		else local name, description, standing, minValue, maxValue, value, atWar, canToggle, header, collapsed, hasRep, watched, child, id = get("GetFactionInfo", i); row = { name = name, description = description, reaction = standing, currentReactionThreshold = minValue, nextReactionThreshold = maxValue, currentStanding = value, atWarWith = atWar, canToggleAtWar = canToggle, isHeader = header, isCollapsed = collapsed, isHeaderWithRep = hasRep, isWatched = watched, isChild = child, factionID = id } end
		if type(row) == "table" then row.index = i; entries[#entries + 1] = row end
	end
	return available({ entries = entries, scope = "visible faction list; collapsed headers not expanded" })
end
local function auras(token)
	local result = { helpful = array(), harmful = array() }
	for _, filter in ipairs({ "HELPFUL", "HARMFUL" }) do
		local list = filter == "HELPFUL" and result.helpful or result.harmful
		local i = 1
		while true do
			local info
			if exists("C_UnitAuras.GetAuraDataByIndex") then info = get("C_UnitAuras.GetAuraDataByIndex", token, i, filter)
			elseif exists("UnitAura") then local name, icon, applications, dispel, duration, expiration, source, stealable, personal, spellID = get("UnitAura", token, i, filter); if name then info = { name = name, icon = icon, applications = applications, dispelName = dispel, duration = duration, expirationTime = expiration, sourceUnit = source, isStealable = stealable, nameplateShowPersonal = personal, spellId = spellID } end
			else return marker("aura APIs unavailable") end
			if not info then break end
			list[#list + 1] = info; i = i + 1
		end
	end
	return available(result)
end
providers.auras = function() return auras("player") end
providers.pet = function()
	local result = unit("pet"); result.actions = array()
	if result.status == "available" then for i = 1, (NUM_PET_ACTION_SLOTS or 10) do local name, texture, token, active, autoAllowed, autoEnabled, spellID = get("GetPetActionInfo", i); result.actions[#result.actions + 1] = { slot = i, name = name, texture = texture, isToken = token, active = active, autoCastAllowed = autoAllowed, autoCastEnabled = autoEnabled, spellID = spellID } end end
	return result
end
providers.target = function() return available({ target = unit("target"), focus = unit("focus") }) end
providers.group = function()
	local raid = get("IsInRaid"); local n = get("GetNumGroupMembers")
	if n == nil then n = get(raid and "GetNumRaidMembers" or "GetNumPartyMembers") end
	local entries = array()
	for i = 1, count(n) do
		local token = raid and ("raid" .. i) or (i == count(n) and "player" or "party" .. i)
		local row = unit(token)
		if raid then local name, rank, subgroup, level, class, fileClass, zone, online, dead, role, masterLooter = get("GetRaidRosterInfo", i); row.roster = { name = name, rank = rank, subgroup = subgroup, level = level, class = class, fileClass = fileClass, zone = zone, online = online, dead = dead, role = role, masterLooter = masterLooter } end
		entries[#entries + 1] = row
	end
	return available({ raid = raid, entries = entries })
end
providers.currency = function()
	local modern = exists("C_CurrencyInfo.GetCurrencyListSize"); local entries = array()
	for i = 1, count(get(modern and "C_CurrencyInfo.GetCurrencyListSize" or "GetCurrencyListSize")) do
		local info
		if modern then info = get("C_CurrencyInfo.GetCurrencyListInfo", i)
		else local name, header, expanded, unused, watched, amount, icon, maxAmount, canEarn, week, weekMax, totalMax = get("GetCurrencyListInfo", i); info = { name = name, isHeader = header, isHeaderExpanded = expanded, isTypeUnused = unused, isShowInBackpack = watched, quantity = amount, iconFileID = icon, maxQuantity = maxAmount, canEarnPerWeek = canEarn, quantityEarnedThisWeek = week, maxWeeklyQuantity = weekMax, totalMax = totalMax } end
		if type(info) == "table" then info.index = i; entries[#entries + 1] = info end
	end
	return available({ entries = entries, scope = "visible currency list; collapsed headers not expanded" })
end
providers.achievements = function()
	if not exists("GetCategoryList") then return marker("achievement APIs unavailable") end
	local categories = array()
	for _, categoryID in ipairs(get("GetCategoryList") or {}) do
		local name, parent, flags = get("GetCategoryInfo", categoryID)
		local row = { id = categoryID, name = name, parentID = parent, flags = flags, achievements = array() }
		for i = 1, count(get("GetCategoryNumAchievements", categoryID)) do
			local id, aname, points, complete, month, day, year, description, aflags, icon, reward, guild, earnedBy, playerEarned = get("GetAchievementInfo", categoryID, i)
			local achievement = { id = id, name = aname, points = points, completed = complete, month = month, day = day, year = year, description = description, flags = aflags, icon = icon, reward = reward, guild = guild, earnedBy = earnedBy, playerEarned = playerEarned, criteria = array() }
			for j = 1, count(id and get("GetAchievementNumCriteria", id)) do achievement.criteria[#achievement.criteria + 1] = pack(get("GetAchievementCriteriaInfo", id, j)) end
			row.achievements[#row.achievements + 1] = achievement
		end
		categories[#categories + 1] = row
	end
	return available({ points = get("GetTotalAchievementPoints"), categories = categories })
end
providers.collections = function()
	local mounts, pets, toys = marker("mount collection API unavailable"), marker("pet collection API unavailable"), marker("toy collection API unavailable")
	if exists("C_MountJournal.GetMountIDs") then
		mounts = available({ entries = array() }); for _, id in ipairs(get("C_MountJournal.GetMountIDs") or {}) do mounts.entries[#mounts.entries + 1] = { mountID = id, info = pack(get("C_MountJournal.GetMountInfoByID", id)), extra = pack(get("C_MountJournal.GetMountInfoExtraByID", id)) } end
	end
	if exists("C_PetJournal.GetNumPets") then
		local n, owned = get("C_PetJournal.GetNumPets"); pets = available({ total = n, owned = owned, entries = array(), scope = "current journal filters; no filters changed" })
		for i = 1, count(n) do pets.entries[#pets.entries + 1] = pack(get("C_PetJournal.GetPetInfoByIndex", i)) end
	end
	if exists("C_ToyBox.GetNumToys") then
		toys = available({ entries = array(), scope = "current toy filters; no filters changed" })
		for i = 1, count(get("C_ToyBox.GetNumToys")) do local id = get("C_ToyBox.GetToyFromIndex", i); toys.entries[#toys.entries + 1] = { itemID = id, owned = id and get("PlayerHasToy", id), info = id and pack(get("C_ToyBox.GetToyInfo", id)) } end
	end
	return available({ mounts = mounts, pets = pets, toys = toys })
end
providers.mail = function()
	local open = windowOpen("mail", "MailFrame")
	if not open then return { status = open == false and "closed" or "unknown", reason = "mailbox window must be open" } end
	local n, total = get("GetInboxNumItems"); local entries = array()
	for i = 1, count(n) do
		local row = { index = i, header = pack(get("GetInboxHeaderInfo", i)), attachments = array() }
		for j = 1, (ATTACHMENTS_MAX_RECEIVE or 16) do local name, id, texture, amount, quality, usable = get("GetInboxItem", i, j); if name or id then row.attachments[#row.attachments + 1] = { slot = j, name = name, itemID = id, texture = texture, count = amount, quality = quality, usable = usable, link = get("GetInboxItemLink", i, j) } end end
		entries[#entries + 1] = row
	end
	return available({ entries = entries, loaded = n, total = total, scope = "loaded inbox only; no mail refresh requested" })
end
providers.mail_body = function()
	-- Keep this check inside the provider as well as at every public entry point.
	if not Context.IsEnabled("mail_body") then return marker("mail_body permission disabled") end
	local open = windowOpen("mail", "MailFrame")
	if not open then return { status = open == false and "closed" or "unknown", reason = "mailbox window must be open" } end
	local bodyAPI = choose("C_Mail.GetInboxText", "GetInboxText")
	if not exists(bodyAPI) then return marker("mail body API unavailable") end
	local n, total = get("GetInboxNumItems")
	local entries = array()
	for i = 1, count(n) do
		-- Recheck immediately before every read-status-changing getter.
		if not Context.IsEnabled("mail_body") then return marker("mail_body permission revoked") end
		local values = pack(get(bodyAPI, i))
		entries[#entries + 1] = { index = i, text = values[1], returns = values }
	end
	return available({ entries = entries, loaded = n, total = total, sideEffect = "reading marks messages as read", scope = "loaded inbox only; no refresh, send, delete or take operation" })
end
providers.chat = function()
	local frames = array()
	for i = 1, (NUM_CHAT_WINDOWS or 10) do
		local frame = rawget(_G, "ChatFrame" .. i)
		if frame and type(frame.GetNumMessages) == "function" and type(frame.GetMessageInfo) == "function" then
			local row = { frame = "ChatFrame" .. i, messages = array() }
			for j = 1, count(call(frame.GetNumMessages, frame)) do local text, r, g, b, id = call(frame.GetMessageInfo, frame, j); row.messages[#row.messages + 1] = { text = text, r = r, g = g, b = b, id = id } end
			frames[#frames + 1] = row
		end
	end
	return available({ frames = frames, scope = "buffered messages only, not historical server logs" })
end
providers.guild = function()
	local entries = array(); local name, rank, rankIndex, realm = get("GetGuildInfo", "player")
	if not name then return marker("not in a guild or guild information unavailable") end
	for i = 1, count(get("GetNumGuildMembers")) do
		local member, mrank, mrankIndex, level, class, zone, note, officerNote, online, status, fileClass, achievementPoints, achievementRank, mobile, canSoR, rep, guid = get("GetGuildRosterInfo", i)
		entries[#entries + 1] = { name = member, rank = mrank, rankIndex = mrankIndex, level = level, class = class, zone = zone, note = note, officerNote = officerNote, online = online, status = status, fileClass = fileClass, achievementPoints = achievementPoints, achievementRank = achievementRank, mobile = mobile, canSoR = canSoR, reputation = rep, guid = guid }
	end
	return available({ name = name, rank = rank, rankIndex = rankIndex, realm = realm, motd = get("GetGuildRosterMOTD"), info = get("GetGuildInfoText"), entries = entries, scope = "cached roster; may be stale or incomplete" })
end
providers.friends = function()
	local entries, battleNet = array(), array()
	local modern = exists("C_FriendList.GetNumFriends")
	for i = 1, count(get(modern and "C_FriendList.GetNumFriends" or "GetNumFriends")) do
		if modern then entries[#entries + 1] = get("C_FriendList.GetFriendInfoByIndex", i)
		else local name, level, class, area, connected, status, note = get("GetFriendInfo", i); entries[#entries + 1] = { name = name, level = level, class = class, area = area, connected = connected, status = status, note = note } end
	end
	for i = 1, count(get("BNGetNumFriends")) do
		if exists("C_BattleNet.GetFriendAccountInfo") then battleNet[#battleNet + 1] = get("C_BattleNet.GetFriendAccountInfo", i)
		else battleNet[#battleNet + 1] = pack(get("BNGetFriendInfo", i)) end
	end
	return available({ entries = entries, battleNet = battleNet, scope = "cached presence; no refresh requested" })
end
providers.combat = function()
	local result = unit("player")
	result.inCombat = get("UnitAffectingCombat", "player"); result.speed = get("GetUnitSpeed", "player")
	result.attackPower = pack(get("UnitAttackPower", "player")); result.armor = pack(get("UnitArmor", "player")); result.damage = pack(get("UnitDamage", "player")); result.stats = array()
	for i = 1, (MAX_STATS or 5) do result.stats[#result.stats + 1] = { index = i, values = pack(get("UnitStat", "player", i)) } end
	result.threat = get("UnitThreatSituation", "player")
	return result
end
providers.ui = function()
	local frames = array()
	for _, name in ipairs({ "WorldMapFrame", "BankFrame", "MailFrame", "TradeSkillFrame", "QuestLogFrame", "CharacterFrame", "SpellBookFrame", "MerchantFrame", "GossipFrame", "AuctionHouseFrame" }) do
		local frame = rawget(_G, name)
		frames[#frames + 1] = { frame = name, status = frame and "available" or "unavailable", shown = frame and type(frame.IsShown) == "function" and call(frame.IsShown, frame) or false }
	end
	return available({ frames = frames, scope = "known window visibility; use frame queries for allowlisted getters" })
end
providers.addons = function()
	local entries = array()
	local modern = exists("C_AddOns.GetNumAddOns")
	for i = 1, count(get(modern and "C_AddOns.GetNumAddOns" or "GetNumAddOns")) do entries[#entries + 1] = pack(get(modern and "C_AddOns.GetAddOnInfo" or "GetAddOnInfo", i)) end
	return available({ entries = entries, scope = "installed addon metadata; raw global tables require explicit table queries" })
end
local function collect(id)
	local previous = issues; issues = array()
	local ok, value = pcall(providers[id])
	local errors = issues; issues = previous
	if not ok then return marker("provider failed or data restricted") end
	if type(value) ~= "table" then return marker("provider returned no data") end
	if #errors > 0 then
		if value.status == "available" then value.status = "partial" end
		local unique, list = {}, array()
		for _, issue in ipairs(errors) do if not unique[issue] then unique[issue] = true; list[#list + 1] = issue end end
		value.unavailable = list
	end
	return value
end
function Context.Snapshot()
	discover()
	local result = { version = 1, capturedAt = now(), enabled = array(), data = {} }
	for _, d in ipairs(definitions) do
		if Context.IsEnabled(d.id) then
			result.enabled[#result.enabled + 1] = d.id
			if providers[d.id] then result.data[d.id] = collect(d.id)
			else result.data[d.id] = { status = "query-only", reason = "use catalog/api queries for this namespace" } end
		end
	end
	-- The short context must describe this same capture, without reading providers twice.
	return Context.Encode(result), Context.Summary(result.data)
end
function Context.Summary(captured)
	if not db().context then return "" end
	local function selected(id) return captured and (captured[id] or {}) or collect(id) end
	local parts, bytes = {}, 0
	local function add(value)
		if type(value) ~= "string" or #value == 0 then return end
		if bytes + #value + (#parts > 0 and 2 or 0) <= 900 then parts[#parts + 1] = value; bytes = bytes + #value + (#parts > 1 and 2 or 0) end
	end
	local function text(v) return (type(v) == "string" or type(v) == "number") and tostring(v) or "" end
	-- Client label is only read with identity permission, never an unpermissioned side channel.
	if Context.IsEnabled("identity") then
		local d = selected("identity")
		add(text(d.game) .. (d.client and (" (" .. text(d.client) .. ")") or ""))
		add(table.concat({ text(d.name), text(d.realm), text(d.level), text(d.race), text(d.class), text(d.faction) }, " "))
	end
	if Context.IsEnabled("location") then
		local d = selected("location")
		local position = ""
		if type(d.mapID) == "number" then position = " (map " .. text(d.mapID) .. ")" end
		if type(d.x) == "number" and type(d.y) == "number" and d.x >= 0 and d.x <= 1 and d.y >= 0 and d.y <= 1 then
			position = position .. string.format(" %.1f%%, %.1f%%", d.x * 100, d.y * 100)
		end
		add("Location: " .. text(d.zone) .. " " .. text(d.subZone) .. position)
	end
	if Context.IsEnabled("money") then local d = selected("money"); if d.copper then add("Copper: " .. text(d.copper)) end end
	if Context.IsEnabled("professions") then
		local d = selected("professions")
		for _, skill in ipairs(d.skills or {}) do if not skill.isHeader and type(skill.name) == "string" then add(skill.name .. " " .. text(skill.rank) .. "/" .. text(skill.maxRank)) end end
	end
	if Context.IsEnabled("quests") then local d = selected("quests"); add("Quest log entries: " .. #(d.entries or {})) end
	return table.concat(parts, "; ")
end
-- Query pagination uses zero-based offsets. Objects are returned as raw-key/value
-- entries; arrays as items. A path selects a nested result before pagination.
local function selectPath(value, path)
	if path == nil then return value end
	if type(path) ~= "table" or getmetatable(path) ~= nil then return nil, "path must be a plain array" end
	for k in next, path do
		if type(k) ~= "number" or k < 1 or k > #path or k % 1 ~= 0 then return nil, "path must be a dense array" end
	end
	for _, key in ipairs(path) do
		if secret(key) or (type(key) ~= "string" and type(key) ~= "number") then return nil, "invalid path component" end
		if secret(value) or type(value) ~= "table" then return nil, "path is not an accessible table" end
		value = rawget(value, key)
		if value == nil then return nil, "path unavailable" end
	end
	return value
end
local function paginate(value, request)
	local offset, limit = request.offset or 0, request.limit or 100
	if type(offset) ~= "number" or offset < 0 or offset % 1 ~= 0 or type(limit) ~= "number" or limit < 1 or limit > 500 or limit % 1 ~= 0 then return nil, nil, "offset must be a nonnegative integer; limit must be 1..500" end
	value = clean(value)
	if type(value) ~= "table" then return { kind = "scalar", value = value, complete = true, total = 1, offset = 0, limit = limit } end
	local sequence = isArray(value)
	local keys = {}
	for key in next, value do keys[#keys + 1] = key end
	table.sort(keys, function(a, b) if type(a) == "number" and type(b) == "number" then return a < b end; return tostring(a) < tostring(b) end)
	local result = { kind = sequence and "array" or "object", total = #keys, offset = offset, limit = limit, complete = offset + limit >= #keys }
	local items = array()
	for i = offset + 1, math.min(#keys, offset + limit) do local key = keys[i]; items[#items + 1] = sequence and value[key] or { key = key, value = value[key] } end
	if sequence then result.items = items else result.entries = items end
	return result, not result.complete and offset + limit or nil
end
local numericTypes = { number = true, luaIndex = true, fileID = true, uiAddon = true, time_t = true }
local stringTypes = { string = true, cstring = true, UnitToken = true, UnitTokenPvPRestrictedForAddOns = true, UnitTokenRestrictedForAddOns = true, unit = true, WOWGUID = true, textureAtlas = true }
local function plain(value, seen, depth)
	if secret(value) then return false end
	local t = type(value)
	if t == "number" then return value == value and value ~= math.huge and value ~= -math.huge end
	if t == "nil" or t == "boolean" or t == "string" then return true end
	if t ~= "table" or getmetatable(value) ~= nil or depth > 32 or seen[value] then return false end
	seen[value] = true
	for k, v in next, value do if (type(k) ~= "string" and type(k) ~= "number") or not plain(v, seen, depth + 1) then seen[value] = nil; return false end end
	seen[value] = nil; return true
end
local function convert(value, field, depth)
	depth = depth or 0
	if depth > 24 then return nil, "argument nesting too deep" end
	if value == nil then
		if field.Default ~= nil then value = field.Default
		elseif field.Nilable then return nil
		else return nil, "required argument " .. (field.Name or "?") end
	end
	local typ = field.Type
	if numericTypes[typ] then
		if type(value) ~= "number" or value ~= value or value == math.huge or value == -math.huge then return nil, "expected finite number" end
		if typ == "luaIndex" and (value < 1 or value % 1 ~= 0) then return nil, "expected positive integer index" end
		return value
	end
	if stringTypes[typ] then if type(value) ~= "string" then return nil, "expected string" end; return value end
	if typ == "bool" or typ == "boolean" then if type(value) ~= "boolean" then return nil, "expected boolean" end; return value end
	if typ == "SpellIdentifier" then if type(value) == "number" or type(value) == "string" then return value end; return nil, "expected spell ID or name" end
	if typ == "ItemInfo" then
		if type(value) == "number" or type(value) == "string" then return value end
		return nil, "expected item ID, name or hyperlink"
	end
	if typ == "ItemLocation" or typ == "EmptiableItemLocation" then
		if type(value) ~= "table" or value.type ~= "ItemLocation" then return nil, "expected {type='ItemLocation',bag,slot} or {type='ItemLocation',equipmentSlot}" end
		if not ItemLocation then return nil, "ItemLocation unavailable" end
		if value.equipmentSlot ~= nil then
			if type(value.equipmentSlot) ~= "number" or value.equipmentSlot % 1 ~= 0 or value.equipmentSlot < 0 then return nil, "invalid equipment slot" end
			-- Constructors return mixins; do not sanitize away their required methods.
			local ok, object = pcall(ItemLocation.CreateFromEquipmentSlot, ItemLocation, value.equipmentSlot)
			if ok then return object end
		else
			if type(value.bag) ~= "number" or value.bag % 1 ~= 0 or type(value.slot) ~= "number" or value.slot % 1 ~= 0 or value.slot < 1 then return nil, "invalid bag/slot" end
			local ok, object = pcall(ItemLocation.CreateFromBagAndSlot, ItemLocation, value.bag, value.slot)
			if ok then return object end
		end
		return nil, "ItemLocation constructor unavailable"
	end
	if typ == "vector2" or typ == "Vector2D" then
		if type(value) ~= "table" or (value.type ~= "Vector2D" and value.type ~= "vector2") or type(value.x) ~= "number" or type(value.y) ~= "number" then return nil, "expected {type='Vector2D',x,y}" end
		if type(CreateVector2D) ~= "function" then return nil, "Vector2D constructor unavailable" end
		local ok, object = pcall(CreateVector2D, value.x, value.y); if ok then return object end; return nil, "invalid Vector2D"
	end
	if typ == "UiMapPoint" then
		if type(value) ~= "table" or value.type ~= "UiMapPoint" or type(value.mapID) ~= "number" or type(value.x) ~= "number" or type(value.y) ~= "number" then return nil, "expected {type='UiMapPoint',mapID,x,y}" end
		if not UiMapPoint or type(UiMapPoint.CreateFromCoordinates) ~= "function" then return nil, "UiMapPoint constructor unavailable" end
		local ok, object = pcall(UiMapPoint.CreateFromCoordinates, value.mapID, value.x, value.y); if ok then return object end; return nil, "invalid UiMapPoint"
	end
	local enumeration = Enum and Enum[typ]
	if type(enumeration) == "table" then
		if type(value) == "string" and enumeration[value] ~= nil then return enumeration[value] end
		for _, candidate in pairs(enumeration) do if value == candidate then return value end end
		return nil, "invalid enum " .. typ
	end
	local schema = schemas[typ]
	if schema and schema.Type == "Enumeration" then
		for _, f in ipairs(schema.Fields or {}) do if value == f.EnumValue or value == f.Name then return f.EnumValue end end
		return nil, "invalid documented enum"
	end
	if typ == "table" then
		if type(value) ~= "table" then return nil, "expected table" end
		local result = {}
		for k, v in next, value do
			local converted, err = convert(v, { Type = field.InnerType or "any", Nilable = true }, depth + 1)
			if err then return nil, err end; result[k] = converted
		end
		return result
	end
	if schema and schema.Fields then
		if type(value) ~= "table" then return nil, "expected " .. typ .. " structure" end
		local result, approved = {}, {}
		for _, f in ipairs(schema.Fields) do local v, err = convert(rawget(value, f.Name), f, depth + 1); if err then return nil, err end; result[f.Name] = v; approved[f.Name] = true end
		for k in next, value do if not approved[k] then return nil, "unknown structure field" end end
		return result
	end
	if typ == "any" then if plain(value, {}, 0) then return value end; return nil, "expected JSON value" end
	return nil, "unsupported argument type " .. tostring(typ)
end
local function arguments(args, fields)
	args = args or {}
	if type(args) ~= "table" or not plain(args, {}, 0) then return nil, "args must be a plain JSON array" end
	local max = #fields
	if args.n ~= nil and (type(args.n) ~= "number" or args.n < 0 or args.n > max or args.n % 1 ~= 0) then return nil, "invalid argument count" end
	for k in next, args do
		if k ~= "n" and (type(k) ~= "number" or k < 1 or k % 1 ~= 0 or k > max or (args.n ~= nil and k > args.n)) then return nil, "unexpected argument" end
	end
	local result = { n = max }
	for i, field in ipairs(fields) do local value, err = convert(rawget(args, i), field); if err then return nil, (field.Name or tostring(i)) .. ": " .. err end; result[i] = value end
	return result
end
local frameMethods = {
	IsShown = {}, IsVisible = {}, IsEnabled = {}, GetMapID = {}, GetID = {}, GetName = {}, GetWidth = {}, GetHeight = {}, GetScale = {}, GetEffectiveScale = {}, GetAlpha = {}, GetFrameLevel = {}, GetFrameStrata = {}, GetText = {}, GetValue = {}, GetMinMaxValues = {}, GetChecked = {}, GetNumMessages = {},
	GetMessageInfo = { { Name = "index", Type = "luaIndex" } }, GetPoint = { { Name = "index", Type = "luaIndex", Default = 1 } }, GetNumPoints = {},
}
local function signature(entry)
	local f = entry.metadata
	local args, returns = array(), array()
	for _, field in ipairs(f.Arguments or {}) do args[#args + 1] = { name = field.Name, type = field.Type, innerType = field.InnerType, nilable = field.Nilable == true, default = field.Default } end
	for _, field in ipairs(f.Returns or {}) do returns[#returns + 1] = { name = field.Name, type = field.Type, innerType = field.InnerType, nilable = field.Nilable == true } end
	return { name = entry.name, category = entry.category, arguments = args, returns = returns, documentation = f.Documentation, mayReturnNothing = f.MayReturnNothing == true, requiredPermission = entry.requiredPermission, sideEffect = entry.requiredPermission == "mail_body" and "reading marks messages as read" or nil }
end
local function query(request)
	if type(request) ~= "table" or not plain(request, {}, 0) then return { ok = false, error = "request must contain only plain JSON values" } end
	if not db().context then return { ok = false, error = "context sharing is disabled" } end
	local op, categoryID = request.op, request.category
	local value
	if op == "catalog" then
		discover()
		if categoryID then
			if type(categoryID) ~= "string" or categoryID:sub(1, 4) ~= "api:" then return { ok = false, error = "catalog category must be a documented api namespace" } end
			if not byID[categoryID] then return { ok = false, category = categoryID, error = "namespace documentation unavailable on this client" } end
			if not Context.IsEnabled(categoryID) then return { ok = false, category = categoryID, error = "category permission disabled" } end
			value = array()
			for _, entry in pairs(apiIndex) do if entry.category == categoryID then value[#value + 1] = signature(entry) end end
			table.sort(value, function(a, b) return a.name < b.name end)
		else
			value = array(); for _, d in ipairs(Context.Categories()) do if d.enabled then value[#value + 1] = d end end
		end
		if request.search ~= nil then
			if type(request.search) ~= "string" then return { ok = false, error = "search must be a string" } end
			local filtered = array(); local search = request.search:lower()
			for _, row in ipairs(value) do if (row.name or row.id):lower():find(search, 1, true) then filtered[#filtered + 1] = row end end
			value = filtered
		end
	elseif op == "snapshot" then
		if not providers[categoryID] then return { ok = false, error = "unknown snapshot category" } end
		if not Context.IsEnabled(categoryID) then return { ok = false, category = categoryID, error = "category permission disabled" } end
		value = collect(categoryID)
	elseif op == "api" then
		discover()
		local entry = type(request.name) == "string" and apiIndex[request.name]
		if not entry then return { ok = false, error = "API is undocumented, unavailable or not an approved native read-only getter" } end
		categoryID = entry.category
		if not Context.IsEnabled(categoryID) then return { ok = false, category = categoryID, error = "category permission disabled" } end
		if entry.requiredPermission then
			if not Context.IsEnabled(entry.requiredPermission) then return { ok = false, category = categoryID, error = entry.requiredPermission .. " permission disabled" } end
			if not windowOpen("mail", "MailFrame") then return { ok = false, category = categoryID, error = "mailbox window must be open" } end
		end
		local fn, owner = resolve(entry.namespace, entry.shortName)
		if fn ~= entry.fn or not trusted(fn, owner, entry.shortName) then return { ok = false, category = categoryID, error = "API implementation changed or is not native" } end
		local args, err = arguments(request.args, entry.metadata.Arguments or {})
		if err then return { ok = false, category = categoryID, error = err } end
		if entry.requiredPermission and not Context.IsEnabled(entry.requiredPermission) then return { ok = false, category = categoryID, error = entry.requiredPermission .. " permission revoked" } end
		-- Constructors and validation happen only after the current permission check.
		local ok, result = pcall(function() return clean(pack(fn(unpack(args, 1, args.n)))) end)
		if not ok then return { ok = false, category = categoryID, error = "API failed or values are restricted" } end
		value = { returns = array(), count = result.n }
		for i = 1, result.n do value.returns[i] = { name = (entry.metadata.Returns[i] or {}).Name, value = result[i], isNil = result[i] == nil } end
	elseif op == "table" then
		categoryID = "addons"
		if not Context.IsEnabled(categoryID) then return { ok = false, category = categoryID, error = "category permission disabled" } end
		if type(request.path) ~= "table" or #request.path == 0 then return { ok = false, category = categoryID, error = "nonempty global path required" } end
		local err; value, err = selectPath(_G, request.path)
		if err then return { ok = false, category = categoryID, error = err } end
		if value == nil then return { ok = false, category = categoryID, error = "global path unavailable" } end
	elseif op == "frame" then
		categoryID = "ui"
		if not Context.IsEnabled(categoryID) then return { ok = false, category = categoryID, error = "category permission disabled" } end
		if type(request.frame) ~= "string" or not request.frame:match("^[%a_][%w_]*$") or not frameMethods[request.method] then return { ok = false, category = categoryID, error = "unapproved frame or method" } end
		local frame = rawget(_G, request.frame)
		local fn, owner = rawMethod(frame, request.method)
		if type(fn) ~= "function" or not trusted(fn, owner, request.method) then return { ok = false, category = categoryID, error = "trusted frame getter unavailable" } end
		local args, err = arguments(request.args, frameMethods[request.method]); if err then return { ok = false, category = categoryID, error = err } end
		local ok, result = pcall(function() return clean(pack(fn(frame, unpack(args, 1, args.n)))) end)
		if not ok then return { ok = false, category = categoryID, error = "frame getter failed or restricted" } end
		value = { returns = array(), count = result.n }; for i = 1, result.n do value.returns[i] = { value = result[i], isNil = result[i] == nil } end
	else return { ok = false, error = "unknown context query operation" } end
	if op ~= "table" then
		local err; value, err = selectPath(value, request.path)
		if err then return { ok = false, category = categoryID, error = err } end
	end
	local page, nextOffset, err = paginate(value, request)
	if err then return { ok = false, category = categoryID, error = err } end
	local documentationStatus
	if op == "catalog" then documentationStatus = type(APIDocumentation) == "table" and type(APIDocumentation.systems) == "table" and #APIDocumentation.systems > 0 and "available" or "unavailable" end
	return { ok = true, category = categoryID, value = page, nextOffset = nextOffset, capturedAt = now(), documentationStatus = documentationStatus }
end
function Context.Query(request)
	local ok, response = pcall(query, request)
	if not ok then response = { ok = false, error = "context request failed or data is inaccessible" } end
	return Context.Encode(response)
end
