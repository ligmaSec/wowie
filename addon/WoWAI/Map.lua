-- WoWAI map: layers the agent draws (routes, quest stops, marks), synced from the
-- bridge, plus herb and ore locations from the optional WoWAI_Nodes addon.
--
-- Layers arrive in slot files as { epoch, version, layers = { { name, title,
-- ordered, loop, points = { { uiMapID, x, y, label, kind }, ... } } } }; x/y are
-- map percent. The bridge owns the source snapshot; local additions and deletion
-- masks are merged over it so editing saved points also works offline. Everything
-- here reads positions and draws; nothing moves, targets or acts for the player.

local ADDON_NAME = ...
local M = {}
WoWAIMap = M

local ARRIVE_YARDS = 12
local NODE_SIZE, PIN_SIZE = 9, 16
local CIRCLE = "Interface\\CHARACTERFRAME\\TempPortraitAlphaMask"
local CONTINENT = (Enum and Enum.UIMapType and Enum.UIMapType.Continent) or 2
local LOCAL_LAYER = "@local" -- outside the bridge's allowed layer-name alphabet

local KIND_COLOR = {
	ore = { 0.95, 0.6, 0.25 }, herb = { 0.35, 0.95, 0.35 }, quest = { 1, 0.85, 0 }, turnin = { 0.35, 0.8, 1 },
	kill = { 1, 0.3, 0.3 }, loot = { 1, 0.5, 0.85 }, object = { 0.8, 0.6, 1 }, explore = { 0.5, 1, 1 },
	npc = { 1, 1, 1 }, trainer = { 0.95, 0.95, 0.4 }, vendor = { 0.6, 0.95, 0.6 }, dungeon = { 1, 0.45, 0.1 },
	flight = { 0.55, 0.75, 1 }, poi = { 1, 1, 1 },
}

local mdb -- WoWAIMapDB: source map, local edits, visibility/nodes, navigation and owned waypoint

local function Try(fn, ...)
	if type(fn) ~= "function" then return nil end
	local ok, a, b, c, d = pcall(fn, ...)
	if ok then return a, b, c, d end
end

local function Print(msg)
	print("|cff66ccff[WoW AI map]|r " .. msg)
end

local function DB()
	if not mdb then
		WoWAIMapDB = WoWAIMapDB or {}
		mdb = WoWAIMapDB
		mdb.hidden = mdb.hidden or {}
		mdb.nodes = mdb.nodes or { ore = false, herb = false, filter = "skill" }
		mdb.navPos = nil -- the standalone compass was replaced by map tracking
	end
	return mdb
end

local EMPTY_LAYERS = {}
local navigationRevision, navigationSnapshot = 0, nil
local navigationMessage, navigationUnavailable = "", false
local effectiveLayers
local RefreshNavigation

local function NavigationChanged()
	navigationRevision = navigationRevision + 1
	navigationSnapshot = nil
	if RefreshNavigation then RefreshNavigation() end
	M.Refresh()
	if WoWAI and WoWAI.UpdateNavigation then WoWAI.UpdateNavigation() end
end

-- Include occurrence numbers so removing a repeated route stop removes just that stop.
local function PointKey(p, occurrences)
	local key = string.format("%d/%.6f/%.6f/%q/%q", p[1], p[2], p[3], p[4] or "", p[5] or "")
	occurrences[key] = (occurrences[key] or 0) + 1
	return key .. "/" .. occurrences[key]
end

local function Layers()
	if effectiveLayers then return effectiveLayers end
	local db = DB()
	local source = db.map and db.map.layers or EMPTY_LAYERS
	if not db.edits or not next(db.edits) then effectiveLayers = source; return source end
	local layers, seen = {}, {}
	for _, l in ipairs(source) do
		seen[l.name] = true
		local edit = db.edits[l.name]
		if edit then
			local points, occurrences = {}, {}
			for _, p in ipairs(l.points) do
				if not edit.removed or not edit.removed[PointKey(p, occurrences)] then points[#points + 1] = p end
			end
			for _, p in ipairs(edit.points) do points[#points + 1] = p end
			layers[#layers + 1] = { name = l.name, title = l.title, ordered = l.ordered, loop = l.loop, points = points }
		else
			layers[#layers + 1] = l
		end
	end
	local extra = {}
	for name, edit in pairs(db.edits) do
		if not seen[name] and #edit.points > 0 then extra[#extra + 1] = name end
	end
	table.sort(extra)
	for _, name in ipairs(extra) do
		local edit = db.edits[name]
		layers[#layers + 1] = { name = name, title = edit.title, ordered = edit.ordered, loop = edit.loop, points = edit.points }
	end
	effectiveLayers = layers
	return layers
end

local function FindLayer(name)
	for i, l in ipairs(Layers()) do
		if l.name == name then return l, i end
	end
end

local function EditLayer(l)
	local db = DB()
	db.edits = db.edits or {}
	local edit = db.edits[l.name]
	if not edit then edit = { points = {} }; db.edits[l.name] = edit end
	edit.title, edit.ordered, edit.loop = l.title, l.ordered, l.loop
	return edit
end

---------------------------------------------------------------------------
-- Map geometry (C_Map only; results cached)
---------------------------------------------------------------------------

local continentOf = {}
local function ContinentOf(mapID)
	if continentOf[mapID] ~= nil then return continentOf[mapID] or nil end
	local id, guard = mapID, 0
	while id and id > 0 and guard < 10 do
		local info = Try(C_Map.GetMapInfo, id)
		if type(info) ~= "table" then break end
		if info.mapType == CONTINENT then continentOf[mapID] = id; return id end
		id, guard = info.parentMapID, guard + 1
	end
	continentOf[mapID] = false
end

-- Where mapID's (x, y) (0-1) falls on `target` (0-1), or nil if it doesn't.
local function Project(mapID, x, y, target)
	if mapID == target then return x, y end
	local minX, maxX, minY, maxY = Try(C_Map.GetMapRectOnMap, mapID, target)
	if type(minX) == "number" and maxX ~= minX and maxY ~= minY then
		return minX + (maxX - minX) * x, minY + (maxY - minY) * y
	end
	-- `target` sits inside mapID (a city map shown while the point is on its zone).
	minX, maxX, minY, maxY = Try(C_Map.GetMapRectOnMap, target, mapID)
	if type(minX) == "number" and maxX ~= minX and maxY ~= minY then
		return (x - minX) / (maxX - minX), (y - minY) / (maxY - minY)
	end
end

-- Continent-space size in yards, measured from the engine's own map->world transform.
local continentSize = {}
local function ContinentYards(cont)
	if continentSize[cont] then return continentSize[cont][1], continentSize[cont][2] end
	local w, h
	if C_Map.GetWorldPosFromMapPos and CreateVector2D then
		local _, a = Try(C_Map.GetWorldPosFromMapPos, cont, CreateVector2D(0, 0))
		local _, b = Try(C_Map.GetWorldPosFromMapPos, cont, CreateVector2D(1, 0))
		local _, c = Try(C_Map.GetWorldPosFromMapPos, cont, CreateVector2D(0, 1))
		if a and b and c then
			w = math.sqrt((b.x - a.x) ^ 2 + (b.y - a.y) ^ 2)
			h = math.sqrt((c.x - a.x) ^ 2 + (c.y - a.y) ^ 2)
		end
	end
	if not (w and h and w > 0 and h > 0) then
		local ww, hh = Try(C_Map.GetMapWorldSize, cont)
		w, h = ww, hh
	end
	if w and h and w > 0 and h > 0 then continentSize[cont] = { w, h } end
	return w, h
end

-- The player's position as (continent, cx, cy) in continent map space.
local function PlayerOnContinent()
	local mapID = Try(C_Map.GetBestMapForUnit, "player")
	if not mapID then return end
	local pos = Try(C_Map.GetPlayerMapPosition, mapID, "player")
	if not pos then return end
	local px, py = pos.x, pos.y
	if not px or (px == 0 and py == 0) then return end
	local cont = ContinentOf(mapID)
	if not cont then return end
	local cx, cy = Project(mapID, px, py, cont)
	if cx then return cont, cx, cy end
end

-- Straight-line yards are only used for arrival when no routing addon is active.
local function DistanceTo(p)
	local cont, px, py = PlayerOnContinent()
	if not cont or ContinentOf(p[1]) ~= cont then return end
	local tx, ty = Project(p[1], p[2] / 100, p[3] / 100, cont)
	if not tx then return end
	local w, h = ContinentYards(cont)
	if not w or not h then return end
	local east, south = (tx - px) * w, (ty - py) * h
	return math.sqrt(east * east + south * south)
end

---------------------------------------------------------------------------
-- World map drawing
---------------------------------------------------------------------------

local overlay
local pins, pinCount = {}, 0
local lines, lineCount = {}, 0
local nodePins, nodeCount = {}, 0

local function ShowTip(self)
	if not self.info then return end
	GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
	GameTooltip:AddLine(self.info.title or "Map", 0.4, 0.8, 1)
	GameTooltip:AddLine(self.info.label or "", 1, 1, 1, true)
	if self.info.hint then GameTooltip:AddLine(self.info.hint, 0.6, 0.6, 0.6) end
	GameTooltip:Show()
end

local function NewPin(size)
	local b = CreateFrame("Button", nil, overlay)
	b:SetSize(size, size)
	b.dot = b:CreateTexture(nil, "OVERLAY")
	b.dot:SetAllPoints()
	b.dot:SetTexture(CIRCLE)
	b.ring = b:CreateTexture(nil, "ARTWORK")
	b.ring:SetPoint("CENTER")
	b.ring:SetSize(size + 4, size + 4)
	b.ring:SetTexture(CIRCLE)
	b.ring:SetVertexColor(0, 0, 0, 0.85)
	b.num = b:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
	b.num:SetPoint("CENTER", 0, 0)
	b.num:SetTextColor(0, 0, 0)
	b:SetScript("OnEnter", ShowTip)
	b:SetScript("OnLeave", function() GameTooltip:Hide() end)
	b:RegisterForClicks("LeftButtonUp")
	b:SetScript("OnClick", function(self)
		if self.info and self.info.layer then M.Navigate(self.info.layer, self.info.index) end
	end)
	return b
end

local function Place(frame, x, y, scale)
	local w, h = overlay:GetWidth(), overlay:GetHeight()
	frame:SetScale(scale)
	frame:ClearAllPoints()
	frame:SetPoint("CENTER", overlay, "TOPLEFT", x * w / scale, -y * h / scale)
	frame:Show()
end

local function CanvasScale()
	local s = WorldMapFrame and WorldMapFrame.GetCanvasScale and Try(WorldMapFrame.GetCanvasScale, WorldMapFrame)
	return (type(s) == "number" and s > 0) and s or 1
end

local function AddLine(x1, y1, x2, y2, color, thickness)
	lineCount = lineCount + 1
	local l = lines[lineCount]
	if not l then
		l = overlay:CreateLine(nil, "ARTWORK")
		lines[lineCount] = l
	end
	local w, h = overlay:GetWidth(), overlay:GetHeight()
	l:SetThickness(thickness)
	l:SetColorTexture(color[1], color[2], color[3], 0.75)
	l:SetStartPoint("TOPLEFT", overlay, x1 * w, -y1 * h)
	l:SetEndPoint("TOPLEFT", overlay, x2 * w, -y2 * h)
	l:Show()
end

-- Skill of a profession (Mining 186, Herbalism 182), or nil if not learned.
local SKILL_IDS = { mining = 186, herbalism = 182 }
local SKILL_NAMES = { mining = MINING or "Mining", herbalism = HERBALISM or "Herbalism" }
local function SkillRank(prof)
	local lines = WoWAI and WoWAI.SkillLines and WoWAI.SkillLines() or {}
	for _, sk in ipairs(lines) do
		if not sk.isHeader and (sk.skillID == SKILL_IDS[prof] or sk.name == SKILL_NAMES[prof]) then return sk.rank end
	end
end

local function NodeFilter()
	local f = DB().nodes
	local want = {}
	if f.ore then want.mining = SkillRank("mining") or false end
	if f.herb then want.herbalism = SkillRank("herbalism") or false end
	return want, f.filter
end

local function DrawNodes(mapID, scale)
	local data = WoWAINodes
	local want, filter = NodeFilter()
	if not data or not next(want) then return end
	local perMap = data.maps and data.maps[mapID]
	if not perMap then return end
	for i, packed in pairs(perMap) do
		local kind = data.kinds[i]
		local prof = kind and kind[2]
		local rank = prof and want[prof]
		local show = rank ~= nil and (filter == "all" or rank == false or kind[3] <= rank)
		if show then
			local color = prof == "mining" and KIND_COLOR.ore or KIND_COLOR.herb
			for j = 1, #packed - 5, 6 do
				local x = tonumber(packed:sub(j, j + 2)) / 1000
				local y = tonumber(packed:sub(j + 3, j + 5)) / 1000
				nodeCount = nodeCount + 1
				local b = nodePins[nodeCount]
				if not b then
					b = NewPin(NODE_SIZE)
					b.ring:SetSize(NODE_SIZE + 2, NODE_SIZE + 2)
					-- Hover shows the tooltip; clicks and drags go through to the map (pan, zoom).
					if b.SetMouseClickEnabled then b:SetMouseClickEnabled(false) end
					b.info = {}
					nodePins[nodeCount] = b
				end
				b.dot:SetVertexColor(color[1], color[2], color[3], 0.9)
				b.num:SetText("")
				local info = b.info
				info.title = kind[1]
				info.label = (prof == "mining" and "Mining " or "Herbalism ") .. kind[3]
				info.hint = rank == false and "You don't have this profession" or nil
				info.layer = nil
				Place(b, x, y, scale)
			end
		end
	end
end

function M.Refresh()
	if not overlay or not WorldMapFrame:IsShown() then return end
	for i = 1, pinCount do pins[i]:Hide() end
	for i = 1, lineCount do lines[i]:Hide() end
	for i = 1, nodeCount do nodePins[i]:Hide() end
	pinCount, lineCount, nodeCount = 0, 0, 0
	local mapID = WorldMapFrame:GetMapID()
	if not mapID then return end
	local scale = 1 / CanvasScale()
	overlay.drawnScale = CanvasScale()
	DrawNodes(mapID, scale)
	local nav = DB().nav
	for _, l in ipairs(Layers()) do
		if not mdb.hidden[l.name] then
			local prev, first
			for i, p in ipairs(l.points) do
				local x, y = Project(p[1], p[2] / 100, p[3] / 100, mapID)
				local inside = x and x >= 0 and x <= 1 and y >= 0 and y <= 1
				if inside then
					local color = KIND_COLOR[p[5]] or KIND_COLOR.poi
					if l.ordered and prev then AddLine(prev[1], prev[2], x, y, color, 2.5 * scale) end
					pinCount = pinCount + 1
					local b = pins[pinCount]
					if not b then b = NewPin(PIN_SIZE); pins[pinCount] = b end
					local current = nav and nav.layer == l.name and nav.index == i
					b.dot:SetVertexColor(color[1], color[2], color[3], 1)
					b.ring:SetVertexColor(current and 1 or 0, current and 1 or 0, current and 1 or 0, 0.9)
					b.num:SetText(l.ordered and tostring(i) or "")
					b:SetFrameLevel(overlay:GetFrameLevel() + (current and 20 or 10))
					b.info = { title = l.title, label = p[4] ~= "" and p[4] or l.name, layer = l.name, index = i, hint = "Click: navigate here" }
					Place(b, x, y, scale)
					prev = { x, y }
					first = first or { x, y, color }
				else
					prev = nil
				end
			end
			-- A loop closes back to its first stop.
			if l.loop and l.ordered and prev and first and #l.points > 2 then
				AddLine(prev[1], prev[2], first[1], first[2], first[3], 2.5 * scale)
			end
		end
	end
end

local function SetupWorldMap()
	if overlay or not WorldMapFrame or not WorldMapFrame.GetCanvas then return end
	local canvas = WorldMapFrame:GetCanvas()
	overlay = CreateFrame("Frame", nil, canvas)
	overlay:SetAllPoints(canvas)
	overlay:SetFrameLevel(canvas:GetFrameLevel() + 2000)
	hooksecurefunc(WorldMapFrame, "OnMapChanged", M.Refresh)
	WorldMapFrame:HookScript("OnShow", M.Refresh)
	-- Keep pins the same size on screen while zooming.
	overlay:SetScript("OnUpdate", function(self, elapsed)
		self.t = (self.t or 0) + elapsed
		if self.t < 0.1 then return end
		self.t = 0
		if math.abs(CanvasScale() - (self.drawnScale or 0)) > 0.01 then M.Refresh() end
	end)
end

---------------------------------------------------------------------------
-- Map tracking: native waypoints, with dotted routes through ShortestPathForever
---------------------------------------------------------------------------

local ROUTE_OWNER = "WoWAI"
local tracking, navigatorTicker

local function Router()
	local api = ShortestPathForever and ShortestPathForever.API
	if api and api.version == 1 and type(api.Navigate) == "function"
		and type(api.Cancel) == "function" and type(api.CurrentStop) == "function"
		and type(api.Ended) == "function" and type(api.Active) == "function" then return api end
end

local function WaypointMatches(point, own)
	return point and point.position and point.uiMapID == own.map
		and math.abs(point.position.x - own.x) < 0.000001
		and math.abs(point.position.y - own.y) < 0.000001
end

local function ReleaseWaypoint()
	local own = DB().waypoint
	if not own then return end
	mdb.waypoint = nil
	if not WaypointMatches(Try(C_Map.GetUserWaypoint), own) then return end
	local ownsTracking = Try(C_SuperTrack and C_SuperTrack.IsSuperTrackingUserWaypoint)
	local restored = false
	if own.previous and UiMapPoint and UiMapPoint.CreateFromCoordinates then
		local p = own.previous
		restored = Try(C_Map.SetUserWaypoint, UiMapPoint.CreateFromCoordinates(p.map, p.x, p.y, p.z)) == true
	end
	if not restored then Try(C_Map.ClearUserWaypoint) end
	if ownsTracking then
		Try(C_SuperTrack.SetSuperTrackedUserWaypoint, restored and own.tracked or false)
		if not (restored and own.tracked) and own.quest then Try(C_SuperTrack.SetSuperTrackedQuestID, own.quest) end
	end
end

local function ReleaseTracking()
	local api = tracking and tracking.api or Router()
	if api then Try(api.Cancel, ROUTE_OWNER) end -- the API only cancels this owner's journey
	tracking = nil
	ReleaseWaypoint()
end

local function SetNativeWaypoint(p)
	if not (C_Map.SetUserWaypoint and C_Map.GetUserWaypoint and C_Map.ClearUserWaypoint
		and UiMapPoint and UiMapPoint.CreateFromCoordinates
		and C_SuperTrack and C_SuperTrack.SetSuperTrackedUserWaypoint
		and C_SuperTrack.IsSuperTrackingUserWaypoint) then return false end
	if C_Map.CanSetUserWaypointOnMap and not Try(C_Map.CanSetUserWaypointOnMap, p[1]) then return false end
	local own = DB().waypoint
	if not own then
		own = { tracked = Try(C_SuperTrack.IsSuperTrackingUserWaypoint), quest = Try(C_SuperTrack.GetSuperTrackedQuestID) }
		local previous = Try(C_Map.GetUserWaypoint)
		if previous and previous.position then
			own.previous = { map = previous.uiMapID, x = previous.position.x, y = previous.position.y, z = previous.z }
		end
	end
	local x, y = p[2] / 100, p[3] / 100
	if Try(C_Map.SetUserWaypoint, UiMapPoint.CreateFromCoordinates(p[1], x, y)) ~= true then return false end
	own.map, own.x, own.y = p[1], x, y
	mdb.waypoint = own -- plain coordinates survive /reload; no Vector2D userdata is saved
	local ok = pcall(C_SuperTrack.SetSuperTrackedUserWaypoint, true)
	if not ok then ReleaseWaypoint(); return false end
	return true
end

local function TrackingMatches(l, p, i)
	return tracking and tracking.layer == l.name and tracking.index == i
		and tracking.map == p[1] and tracking.x == p[2] and tracking.y == p[3]
		and tracking.title == (p[4] ~= "" and p[4] or l.title) and tracking.kind == p[5]
end

local function StartTracking(l, p, i)
	if TrackingMatches(l, p, i) and tracking.backend ~= "pending" then return true end
	local api = Router()
	local backend = "native"
	if api and InCombatLockdown() then
		if not tracking or tracking.backend ~= "pending" then
			ReleaseTracking()
			Print("Map route tracking will start after combat.")
		end
		backend = "pending"
	elseif api then
		-- The router owns its native bend waypoint and restores the player's tracking.
		-- Never compete with it by writing a second waypoint on every update.
		ReleaseWaypoint()
		if Try(api.Navigate, ROUTE_OWNER, p[1], p[2] / 100, p[3] / 100, p[4] ~= "" and p[4] or l.title, p[5]) == true then
			backend = "route"
		else
			Try(api.Cancel, ROUTE_OWNER)
			Print("Dotted routing is unavailable; setting the game's map waypoint.")
		end
	end
	if backend == "native" and not SetNativeWaypoint(p) then
		ReleaseTracking()
		mdb.nav = nil
		navigationMessage = "This location is unavailable in the client's waypoint API."
		navigationUnavailable = true
		Print(navigationMessage)
		return false
	end
	tracking = { backend = backend, api = backend == "route" and api or nil, layer = l.name, index = i,
		map = p[1], x = p[2], y = p[3], title = p[4] ~= "" and p[4] or l.title, kind = p[5] }
	navigationUnavailable = false
	navigationMessage = backend == "pending" and "Waiting for combat to end." or ""
	NavigationChanged()
	return true
end

local function NavPoint()
	local n = DB().nav
	if not n then return end
	local l = FindLayer(n.layer)
	if not l or #l.points == 0 then
		mdb.nav = nil
		return
	end
	n.index = math.max(1, math.min(math.floor(tonumber(n.index) or 1), #l.points))
	return l, l.points[n.index], n.index
end

-- Snapshots retain the saved layer/point references and are rebuilt only on change.
function M.GetNavigationState()
	if navigationSnapshot then return navigationSnapshot end
	local l, p, i = NavPoint()
	local backend = tracking and tracking.backend
	navigationSnapshot = {
		revision = navigationRevision, layers = Layers(),
		status = l and (backend or "pending") or (navigationUnavailable and "unavailable" or "idle"),
		message = navigationMessage,
	}
	if l then
		navigationSnapshot.active = { layer = l.name, title = l.title or "Destinations", index = i,
			total = #l.points, point = p, ordered = l.ordered == true, loop = l.loop == true,
			backend = backend or "pending" }
	end
	return navigationSnapshot
end

function M.UpdateNavigator()
	local hadNav = DB().nav ~= nil
	local l, p, i = NavPoint()
	if not l then
		if tracking or DB().waypoint or hadNav then
			ReleaseTracking()
			NavigationChanged()
		end
		return
	end
	-- Respect a pin the player moved or cleared, including between UI reloads.
	local own = DB().waypoint
	if own and (not WaypointMatches(Try(C_Map.GetUserWaypoint), own)
		or Try(C_SuperTrack and C_SuperTrack.IsSuperTrackingUserWaypoint) == false) then
		mdb.nav = nil
		ReleaseTracking()
		navigationMessage = "Tracking stopped: the player's waypoint or quest changed."
		NavigationChanged()
		return
	end
	if tracking and tracking.backend == "route" then
		if not Try(tracking.api.CurrentStop, ROUTE_OWNER) then
			local reason = Try(tracking.api.Ended, ROUTE_OWNER)
			if reason == "arrived" then
				if TrackingMatches(l, p, i) then M.Step(1, true); return end
				tracking = nil
			else
				mdb.nav = nil
				ReleaseTracking()
				navigationMessage = "Tracking stopped: the dotted route ended or was replaced."
				NavigationChanged()
				return
			end
		elseif TrackingMatches(l, p, i) then
			return -- the routing addon, not straight-line distance, decides arrival
		end
	end
	if tracking and tracking.backend == "pending" then
		if InCombatLockdown() then return end
		local api = Router()
		if api and Try(api.Active) and not Try(api.CurrentStop, ROUTE_OWNER) then
			mdb.nav = nil
			ReleaseTracking()
			navigationMessage = "Tracking stopped: another addon started a route during combat."
			NavigationChanged()
			return
		end
	end
	if not StartTracking(l, p, i) then NavigationChanged(); return end
	if tracking.backend ~= "native" then return end
	local dist = DistanceTo(p)
	if dist and dist <= ARRIVE_YARDS then
		Try(PlaySound, SOUNDKIT and SOUNDKIT.MAP_PING or 3175)
		M.Step(1, true)
	end
end

function M.Navigate(layer, index)
	local l = FindLayer(layer)
	index = tonumber(index) or 1
	if not l or #l.points == 0 or index < 1 or index > #l.points or index ~= math.floor(index) then
		return false -- invalid choices must not cancel another valid destination
	end
	ReleaseTracking() -- explicit choices may take over tracking or retry a failed router
	DB().nav = { layer = layer, index = index }
	mdb.hidden[layer] = nil
	navigationMessage, navigationUnavailable = "", false
	M.UpdateNavigator()
	NavigationChanged()
	return not navigationUnavailable
end

function M.Step(delta, arrived)
	local l, _, i = NavPoint()
	if not l then return false end
	local nexti = i + delta
	if (arrived and not l.ordered) or (nexti > #l.points and not (l.loop and #l.points > 1)) then
		mdb.nav = nil
		ReleaseTracking()
		navigationMessage, navigationUnavailable = "Destination reached.", false
		NavigationChanged()
		return true
	end
	if nexti > #l.points then nexti = 1
	elseif nexti < 1 then nexti = l.loop and #l.points or 1 end
	mdb.nav.index = nexti
	if arrived then
		StartTracking(l, l.points[nexti], nexti)
	else
		M.UpdateNavigator()
	end
	NavigationChanged()
	return true
end

function M.Stop()
	DB().nav = nil
	ReleaseTracking()
	navigationMessage, navigationUnavailable = "Navigation stopped.", false
	NavigationChanged()
end

function M.SetLayerVisible(name, visible)
	if not FindLayer(name) then return false end
	DB().hidden[name] = not visible or nil
	NavigationChanged()
	return true
end

function M.AddPoint(layer, mapID, x, y, label)
	mapID, x, y = tonumber(mapID), tonumber(x), tonumber(y)
	if not mapID or mapID <= 0 or mapID ~= math.floor(mapID) or type(Try(C_Map.GetMapInfo, mapID)) ~= "table" then
		return false, "Enter a valid map ID."
	end
	if not x or not y or x ~= x or y ~= y or x < 0 or x > 100 or y < 0 or y > 100 then
		return false, "X and Y must be map percentages between 0 and 100."
	end
	layer = layer or LOCAL_LAYER
	local l = FindLayer(layer)
	if not l and layer ~= LOCAL_LAYER then return false, "That destination group changed. Select it again." end
	l = l or { name = LOCAL_LAYER, title = "My places", ordered = false, loop = false }
	label = tostring(label or ""):gsub("[%c|]", " "):match("^%s*(.-)%s*$")
	local point = { mapID, x, y, label ~= "" and label or "Saved place", "poi" }
	local edit = EditLayer(l)
	edit.points[#edit.points + 1] = point
	DB().hidden[layer] = nil
	effectiveLayers = nil
	NavigationChanged()
	return true, point
end

function M.DeletePoint(layer, index, expected)
	local l = FindLayer(layer)
	index = tonumber(index)
	local p = l and index and l.points[index]
	if not p or (expected and p ~= expected) then return false, "That destination changed. Select it again." end
	local edit = EditLayer(l)
	local removed = false
	for i, localPoint in ipairs(edit.points) do
		if localPoint == p then table.remove(edit.points, i); removed = true; break end
	end
	if not removed then
		for _, source in ipairs(DB().map and mdb.map.layers or EMPTY_LAYERS) do
			if source.name == layer then
				local occurrences = {}
				for _, original in ipairs(source.points) do
					local key = PointKey(original, occurrences)
					if original == p then
						edit.removed = edit.removed or {}
						edit.removed[key] = true
						removed = true
						break
					end
				end
				break
			end
		end
	end
	if not removed then return false, "That destination changed. Select it again." end
	if #edit.points == 0 and (not edit.removed or not next(edit.removed)) then mdb.edits[layer] = nil end
	local nav = mdb.nav
	if nav and nav.layer == layer then
		if nav.index == index then
			mdb.nav = nil
			ReleaseTracking()
			navigationMessage, navigationUnavailable = "Active destination deleted.", false
		elseif nav.index > index then
			nav.index = nav.index - 1
			if tracking and tracking.layer == layer and tracking.index > index then tracking.index = tracking.index - 1 end
		end
	end
	effectiveLayers = nil
	if not FindLayer(layer) then mdb.hidden[layer] = nil end
	M.UpdateNavigator()
	NavigationChanged()
	return true
end

---------------------------------------------------------------------------
-- Local destination management: saved data works without a bridge connection.
---------------------------------------------------------------------------

local navigationPanel
local NAV_ROW_HEIGHT = 72
local RenderNavigationRows, FilterNavigation, ShowPointEditor

local function HumanTitle(l)
	return l.title and l.title ~= "" and l.title or "Saved destinations"
end

local function PointTitle(l, p)
	return p[4] and p[4] ~= "" and p[4] or HumanTitle(l)
end

local function DisplayLabel(text)
	return (tostring(text or ""):gsub("|", "¦"))
end

local function PointLocation(p)
	local info = Try(C_Map.GetMapInfo, p[1])
	return string.format("%s · %.1f, %.1f", info and info.name or "Unknown zone", p[2], p[3])
end

StaticPopupDialogs["WOWAI_MAP_DELETE"] = {
	text = "Delete navigation point \"%s\"?\n\nThis removes the saved point locally, including from its route. Bridge refreshes will not restore it.",
	button1 = OKAY, button2 = CANCEL,
	timeout = 0, whileDead = true, hideOnEscape = true,
	OnAccept = function(_, data)
		if data then
			local ok, message = M.DeletePoint(data.layer, data.index, data.point)
			if not ok then Print(message) end
		end
	end,
}

local function ShowPointOnMap(layer, index)
	local l = FindLayer(layer)
	local p = l and l.points[index]
	if not p then return end
	M.SetLayerVisible(layer, true)
	if OpenWorldMap then
		OpenWorldMap(p[1])
	elseif WorldMapFrame and WorldMapFrame.SetMapID then
		WorldMapFrame:SetMapID(p[1])
		WorldMapFrame:Show()
	end
	M.Refresh()
end

local function NewNavigationRow(slot)
	local panel, UI = navigationPanel, WoWAI.UI
	local row = CreateFrame("Frame", nil, panel.content, "BackdropTemplate")
	UI.Surface(row)
	row:SetHeight(NAV_ROW_HEIGHT - 4)
	row.label = UI.Label(row, "", 13)
	row.label:SetPoint("TOPLEFT", row, "TOPLEFT", 10, -9)
	row.label:SetPoint("TOPRIGHT", row, "TOPRIGHT", -358, -9)
	row.label:SetHeight(18)
	row.label:SetWordWrap(false)
	row.detail = UI.Label(row, "", 11, "muted")
	row.detail:SetPoint("TOPLEFT", row, "TOPLEFT", 10, -30)
	row.detail:SetPoint("TOPRIGHT", row, "TOPRIGHT", -358, -30)
	row.detail:SetHeight(30)
	row.detail:SetJustifyV("TOP")
	-- Each closure resolves the current binding, never the row's former stop.
	row.navigate = UI.Button(row, "Navigate", 92, function()
		if row.entry then M.Navigate(row.entry.layer, row.entry.index) end
	end, "primary", "WoWAINavigationRow" .. slot .. "Navigate")
	row.navigate:SetPoint("RIGHT", row, "RIGHT", -8, 0)
	row.map = UI.Button(row, "On map", 76, function()
		if row.entry then ShowPointOnMap(row.entry.layer, row.entry.index) end
	end, "secondary", "WoWAINavigationRow" .. slot .. "Map")
	row.map:SetPoint("RIGHT", row.navigate, "LEFT", -6, 0)
	row.visibility = UI.Button(row, "Hide", 70, function()
		if row.entry then M.SetLayerVisible(row.entry.layer, DB().hidden[row.entry.layer] == true) end
	end, "quiet", "WoWAINavigationRow" .. slot .. "Visibility")
	row.visibility:SetPoint("RIGHT", row.map, "LEFT", -6, 0)
	row.delete = UI.Button(row, "Delete", 70, function()
		local entry = row.entry
		if entry then
			StaticPopup_Show("WOWAI_MAP_DELETE", entry.label, nil, { layer = entry.layer, index = entry.index, point = entry.point })
		end
	end, "danger", "WoWAINavigationRow" .. slot .. "Delete")
	row.delete:SetPoint("RIGHT", row.visibility, "LEFT", -6, 0)
	return row
end

RenderNavigationRows = function()
	local panel = navigationPanel
	if not panel or not panel.filtered then return end
	local first = math.floor(panel.scroll:GetVerticalScroll() / NAV_ROW_HEIGHT) + 1
	local visible = math.ceil(math.max(1, panel.scroll:GetHeight()) / NAV_ROW_HEIGHT) + 1
	local active = M.GetNavigationState().active
	for slot = 1, visible do
		local entry = panel.filtered[first + slot - 1]
		local row = panel.rows[slot]
		if entry then
			if not row then row = NewNavigationRow(slot); panel.rows[slot] = row end
			row.entry = entry
			row:ClearAllPoints()
			row:SetPoint("TOPLEFT", panel.content, "TOPLEFT", 0, -(first + slot - 2) * NAV_ROW_HEIGHT)
			row:SetWidth(math.max(1, panel.scroll:GetWidth() - 4))
			local current = active and active.layer == entry.layer and active.index == entry.index
			row.label:SetText((current and "To: " or "") .. entry.label)
			row.detail:SetText(entry.detail)
			row.navigate:SetText(entry.ordered and entry.index == 1 and "Start route" or "Navigate")
			row.visibility:SetText(DB().hidden[entry.layer] and "Show" or "Hide")
			row:Show()
		elseif row then
			row.entry = nil
			row:Hide()
		end
	end
	for slot = visible + 1, #panel.rows do
		panel.rows[slot].entry = nil
		panel.rows[slot]:Hide()
	end
end

FilterNavigation = function(resetScroll)
	local panel = navigationPanel
	if not panel then return end
	local search = string.lower(panel.search:GetText() or "")
	panel.filtered = {}
	for _, entry in ipairs(panel.catalog or {}) do
		if search == "" or string.find(entry.search, search, 1, true) then
			panel.filtered[#panel.filtered + 1] = entry
		end
	end
	panel.count:SetText(#panel.filtered .. " shown / " .. #(panel.catalog or {}) .. " saved destinations")
	panel.empty:SetText(#(panel.catalog or {}) == 0 and "No saved destinations. Add a point here or ask your assistant for places."
		or "No destinations match this search.")
	panel.empty:SetShown(#panel.filtered == 0)
	panel.content:SetWidth(math.max(1, panel.scroll:GetWidth() - 4))
	panel.content:SetHeight(math.max(1, #panel.filtered * NAV_ROW_HEIGHT))
	local maximum = math.max(0, #panel.filtered * NAV_ROW_HEIGHT - panel.scroll:GetHeight())
	panel.scroll:SetVerticalScroll(resetScroll and 0 or math.max(0, math.min(panel.scroll:GetVerticalScroll(), maximum)))
	RenderNavigationRows()
end

RefreshNavigation = function()
	local panel = navigationPanel
	if not panel or not panel:IsShown() then return end
	local state = M.GetNavigationState()
	if panel.layers ~= state.layers then
		panel.layers, panel.catalog = state.layers, {}
		for _, l in ipairs(state.layers) do
			for index, p in ipairs(l.points) do
				local title = HumanTitle(l)
				local detail = title .. (l.ordered and (" · Stop " .. index .. "/" .. #l.points) or "") .. "\n" .. PointLocation(p)
				local label = PointTitle(l, p)
				panel.catalog[#panel.catalog + 1] = { layer = l.name, index = index, point = p, ordered = l.ordered,
					label = DisplayLabel(label), detail = DisplayLabel(detail),
					search = string.lower(label .. " " .. detail) }
			end
		end
		FilterNavigation(false)
	end
	local active = state.active
	panel.active.destination:SetText(active and DisplayLabel(PointTitle(FindLayer(active.layer), active.point)) or "No active destination")
	panel.active.detail:SetText(active and DisplayLabel(active.title .. " · " .. active.index .. "/" .. active.total .. " · " .. PointLocation(active.point)) or "Choose a saved destination or start a route below.")
	local status = { idle = "Idle", route = "Dotted route active", native = "Game waypoint active",
		pending = "Waiting for combat to end", unavailable = "Navigation unavailable" }
	panel.active.status:SetText(status[state.status] .. (state.message ~= "" and " · " .. DisplayLabel(state.message) or ""))
	panel.previous:SetEnabled(active ~= nil and active.total > 1 and (active.loop or active.index > 1))
	panel.next:SetEnabled(active ~= nil and active.total > 1 and (active.loop or active.index < active.total))
	panel.stop:SetEnabled(active ~= nil)
	panel.map:SetEnabled(active ~= nil)
	panel.visibility:SetEnabled(active ~= nil)
	panel.visibility:SetText(active and DB().hidden[active.layer] and "Show layer" or "Hide layer")
	RenderNavigationRows()
end

local function CreatePointEditor()
	local panel, UI = navigationPanel, WoWAI.UI
	local editor = UI.Surface(CreateFrame("Frame", "WoWAINavigationPointEditor", panel, "BackdropTemplate"), "background")
	panel.editor = editor
	editor:SetSize(600, 420)
	editor:SetPoint("CENTER", panel, "CENTER")
	editor:SetFrameStrata("FULLSCREEN_DIALOG")
	editor:SetToplevel(true)
	editor:SetClampedToScreen(true)
	editor:EnableMouse(true)
	table.insert(UISpecialFrames, "WoWAINavigationPointEditor")
	local title = UI.Label(editor, "Add navigation point", 18)
	title:SetPoint("TOPLEFT", editor, "TOPLEFT", 20, -18)
	local note = UI.Label(editor, "Saved locally. Bridge refreshes keep your changes.", 12, "muted")
	note:SetPoint("TOPLEFT", editor, "TOPLEFT", 20, -50)
	editor.fields, editor.targets = {}, {}
	local function Field(name, label, x, y, width, maximum)
		local heading = UI.Label(editor, label, 12, "muted")
		heading:SetPoint("TOPLEFT", editor, "TOPLEFT", x, -y)
		local field = UI.Surface(CreateFrame("EditBox", name, editor, "BackdropTemplate"), "raised")
		field:SetPoint("TOPLEFT", editor, "TOPLEFT", x, -y - 22)
		field:SetSize(width, 30)
		field:SetFontObject(ChatFontNormal)
		field:SetTextInsets(8, 8, 0, 0)
		field:SetAutoFocus(false)
		field:SetMaxLetters(maximum)
		field:SetScript("OnEscapePressed", function() editor:Hide() end)
		field:SetScript("OnEnterPressed", function() editor.save:GetScript("OnClick")(editor.save) end)
		editor.fields[#editor.fields + 1] = field
		return field
	end
	editor.name = Field("WoWAINavigationPointName", "Name", 20, 84, 560, 80)
	editor.map = Field("WoWAINavigationPointMap", "Map ID", 294, 150, 286, 10)
	editor.x = Field("WoWAINavigationPointX", "X % (0–100)", 294, 220, 134, 16)
	editor.y = Field("WoWAINavigationPointY", "Y % (0–100)", 444, 220, 136, 16)
	for i, field in ipairs(editor.fields) do
		field:SetScript("OnTabPressed", function(self)
			local delta = IsShiftKeyDown() and -1 or 1
			self:ClearFocus()
			editor.fields[(i - 1 + delta) % #editor.fields + 1]:SetFocus()
		end)
	end
	editor.targetLabel = UI.Label(editor, "", 12, "muted")
	editor.targetLabel:SetPoint("TOPLEFT", editor, "TOPLEFT", 20, -150)
	editor.targetLabel:SetWidth(252)
	editor.targetLabel:SetWordWrap(false)
	editor.targetScroll = UI.ScrollFrame(editor, "WoWAINavigationPointTargets")
	editor.targetScroll:SetPoint("TOPLEFT", editor, "TOPLEFT", 20, -174)
	editor.targetScroll:SetSize(244, 120)
	editor.targetContent = CreateFrame("Frame", nil, editor.targetScroll)
	editor.targetContent:SetWidth(240)
	editor.targetScroll:SetScrollChild(editor.targetContent)
	editor.error = UI.Label(editor, "", 12, "danger")
	editor.error:SetPoint("TOPLEFT", editor, "TOPLEFT", 20, -352)
	editor.error:SetPoint("TOPRIGHT", editor, "TOPRIGHT", -20, -352)
	editor.error:SetHeight(20)
	local function FillPosition(mapID, x, y)
		if not mapID or not x or not y then return false end
		editor.map:SetText(tostring(mapID))
		editor.x:SetText(string.format("%.4f", x * 100))
		editor.y:SetText(string.format("%.4f", y * 100))
		editor.error:SetText("")
		return true
	end
	editor.current = UI.Button(editor, "Use my position", 154, function()
		local mapID = Try(C_Map.GetBestMapForUnit, "player")
		local pos = mapID and Try(C_Map.GetPlayerMapPosition, mapID, "player")
		if not pos or (pos.x == 0 and pos.y == 0) or not FillPosition(mapID, pos.x, pos.y) then
			editor.error:SetText("Player coordinates unavailable. Enter coordinates or use a map pin.")
		end
	end, "secondary", "WoWAINavigationPointCurrent")
	editor.current:SetPoint("TOPLEFT", editor, "TOPLEFT", 20, -310)
	editor.pin = UI.Button(editor, "Use map pin", 128, function()
		local point = Try(C_Map.GetUserWaypoint)
		if not point or not point.position or not FillPosition(point.uiMapID, point.position.x, point.position.y) then
			editor.error:SetText("Place a pin on your world map first, then use it here.")
		end
	end, "secondary", "WoWAINavigationPointPin")
	editor.pin:SetPoint("LEFT", editor.current, "RIGHT", 8, 0)
	editor.save = UI.Button(editor, "Add point", 112, function()
		local ok, result = M.AddPoint(editor.target, editor.map:GetText(), editor.x:GetText(), editor.y:GetText(), editor.name:GetText())
		if not ok then editor.error:SetText(result); return end
		editor:Hide()
		panel.search:SetText("")
		FilterNavigation(false)
		for i, entry in ipairs(panel.filtered) do
			if entry.point == result then
				local maximum = math.max(0, #panel.filtered * NAV_ROW_HEIGHT - panel.scroll:GetHeight())
				panel.scroll:SetVerticalScroll(math.min((i - 1) * NAV_ROW_HEIGHT, maximum))
				break
			end
		end
	end, "primary", "WoWAINavigationPointSave")
	editor.save:SetPoint("BOTTOMRIGHT", editor, "BOTTOMRIGHT", -20, 16)
	local cancel = UI.Button(editor, "Cancel", 88, function() editor:Hide() end, "quiet", "WoWAINavigationPointCancel")
	cancel:SetPoint("RIGHT", editor.save, "LEFT", -8, 0)
	editor:SetScript("OnHide", function()
		for _, field in ipairs(editor.fields) do field:ClearFocus() end
	end)
	editor:Hide()
end

ShowPointEditor = function()
	local panel = navigationPanel
	if not panel.editor then CreatePointEditor() end
	local editor, UI = panel.editor, WoWAI.UI
	local choices = { { name = LOCAL_LAYER, title = "My places" } }
	for _, l in ipairs(Layers()) do if l.name ~= LOCAL_LAYER then choices[#choices + 1] = l end end
	local function SelectTarget(name)
		editor.target = name
		for _, button in ipairs(editor.targets) do
			if button.target then
				local selected = button.target == name
				button:SetText((selected and "> " or "") .. button.title)
				if selected then editor.targetLabel:SetText("Save to: " .. button.title) end
			end
		end
	end
	for i, l in ipairs(choices) do
		local button = editor.targets[i]
		if not button then
			button = UI.Button(editor.targetContent, "", 240, function(self) SelectTarget(self.target) end, "quiet", "WoWAINavigationPointTarget" .. i)
			editor.targets[i] = button
		end
		button.target, button.title = l.name, DisplayLabel(HumanTitle(l)) .. (l.ordered and " (route)" or "")
		button:ClearAllPoints()
		button:SetPoint("TOPLEFT", editor.targetContent, "TOPLEFT", 0, -(i - 1) * 30)
		button:Show()
	end
	for i = #choices + 1, #editor.targets do
		editor.targets[i].target, editor.targets[i].title = nil, nil
		editor.targets[i]:Hide()
	end
	editor.targetContent:SetHeight(#choices * 30)
	editor.targetScroll:SetVerticalScroll(0)
	SelectTarget(LOCAL_LAYER)
	editor.name:SetText("")
	editor.map:SetText("")
	editor.x:SetText("")
	editor.y:SetText("")
	editor.error:SetText("")
	editor:Show()
	editor:Raise()
	editor.current:GetScript("OnClick")(editor.current)
	editor.name:SetFocus()
end

local function CreateNavigationPanel()
	local UI = WoWAI.UI
	local panel = CreateFrame("Frame", "WoWAINavigationPanel", UIParent, "BackdropTemplate")
	navigationPanel = panel
	panel:SetSize(780, 680)
	panel:SetScale(math.min(1, math.max(1, UIParent:GetWidth() - 24) / 780, math.max(1, UIParent:GetHeight() - 24) / 680))
	panel:SetPoint("CENTER")
	panel:SetFrameStrata("DIALOG")
	panel:SetToplevel(true)
	panel:SetClampedToScreen(true)
	panel:EnableMouse(true)
	panel:SetMovable(true)
	panel:RegisterForDrag("LeftButton")
	panel:SetScript("OnDragStart", panel.StartMoving)
	panel:SetScript("OnDragStop", panel.StopMovingOrSizing)
	UI.Surface(panel, "background")
	table.insert(UISpecialFrames, "WoWAINavigationPanel")
	panel.rows, panel.filtered = {}, {}
	local title = UI.Label(panel, "Navigation", 20)
	title:SetPoint("TOPLEFT", panel, "TOPLEFT", 20, -18)
	local close = UI.Button(panel, "Close", 72, function() panel:Hide() end, "quiet", "WoWAINavigationClose")
	close:SetPoint("TOPRIGHT", panel, "TOPRIGHT", -16, -14)
	local add = UI.Button(panel, "Add point", 112, function() ShowPointEditor() end, "primary", "WoWAINavigationAdd")
	add:SetPoint("RIGHT", close, "LEFT", -8, 0)
	local note = UI.Label(panel, "Saved destinations and routes · available even while disconnected", 12, "muted")
	note:SetPoint("TOPLEFT", panel, "TOPLEFT", 20, -52)
	panel.active = CreateFrame("Frame", "WoWAINavigationActive", panel, "BackdropTemplate")
	UI.Surface(panel.active)
	panel.active:SetPoint("TOPLEFT", panel, "TOPLEFT", 16, -80)
	panel.active:SetPoint("TOPRIGHT", panel, "TOPRIGHT", -16, -80)
	panel.active:SetHeight(142)
	panel.active.destination = UI.Label(panel.active, "", 15)
	panel.active.destination:SetPoint("TOPLEFT", panel.active, "TOPLEFT", 12, -10)
	panel.active.destination:SetPoint("TOPRIGHT", panel.active, "TOPRIGHT", -12, -10)
	panel.active.destination:SetHeight(20)
	panel.active.destination:SetWordWrap(false)
	panel.active.detail = UI.Label(panel.active, "", 12, "muted")
	panel.active.detail:SetPoint("TOPLEFT", panel.active, "TOPLEFT", 12, -35)
	panel.active.detail:SetPoint("TOPRIGHT", panel.active, "TOPRIGHT", -12, -35)
	panel.active.detail:SetHeight(18)
	panel.active.detail:SetWordWrap(false)
	panel.active.status = UI.Label(panel.active, "", 12, "muted")
	panel.active.status:SetPoint("TOPLEFT", panel.active, "TOPLEFT", 12, -59)
	panel.active.status:SetPoint("TOPRIGHT", panel.active, "TOPRIGHT", -12, -59)
	panel.active.status:SetHeight(32)
	panel.active.status:SetJustifyV("TOP")
	panel.previous = UI.Button(panel.active, "Previous", 88, function() M.Step(-1) end, "secondary", "WoWAINavigationPrevious")
	panel.previous:SetPoint("BOTTOMLEFT", panel.active, "BOTTOMLEFT", 12, 10)
	panel.next = UI.Button(panel.active, "Next", 72, function() M.Step(1) end, "secondary", "WoWAINavigationNext")
	panel.next:SetPoint("LEFT", panel.previous, "RIGHT", 6, 0)
	panel.stop = UI.Button(panel.active, "Stop", 72, M.Stop, "danger", "WoWAINavigationStop")
	panel.stop:SetPoint("LEFT", panel.next, "RIGHT", 6, 0)
	panel.map = UI.Button(panel.active, "Show on map", 112, function()
		local active = M.GetNavigationState().active
		if active then ShowPointOnMap(active.layer, active.index) end
	end, "secondary", "WoWAINavigationMap")
	panel.map:SetPoint("LEFT", panel.stop, "RIGHT", 18, 0)
	panel.visibility = UI.Button(panel.active, "Hide layer", 100, function()
		local active = M.GetNavigationState().active
		if active then M.SetLayerVisible(active.layer, DB().hidden[active.layer] == true) end
	end, "quiet", "WoWAINavigationVisibility")
	panel.visibility:SetPoint("LEFT", panel.map, "RIGHT", 6, 0)
	local searchLabel = UI.Label(panel, "Search places", 12, "muted")
	searchLabel:SetPoint("TOPLEFT", panel, "TOPLEFT", 20, -249)
	panel.search = CreateFrame("EditBox", "WoWAINavigationSearch", panel, "BackdropTemplate")
	UI.Surface(panel.search, "raised")
	panel.search:SetPoint("TOPLEFT", panel, "TOPLEFT", 120, -240)
	panel.search:SetPoint("TOPRIGHT", panel, "TOPRIGHT", -90, -240)
	panel.search:SetHeight(32)
	panel.search:SetFontObject(ChatFontNormal)
	panel.search:SetTextInsets(9, 9, 0, 0)
	panel.search:SetAutoFocus(false)
	panel.search:SetMaxLetters(160)
	panel.search:SetScript("OnTextChanged", function() FilterNavigation(true) end)
	panel.search:SetScript("OnEscapePressed", function() panel:Hide() end)
	panel.search:SetScript("OnEnterPressed", function(self) self:ClearFocus() end)
	local clear = UI.Button(panel, "Clear", 64, function() panel.search:SetText("") end, "quiet", "WoWAINavigationClear")
	clear:SetPoint("TOPRIGHT", panel, "TOPRIGHT", -16, -240)
	panel.count = UI.Label(panel, "", 12, "muted")
	panel.count:SetPoint("TOPLEFT", panel, "TOPLEFT", 20, -284)
	panel.scroll = UI.ScrollFrame(panel, "WoWAINavigationScroll")
	panel.scroll:SetPoint("TOPLEFT", panel, "TOPLEFT", 16, -308)
	panel.scroll:SetPoint("BOTTOMRIGHT", panel, "BOTTOMRIGHT", -34, 42)
	panel.content = CreateFrame("Frame", nil, panel.scroll)
	panel.content:SetSize(726, 1)
	panel.scroll:SetScrollChild(panel.content)
	panel.scroll:HookScript("OnVerticalScroll", RenderNavigationRows)
	panel.scroll:HookScript("OnSizeChanged", function() FilterNavigation(false) end)
	panel.empty = UI.Label(panel, "", 13, "muted")
	panel.empty:SetPoint("TOPLEFT", panel.scroll, "TOPLEFT", 12, -16)
	panel.empty:SetPoint("TOPRIGHT", panel.scroll, "TOPRIGHT", -12, -16)
	panel.empty:SetHeight(48)
	local footer = UI.Label(panel, "Tracking only: follow the map or route yourself. No automatic movement.", 11, "muted")
	footer:SetPoint("BOTTOMLEFT", panel, "BOTTOMLEFT", 20, 16)
	panel:SetScript("OnHide", function()
		panel.search:ClearFocus()
		if panel.editor then panel.editor:Hide() end
	end)
	panel:Hide()
end

function M.ShowNavigation()
	if not navigationPanel then CreateNavigationPanel() end
	navigationPanel:Show()
	navigationPanel:Raise()
	RefreshNavigation()
end

---------------------------------------------------------------------------
-- Sync from the bridge
---------------------------------------------------------------------------

local function LayerKey(l)
	local parts = { l.title or "", tostring(l.ordered), tostring(l.loop), #(l.points or {}) }
	for _, p in ipairs(l.points or {}) do parts[#parts + 1] = table.concat({ p[1], p[2], p[3], p[4] }, ",") end
	return table.concat(parts, ";")
end

function M.Sync(m)
	if type(m) ~= "table" or type(m.layers) ~= "table" then return end
	local cur = DB().map
	if cur and cur.epoch == m.epoch and (tonumber(m.version) or 0) <= (tonumber(cur.version) or 0) then return end
	local old = {}
	for _, l in ipairs(cur and cur.layers or {}) do old[l.name] = LayerKey(l) end
	local layers, changed = {}, {}
	for _, l in ipairs(m.layers) do
		if type(l) == "table" and type(l.name) == "string" and type(l.points) == "table" then
			layers[#layers + 1] = l
			if old[l.name] ~= LayerKey(l) then changed[#changed + 1] = l end
		end
	end
	-- Keep manually appended stops in place when source layers are regenerated.
	local _, previousPoint = NavPoint()
	local localTarget
	if mdb.nav then
		local edit = mdb.edits and mdb.edits[mdb.nav.layer]
		for _, p in ipairs(edit and edit.points or EMPTY_LAYERS) do
			if p == previousPoint then localTarget = p; break end
		end
	end
	mdb.map = { epoch = m.epoch, version = tonumber(m.version) or 0, layers = layers }
	effectiveLayers = nil
	if localTarget and mdb.nav then
		local l = FindLayer(mdb.nav.layer)
		for index, p in ipairs(l and l.points or EMPTY_LAYERS) do
			if p == localTarget then
				mdb.nav.index = index
				if tracking and tracking.layer == l.name and tracking.map == p[1] and tracking.x == p[2] and tracking.y == p[3] then
					tracking.index = index
				end
				break
			end
		end
	end
	-- Normalize an existing target without restarting it at the first stop.
	NavPoint()
	for _, source in ipairs(changed) do
		local edit = mdb.edits and mdb.edits[source.name]
		if edit then edit.title, edit.ordered, edit.loop = source.title, source.ordered, source.loop end
		local l = FindLayer(source.name)
		mdb.hidden[l.name] = nil
		Print(string.format("%s: %d point(s)%s. Open the map (M) to see it.", l.title or l.name, #l.points, l.ordered and ", route" or ""))
		-- Routes and single destinations start navigation even with the map closed.
		-- Unordered collections stay map-only; never take over another active route.
		local here = PlayerOnContinent()
		local free = not mdb.nav
		local api = Router()
		free = free and (not api or not Try(api.Active) or Try(api.CurrentStop, ROUTE_OWNER) ~= nil)
		if (l.ordered or #l.points == 1) and #l.points > 0 and free and (not here or ContinentOf(l.points[1][1]) == here) then
			mdb.nav = { layer = l.name, index = 1 }
		end
	end
	M.UpdateNavigator()
	NavigationChanged()
end

---------------------------------------------------------------------------
-- /wow-ai map (and /aimap)
---------------------------------------------------------------------------

local function Status()
	local layers = Layers()
	if #layers == 0 then Print("no layers yet. Ask the agent for a route, e.g. /ai route me through copper veins in Loch Modan") end
	for _, l in ipairs(layers) do
		Print(string.format("%s%s|r  %s (%d point(s))%s", mdb.hidden[l.name] and "|cff888888" or "|cffffffff", l.name, l.title or "", #l.points, (mdb.nav and mdb.nav.layer == l.name) and string.format("  navigating %d/%d", mdb.nav.index, #l.points) or ""))
	end
	local n = mdb.nodes
	Print(string.format("nodes: ore %s, herb %s, filter %s%s", n.ore and "on" or "off", n.herb and "on" or "off", n.filter, WoWAINodes and "" or "  (WoWAI_Nodes data addon not installed)"))
	Print("commands: /wow-ai map ore|herb [on|off], filter all|skill, show|hide <layer>, nav <layer> [n], next, prev, stop  (/aimap is the same)")
end

function M.Command(msg)
	DB()
	local cmd, rest = (msg or ""):match("^%s*(%S*)%s*(.-)%s*$")
	cmd = (cmd or ""):lower()
	if cmd == "" then Status()
	elseif cmd == "ore" or cmd == "herb" then
		local v = rest:lower()
		mdb.nodes[cmd] = (v == "on") or (v ~= "off" and not mdb.nodes[cmd])
		Print(cmd .. " nodes " .. (mdb.nodes[cmd] and "shown" or "hidden") .. " on the world map")
		M.Refresh()
	elseif cmd == "filter" and (rest == "all" or rest == "skill") then
		mdb.nodes.filter = rest
		Print(rest == "all" and "showing every node" or "showing nodes your skill can gather")
		M.Refresh()
	elseif (cmd == "show" or cmd == "hide") and rest ~= "" then
		M.SetLayerVisible(rest, cmd == "show")
	elseif cmd == "nav" then
		local name, idx = rest:match("^(%S+)%s*(%d*)$")
		M.Navigate(name, tonumber(idx))
	elseif cmd == "next" then M.Step(1)
	elseif cmd == "prev" then M.Step(-1)
	elseif cmd == "stop" then M.Stop()
	else Status() end
end

SLASH_WOWAIMAP1 = "/aimap"
SlashCmdList["WOWAIMAP"] = M.Command

local ev = CreateFrame("Frame")
ev:RegisterEvent("ADDON_LOADED")
ev:RegisterEvent("PLAYER_LOGIN")
ev:RegisterEvent("SKILL_LINES_CHANGED")
ev:RegisterEvent("PLAYER_REGEN_ENABLED")
ev:SetScript("OnEvent", function(_, event, arg1)
	if event == "ADDON_LOADED" and (arg1 == ADDON_NAME or arg1 == "Blizzard_WorldMap") then
		DB()
		SetupWorldMap()
	elseif event == "PLAYER_LOGIN" then
		DB()
		SetupWorldMap()
		if not navigatorTicker then navigatorTicker = C_Timer.NewTicker(0.2, M.UpdateNavigator) end
		C_Timer.After(0, M.UpdateNavigator)
	elseif event == "PLAYER_REGEN_ENABLED" then
		M.UpdateNavigator()
	elseif event == "SKILL_LINES_CHANGED" then
		M.Refresh()
	end
end)
