-- Wowie: talk to local coding agents (Claude Code, Codex, Grok) from inside WoW,
-- without reloading.
--
-- The WoW sandbox has no network and no file reads at runtime. Two doors remain open:
--
--   OUT ("pixel" mode): pending messages are drawn as a strip of colored squares in
--        the top-left corner of the screen until the bridge acknowledges them.
--        bridge.js screen-captures that corner and decodes it. Nothing touches the game.
--   IN:  load-on-demand addons read their files from disk at the moment they load.
--        The bridge writes the latest replies for every chat into a pool of pre-made
--        slot addons (Wowie_S001..S200); we load a fresh slot from a timer.
--        Each slot is single-use per session; a /reload frees them all.
--   Fallback ("reload" mode): SavedVariables + Inbox.lua, a ReloadUI() per step.
--
-- Chats: each chat is its own agent session (like a separate terminal) with its own
-- folder, agent, history and pending message. The bridge runs them in parallel.
-- Everything here is plain addon API. No automation, no memory reading.

local ADDON_NAME = ...
local Wowie = {}
_G.Wowie = Wowie
local Codec = Wowie_Codec
local unpack = unpack or table.unpack

local DEFAULT_CWD = "" -- empty = the bridge's configured defaultCwd
local MAX_HISTORY = 200
local MAX_CHATS = 16
local CHAT_ROW_HEIGHT, CHAT_ROW_GAP = 44, 4

local SLOT_COUNT = 200
local SLOT_PREFIX = "Wowie_S"
local ACT_MAX = 60 -- heartbeat files per message (act/NNN/01..60.wav)
local PRESENCE_MAX = 2000 -- presence/0001..2000.wav, one flipped by the bridge every 30 s
local STRIP_TRIES = 3 -- re-show an unacknowledged message this many times before falling back
local CELLS_PER_ROW, MAX_ROWS = 200, 48
local STRIP_SECONDS = 40 -- max per message; it leaves the strip as soon as the bridge acknowledges
local POLL_SCHEDULE = { 5, 10, 16, 24, 34, 46, 60, 80, 100, 130, 160, 200, 240, 300 }
local POLL_TAIL = 60
local TICK_SECONDS = 2
local TRANSPORT_SECONDS = 0.1 -- cheap readiness and negotiated frame pacing, not slot polling
local CONNECT_WAIT = 15 -- seconds to wait for a fresh nonce acknowledgement
local VERIFIED_SECONDS = 90 -- confirmation age, never renewed by clocks or sound hints
local IDLE_POLL_SECONDS = 600 -- without recent presence progress, spend one idle slot this often
local RS, US = "\30", "\31" -- record / unit separators in the strip payload
local CONTEXT_POLL_SECONDS = 15

local db
local ui = {}
-- Transport state for this UI session. outbound[id] = { chat, cwd, flags, text, sentAt, acked }
local run = { outbound = {} }
local tx = { active = "robust", interval = 0.5, reason = "" }

local UI = {}
Wowie.UI = UI
UI.font = STANDARD_TEXT_FONT
UI.titleFont = UI.font
UI.colors = {
	background = { 0.055, 0.065, 0.080, 1 }, surface = { 0.080, 0.095, 0.115, 1 },
	raised = { 0.115, 0.135, 0.160, 1 }, input = { 0.035, 0.045, 0.060, 1 },
	border = { 0.22, 0.25, 0.29, 1 }, hover = { 0.15, 0.18, 0.21, 1 },
	primary = { 0.20, 0.18, 0.13, 1 }, text = { 0.92, 0.94, 0.97, 1 },
	muted = { 0.64, 0.69, 0.75, 1 }, accent = { 0.90, 0.77, 0.50, 1 },
	success = { 0.45, 0.80, 0.64, 1 }, warning = { 0.97, 0.72, 0.38, 1 },
	danger = { 0.96, 0.48, 0.48, 1 }, highlight = { 0.50, 0.65, 0.85, 0.35 },
	userBand = { 0.105, 0.130, 0.165, 1 }, replyBand = { 0.065, 0.080, 0.100, 1 },
	noticeBand = { 0.10, 0.115, 0.135, 1 }, onAccent = { 0.055, 0.065, 0.080, 1 },
}
local BACKDROP = {
	bgFile = "Interface\\Buttons\\WHITE8X8", edgeFile = "Interface\\Buttons\\WHITE8X8",
	edgeSize = 1, insets = { left = 1, right = 1, top = 1, bottom = 1 },
}

function UI.Surface(frame, tone)
	frame:SetBackdrop(BACKDROP)
	frame:SetBackdropColor(unpack(UI.colors[tone or "surface"]))
	frame:SetBackdropBorderColor(unpack(UI.colors.border))
	return frame
end

function UI.Rule(parent, tone, alpha, vertical)
	local rule = parent:CreateTexture(nil, "BORDER")
	local c = UI.colors[tone or "border"]
	rule:SetColorTexture(c[1], c[2], c[3], alpha or c[4])
	if vertical then rule:SetWidth(1) else rule:SetHeight(1) end
	return rule
end

function UI.Window(frame, headerHeight)
	UI.Surface(frame, "background")
	local border = UI.colors.border
	frame:SetBackdropBorderColor(border[1], border[2], border[3], 1)
	if headerHeight ~= 0 then
		local rule = UI.Rule(frame, "border", 1)
		rule:SetPoint("TOPLEFT", frame, "TOPLEFT", 1, -(headerHeight or 48))
		rule:SetPoint("TOPRIGHT", frame, "TOPRIGHT", -1, -(headerHeight or 48))
	end
	return frame
end

function UI.FitPanel(frame, width, height)
	frame:SetSize(width, height)
	frame:SetScale(math.min(1, math.max(1, UIParent:GetWidth() - 32) / width, math.max(1, UIParent:GetHeight() - 32) / height))
end

function UI.RaisePanel(frame)
	frame:SetFrameStrata("FULLSCREEN_DIALOG")
	frame:SetToplevel(true)
	frame:Raise()
	local parent = frame:GetParent()
	UI.panelLevel = math.max(UI.panelLevel or 60, frame:GetFrameLevel(), parent and parent:GetFrameLevel() or 0) + 20
	frame:SetFrameLevel(UI.panelLevel)
end

function UI.Label(parent, text, size, tone)
	local label = parent:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
	label:SetFont(UI.font, size or 12, "")
	label:SetTextColor(unpack(UI.colors[tone or "text"]))
	label:SetJustifyH("LEFT")
	label:SetShadowColor(0, 0, 0, 0)
	label:SetShadowOffset(0, 0)
	label:SetText(text or "")
	return label
end

function UI.Title(parent, text, size)
	local title = UI.Label(parent, text, size or 18, "text")
	title:SetFont(UI.titleFont, size or 18, "")
	return title
end

function UI.Input(frame, field)
	UI.Surface(frame, "input")
	field = field or frame
	field:SetTextColor(unpack(UI.colors.text))
	field:SetHighlightColor(unpack(UI.colors.highlight))
	field:HookScript("OnEditFocusGained", function()
		local c = UI.colors.accent
		frame:SetBackdropBorderColor(c[1], c[2], c[3], 0.7)
	end)
	field:HookScript("OnEditFocusLost", function() frame:SetBackdropBorderColor(unpack(UI.colors.border)) end)
	return frame
end

function UI.Tooltip(control, title, body)
	control:SetScript("OnEnter", function(self)
		GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
		GameTooltip:SetText(title)
		if body then GameTooltip:AddLine(body, 0.75, 0.81, 0.89, true) end
		GameTooltip:Show()
	end)
	control:SetScript("OnLeave", function() GameTooltip:Hide() end)
end

function UI.Button(parent, label, width, onClick, style, name)
	local b = CreateFrame("Button", name, parent, "BackdropTemplate")
	b:SetSize(width or 100, 32)
	b.label = UI.Label(b, label, 12)
	b.label:SetPoint("LEFT", b, "LEFT", 8, 0)
	b.label:SetPoint("RIGHT", b, "RIGHT", -8, 0)
	b.label:SetJustifyH("CENTER")
	b.label:SetWordWrap(false)
	b:SetFontString(b.label)
	b:SetText(label)
	UI.Surface(b)
	b.selectionLine = UI.Rule(b, "accent", 0.72)
	b.selectionLine:SetPoint("BOTTOMLEFT", b, "BOTTOMLEFT", 8, 1)
	b.selectionLine:SetPoint("BOTTOMRIGHT", b, "BOTTOMRIGHT", -8, 1)
	local function Paint(self)
		local enabled = self:IsEnabled()
		local tone = self.pressed and "hover" or (self.isSelected and "primary" or (self.hover and "hover" or "raised"))
		local fill = UI.colors[style == "primary" and not self.pressed and "accent" or tone]
		local edge = UI.colors[self.isSelected and "accent" or "border"]
		self:SetBackdropColor(fill[1], fill[2], fill[3], style == "quiet" and not self.hover and not self.isSelected and 0 or 1)
		self:SetBackdropBorderColor(edge[1], edge[2], edge[3], style == "quiet" and not self.hover and not self.isSelected and 0 or 1)
		self.label:SetTextColor(unpack(UI.colors[not enabled and "muted" or (style == "primary" and not self.pressed and "onAccent" or (style == "danger" and "danger" or (self.isSelected and "accent" or "text")))]))
		self.selectionLine:SetShown(enabled and self.isSelected and true or false)
		self:SetAlpha(enabled and 1 or 0.6)
	end
	b.RefreshAppearance = Paint
	b:HookScript("OnEnter", function(self) self.hover = true; Paint(self) end)
	b:HookScript("OnLeave", function(self) self.hover, self.pressed = nil, nil; Paint(self) end)
	b:SetScript("OnMouseDown", function(self) if self:IsEnabled() then self.pressed = true; Paint(self) end end)
	b:SetScript("OnMouseUp", function(self) self.pressed = nil; Paint(self) end)
	b:HookScript("OnEnable", Paint)
	b:HookScript("OnDisable", Paint)
	b:SetScript("OnClick", onClick)
	Paint(b)
	return b
end

function UI.SetSelected(control, selected)
	selected = selected and true or false
	if control.isSelected == selected then return end
	control.isSelected = selected
	control:RefreshAppearance()
end

-- Native scroll templates use client-specific artwork. Keep our own scrollbars
-- on standard ScrollFrame/Slider behavior without borrowing Blizzard textures.
function UI.ScrollFrame(parent, name)
	local scroll = CreateFrame("ScrollFrame", name, parent)
	local bar = CreateFrame("Slider", nil, parent, "BackdropTemplate")
	UI.Surface(bar, "background")
	bar:SetFrameLevel(scroll:GetFrameLevel() + 1)
	bar:SetWidth(7)
	bar:SetPoint("TOPLEFT", scroll, "TOPRIGHT", 5, -2)
	bar:SetPoint("BOTTOMLEFT", scroll, "BOTTOMRIGHT", 5, 2)
	bar:SetOrientation("VERTICAL")
	bar:SetMinMaxValues(0, 1)
	bar:SetValueStep(1)
	bar:SetObeyStepOnDrag(true)
	bar:SetThumbTexture("Interface\\Buttons\\WHITE8X8")
	local thumb = bar:GetThumbTexture()
	thumb:SetWidth(3)
	thumb:SetVertexColor(unpack(UI.colors.muted))
	scroll.bar = bar
	local updating = false
	local function Update()
		if updating then return end
		updating = true
		scroll:UpdateScrollChildRect()
		local maximum = math.max(0, scroll:GetVerticalScrollRange())
		local position = math.max(0, math.min(scroll:GetVerticalScroll(), maximum))
		bar:SetMinMaxValues(0, math.max(1, maximum))
		bar:SetValue(position)
		local height = math.max(20, bar:GetHeight())
		thumb:SetHeight(math.min(height, math.max(20, height * scroll:GetHeight() / math.max(1, scroll:GetHeight() + maximum))))
		bar:SetShown(maximum > 0 and scroll:IsShown())
		if position ~= scroll:GetVerticalScroll() then scroll:SetVerticalScroll(position) end
		updating = false
	end
	bar:SetScript("OnValueChanged", function(_, value)
		if updating then return end
		scroll:SetVerticalScroll(value)
		Update()
	end)
	bar:SetScript("OnEnter", function() thumb:SetVertexColor(unpack(UI.colors.accent)) end)
	bar:SetScript("OnLeave", function() thumb:SetVertexColor(unpack(UI.colors.muted)) end)
	scroll:EnableMouseWheel(true)
	local function Wheel(_, delta)
		local maximum = math.max(0, scroll:GetVerticalScrollRange())
		scroll:SetVerticalScroll(math.max(0, math.min(maximum, scroll:GetVerticalScroll() - delta * 40)))
		Update()
	end
	scroll:SetScript("OnMouseWheel", Wheel)
	bar:EnableMouseWheel(true)
	bar:SetScript("OnMouseWheel", Wheel)
	scroll:HookScript("OnScrollRangeChanged", Update)
	scroll:HookScript("OnVerticalScroll", Update)
	scroll:HookScript("OnSizeChanged", Update)
	scroll:HookScript("OnShow", Update)
	scroll:HookScript("OnHide", function() bar:Hide() end)
	bar:HookScript("OnSizeChanged", Update)
	bar:Hide()
	return scroll
end

local ROLE_STYLE = {
	user = { label = "You", color = UI.colors.muted, bg = UI.colors.userBand },
	assistant = { label = "Assistant", color = UI.colors.accent, bg = UI.colors.replyBand },
	system = { label = "Notice", color = UI.colors.warning, bg = UI.colors.noticeBand },
}

---------------------------------------------------------------------------
-- Helpers
---------------------------------------------------------------------------

local function ToHex(s)
	return (s:gsub(".", function(c)
		return string.format("%02x", c:byte())
	end))
end

-- Record fields use control characters as separators, so keep them out of the wire format.
local function Wire(s)
	local value = tostring(s or "")
	return (value:gsub("[\30\31]", " "))
end

-- EditBoxes do not render UI escape sequences, so just make pipes harmless.
local function Display(s)
	return (tostring(s or ""):gsub("|", "¦"))
end

local function Trim(s)
	return (s:gsub("^%s+", ""):gsub("%s+$", ""))
end

local function FmtDur(sec)
	sec = math.floor(sec or 0)
	if sec < 60 then return sec .. "s" end
	if sec < 3600 then return math.floor(sec / 60) .. "m" .. string.format("%02d", sec % 60) .. "s" end
	return math.floor(sec / 3600) .. "h" .. string.format("%02d", math.floor(sec / 60) % 60) .. "m"
end

-- Last path component of a folder, for labels.
local function FolderName(cwd)
	local name = tostring(cwd or ""):gsub("[\\/]+$", ""):match("([^\\/]+)$")
	return name or ""
end

-- The folder a chat works in: its own, or the bridge's default (the folder the
-- bridge was started from), which the bridge reports in every slot file.
local function ChatFolder(c)
	if c and c.cwd ~= "" then return c.cwd end
	return run.bridgeCwd or ""
end

-- Agents are named by id as the bridge knows them ("claude", "codex", "grok");
-- the bridge lists the ones it has, and its default, in every slot file. A chat
-- with no agent of its own uses addon defaults, then the bridge's default.
local AGENT_NAMES = { claude = "Claude", codex = "Codex", grok = "Grok", agy = "Antigravity", hermes = "Hermes" }

local function AgentName(id)
	id = tostring(id or "")
	if id == "" then return "AI" end
	return AGENT_NAMES[id] or (id:sub(1, 1):upper() .. id:sub(2))
end

local function DefaultAgent(defaults)
	defaults = defaults or (db and db.settings.defaults)
	if defaults and defaults.agent and defaults.agent ~= "" then return defaults.agent end
	return run.bridgeAgent or ""
end

local function ChatAgent(c, defaults)
	if c and c.agent and c.agent ~= "" then return c.agent end
	return DefaultAgent(defaults)
end

-- Model/effort defaults belong to their agent, never to another provider.
local function InheritedChoice(c, key, defaults)
	defaults = defaults or db.settings.defaults
	if defaults.agent ~= "" and ChatAgent(c, defaults) == defaults.agent then return defaults[key] or "" end
	return ""
end

local function ChatChoice(c, key, defaults)
	if c and c[key] and c[key] ~= "" then return c[key] end
	return InheritedChoice(c, key, defaults)
end

local function ChatAgentName(c)
	return AgentName(ChatAgent(c))
end
local NO_OPTIONS = {}

local function ChatOptions(c)
	return (run.agentOptions or NO_OPTIONS)[ChatAgent(c)] or NO_OPTIONS
end


-- The name to show on a reply: the agent the bridge says wrote it, else the chat's.
local function ReplyAgentName(c, agent)
	if agent and agent ~= "" then return AgentName(agent) end
	return ChatAgentName(c)
end

local function Contains(list, v)
	for _, x in ipairs(list or {}) do
		if x == v then return true end
	end
	return false
end

-- First few words of a message, as a chat title.
local function AutoTitle(text)
	local words = {}
	for w in tostring(text or ""):match("^[^\r\n]*"):gmatch("%S+") do
		w = w:gsub("^[%p]+", ""):gsub("[%p]+$", "")
		if w ~= "" then
			table.insert(words, w)
			if #words >= 9 then break end
		end
	end
	local title = table.concat(words, " ")
	if #title > 64 then title = title:sub(1, 64):gsub("%s+%S*$", "") end
	if title == "" then return nil end
	return title:sub(1, 1):upper() .. title:sub(2)
end

local function NewId()
	return string.format("%x%04x", time() % 0xFFFFFF, math.random(0, 0xFFFF))
end

-- Independent of SavedVariables counters: rollback must not reuse an identity.
local nonceSeq = 0
local function NewNonce()
	nonceSeq = nonceSeq + 1
	return string.format("%x-%x-%04x%04x%04x%04x-%x", time() % 0xFFFFFF,
		math.floor(GetTime() * 1000) % 0xFFFFFF, math.random(0, 0xFFFF),
		math.random(0, 0xFFFF), math.random(0, 0xFFFF), math.random(0, 0xFFFF), nonceSeq)
end

local function ValidToken(value)
	return type(value) == "string" and #value >= 8 and #value <= 64 and not value:find("[^%w_-]")
end

local function FromHex(text)
	return text and (text:gsub("%x%x", function(byte) return string.char(tonumber(byte, 16)) end))
end

local function MigratePending(c)
	if not c.pendingId or (c.request and c.request.nonce) then return end
	local out = db.outbox
	if not out or out.id ~= c.pendingId or out.chat ~= c.id then out = nil end
	local request = c.request
	if not request then
		local text = out and FromHex(out.text)
		if not text then
			for i = #(c.history or {}), 1, -1 do
				local m = c.history[i]
				if m.id == c.pendingId and m.role == "user" then text = m.text break end
			end
		end
		local flags = {}
		if out and out.newSession then flags[#flags + 1] = "n" end
		local agent = out and out.agent or c.agent
		if agent and agent ~= "" then flags[#flags + 1] = "agent=" .. agent end
		if out and out.model then flags[#flags + 1] = "model=" .. out.model end
		if out and out.reasoning then flags[#flags + 1] = "reasoning=" .. out.reasoning end
		if out and out.allow then flags[#flags + 1] = "allow=" .. FromHex(out.allow):gsub(US, ",") end
		if out and out.profile then flags[#flags + 1] = "profile=" .. c.pendingId end
		request = { chat = c.id, cwd = out and FromHex(out.cwd) or c.cwd, name = c.name,
			text = text or "", flags = table.concat(flags, ";"), ctx = out and FromHex(out.ctx),
			profile = out and FromHex(out.profile) }
		c.request = request
	end
	request.nonce = NewNonce()
	c.resumePending = true
	request.flags = (request.flags and request.flags ~= "" and (request.flags .. ";") or "") .. "nonce=" .. request.nonce
	c.snapshotAcked, c.queryReply = nil, nil
	if out then
		out.nonce = request.nonce
		out.profile = request.profile and ToHex(request.profile) or nil
	end
	if db.contextOutbox and db.contextOutbox.id == c.pendingId and db.contextOutbox.chat == c.id then
		db.contextOutbox = nil
	end
end

local function FindChat(id)
	for i, c in ipairs(db.chats) do
		if c.id == id then return c, i end
	end
end

local function ActiveChat()
	return FindChat(db.activeChat)
end

local function AddChat(name, cwd)
	if #db.chats >= MAX_CHATS then return nil end
	local current = ActiveChat()
	local c = {
		id = NewId(),
		generation = NewNonce(),
		name = name or ("Chat " .. (#db.chats + 1)),
		cwd = cwd or (current and current.cwd) or DEFAULT_CWD,
		agent = (current and current.agent) or "",
		model = (current and current.model) or "",
		reasoning = (current and current.reasoning) or "",
		history = {},
		unread = 0,
		created = time(),
	}
	table.insert(db.chats, c)
	return c
end

local function AnyPending()
	for _, c in ipairs(db.chats) do
		if c.pendingId then return true end
	end
	return false
end

local function InitDB()
	WowieDB = WowieDB or {}
	db = WowieDB
	db.settings = db.settings or {}
	local s = db.settings
	s.defaults = s.defaults or {}
	for _, key in ipairs({ "agent", "model", "reasoning" }) do
		s.defaults[key] = s.defaults[key] or ""
	end
	if s.autoRefresh == nil then s.autoRefresh = true end
	if s.signal == nil then s.signal = true end
	if s.context == nil then s.context = true end -- tell the agent about the character, zone, etc.
	-- Game chat previews the reply itself; detailed answers stay in the window.
	if s.echo ~= "full" and s.echo ~= "short" and s.echo ~= "off" and not tonumber(s.echo) then s.echo = "short" end
	s.echoV2 = nil
	s.mode = s.mode or "pixel"
	if not Codec.DISPLAYS[s.pixelDisplay] or Codec.DISPLAYS[s.pixelDisplay].family then s.pixelDisplay = "robust" end
	if type(s.pixelVerified) ~= "table" then s.pixelVerified = {} end
	s.interval = s.interval or 20
	s.cwd = s.cwd or DEFAULT_CWD
	s.width = s.width or 1020
	s.height = s.height or 700
	if s.replyFontSize ~= 13 and s.replyFontSize ~= 16 then s.replyFontSize = 14 end
	db.lastSeq = db.lastSeq or 0
	-- Chats deleted in game that the bridge hasn't confirmed forgetting yet.
	db.forget = db.forget or {}
	db.receipts = db.receipts or {}
	local forget = {}
	for key, info in pairs(db.forget) do
		info.chat = info.chat or key
		info.kind = "forget"
		info.generation = info.generation or ("legacy-" .. info.chat)
		info.nonce = info.nonce or NewNonce()
		if not info.id then db.lastSeq = db.lastSeq + 1; info.id = db.lastSeq end
		forget[info.nonce] = info
	end
	db.forget = forget
	-- The session groups this installation's requests; each operation also has
	-- its own nonce so rolling back the saved numeric counter is harmless.
	if not db.session then
		db.session = string.format("%x%04x%04x", time() % 0xFFFFFF, math.random(0, 0xFFFF), math.random(0, 0xFFFF))
	end
	if not db.chats then
		-- Migrate the single-chat layout into the first chat.
		db.chats = {}
		local c = {
			id = NewId(),
			name = "Chat 1",
			cwd = s.cwd,
			history = db.history or {},
			pendingId = db.pendingId,
			unread = db.unread or 0,
			draft = db.draft,
			created = time(),
		}
		table.insert(db.chats, c)
		db.activeChat = c.id
		db.history, db.pendingId, db.unread, db.draft = nil, nil, nil, nil
	end
	if #db.chats == 0 then AddChat() end
	if not FindChat(db.activeChat) then db.activeChat = db.chats[1].id end
	-- Chats from before agents had names: replies were stored with role "claude".
	for _, c in ipairs(db.chats) do
		c.agent = c.agent or ""
		c.model = c.model or ""
		c.reasoning = c.reasoning or ""
		if not c.generation then
			c.generation = (c.request and c.request.generation) or ("legacy-" .. c.id)
			for _, info in pairs(db.forget) do
				if info.chat == c.id and info.generation == c.generation then
					-- An old last-chat delete reused its ID. Its durable operation
					-- token gives the replacement a stable, distinct incarnation.
					c.generation, c.resetNext = info.nonce, true
					break
				end
			end
		end
		local firstUser
		for _, m in ipairs(c.history or {}) do
			if m.role == "claude" then m.role, m.agent = "assistant", m.agent or "claude" end
			if m.role == "user" and not firstUser then firstUser = m end
		end
		MigratePending(c)
		if c.request and not c.request.generation then
			c.request.generation = c.generation
			c.request.flags = (c.request.flags and c.request.flags ~= "" and (c.request.flags .. ";") or "") .. "generation=" .. c.generation
			c.resumePending = c.pendingId and true or nil
		end
		if db.outbox and db.outbox.chat == c.id and not db.outbox.generation then db.outbox.generation = c.generation end
		if db.contextOutbox and db.contextOutbox.chat == c.id and not db.contextOutbox.generation then db.contextOutbox.generation = c.generation end
		-- Repair only titles derived from an old, already-expanded named-color link.
		-- Explicit renames, transcripts and pending request snapshots stay untouched.
		if firstUser and c.name == AutoTitle(firstUser.text) then
			local plain = firstUser.text:gsub("|cn[%w_]+:(%b[])|r", "%1")
			if plain ~= firstUser.text then c.name = AutoTitle(plain) or c.name end
		end
	end
	-- Older clients left completed/cancelled instructions in the singleton outbox.
	for _, key in ipairs({ "outbox", "contextOutbox" }) do
		local out = db[key]
		local chat = out and FindChat(out.chat)
		if out and (not chat or chat.pendingId ~= out.id or not chat.request or chat.request.nonce ~= out.nonce) then db[key] = nil end
	end
end

local function AddHistory(chat, role, text, id, denied, agent, macros)
	table.insert(chat.history, { role = role, text = text, id = id, t = time(), denied = denied, agent = agent, macros = macros })
	while #chat.history > MAX_HISTORY do
		table.remove(chat.history, 1)
	end
end

local function SlotName(i)
	return string.format("%s%03d", SLOT_PREFIX, i)
end

local function SlotNumber(id)
	return ((id - 1) % SLOT_COUNT) + 1
end

---------------------------------------------------------------------------
-- Reload plumbing (fallback path)
---------------------------------------------------------------------------

local function SafeReload()
	if InCombatLockdown() then
		Wowie.reloadAfterCombat = true
		if ui.status then
			ui.status:SetText("In combat - will reload as soon as it ends")
		end
		return
	end
	ReloadUI()
end

-- ReloadUI() only works from a hardware event (a keypress or click), never from
-- a timer. So the automatic reload piggybacks on the player's own next keypress
-- once the interval has elapsed. The key still reaches the game normally.
local keyCatcher = CreateFrame("Frame", "WowieKeyCatcher", UIParent)
keyCatcher:Hide()
keyCatcher:EnableKeyboard(true)
keyCatcher:SetScript("OnKeyDown", function(self, key)
	if db and AnyPending() and db.settings.autoRefresh
		and GetTime() >= (Wowie.nextAutoRefresh or 0)
		and not InCombatLockdown() then
		self:Hide()
		Wowie.nextAutoRefresh = nil
		ReloadUI()
	end
end)

-- Arm the keypress reload. In pixel mode this is only used once the slot pool
-- is exhausted (a reload frees every slot) or the slots are not installed.
function Wowie.ArmAutoRefresh()
	if not AnyPending() or not db.settings.autoRefresh
		or (db.settings.mode == "pixel" and not (run.slotsExhausted or run.slotsMissing or run.pixelFailed)) then
		keyCatcher:Hide()
		Wowie.nextAutoRefresh = nil
		return
	end
	-- Propagation can't be changed in combat. Never show the catcher without it,
	-- or it would eat every keypress. PLAYER_REGEN_ENABLED re-arms after combat.
	if not keyCatcher.propagates then
		if InCombatLockdown() or not keyCatcher.SetPropagateKeyboardInput then return end
		keyCatcher:SetPropagateKeyboardInput(true)
		keyCatcher.propagates = true
	end
	Wowie.nextAutoRefresh = Wowie.nextAutoRefresh or (GetTime() + db.settings.interval)
	keyCatcher:Show()
end

---------------------------------------------------------------------------
-- Pixel strip (out)
---------------------------------------------------------------------------

local strip
local cellPool, palettes = {}, {}
local painter = CreateFrame("Frame", "WowieStripPainter", UIParent)
local RefreshStrip
local PAINT_CELLS = 2048
local PAINT_MS = 2

local function EnsureStrip()
	local display = tx.probe and tx.probe.display or tx.active
	local cell = Codec.DISPLAYS[display].cell
	if not strip then
		strip = CreateFrame("Frame", "WowieStrip", UIParent)
		strip:SetFrameStrata("TOOLTIP")
		strip:SetFrameLevel(10000)
		if strip.SetIgnoreParentScale then strip:SetIgnoreParentScale(true) end
		strip:SetPoint("TOPLEFT", UIParent, "TOPLEFT", 0, 0)
		strip:SetSize(CELLS_PER_ROW * cell, MAX_ROWS * cell)
		strip:Hide()
	end
	-- GetPhysicalScreenSize excludes the DPI factor used by the rendered window.
	-- Refresh on every send as well as UI_SCALE_CHANGED so cells stay physical pixels.
	local physH = 1080
	if GetPhysicalScreenSize then
		local _, h = GetPhysicalScreenSize()
		physH = h or physH
	end
	local dpiScale = GetScreenDPIScale and GetScreenDPIScale() or 1
	local scale = 768 / (physH * dpiScale)
	if strip:GetScale() ~= scale then strip:SetScale(scale) end
	if strip.cell ~= cell then strip:SetSize(CELLS_PER_ROW * cell, MAX_ROWS * cell) end
	strip.cell, strip.display = cell, display
	return strip
end

local function HideStrip()
	painter:SetScript("OnUpdate", nil)
	if strip then strip:Hide(); strip.lastPayload, strip.paint = nil, nil end
	run.stripShown = nil
end

local function PaintCurrent(job)
	local display = tx.probe and tx.probe.display or tx.active
	if not db or db.settings.mode ~= "pixel" or job.display ~= display then return false end
	for id, rec in pairs(job.records) do
		if run.outbound[id] ~= rec or rec.acked then return false end
	end
	return true
end

local function PaintStrip()
	local s, job = strip, strip and strip.paint
	if not job then return end
	if not PaintCurrent(job) then
		HideStrip()
		RefreshStrip()
		return
	end
	local started = debugprofilestop and debugprofilestop()
	local last = math.min(job.stop, job.index + PAINT_CELLS - 1)
	for i = job.index, last do
		local t = cellPool[i]
		if i <= job.total then
			if not t then
				t = s:CreateTexture(nil, "OVERLAY")
				cellPool[i] = t
			end
			if t.wowieCell ~= s.cell then
				t:SetSize(s.cell, s.cell)
				t:ClearAllPoints()
				t:SetPoint("TOPLEFT", s, "TOPLEFT", ((i - 1) % CELLS_PER_ROW) * s.cell, -math.floor((i - 1) / CELLS_PER_ROW) * s.cell)
				t.wowieCell = s.cell
			end
			local value = job.cells[i] or 0
			if t.wowieValue ~= value or t.wowieDisplay ~= job.display then
				local color = job.palette[value]
				t:SetColorTexture(color[1], color[2], color[3], 1)
				t.wowieValue, t.wowieDisplay = value, job.display
			end
			if not t.wowieShown then t:Show(); t.wowieShown = true end
		elseif t.wowieShown then
			t:Hide()
			t.wowieShown = false
		end
		job.index = i + 1
		if started and i % 16 == 0 and debugprofilestop() - started >= PAINT_MS then break end
	end
	if job.index <= job.stop then return end
	s.lastId, s.lastPayload, s.lastDisplay, s.lastScale = job.id, job.payload, job.display, s:GetScale()
	s.paint = nil
	painter:SetScript("OnUpdate", nil)
	local probe = tx.probe
	if probe and probe.id == job.id then
		local now = GetTime()
		probe.pollAt, probe.deadline = now + probe.pollDelay, now + probe.timeout
	end
	-- Keep a complete frame visible for the negotiated capture period. Partial
	-- texture updates are hidden, and cannot look like a new packet to the bridge.
	tx.nextFrameAt = GetTime() + tx.FramePeriod()
	s:Show()
	run.stripShown = true
end

local function ShowStrip(id, payload, records)
	local s = EnsureStrip()
	if s:IsShown() and s.lastId == id and s.lastPayload == payload and s.lastDisplay == s.display and s.lastScale == s:GetScale() then
		tx.nextFrameAt = GetTime() + tx.FramePeriod()
		run.stripShown = true
		return
	end
	local palette = palettes[s.display]
	if not palette then
		palette = {}
		for value = 0, 7 do palette[value] = { Codec.CellColor(value, s.display) } end
		palettes[s.display] = palette
	end
	local cells = Codec.Encode(id % 65536, payload)
	local total = math.ceil(#cells / CELLS_PER_ROW) * CELLS_PER_ROW
	s:Hide()
	run.stripShown = nil
	s.paint = { id = id, payload = payload, display = s.display, records = records,
		cells = cells, palette = palette, total = total, stop = math.max(total, #cellPool), index = 1 }
	painter:SetScript("OnUpdate", PaintStrip)
	PaintStrip()
end

-- Record: session, chat, id, cwd, flags, name, [context,] text. Several records
-- per frame. The context field is only present when the flags carry "c", so the
-- bridge can tell it from a separator inside the text.
local function RecordFor(id, rec)
	local flags = Wire(rec.flags)
	local fields = { Wire(db.session), Wire(rec.chat), tostring(id), Wire(rec.cwd), flags, Wire(rec.name) }
	if rec.ctx ~= nil then
		fields[5] = flags == "" and "c" or (flags .. ";c")
		table.insert(fields, Wire(rec.ctx))
	end
	table.insert(fields, Wire(rec.text))
	return table.concat(fields, US)
end

local function ControlRecord(info)
	local flags = "nonce=" .. info.nonce
	if info.generation then flags = flags .. ";generation=" .. info.generation end
	if info.kind == "forget" then flags = flags .. ";d"
	else flags = flags .. ";receipt=" .. info.kind .. ";target=" .. info.target end
	return { chat = info.chat, nonce = info.nonce, generation = info.generation, flags = flags,
		name = "", text = "", control = true, forget = info.kind == "forget" and info.nonce or nil, sentAt = GetTime() }
end

local function RefreshControlOutbox()
	local records = {}
	for _, pending in ipairs({ db.forget, db.receipts }) do
		for _, info in pairs(pending) do records[#records + 1] = RecordFor(info.id, ControlRecord(info)) end
	end
	db.controlOutbox = #records > 0 and ToHex(table.concat(records, RS)) or nil
end

local function SendControls()
	RefreshControlOutbox()
	if db.settings.mode ~= "pixel" or run.requestProtocol ~= 2 then return end
	local changed = false
	for _, pending in ipairs({ db.forget, db.receipts }) do
		for _, info in pairs(pending) do
			local rec = run.outbound[info.id]
			if not rec or rec.nonce ~= info.nonce then
				run.outbound[info.id] = ControlRecord(info)
				changed = true
			end
		end
	end
	if next(db.forget) or next(db.receipts) then
		run.controlsPollAt = run.controlsPollAt or (GetTime() + 5)
	else run.controlsPollAt = nil end
	if changed then RefreshStrip() end
end

local function QueueReceipt(kind, chat, generation, target)
	if not ValidToken(target) then return end
	for _, info in pairs(db.receipts) do
		if info.kind == kind and info.chat == chat and info.target == target then SendControls(); return end
	end
	db.lastSeq = db.lastSeq + 1
	local nonce = NewNonce()
	db.receipts[nonce] = { id = db.lastSeq, nonce = nonce, kind = kind, chat = chat, generation = generation, target = target }
	SendControls()
end

local function ApplyReceipts(receipts)
	local changed = false
	for _, ack in ipairs(type(receipts) == "table" and receipts or {}) do
		if type(ack) == "table" and ack.session == db.session and ValidToken(ack.nonce) then
			local info = db.forget[ack.nonce] or db.receipts[ack.nonce]
			if info and ack.chat == info.chat and ack.kind == info.kind then
				db.forget[ack.nonce], db.receipts[ack.nonce] = nil, nil
				local rec = run.outbound[info.id]
				if rec and rec.nonce == info.nonce then run.outbound[info.id] = nil end
				changed = true
			end
		end
	end
	if changed then RefreshControlOutbox(); RefreshStrip() end
end

local function ForgetPending(chatId)
	for _, info in pairs(db.forget) do if info.chat == chatId then return true end end
	return false
end

local BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
local function ToBase64(text)
	if C_EncodingUtil and type(C_EncodingUtil.EncodeBase64) == "function" then
		local ok, encoded = pcall(C_EncodingUtil.EncodeBase64, text)
		if ok and type(encoded) == "string" then return encoded end
	end
	local parts = {}
	for i = 1, #text, 3 do
		local a, b, c = string.byte(text, i, i + 2)
		local first = math.floor(a / 4) + 1
		local second = (a % 4) * 16 + math.floor((b or 0) / 16) + 1
		local third = ((b or 0) % 16) * 4 + math.floor((c or 0) / 64) + 1
		local fourth = (c or 0) % 64 + 1
		parts[#parts + 1] = BASE64:sub(first, first) .. BASE64:sub(second, second)
			.. (b and BASE64:sub(third, third) or "=") .. (c and BASE64:sub(fourth, fourth) or "=")
	end
	return table.concat(parts)
end

local function DataFlags(id, rec, part, parts)
	local flags = "nonce=" .. rec.nonce .. ";generation=" .. rec.generation .. ";data=" .. (rec.dataKind or "profile") .. ";part=" .. part .. "/" .. parts
	if rec.dataKind == "query" then flags = flags .. ";request=" .. rec.request
	else flags = flags .. ";profile=" .. id end
	return flags .. ";encoding=" .. rec.encoding
end

local function PrepareData(rec, id)
	local text = rec.profile or rec.payload
	if not text then return end
	rec.encoding = "b64"
	if C_EncodingUtil and type(C_EncodingUtil.CompressString) == "function"
		and Enum and Enum.CompressionMethod and Enum.CompressionMethod.Zlib ~= nil then
		local level = Enum.CompressionLevel and Enum.CompressionLevel.OptimizeForSpeed
		local ok, compressed = pcall(C_EncodingUtil.CompressString, text, Enum.CompressionMethod.Zlib, level)
		if ok and type(compressed) == "string" and #compressed < #text then
			text, rec.encoding = compressed, "zlib64"
		end
	end
	local encoded = ToBase64(text)
	local overhead = #RecordFor(id, { chat = rec.chat, flags = DataFlags(id, rec, 4096, 4096), text = "" })
	local chunk = math.floor((Codec.MAX_PAYLOAD - overhead) / 4) * 4
	assert(chunk > 0, "Information-transfer envelope exceeds the pixel frame capacity")
	local parts = {}
	for i = 1, #encoded, chunk do parts[#parts + 1] = encoded:sub(i, i + chunk - 1) end
	rec.parts = parts
	rec.cursor = rec.dataKind and 1 or 0
end

local function DataRecord(id, rec)
	local cursor = rec.cursor or 0
	if cursor == 0 then
		rec.cursor = 1
		return RecordFor(id, rec)
	end
	local flags = DataFlags(id, rec, cursor, #rec.parts)
	local text = RecordFor(id, { chat = rec.chat, flags = flags, text = rec.parts[cursor] })
	rec.cursor = cursor == #rec.parts and (rec.dataKind and 1 or 0) or cursor + 1
	return text
end

-- Redraw the strip from every outbound message the bridge hasn't acknowledged.
RefreshStrip = function(prefer)
	if strip and strip.paint then
		if PaintCurrent(strip.paint) and (not prefer or strip.paint.records[prefer]) then return end
		HideStrip()
	end
	if tx.probe then
		local rec = run.outbound[tx.probe.id]
		if rec then ShowStrip(tx.probe.id, RecordFor(tx.probe.id, rec), { [tx.probe.id] = rec }); return end
	end
	local ids = {}
	for id, rec in pairs(run.outbound) do
		if not rec.acked then table.insert(ids, id) end
	end
	if #ids == 0 then
		HideStrip()
		return
	end
	table.sort(ids)
	local multipart = false
	for _, id in ipairs(ids) do if run.outbound[id].parts then multipart = true; break end end
	if multipart then
		-- Fair rotation prevents a large snapshot starving another chat or control record.
		local index = ((run.dataOwner or 0) % #ids) + 1
		if prefer then for i, id in ipairs(ids) do if id == prefer then index = i; break end end end
		run.dataOwner = index
		local id = ids[index]
		local rec = run.outbound[id]
		ShowStrip(id, rec.parts and DataRecord(id, rec) or RecordFor(id, rec), { [id] = rec })
		return
	end
	-- Newest first; drop the oldest if the frame would overflow.
	local parts, records, size, latest = {}, {}, 0, ids[#ids]
	for i = #ids, 1, -1 do
		local r = RecordFor(ids[i], run.outbound[ids[i]])
		if size + #r + 1 > Codec.MAX_PAYLOAD then break end
		table.insert(parts, 1, r)
		records[ids[i]] = run.outbound[ids[i]]
		size = size + #r + 1
	end
	ShowStrip(latest, table.concat(parts, RS), records)
end

function tx.FramePeriod()
	local period, count, now = tx.interval, 0, GetTime()
	for _, rec in pairs(run.outbound) do if not rec.acked then count = count + 1 end end
	for _, rec in pairs(run.outbound) do
		if rec.parts and not rec.acked then
			local cycle = (#rec.parts + 1) * tx.interval * math.max(1, count)
			local wait = math.max(3, cycle * 2)
			local age = now - rec.sentAt
			if age > wait * 2 then period = math.max(period, 0.5)
			elseif age > wait then period = math.max(period, 0.25) end
		end
	end
	return period
end

function tx.Status()
	if tx.probe then return "Checking " .. Codec.DISPLAYS[tx.probe.display].label .. " against a full-size captured frame..." end
	local profile = Codec.DISPLAYS[tx.active]
	local text = profile.label .. " active · " .. profile.cell .. " px · up to " .. string.format("%.0f", 1 / tx.interval) .. " frames/s"
	if tx.reason ~= "" then text = text .. "\n" .. tx.reason end
	return text
end

function tx.UpdateSettings()
	if ui.pixelStatus then ui.pixelStatus:SetText(tx.Status()) end
	for display, button in pairs(ui.pixelButtons or {}) do
		local selected = ui.defaultsDraft and ui.defaultsDraft.pixelDisplay == display
		button:SetText(Codec.DISPLAYS[display].label)
		UI.SetSelected(button, selected)
	end
end

function tx.FreshAck(data, nonce, startedEpoch)
	local ack, clock = data.connectionAck, data.now
	return data.connectionProtocol == 1 and type(ack) == "table"
		and ack.session == db.session and ack.nonce == nonce
		and type(clock) == "number" and clock >= time() - CONNECT_WAIT and clock <= time() + 2
		and type(ack.at) == "number" and ack.at >= startedEpoch and ack.at <= clock
end

function tx.Fail(reason)
	local probe = tx.probe
	if probe then run.outbound[probe.id] = nil end
	tx.probe, tx.active = nil, "robust"
	if probe and probe.display == "quiet" and tx.displays and tx.displays.quiet4 then
		tx.retryDisplay, tx.failed, tx.reason = "quiet4", nil, "Two-pixel colors were not reliable; checking four-pixel Quiet."
	else
		tx.retryDisplay, tx.failed, tx.reason = nil, probe and probe.preference or db.settings.pixelDisplay, reason
	end
	RefreshStrip()
	tx.UpdateSettings()
end

function tx.MaybeCalibrate()
	local preference = db.settings.pixelDisplay
	local active = Codec.DISPLAYS[tx.active]
	if preference == "robust" or preference == (active.family or tx.active) or tx.failed == preference or tx.probe then return end
	local display = tx.retryDisplay or db.settings.pixelVerified[preference]
	if not Codec.DISPLAYS[display or ""] or not tx.displays or not tx.displays[display]
		or (Codec.DISPLAYS[display].family or display) ~= preference then display = preference end
	if not tx.displays or not tx.displays[display] then
		local reason = Wowie.IsConnected() and "Update/restart the bridge to check Compact or Quiet."
			or "Reconnect to check the saved display preference."
		if tx.reason ~= reason then tx.reason = reason; tx.UpdateSettings() end
		return
	end
	if run.connectingAt or not Wowie.IsConnected() then return end
	tx.retryDisplay = nil
	db.lastSeq = db.lastSeq + 1
	local nonce, now = NewNonce(), GetTime()
	local pollDelay = math.max(1, (tx.captureInterval or 0.25) * 2 + 0.25)
	tx.probe = { id = db.lastSeq, nonce = nonce, display = display, preference = preference, startedEpoch = time(),
		pollDelay = pollDelay, timeout = math.max(4, pollDelay + 2) }
	local c = ActiveChat()
	local rec = { chat = c and c.id or "", cwd = "", flags = "h;nonce=" .. nonce .. ";calibration=" .. display,
		name = "", text = "", hello = true, calibration = true, nonce = nonce, sentAt = now }
	-- Exercise the complete canvas, not just a small header, without sharing character data.
	local length = Codec.MAX_PAYLOAD - #RecordFor(tx.probe.id, rec)
	local pattern = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	rec.text = string.rep(pattern, math.ceil(length / #pattern)):sub(1, length)
	run.outbound[tx.probe.id] = rec
	tx.reason = ""
	RefreshStrip()
	tx.UpdateSettings()
end

function tx.Accept(data, verified)
	if verified then
		local capability = data.transport
		tx.displays, tx.interval, tx.captureInterval = nil, 0.5, nil
		if data.transportProtocol == 1 and type(capability) == "table" and type(capability.displays) == "table" then
			tx.displays = {}
			for _, display in ipairs(capability.displays) do
				if Codec.DISPLAYS[display] then tx.displays[display] = true end
			end
			tx.interval = math.max(0.1, (tonumber(capability.frameIntervalMs) or 500) / 1000)
			tx.captureInterval = math.max(0.01, (tonumber(capability.captureIntervalMs) or 250) / 1000)
			tx.nextFrameAt = GetTime()
		end
	end
	local probe = tx.probe
	if probe and tx.FreshAck(data, probe.nonce, probe.startedEpoch) then
		if data.connectionAck.display == probe.display then
			run.outbound[probe.id] = nil
			db.settings.pixelVerified[probe.preference] = probe.display
			tx.active, tx.probe, tx.failed = probe.display, nil, nil
			tx.reason = probe.display == "quiet4" and "Four-pixel dark cells selected for reliable capture." or ""
			RefreshStrip()
		else tx.Fail("Display check did not match the captured mode; using Robust.") end
	end
	tx.UpdateSettings()
end

function tx.SetPreference(display)
	if not Codec.DISPLAYS[display] or Codec.DISPLAYS[display].family then return end
	local changed, retry = db.settings.pixelDisplay ~= display, tx.failed == display
	if changed then db.settings.pixelVerified[display] = nil end
	db.settings.pixelDisplay = display
	if changed or retry or (display == "robust" and (tx.active ~= "robust" or tx.probe)) then
		if tx.probe then run.outbound[tx.probe.id] = nil end
		tx.active, tx.probe, tx.failed, tx.retryDisplay, tx.reason = "robust", nil, nil, nil, ""
		RefreshStrip()
	end
	tx.UpdateSettings()
	if display ~= "robust" and not Wowie.IsConnected() then Wowie.Connect()
	else tx.MaybeCalibrate() end
end

function tx.Invalidate()
	if tx.probe then run.outbound[tx.probe.id] = nil end
	tx.active, tx.probe, tx.failed, tx.retryDisplay, tx.reason = "robust", nil, nil, nil, ""
	HideStrip()
	RefreshStrip()
	tx.UpdateSettings()
end

---------------------------------------------------------------------------
-- Signals and slots (in)
---------------------------------------------------------------------------

-- Optional cheap poll: an empty .wav won't play, a valid one will. The bridge
-- fills sig/NNN.wav when reply NNN is ready. Self-disables if it misbehaves.
local signalAvailable = type(PlaySoundFile) == "function"
local signalStats = { checks = 0, hits = 0, lastHit = nil }

local function SoundValid(path)
	if not signalAvailable or not db.settings.signal then return false end
	signalStats.checks = signalStats.checks + 1
	local ok, willPlay, handle = pcall(PlaySoundFile, path, "Master")
	if not ok then
		signalAvailable = false
		signalStats.error = tostring(willPlay)
		return false
	end
	if willPlay and handle then pcall(StopSound, handle) end
	if willPlay then
		signalStats.hits = signalStats.hits + 1
		signalStats.lastHit = GetTime()
	end
	return willPlay and true or false
end

local function CheckSignal(kind, id)
	if run.signalUnreliable then return false end
	return SoundValid(string.format("Interface\\AddOns\\Wowie\\%s\\%03d.wav", kind, SlotNumber(id)))
end

-- Heartbeat: the bridge flips act/NNN/kk.wav for the k-th action of message NNN.
local function ActPath(id, k)
	return string.format("Interface\\AddOns\\Wowie\\act\\%03d\\%02d.wav", SlotNumber(id), k)
end

local function StartActivity(chat, id)
	local a = { next = 1, count = 0, startedAt = GetTime() }
	-- The bridge can't have written anything yet, so a valid first file means the
	-- client cached this slot number's files from an earlier use: don't trust them.
	if SoundValid(ActPath(id, 1)) then a.unreliable = true end
	run.act = run.act or {}
	run.act[chat.id] = a
end

-- Returns true if the counter moved.
local function PollActivity(chat)
	local a = run.act and run.act[chat.id]
	if not a or a.unreliable or not chat.pendingId then return false end
	local moved = false
	for _ = 1, 3 do
		if a.next > ACT_MAX then break end
		if not SoundValid(ActPath(chat.pendingId, a.next)) then break end
		a.count = a.count + 1
		a.next = a.next + 1
		a.last = GetTime()
		moved = true
	end
	return moved
end

-- Snapshot clocks and advancing sounds are maintenance hints, not proof that
-- this addon's current outbound challenge reached the bridge.
local function NotedBridge(at)
	at = at or GetTime()
	if not run.bridgeSeen or at > run.bridgeSeen then
		run.bridgeSeen = at
	end
end

local function PresencePath(k)
	return string.format("Interface\\AddOns\\Wowie\\presence\\%04d.wav", k)
end

-- Valid presence files form a prefix 1..k, so a binary search finds the head.
local function FindPresenceHead()
	local lo, hi = 0, PRESENCE_MAX
	while lo < hi do
		local mid = math.ceil((lo + hi) / 2)
		if SoundValid(PresencePath(mid)) then lo = mid else hi = mid - 1 end
	end
	return lo
end

local function PollPresence()
	if not signalAvailable or not db.settings.signal then return end
	run.presence = run.presence or { last = FindPresenceHead() }
	local p = run.presence
	local moved = false
	for _ = 1, 3 do
		local k = p.last + 1
		if k > PRESENCE_MAX then break end
		if not SoundValid(PresencePath(k)) then break end
		p.last = k
		p.beats = (p.beats or 0) + 1
		p.observedAt = GetTime()
		NotedBridge()
		moved = true
	end
	return moved
end

-- The self-test only proves the sound API works. Presence needs an advancing,
-- recent filename, and exhausted cached filenames cannot provide another beat.
local function PresenceWorks()
	local p = run.presence
	return signalAvailable and db ~= nil and db.settings.signal and p
		and p.last < PRESENCE_MAX and p.observedAt ~= nil and GetTime() - p.observedAt < 90
end

local function PresenceStatus()
	local p = run.presence
	if PresenceWorks() then
		return "Notifications: sound presence (last hint " .. FmtDur(GetTime() - p.observedAt) .. " ago)"
	end
	local reason
	if not db or not db.settings.signal then
		reason = "signal checks off"
	elseif not signalAvailable then
		reason = "sound unavailable: " .. tostring(signalStats.error or signalStats.selftest)
	elseif p and p.last >= PRESENCE_MAX then
		reason = "cached presence filenames exhausted"
	elseif p and p.observedAt then
		reason = "presence stalled; last beat " .. FmtDur(GetTime() - p.observedAt) .. " ago"
	else
		reason = "no advancing presence observed"
	end
	return "Notifications: slot-clock maintenance (" .. reason .. "); idle checks every " .. FmtDur(IDLE_POLL_SECONDS)
end

-- Verification describes a completed round trip, not a persistent socket.
local function VerificationAge()
	return run.verifiedAt and math.max(0, GetTime() - run.verifiedAt) or nil
end

local function ConnectionLabel()
	if run.connectingAt then return "Checking bridge..." end
	if run.connectFailed then return "Bridge not responding" end
	local age = VerificationAge()
	if age and age < VERIFIED_SECONDS then return "Verified " .. FmtDur(age) .. " ago" end
	return "Idle / not verified"
end

function Wowie.BridgeState()
	if run.connectingAt then return "unknown", 0.6, 0.6, 0.6, "Bridge: checking a fresh challenge" end
	if run.connectFailed then return "down", 0.9, 0.25, 0.25, "Bridge: not responding to the latest check" end
	local age = VerificationAge()
	if age and age < VERIFIED_SECONDS then
		return "ok", 0.2, 0.9, 0.3, "Bridge: verified " .. FmtDur(age) .. " ago"
	end
	return "unknown", 0.6, 0.6, 0.6, "Bridge: idle / not verified" .. (age and ("; last check " .. FmtDur(age) .. " ago") or "")
end

-- Same icons the friends list uses for online / away / busy / offline.
local STATE_ICON = {
	ok = "Interface\\FriendsFrame\\StatusIcon-Online",
	stale = "Interface\\FriendsFrame\\StatusIcon-Away",
	down = "Interface\\FriendsFrame\\StatusIcon-DnD",
	unknown = "Interface\\FriendsFrame\\StatusIcon-Offline",
}

function Wowie.UpdateDot()
	local state, _, _, _, tip = Wowie.BridgeState()
	if run.pixelFailed and not run.connectingAt then state = "down" end
	tip = tip .. "\n" .. PresenceStatus() .. "\n" .. tx.Status()
	for _, dot in ipairs({ ui.dot, ui.miniDot }) do
		if dot then
			dot:SetTexture(STATE_ICON[state] or STATE_ICON.unknown)
			dot.tip = tip
		end
	end
	if ui.connection then
		ui.connection:SetText(db and db.settings.mode == "reload" and "Reload transport" or ConnectionLabel())
		ui.connection:SetTextColor(unpack(UI.colors[state == "ok" and "success" or (state == "stale" and "warning" or "muted")]))
	end
end

-- Map changes notify this entry directly; navigation never rebuilds the
-- discussion or collects character/provider context.
function Wowie.UpdateNavigation()
	local button = ui.navigation
	if not button then return end
	local map = WowieMap
	local available = type(map) == "table" and type(map.GetNavigationState) == "function" and type(map.ShowNavigation) == "function"
	local state = available and map.GetNavigationState() or nil
	if ui.navigationMap == map and ui.navigationState == state and ui.navigationReady == available then return end
	ui.navigationMap, ui.navigationState, ui.navigationReady = map, state, available
	button:SetEnabled(available and state ~= nil)
	local label, title, body = "Navigation", "Navigation", "The navigation module is not available."
	if state then
		local count = 0
		for _, layer in ipairs(state.layers or {}) do count = count + #(layer.points or {}) end
		label = count > 0 and ("Navigation · " .. count) or label
		body = count > 0 and (count .. " saved destinations. Choose a destination or route without sending an AI request.")
			or "No saved destinations yet."
		local active = state.active
		if active then
			local point = active.point or {}
			local destination = point[4] and point[4] ~= "" and point[4] or active.title
			destination = destination and destination ~= "" and destination or "Destination"
			label, title = "To: " .. Display(destination), "Navigation · " .. Display(destination)
			body = Display(active.title or "Destination") .. "\n"
				.. (active.ordered and "Route stop " or "Destination ") .. (active.index or 1) .. " of " .. (active.total or 1)
				.. (active.ordered and active.loop and " · Looping" or "")
			if type(point[2]) == "number" and type(point[3]) == "number" then
				body = body .. string.format("\nCoordinates: %.1f, %.1f", point[2], point[3])
			end
		end
		local status = state.status
		local detail = status == "pending" and "Waiting for combat to end."
			or status == "route" and "Tracking on the map and minimap."
			or status == "native" and "Tracking with a native waypoint."
			or status == "unavailable" and "Navigation unavailable."
			or "No active destination."
		body = body .. "\n" .. detail
		if state.message and state.message ~= "" then body = body .. "\n" .. Display(state.message) end
		body = body .. "\nOpen Navigation to choose a destination or manage tracking. Saved destinations work offline."
	end
	button:SetText(label)
	button.navigationTitle, button.navigationBody = title, body
end

-- Reload transport still uses its explicit reload cycle. Pixel sends require a
-- recent acknowledgement of this session's current challenge.
function Wowie.IsConnected()
	if not db or db.settings.mode ~= "pixel" then return true end
	local age = VerificationAge()
	return age ~= nil and age < VERIFIED_SECONDS and not run.pixelFailed
end

-- An explicit new check supersedes old confirmation immediately. Repeated
-- clicks/callers during a pending check retransmit the same operation.
function Wowie.Connect()
	if db.settings.mode ~= "pixel" then
		SafeReload()
		return
	end
	if run.connectingAt then
		Wowie.SayHello()
		return
	end
	tx.Invalidate()
	tx.interval, tx.displays, tx.captureInterval = 0.5, nil, nil
	for id, rec in pairs(run.outbound) do if rec.hello then run.outbound[id] = nil end end
	db.hello = nil
	run.probe, run.verifiedAt = nil, nil
	run.lastHelloAt = nil
	run.pixelFailed = nil
	run.connectFailed = nil
	run.connectingAt = nil -- SayHello records both clocks before publishing
	Wowie.SayHello()
end

-- One word for the connection state, so Tick can tell when it changed.
local function ConnectionKey()
	if run.connectingAt then return "connecting" end
	if run.connectFailed then return "failed" end
	return Wowie.IsConnected() and "ok" or "unverified"
end

-- Called every tick: time out a Connect attempt, and redraw when the state flips
-- (light, button, status line, placeholder) without redrawing every tick.
function Wowie.CheckConnection()
	if run.connectingAt then
		if Wowie.IsConnected() then
			run.connectingAt, run.connectFailed = nil, nil
			-- A message typed while disconnected goes out now, without a second click,
			-- as long as the same chat is still in front and free.
			local queued = run.sendOnConnect
			run.sendOnConnect = nil
			local c = queued and ActiveChat()
			if c and c.id == queued.chat and not c.pendingId then
				if ui.input and Trim(ui.input:GetText() or "") == queued.text then ui.input:SetText("") end
				Wowie.Send(queued.text, queued.allow)
			end
		elseif GetTime() - run.connectingAt > CONNECT_WAIT then
			run.connectingAt, run.connectFailed = nil, true
			run.sendOnConnect = nil -- the text is still in the box
			db.hello = nil
			run.helloPollAt = nil
			for id, rec in pairs(run.outbound) do if rec.hello then run.outbound[id] = nil end end
			RefreshStrip()
		end
	elseif run.connectFailed and Wowie.IsConnected() then
		run.connectFailed = nil
	end
	local key = ConnectionKey()
	if key ~= run.connKey then
		run.connKey = key
		Wowie.Render()
	end
end

-- Both actions remain available; only the direct check waits for its probe.
function Wowie.UpdateConnect()
	if not ui.reconnect or not ui.send then return end
	ui.send:Show()
	ui.reconnect:Show()
	ui.reconnect:SetEnabled(not run.connectingAt)
	local c = ActiveChat()
	ui.send:SetText(c and c.pendingId and "Check reply" or "Send")
	if ui.cancel then ui.cancel:SetShown((c and c.pendingId ~= nil) or run.sendOnConnect ~= nil) end
	if ui.statusArea then ui.statusArea:SetPoint("RIGHT", ui.cancel and ui.cancel:IsShown() and ui.cancel or ui.send, "LEFT", -12, 0) end
end

-- Prove the sound-file trick actually distinguishes empty from valid files on this
-- client before trusting it for presence, heartbeats and readiness signals.
local function SelfTestSignals()
	if not signalAvailable then
		signalStats.selftest = "PlaySoundFile missing"
		return
	end
	local emptyLooksValid = SoundValid("Interface\\AddOns\\Wowie\\ctl\\empty.wav")
	local validLooksValid = SoundValid("Interface\\AddOns\\Wowie\\ctl\\valid.wav")
	if emptyLooksValid then
		signalAvailable = false
		signalStats.selftest = "an empty file reports as playable"
	elseif not validLooksValid then
		signalAvailable = false
		signalStats.selftest = "a valid file reports as unplayable (files not indexed? restart WoW)"
	else
		signalStats.selftest = "passed"
	end
end

local function ActivityLine(chat)
	local a = run.act and run.act[chat.id]
	local now = GetTime()
	local started = (a and a.startedAt) or run.sentAt or now
	local s = "running " .. FmtDur(now - started)
	if a and not a.unreliable then
		s = s .. " - " .. a.count .. (a.count == 1 and " action" or " actions")
		if a.last then
			local quiet = now - a.last
			s = s .. ", last " .. FmtDur(quiet) .. " ago"
			if quiet > 120 then s = s .. " (quiet for a while - stuck? /wowie cancel)" end
		elseif now - started > 60 then
			s = s .. ", no activity seen yet"
		end
	end
	return s
end

local function FreeSlot()
	for i = 1, SLOT_COUNT do
		local name = SlotName(i)
		if not C_AddOns.IsAddOnLoaded(name) then
			return name
		end
	end
end

local function ScheduleNextPoll()
	local idx = (run.polls or 0) + 1
	local t = POLL_SCHEDULE[idx]
	if not t then
		t = POLL_SCHEDULE[#POLL_SCHEDULE] + POLL_TAIL * (idx - #POLL_SCHEDULE)
	end
	run.nextPollAt = (run.sentAt or GetTime()) + t
	for _, chat in ipairs(db.chats) do
		if chat.pendingId and chat.request and chat.request.profile then
			run.nextPollAt = math.min(run.nextPollAt, GetTime() + CONTEXT_POLL_SECONDS)
			break
		end
	end
end

local Finish -- defined below

-- The bridge has read this record: whatever game context rode on it is now
-- what the bridge knows, so later messages only carry it again if it changes.
local function NoteAcked(rec)
	rec.acked = true
	if rec.ctx ~= nil then run.contextSent = rec.ctx end
	if rec.hello and db.hello and db.hello.nonce == rec.nonce then
		db.hello, run.helloPollAt = nil, nil
	end
end

local function MarkAcked(id, nonce)
	local rec = run.outbound[id]
	if rec and rec.nonce == nonce and not rec.acked then
		NoteAcked(rec)
		RefreshStrip()
	end
end

local function ReconcilePending()
	if not run.reconcilePending or db.settings.mode ~= "pixel" or run.requestProtocol ~= 2 then return end
	run.reconcilePending = nil
	local sent = false
	for _, chat in ipairs(db.chats) do
		if chat.pendingId and chat.request then
			-- Ask the durable journal about the original turn, not an orphaned cached
			-- query response. A restored query wait republishes its exact batch.
			local rec = {}
			for key, value in pairs(chat.request) do rec[key] = value end
			rec.sentAt = GetTime()
			PrepareData(rec, chat.pendingId)
			run.outbound[chat.pendingId] = rec
			chat.resumePending = nil
			sent = true
		end
	end
	if sent then
		run.sentAt, run.polls = GetTime(), 0
		ScheduleNextPoll()
		RefreshStrip()
	end
end

local function ReplyToContext(c, r)
	if type(r.request) ~= "string" or type(r.queries) ~= "table" then return end
	local old = run.outbound[r.id]
	if old and old.nonce == r.nonce and old.request ~= r.request then MarkAcked(r.id, r.nonce) end
	c.snapshotAcked = true
	if not c.queryReply or c.queryReply.nonce ~= r.nonce or c.queryReply.request ~= r.request then
		local results = {}
		for _, query in ipairs(r.queries) do
			if query.category == nil and query.op == "snapshot" then query.category = query.name end
			results[#results + 1] = WowieContext.Query(query)
		end
		c.queryReply = { nonce = r.nonce, request = r.request, text = "[" .. table.concat(results, ",") .. "]" }
	end
	db.contextOutbox = { id = r.id, nonce = r.nonce, generation = c.request.generation, session = db.session, chat = c.id, request = r.request, text = ToHex(c.queryReply.text) }
	if db.settings.mode == "pixel" then
		local rec = run.outbound[r.id]
		if not rec or rec.nonce ~= r.nonce or rec.request ~= r.request then
			rec = { chat = c.id, nonce = r.nonce, generation = c.request.generation, dataKind = "query", request = r.request, payload = c.queryReply.text, sentAt = GetTime() }
			PrepareData(rec, r.id)
			run.outbound[r.id] = rec
			RefreshStrip(r.id)
		end
	end
	run.sentAt, run.polls = GetTime(), 0
	ScheduleNextPoll()
	Wowie.ArmAutoRefresh()
end

-- Dispatch a list of reply records to the chats waiting for them.
local function ApplyReplies(replies)
	local matched = false
	for _, r in ipairs(replies or {}) do
		local c = FindChat(r.chat)
		if c and c.pendingId and r.id == c.pendingId and c.request and type(c.request.nonce) == "string" and r.nonce == c.request.nonce
			and (r.generation == nil or r.generation == c.request.generation) then
			matched = true
			run.replyPhase = run.replyPhase or {}
			run.replyPhase[c.id] = r.status
			if r.status ~= "context" and r.status ~= "context_query" then
				MarkAcked(r.id, r.nonce)
				c.snapshotAcked = true
			end
			local denied = type(r.denied) == "table" and #r.denied > 0 and r.denied or nil
			if r.status == "done" then
				Finish(c, "assistant", r.text or "", denied, r.agent, Wowie.CleanMacros(r.macros))
			elseif r.status == "error" then
				Finish(c, "system", "Bridge error: " .. tostring(r.text), denied)
			elseif r.status == "working" or r.status == "queued" then
				c.progress = r.text
			elseif r.status == "context" then
				c.progress = r.text
			elseif r.status == "context_query" then
				c.progress = r.text
				ReplyToContext(c, r)
			end
		end
	end
	return matched
end

-- The bridge keeps every chat's transcript. After the client wipes our saved data,
-- it sends them back once, addressed to our new session token.
local function ImportRestore(r)
	if type(r) ~= "table" or r.token ~= db.session or not ValidToken(r.id) then return end
	if db.restored == r.id then QueueReceipt("restore", "", nil, r.id); return end
	local added = 0
	local current = ActiveChat()
	for _, rc in ipairs(r.chats or {}) do
		-- Skip chats deleted here that the bridge hasn't been told about yet.
		if type(rc) == "table" and rc.id and not FindChat(rc.id) and not ForgetPending(rc.id) and #db.chats < MAX_CHATS then
			local chat = {
				id = rc.id,
				generation = ValidToken(rc.generation) and rc.generation or NewNonce(),
				name = (rc.name and rc.name ~= "") and rc.name or ("Chat " .. (#db.chats + 1)),
				cwd = rc.cwd or DEFAULT_CWD,
				agent = "",
				model = "",
				reasoning = "",
				history = {},
				unread = 0,
				created = time(),
			}
			for _, m in ipairs(rc.messages or {}) do
				local role, agent = m.role, m.agent
				if role == "claude" then role, agent = "assistant", agent or "claude" end -- an older bridge's transcript
				if agent == "" then agent = nil end
				table.insert(chat.history, { role = role, text = m.text, id = m.id, t = m.t, agent = agent })
			end
			-- Keep the chat we're currently using last so it stays where it was.
			table.insert(db.chats, math.max(1, #db.chats), chat)
			added = added + 1
		end
	end
	db.restored = r.id
	QueueReceipt("restore", "", nil, r.id)
	run.restoring = nil
	if added > 0 then
		if current and #current.history <= 2 then
			for _, ch in ipairs(db.chats) do
				if ch ~= current and ch.name == current.name then current.name = "New chat" end
			end
		end
		AddHistory(current, "system", "Restored " .. added .. " chat(s) from the bridge after the game reset the saved data.")
		Wowie.RenderChatList()
	end
end

-- Slot loads and the reload inbox carry the same bridge snapshot.
local function ApplyBridgeData(data)
	if type(data) ~= "table" then return false end
	local probe, ack = run.probe, data.connectionAck
	local verified = run.connectingAt and probe and probe.session == db.session
		and GetTime() - probe.startedAt <= CONNECT_WAIT and tx.FreshAck(data, probe.nonce, probe.startedEpoch)
	if verified then
		-- Capture this acknowledgement's actual age once. Republishing metadata
		-- or a later retry must not renew a completed verification.
		if not probe.acknowledgedAt then
			probe.acknowledgedAt = ack.at
			run.verifiedAt = GetTime() - math.max(0, time() - ack.at)
			run.pixelFailed = nil
			MarkAcked(probe.id, probe.nonce)
		end
	end
	tx.Accept(data, verified)
	if type(data.cwd) == "string" and data.cwd ~= "" then run.bridgeCwd = data.cwd end
	if type(data.agent) == "string" and data.agent ~= "" then run.bridgeAgent = data.agent end
	if type(data.agents) == "table" and #data.agents > 0 then run.bridgeAgents = data.agents end
	if type(data.agentOptions) == "table" then run.agentOptions = data.agentOptions end
	if type(data.contextProtocol) == "number" then run.contextProtocol = data.contextProtocol end
	run.requestProtocol = data.requestProtocol
	run.contextEnabled = data.contextEnabled ~= false
	if run.requestProtocol == 2 then ApplyReceipts(data.receipts) end
	local matched = ApplyReplies(data.replies)
	if data.restore then ImportRestore(data.restore) end
	if data.map and WowieMap then WowieMap.Sync(data.map) end
	SendControls()
	ReconcilePending()
	return matched
end

local function TryLoadSlot(why)
	if (run.slotsExhausted or run.slotsMissing) and why ~= "manual" then return end
	run.lastSlotPoll = GetTime()
	local name = FreeSlot()
	if not name then
		run.slotsExhausted = true
		run.nextPollAt, run.helloPollAt = nil, nil
		Wowie.ArmAutoRefresh()
		Wowie.UpdateStatus()
		return
	end
	Wowie_SlotData = nil
	local loaded, reason = C_AddOns.LoadAddOn(name)
	if not loaded then
		run.slotError = reason
		if reason == "MISSING" or reason == "DISABLED" then
			run.slotsMissing = true
			run.nextPollAt, run.helloPollAt = nil, nil
			Wowie.ArmAutoRefresh()
		end
		Wowie.UpdateStatus()
		return
	end
	run.slotsExhausted, run.slotsMissing, run.slotError = nil, nil, nil
	Wowie.ArmAutoRefresh()
	run.polls = (run.polls or 0) + 1
	ScheduleNextPoll()
	local data = Wowie_SlotData
	if type(data) == "table" and type(data.now) == "number" then
		-- The bridge's clock and ours are the same machine; translate to GetTime().
		NotedBridge(GetTime() - (time() - data.now))
	end
	local matched = ApplyBridgeData(data)
	if why == "signal" and not matched then
		run.signalUnreliable = true
	end
	Wowie.Render()
end

local function TransportTick()
	if not db or db.settings.mode ~= "pixel" then return end
	local now, read = GetTime(), false
	local busy = AnyPending() or run.connectingAt ~= nil or tx.probe ~= nil or run.controlsPollAt ~= nil
	if busy or not tx.lastSignalCheck or now - tx.lastSignalCheck >= TICK_SECONDS then
		tx.lastSignalCheck = now
		if PollPresence() and busy then
			TryLoadSlot("notification")
			read = true
		end
		run.signalSeen = run.signalSeen or {}
		if not read then
			for _, c in ipairs(db.chats) do
				local nonce = c.request and c.request.nonce
				if c.pendingId and nonce and run.signalSeen[c.id] ~= nonce and CheckSignal("sig", c.pendingId) then
					-- A numeric sound path can be cached. It gets at most one read per request,
					-- even if that read contains only working status rather than the final reply.
					run.signalSeen[c.id] = nonce
					TryLoadSlot("signal")
					read = true
					break
				end
			end
		end
	end
	local probe = tx.probe
	if probe and probe.pollAt and not probe.polled and now >= probe.pollAt and not read then
		probe.polled = true
		TryLoadSlot("calibration")
	end
	if tx.probe and tx.probe.deadline and now >= tx.probe.deadline then tx.Fail("Display check timed out; using Robust. Save again to retry.") end
	Wowie.CheckConnection()
	tx.MaybeCalibrate()
	if not tx.probe and (not tx.nextFrameAt or now + 0.001 >= tx.nextFrameAt) then
		for _, rec in pairs(run.outbound) do
			if rec.parts and not rec.acked then RefreshStrip(); break end
		end
	end
end

local function Tick()
	if not db then return end
	local now = GetTime()
	if db.settings.mode ~= "pixel" then
		Wowie.UpdateDot()
		Wowie.CheckConnection()
		return
	end
	local changed = false
	if run.helloPollAt and now >= run.helloPollAt then
		run.helloPollAt = nil
		TryLoadSlot("hello")
		if not run.slotsExhausted and not run.slotsMissing and run.connectingAt and not Wowie.IsConnected() and now - run.connectingAt <= CONNECT_WAIT then
			Wowie.SayHello()
		end
		-- Whatever that slot held, the wait is over.
		if run.restoring then
			run.restoring = nil
			Wowie.Render()
		end
	end
	if run.restoring and now - run.restoring > 25 then
		run.restoring = nil
		Wowie.Render()
	end
	-- Only maintain established liveness, and never duplicate a hello/reply probe.
	-- Failed or stale slot reads delay the next probe, but do not refresh bridgeSeen.
	if not PresenceWorks() and not AnyPending() and not run.helloPollAt and run.bridgeSeen
		and now - math.max(run.bridgeSeen, run.lastSlotPoll or run.bridgeSeen) >= IDLE_POLL_SECONDS then
		TryLoadSlot("idle")
	end
	Wowie.UpdateDot()
	Wowie.CheckConnection()
	Wowie.UpdateMini()
	for id, rec in pairs(run.outbound) do
		if rec.acked then
			run.outbound[id] = nil
			changed = true
		elseif rec.hello and now - rec.sentAt >= 20 then
			run.outbound[id] = nil
			changed = true
		elseif now - rec.sentAt >= math.max(STRIP_SECONDS, rec.parts and (#rec.parts + 1) * math.max(1, #db.chats) or 0) then
			rec.tries = (rec.tries or 1) + 1
			if rec.tries <= STRIP_TRIES then
				-- Nobody picked it up: show it again.
				rec.sentAt = now
				changed = true
			elseif rec.control then
				-- Keep the durable control until its exact receipt, even while offline.
				run.outbound[id] = nil
				changed = true
			else
				-- Give up on pixels for this message; the reload path still has it.
				run.outbound[id] = nil
				run.pixelFailed = true
				changed = true
				Wowie.ArmAutoRefresh()
			end
		end
	end
	if changed then
		RefreshStrip()
		Wowie.UpdateStatus()
	end
	if run.controlsPollAt and now >= run.controlsPollAt and not run.slotsExhausted and not run.slotsMissing then
		run.controlsPollAt = now + 15
		if not run.lastSlotPoll or now - run.lastSlotPoll >= 1 then TryLoadSlot("receipt") end
	end
	if not AnyPending() then return end
	local moved = false
	for _, c in ipairs(db.chats) do
		if c.pendingId and PollActivity(c) then moved = true end
	end
	if moved then Wowie.Render() end
	if run.nextPollAt and now >= run.nextPollAt then
		TryLoadSlot("schedule")
	end
end

Finish = function(chat, role, text, denied, agent, macros)
	AddHistory(chat, role, text, chat.pendingId, denied, agent, macros)
	QueueReceipt("reply", chat.id, chat.request.generation, chat.request.nonce)
	if db.outbox and db.outbox.id == chat.pendingId and db.outbox.nonce == chat.request.nonce then db.outbox = nil end
	if db.contextOutbox and db.contextOutbox.id == chat.pendingId and db.contextOutbox.nonce == chat.request.nonce then db.contextOutbox = nil end
	chat.queryReply, chat.snapshotAcked = nil, nil
	chat.pendingId = nil
	chat.request = nil
	chat.progress = nil
	if run.act then run.act[chat.id] = nil end
	local visible = ui.frame and ui.frame:IsShown() and db.activeChat == chat.id
	if not visible then
		chat.unread = (chat.unread or 0) + 1
	end
	if not AnyPending() then
		keyCatcher:Hide()
		Wowie.nextAutoRefresh = nil
	end
	if visible and ui.input and chat.draft and chat.draft ~= "" and ui.input:GetText() ~= chat.draft then
		ui.input:SetText(chat.draft)
	end
	Wowie.Render()
	Wowie.Notify(chat, text, agent)
end

---------------------------------------------------------------------------
-- Game context and links
---------------------------------------------------------------------------

-- The agent only sees text, so two things about the game are spelled out for it:
-- who is asking (the character, where they are; sent with the hello and again
-- when it changes, and put into the agent's system prompt by the bridge), and
-- what the player shift-clicked into the message (item, spell and quest links
-- are meaningless markup to the agent; their tooltips are what the player sees).
-- Every game API here is optional: whatever the client lacks is left out.

local LINK_LINES_MAX = 30 -- tooltip lines kept per link
local LINK_BYTES_MAX = 900 -- bytes kept per link

-- Call a game API that may not exist or may throw, and get its returns or nothing.
local function Try(fn, ...)
	if type(fn) ~= "function" then return nil end
	local ok, a, b, c, d, e, f, g = pcall(fn, ...)
	if ok then return a, b, c, d, e, f, g end
end


-- The character's skill lines as { name, isHeader, rank, maxRank, skillID }.
-- Forever only has C_SkillInfo (one table per line); the classic globals
-- (multiple returns) are the fallback for other clients.
function Wowie.SkillLines()
	local out = {}
	if C_SkillInfo and C_SkillInfo.GetNumSkillLines then
		local n = Try(C_SkillInfo.GetNumSkillLines)
		local seen = {}
		for i = 1, (type(n) == "number" and n or 0) do
			local sk = Try(C_SkillInfo.GetSkillLineInfo, i)
			-- Child lines (parentSkillLineID ~= 0) repeat their parent; Blizzard's
			-- skills frame skips them too.
			if type(sk) == "table" and type(sk.name) == "string" and (sk.parentSkillLineID or 0) == 0 then
				local key = sk.isHeader and ("h:" .. sk.name) or (sk.skillID or sk.name)
				if not seen[key] then
					seen[key] = true
					out[#out + 1] = { name = sk.name, isHeader = sk.isHeader, rank = sk.rank, maxRank = sk.maxRank, skillID = sk.skillID }
				end
			end
		end
		return out
	end
	local n = Try(GetNumSkillLines)
	for i = 1, (type(n) == "number" and n or 0) do
		local sname, isHeader, _, rank, _, _, maxRank = Try(GetSkillLineInfo, i)
		if type(sname) == "string" then
			out[#out + 1] = { name = sname, isHeader = isHeader and true or false, rank = rank, maxRank = maxRank }
		end
	end
	return out
end

function Wowie.GameContext()
	return WowieContext.Summary()
end

function Wowie.SetContextEnabled(enabled)
	local checking = run.connectingAt ~= nil or Wowie.IsConnected()
	db.settings.context = enabled == true
	run.contextSent, run.lastHelloAt = nil, nil
	db.hello = nil -- changing Sharing creates a new hello, not a retry of its old context
	if checking and db.settings.mode == "pixel" then
		run.connectingAt = nil
		Wowie.Connect()
	end
	Wowie.UpdateSharingSummary()
	Wowie.Render()
end

-- The context to put on the next record, or nil when the bridge already has
-- it (or it wouldn't fit next to this message; it goes with a later one).
-- "" when the setting is off, so the bridge drops what it had.
local function ContextToSend(room, summary)
	local ctx = db.settings.context and (summary or Wowie.GameContext()) or ""
	if ctx == (run.contextSent or "") then return nil end
	if room and #ctx > room then return nil end
	return ctx
end

-- Read a link's tooltip off a hidden GameTooltip, one line per row.
local scanTip
local function TooltipLines(payload)
	if not scanTip then
		scanTip = CreateFrame("GameTooltip", "WowieScanTip", UIParent, "GameTooltipTemplate")
	end
	scanTip:SetOwner(UIParent, "ANCHOR_NONE")
	scanTip:ClearLines()
	local lines = {}
	if pcall(scanTip.SetHyperlink, scanTip, payload) then
		for i = 1, math.min(scanTip:NumLines() or 0, LINK_LINES_MAX) do
			local left = _G["WowieScanTipTextLeft" .. i]
			local right = _G["WowieScanTipTextRight" .. i]
			local l = Trim(tostring((left and left:GetText()) or ""))
			local r = Trim(tostring((right and right:IsShown() and right:GetText()) or ""))
			if r ~= "" then l = l .. "  " .. r end
			if l ~= "" then table.insert(lines, l) end
		end
	end
	scanTip:Hide()
	return lines
end

-- What a link is, in words: "item 2140 (Uncommon)", "spell 1978", "quest 176".
local function DescribeLink(payload)
	local kind, id = payload:match("^(%a+):(%d+)")
	if not kind then return payload:match("^(%a+)") or "link" end
	local s = kind .. " " .. id
	if kind == "item" then
		local _, _, quality = Try((C_Item and C_Item.GetItemInfo) or GetItemInfo, payload)
		local desc = type(quality) == "number" and _G["ITEM_QUALITY" .. quality .. "_DESC"]
		if desc then s = s .. " (" .. desc .. ")" end
	end
	return s
end

-- Turn the links in a message into text the agent can use: each becomes [Name]
-- in place, and a block at the end lists what the tooltip says about it.
-- Returns the new text and the number of links found.
function Wowie.ExpandLinks(text)
	local links, seen = {}, {}
	local function Take(payload, name)
		if not seen[payload] then
			seen[payload] = true
			table.insert(links, { payload = payload, name = name })
		end
		return "[" .. name .. "]"
	end
	-- Consume color wrappers with their links, including the client's named colors.
	local out = text:gsub("|cn[%w_]+:|H([^|]+)|h%[([^%]]*)%]|h|r", Take)
	out = out:gsub("|c%x%x%x%x%x%x%x%x|H([^|]+)|h%[([^%]]*)%]|h|r", Take)
	out = out:gsub("|H([^|]+)|h%[([^%]]*)%]|h", Take)
	if #links == 0 then return text, 0 end
	local blocks = {}
	for _, l in ipairs(links) do
		local head = "[" .. l.name .. "] " .. DescribeLink(l.payload)
		local body = table.concat(TooltipLines(l.payload), "\n  ")
		local block = body ~= "" and (head .. "\n  " .. body) or head
		if #block > LINK_BYTES_MAX then block = block:sub(1, LINK_BYTES_MAX) .. "..." end
		table.insert(blocks, block)
	end
	return out .. "\n\n--- Linked from the game ---\n" .. table.concat(blocks, "\n"), #links
end

---------------------------------------------------------------------------
-- Sending
---------------------------------------------------------------------------

-- allow: optional list of permission rules to grant before this message runs.
function Wowie.Send(text, allow)
	local c = ActiveChat()
	if not c then return end
	text = Trim(text or "")
	if c.pendingId then
		-- Typing while waiting: keep the draft, and check for the reply.
		if text ~= "" then c.draft = text end
		if not Wowie.IsConnected() and not run.connectingAt then Wowie.Connect() end
		if db.settings.mode == "pixel" and not (run.slotsExhausted or run.slotsMissing) then
			TryLoadSlot("manual")
		else
			SafeReload()
		end
		return
	end
	if text == "" then return end
	if not Wowie.IsConnected() then
		-- Keep the draft and intent until a fresh nonce round trip succeeds.
		if ui.input then ui.input:SetText(text) end
		run.sendOnConnect = { chat = c.id, text = text, allow = allow }
		if not run.connectingAt then Wowie.Connect() end
		Wowie.Toggle(true)
		return
	end
	if run.requestProtocol ~= 2 then
		AddHistory(c, "system", "The bridge needs updating/restarting before it can receive new questions safely.")
		if ui.input then ui.input:SetText(text) end
		Wowie.Render()
		return
	end
	local profile, summary
	if db.settings.context and run.contextEnabled ~= false then
		if db.settings.mode == "pixel" and run.contextProtocol ~= 2 then
			AddHistory(c, "system", "The bridge needs updating/restarting before it can receive the information selected in Sharing.")
			if ui.input then ui.input:SetText(text) end
			Wowie.Render()
			return
		end
		profile, summary = WowieContext.Snapshot()
	end
	-- Shift-clicked links become [Name] plus their tooltip, which is what the agent can read.
	local links
	text, links = Wowie.ExpandLinks(text)
	local agent = c.agent ~= "" and c.agent or db.settings.defaults.agent
	local chosenModel, reasoning = ChatChoice(c, "model"), ChatChoice(c, "reasoning")
	local model = chosenModel ~= "" and ToHex(chosenModel) or nil
	local id = db.lastSeq + 1
	local nonce = NewNonce()
	local tokens = { "nonce=" .. nonce, "generation=" .. c.generation }
	if c.resetNext then table.insert(tokens, "n") end
	if agent ~= "" then table.insert(tokens, "agent=" .. agent) end
	if model then table.insert(tokens, "model=" .. model) end
	if reasoning ~= "" then table.insert(tokens, "reasoning=" .. reasoning) end
	if profile then table.insert(tokens, "profile=" .. id) end
	local allowHex
	if type(allow) == "table" and #allow > 0 then
		table.insert(tokens, "allow=" .. table.concat(allow, ","))
		allowHex = ToHex(table.concat(allow, US))
	end
	local flags = table.concat(tokens, ";")
	local name = c.name
	if name:match("^Chat %d+$") then
		local first = true
		for _, m in ipairs(c.history) do if m.role == "user" then first = false; break end end
		if first then name = AutoTitle(text) or name end
	end
	local envelope = { chat = c.id, cwd = c.cwd, flags = flags, name = name, text = "" }
	local ctx = ContextToSend(nil, summary)
	local limit = Codec.MAX_PAYLOAD - #RecordFor(id, envelope) - (ctx ~= nil and 3 or 0)
	if #text > limit then
		AddHistory(c, "system", "That message is too long for one send (" .. #text .. " bytes, max " .. math.max(0, limit) .. "). Split it up." .. (links > 0 and " Each linked item adds its tooltip to the message." or ""))
		Wowie.Render()
		return
	end
	-- The optional summary may wait, but a context-off field always fits its reserved header.
	if ctx and #ctx > limit - #text then ctx = nil end
	db.lastSeq = id
	local newSession = c.resetNext and true or nil
	c.resetNext = nil
	db.outbox = {
		id = id,
		nonce = nonce,
		generation = c.generation,
		name = ToHex(name),
		session = db.session,
		chat = c.id,
		text = ToHex(text),
		cwd = ToHex(c.cwd),
		ctx = ctx and ToHex(ctx) or nil,
		profile = profile and ToHex(profile) or nil,
		agent = agent ~= "" and agent or nil,
		model = model,
		reasoning = reasoning ~= "" and reasoning or nil,
		allow = allowHex,
		newSession = newSession,
		t = time(),
	}
	c.pendingId = id
	c.draft = nil
	c.progress = nil
	if run.replyPhase then run.replyPhase[c.id] = nil end
	c.snapshotAcked, c.queryReply = nil, nil
	AddHistory(c, "user", text, id)
	c.name = name
	db.settings.shown = true
	-- Snapshot the run settings: changing a selector only affects future sends,
	-- including when the pending message is resent after a UI reload.
	c.request = { chat = c.id, nonce = nonce, generation = c.generation, cwd = c.cwd, flags = flags, name = c.name, text = text, ctx = ctx, profile = profile, startedAt = time() }

	if db.settings.mode == "pixel" then
		local rec = { chat = c.id, nonce = nonce, generation = c.generation, cwd = c.cwd, flags = flags, name = c.name, text = text, ctx = ctx, profile = profile, sentAt = GetTime() }
		PrepareData(rec, id)
		run.outbound[id] = rec
		run.sentAt = GetTime()
		run.polls = 0
		StartActivity(c, id)
		ScheduleNextPoll()
		RefreshStrip(id)
		Wowie.Render()
	else
		SafeReload()
	end
end

-- A durable deletion owns a particular chat incarnation, never its replacement.
local function ForgetOnBridge(c)
	if not c or not c.id then return end
	for id, rec in pairs(run.outbound) do
		if rec.chat == c.id and rec.generation == c.generation and not rec.forget then run.outbound[id] = nil end
	end
	for nonce, info in pairs(db.receipts) do
		if info.chat == c.id and info.generation == c.generation then db.receipts[nonce] = nil end
	end
	if db.outbox and db.outbox.chat == c.id then db.outbox = nil end
	if db.contextOutbox and db.contextOutbox.chat == c.id then db.contextOutbox = nil end
	if run.sendOnConnect and run.sendOnConnect.chat == c.id then run.sendOnConnect = nil end
	if run.act then run.act[c.id] = nil end
	db.lastSeq = db.lastSeq + 1
	local nonce = NewNonce()
	db.forget[nonce] = { id = db.lastSeq, nonce = nonce, kind = "forget", chat = c.id, generation = c.generation }
	SendControls()
	RefreshStrip()
end

-- A hello is the connection challenge and also synchronizes selected context.
-- A saved, unacknowledged hello may be retried after reload, but cached metadata
-- cannot authenticate it: this UI attempt records a fresh start timestamp.
function Wowie.SayHello()
	if db.settings.mode ~= "pixel" then return end
	local now = GetTime()
	if run.lastHelloAt and now - run.lastHelloAt < 5 then return end
	run.lastHelloAt = now
	if not db.hello then
		db.lastSeq = db.lastSeq + 1
		local c = ActiveChat()
		local nonce = NewNonce()
		db.hello = { id = db.lastSeq, nonce = nonce, chat = c and c.id or "", cwd = c and c.cwd or "",
			flags = "h;nonce=" .. nonce, name = c and c.name or "", text = "",
			ctx = db.settings.context and Wowie.GameContext() or "", hello = true }
	end
	if not run.connectingAt then
		run.connectingAt, run.connectFailed, run.verifiedAt = now, nil, nil
		run.probe = { id = db.hello.id, session = db.session, nonce = db.hello.nonce,
			startedEpoch = time(), startedAt = now }
	end
	local rec = {}
	for k, v in pairs(db.hello) do rec[k] = v end
	rec.sentAt = now
	run.outbound[rec.id] = rec
	run.helloPollAt = now + 5
	-- Outstanding durable controls ride along once the bridge advertises protocol 2.
	SendControls()
	-- Fresh saved data: show "restoring" instead of an empty panel until we hear back.
	if not db.restored then
		local empty = true
		for _, ch in ipairs(db.chats) do
			if #ch.history > 0 then empty = false end
		end
		if empty then run.restoring = now end
	end
	RefreshStrip(rec.id)
	Wowie.Render()
end

-- Put the active chat's pending message back on the strip.
function Wowie.Resend()
	local c = ActiveChat()
	if not c or not c.pendingId then return end
	if not c.request then return end
	if run.requestProtocol ~= 2 then
		AddHistory(c, "system", "Update/restart the bridge before retrying this pending request safely.")
		Wowie.Render()
		return
	end
	local rec = {}
	for k, v in pairs(c.request) do rec[k] = v end
	rec.sentAt = GetTime()
	PrepareData(rec, c.pendingId)
	run.outbound[c.pendingId] = rec
	run.sentAt = GetTime()
	run.polls = 0
	ScheduleNextPoll()
	RefreshStrip(c.pendingId)
	Wowie.UpdateStatus()
end

function Wowie.SendFromInput()
	if not ui.input then return end
	local c = ActiveChat()
	local text = ui.input:GetText()
	local wasPending = c and c.pendingId
	if wasPending then Wowie.Send("") else Wowie.Send(text) end
	if c and c.pendingId and not wasPending then ui.input:SetText("") end
	ui.input:ClearFocus() -- only an explicit send hands the keyboard back to the game
end

-- The Allow button: grant the rules a reply asked for, then tell the agent to carry on.
function Wowie.Allow(chatId, rules)
	local c = FindChat(chatId)
	if not c or c.pendingId or not rules or #rules == 0 then return end
	if db.activeChat ~= c.id then Wowie.SwitchChat(c.id) end
	for _, m in ipairs(c.history) do m.denied = nil end
	AddHistory(c, "system", "Allowed: " .. table.concat(rules, ", "))
	Wowie.Send("Those actions are allowed now. Continue from where you left off.", rules)
end

---------------------------------------------------------------------------
-- Chats
---------------------------------------------------------------------------

function Wowie.SwitchChat(id)
	local c = FindChat(id)
	if not c then return end
	local prev = ActiveChat()
	if prev and prev ~= c and ui.input then
		local typed = ui.input:GetText() or ""
		prev.draft = typed ~= "" and typed or nil
	end
	if ui.selectionMenu then ui.selectionMenu:Hide() end
	if ui.chatMenu then ui.chatMenu:Hide() end
	db.activeChat = c.id
	c.unread = 0
	if ui.input then
		ui.input:SetText(c.draft or "")
	end
	Wowie.Render()
	Wowie.RenderChatList()
end

function Wowie.NewChat(name)
	local c = AddChat(name and name ~= "" and name or nil)
	if not c then
		local a = ActiveChat()
		AddHistory(a, "system", "Chat limit reached (" .. MAX_CHATS .. "). Delete one first with /wowie delete.")
		Wowie.Render()
		return
	end
	if ui.chatSearch then ui.chatSearch:SetText("") end
	Wowie.SwitchChat(c.id)
	Wowie.Toggle(true)
end

-- Folder this chat's agent works in. Empty (or "-" / "default") = the bridge's
-- default. Relative paths are resolved by the bridge against that default.
function Wowie.SetFolder(rest, c)
	c = c or ActiveChat()
	if not c then return end
	rest = Trim(rest or "")
	if rest == "-" or rest == "default" then rest = "" end
	local base = run.bridgeCwd or "the bridge's default folder"
	if rest ~= "" then
		local changed = rest ~= c.cwd
		c.cwd = rest
		local absolute = rest:match("^%a:[\\/]") or rest:match("^[\\/~]")
		local note = absolute and "" or (" (relative to " .. base .. ")")
		AddHistory(c, "system", "cwd set to " .. rest .. note .. (changed and #c.history > 1 and ("; the next message starts a fresh " .. ChatAgentName(c) .. " session there") or ""))
	elseif c.cwd ~= "" then
		c.cwd = ""
		AddHistory(c, "system", "cwd reset to the bridge's default: " .. base)
	else
		AddHistory(c, "system", "cwd is the bridge's default: " .. base .. " (/wowie cd <folder>, or right-click the chat and pick Folder, to change)")
	end
	Wowie.Render()
end

StaticPopupDialogs["WOWIE_FOLDER"] = {
	text = "Folder for this chat\n\nRelative to the bridge's folder (%s), ~, or a full path.\nEmpty = the bridge's default. Changing it starts a fresh agent session.",
	button1 = OKAY,
	button2 = CANCEL,
	hasEditBox = 1,
	editBoxWidth = 320,
	maxLetters = 250,
	timeout = 0,
	whileDead = true,
	hideOnEscape = true,
	OnShow = function(dialog, data)
		local box = dialog.GetEditBox and dialog:GetEditBox() or dialog.editBox
		if box then
			box:SetText(data and data.cwd or "")
			box:HighlightText()
			box:SetFocus()
		end
	end,
	OnAccept = function(dialog, data)
		local box = dialog.GetEditBox and dialog:GetEditBox() or dialog.editBox
		local chat = data and FindChat(data.id)
		if chat and box then Wowie.SetFolder(box:GetText(), chat) end
	end,
	EditBoxOnEnterPressed = function(box)
		local dialog = box:GetParent()
		StaticPopupDialogs["WOWIE_FOLDER"].OnAccept(dialog, dialog.data)
		dialog:Hide()
	end,
	EditBoxOnEscapePressed = function(box)
		box:GetParent():Hide()
	end,
}

-- Folder dialog for a chat (the active one when no id is given).
function Wowie.FolderPrompt(id)
	local c = (id and FindChat(id)) or ActiveChat()
	if not c then return end
	StaticPopup_Show("WOWIE_FOLDER", run.bridgeCwd or "unknown until connected", nil, { id = c.id, cwd = c.cwd })
end

-- Empty (or "-" / "default") uses the saved addon agent, then the bridge's.
-- A different agent starts a fresh session, since sessions belong to their agent.
local function AgentList()
	return run.bridgeAgents and table.concat(run.bridgeAgents, ", ") or "claude, codex, grok, agy, hermes"
end

function Wowie.SetAgent(rest, c)
	c = c or ActiveChat()
	if not c then return end
	rest = Trim(rest or ""):lower()
	if rest == "-" or rest == "default" then rest = "" end
	if rest ~= "" and run.bridgeAgents and not Contains(run.bridgeAgents, rest) then
		AddHistory(c, "system", "Unknown agent \"" .. rest .. "\". The bridge knows: " .. AgentList())
		Wowie.Render()
		return
	end
	local changed = rest ~= (c.agent or "")
	local defaultSource = db.settings.defaults.agent ~= "" and "addon's default: " or "bridge's default: "
	local defaultName = DefaultAgent() ~= "" and AgentName(DefaultAgent()) or "unknown until connected"
	c.agent = rest
	if changed then c.model, c.reasoning = "", "" end
	if rest ~= "" then
		AddHistory(c, "system", "agent set to " .. AgentName(rest) .. (changed and #c.history > 1 and "; the next message starts a fresh session with it" or ""))
	elseif changed then
		AddHistory(c, "system", "agent reset to the " .. defaultSource .. defaultName)
	else
		AddHistory(c, "system", "agent is the " .. defaultSource .. defaultName .. " (/wowie agent <name>, or use the Agent selector, to change; agents: " .. AgentList() .. ")")
	end
	Wowie.Render()
end

-- The direct Agent selector and the chat menu use the same picker.
function Wowie.AgentPrompt(id)
	Wowie.ShowSelection("agent", ui.agentSelector, id)
end

function Wowie.SetModel(value, c)
	c = c or ActiveChat()
	if not c then return end
	value = Trim(value or "")
	if value == "-" or value == "default" then value = "" end
	if value == "" and c.model ~= "" then c.resetNext = true end
	c.model = value
	Wowie.Render()
end

function Wowie.SetReasoning(value, c)
	c = c or ActiveChat()
	if not c then return end
	value = Trim(value or ""):lower()
	if value == "-" or value == "default" then value = "" end
	if value ~= "" and not Contains(ChatOptions(c).reasoningLevels, value) then return end
	if value == "" and c.reasoning ~= "" then c.resetNext = true end
	c.reasoning = value
	Wowie.Render()
end

function Wowie.SaveDefaults()
	local draft = ui.defaultsDraft
	if not draft then return end
	local nextDefaults = { agent = draft.agent, model = draft.model, reasoning = draft.reasoning }
	if nextDefaults.agent == "" then nextDefaults.model, nextDefaults.reasoning = "", "" end
	for _, c in ipairs(db.chats) do
		local agent = ChatAgent(c)
		local model, reasoning = ChatChoice(c, "model"), ChatChoice(c, "reasoning")
		-- Preserve provider-specific per-chat overrides if the default agent changes.
		if c.agent == "" and agent ~= "" and agent ~= DefaultAgent(nextDefaults)
			and (c.model ~= "" or c.reasoning ~= "") then c.agent = agent end
		-- A resumed CLI must not retain an override that was just cleared.
		if agent == ChatAgent(c, nextDefaults)
			and ((model ~= "" and ChatChoice(c, "model", nextDefaults) == "")
			or (reasoning ~= "" and ChatChoice(c, "reasoning", nextDefaults) == "")) then c.resetNext = true end
	end
	db.settings.defaults = nextDefaults
	db.settings.replyFontSize = draft.replyFontSize or db.settings.replyFontSize
	ui.defaultsPanel:Hide()
	tx.SetPreference(draft.pixelDisplay)
	Wowie.Render()
end

StaticPopupDialogs["WOWIE_MODEL"] = {
	text = "Model selection\n\nEnter a model ID or alias accepted by the selected agent.\nEmpty inherits the default. Applies to future messages.",
	button1 = OKAY,
	button2 = CANCEL,
	hasEditBox = 1,
	editBoxWidth = 280,
	maxLetters = 120,
	timeout = 0,
	whileDead = true,
	hideOnEscape = true,
	OnShow = function(dialog, data)
		local box = dialog.GetEditBox and dialog:GetEditBox() or dialog.editBox
		if box then
			box:SetText(data and data.model or "")
			box:HighlightText()
			box:SetFocus()
		end
	end,
	OnAccept = function(dialog, data)
		local box = dialog.GetEditBox and dialog:GetEditBox() or dialog.editBox
		if data and data.defaults then
			if ui.defaultsDraft and box then Wowie.SetDefaultChoice("model", box:GetText()) end
		else
			local chat = data and FindChat(data.id)
			if chat and box then Wowie.SetModel(box:GetText(), chat) end
		end
	end,
	EditBoxOnEnterPressed = function(box)
		local dialog = box:GetParent()
		StaticPopupDialogs["WOWIE_MODEL"].OnAccept(dialog, dialog.data)
		dialog:Hide()
	end,
	EditBoxOnEscapePressed = function(box) box:GetParent():Hide() end,
}

function Wowie.ModelPrompt(id, defaults)
	local c = defaults and ui.defaultsDraft or ((id and FindChat(id)) or ActiveChat())
	if c then StaticPopup_Show("WOWIE_MODEL", nil, nil, { id = c.id, model = c.model, defaults = defaults }) end
end

StaticPopupDialogs["WOWIE_RENAME"] = {
	text = "Rename this chat",
	button1 = OKAY,
	button2 = CANCEL,
	hasEditBox = 1,
	maxLetters = 24,
	timeout = 0,
	whileDead = true,
	hideOnEscape = true,
	OnShow = function(dialog, data)
		local box = dialog.GetEditBox and dialog:GetEditBox() or dialog.editBox
		if box then
			box:SetText(data and data.name or "")
			box:HighlightText()
			box:SetFocus()
		end
	end,
	OnAccept = function(dialog, data)
		local box = dialog.GetEditBox and dialog:GetEditBox() or dialog.editBox
		local chat = data and FindChat(data.id)
		local name = box and Trim(box:GetText() or "") or ""
		if chat and name ~= "" then
			chat.name = name:sub(1, 24)
			Wowie.Render()
		end
	end,
	EditBoxOnEnterPressed = function(box)
		local dialog = box:GetParent()
		StaticPopupDialogs["WOWIE_RENAME"].OnAccept(dialog, dialog.data)
		dialog:Hide()
	end,
	EditBoxOnEscapePressed = function(box)
		box:GetParent():Hide()
	end,
}

-- Rename dialog for a chat (the active one when no id is given).
function Wowie.RenamePrompt(id)
	local c = (id and FindChat(id)) or ActiveChat()
	if not c then return end
	StaticPopup_Show("WOWIE_RENAME", nil, nil, { id = c.id, name = c.name })
end
Wowie.RenameActive = Wowie.RenamePrompt

-- Delete a chat (the active one when no id is given). The last chat is cleared
-- and renamed instead of removed, so there is always one to type into. Either
-- way the bridge is told to forget it, so a restore won't bring it back.
function Wowie.DeleteChat(id)
	local c, idx = nil, nil
	if id then c, idx = FindChat(id) end
	if not c then c, idx = ActiveChat() end
	if not c then return end
	ForgetOnBridge(c)
	if #db.chats == 1 then
		wipe(c.history)
		c.pendingId, c.progress, c.unread, c.draft = nil, nil, 0, nil
		c.request, c.queryReply, c.snapshotAcked = nil, nil, nil
		c.generation, c.resetNext = NewNonce(), true
		c.name = "Chat 1"
		if ui.input then ui.input:SetText("") end
		Wowie.Render()
		Wowie.RenderChatList()
		Wowie.ArmAutoRefresh()
		if db.settings.mode ~= "pixel" then SafeReload() end
		return
	end
	table.remove(db.chats, idx)
	if db.activeChat == c.id then
		Wowie.SwitchChat(db.chats[math.min(idx, #db.chats)].id)
	else
		Wowie.RenderChatList()
	end
	Wowie.ArmAutoRefresh()
	if db.settings.mode ~= "pixel" then SafeReload() end
end

-- The conversation menu asks before deleting; /wowie delete does not.
StaticPopupDialogs["WOWIE_DELETE"] = {
	text = "Delete chat \"%s\"?\n\nIts transcript goes away (the last chat is cleared instead of removed).",
	button1 = OKAY,
	button2 = CANCEL,
	timeout = 0,
	whileDead = true,
	hideOnEscape = true,
	OnAccept = function(dialog, data)
		if data then Wowie.DeleteChat(data.id) end
	end,
}

function Wowie.ConfirmDelete(id)
	local c = (id and FindChat(id)) or ActiveChat()
	if not c then return end
	StaticPopup_Show("WOWIE_DELETE", Display(c.name), nil, { id = c.id })
end

---------------------------------------------------------------------------
-- Macros
---------------------------------------------------------------------------

-- The agent can hand over ready-made macros (a ```wowmacro block the bridge turns
-- into `macros` on the reply). Each gets a button under its message that creates
-- the macro, or updates the one with that name, and puts it on the cursor to drop
-- on an action bar. The addon never runs a macro; the player's own click does.

local MACRO_ACCOUNT_MAX = (Constants and Constants.MacroConsts and Constants.MacroConsts.MAX_ACCOUNT_MACROS) or 120
local MACRO_CHAR_MAX = (Constants and Constants.MacroConsts and Constants.MacroConsts.MAX_CHARACTER_MACROS) or 30
local MACRO_DEFAULT_ICON = 134400 -- question mark: with #showtooltip the game shows the spell's icon

local function MacroSay(msg)
	print("|cff66ccff[Wowie]|r " .. msg)
end

-- Only well-formed entries survive (the slot file is trusted, but not blindly).
function Wowie.CleanMacros(list)
	if type(list) ~= "table" then return nil end
	local out = {}
	for _, m in ipairs(list) do
		if type(m) == "table" and type(m.name) == "string" and m.name ~= "" and type(m.body) == "string" and m.body ~= "" then
			out[#out + 1] = {
				name = m.name, body = m.body, char = m.char == true, risky = m.risky == true,
				icon = (type(m.icon) == "number" or type(m.icon) == "string") and m.icon or nil,
			}
		end
	end
	return #out > 0 and out or nil
end

-- The macro called `name` among account (1..120) or character (121..150) macros:
-- the same name may exist in both, and only the requested kind counts.
local function FindMacro(name, perCharacter)
	local first = perCharacter and MACRO_ACCOUNT_MAX + 1 or 1
	local last = perCharacter and MACRO_ACCOUNT_MAX + MACRO_CHAR_MAX or MACRO_ACCOUNT_MAX
	for i = first, last do
		local n, icon, body = Try(GetMacroInfo, i)
		if n == name then return i, icon, body end
	end
end

local function MacroIcon(icon)
	if type(icon) == "number" then return icon end
	if type(icon) == "string" then
		local id = Try(GetFileIDFromPath, "Interface\\Icons\\" .. icon)
		if type(id) == "number" and id > 0 then return id end
		return icon -- CreateMacro also takes a texture name
	end
	return MACRO_DEFAULT_ICON
end

function Wowie.MacroLabel(m)
	local verb = FindMacro(m.name, m.char) and "Update" or "Create"
	return verb .. " macro: " .. Display(m.name) .. (m.char and " (character)" or "") .. (m.risky and "  |cffff6060(runs code)|r" or "")
end

StaticPopupDialogs["WOWIE_MACRO"] = {
	text = "%s",
	button1 = OKAY,
	button2 = CANCEL,
	timeout = 0,
	whileDead = true,
	hideOnEscape = true,
	OnAccept = function(dialog, data)
		if data then Wowie.InstallMacro(data, true) end
	end,
}

-- Create or update macro `m` ({ name, body, icon, char, risky }). Asks first when it
-- would replace a different macro of yours, or when it runs code (/run, /click...).
function Wowie.InstallMacro(m, confirmed)
	if type(m) ~= "table" then return end
	if InCombatLockdown() then
		MacroSay("macros can't be changed in combat; click the button again afterwards.")
		return
	end
	local index, _, oldBody = FindMacro(m.name, m.char)
	if not confirmed then
		local why = {}
		if m.risky then table.insert(why, "This macro runs code or clicks buttons (/run, /script, /click). Only keep it if you trust what it does.") end
		if index and oldBody ~= m.body then table.insert(why, "It replaces your existing macro \"" .. m.name .. "\" (/wowie macro undo brings the old one back).") end
		if #why > 0 then
			StaticPopup_Show("WOWIE_MACRO", table.concat(why, "\n\n") .. "\n\n" .. Display(m.body), nil, m)
			return
		end
	end
	-- Blizzard's macro window saves its edit box into its selected macro when it
	-- hides; close it first so that can't land on a macro we just moved.
	if MacroFrame and MacroFrame:IsShown() then
		Try(HideUIPanel, MacroFrame)
		index, _, oldBody = FindMacro(m.name, m.char)
	end
	local ok, newIndex
	if index then
		local _, oldIcon = FindMacro(m.name, m.char)
		ok, newIndex = pcall(EditMacro, index, m.name, m.icon ~= nil and MacroIcon(m.icon) or nil, m.body)
		if ok and type(newIndex) == "number" then
			db.macroUndo = { name = m.name, char = m.char, icon = oldIcon, body = oldBody }
		end
	else
		local acc, chr = Try(GetNumMacros)
		if m.char and type(chr) == "number" and chr >= MACRO_CHAR_MAX then
			MacroSay("your character macros are full (" .. MACRO_CHAR_MAX .. "); delete one in /macro first.")
			return
		elseif not m.char and type(acc) == "number" and acc >= MACRO_ACCOUNT_MAX then
			MacroSay("your account macros are full (" .. MACRO_ACCOUNT_MAX .. "); delete one in /macro first.")
			return
		end
		ok, newIndex = pcall(CreateMacro, m.name, MacroIcon(m.icon), m.body, m.char)
		if (not ok or type(newIndex) ~= "number") and m.icon ~= nil then
			ok, newIndex = pcall(CreateMacro, m.name, MACRO_DEFAULT_ICON, m.body, m.char)
		end
		if ok and type(newIndex) == "number" then
			db.macroUndo = { name = m.name, char = m.char, created = true }
		end
	end
	if not ok or type(newIndex) ~= "number" then
		MacroSay("could not save macro \"" .. m.name .. "\": " .. (ok and "the game refused it (is the list full?)" or tostring(newIndex)))
		return
	end
	-- EditMacro may move the macro (names are sorted): pick up the index it returned.
	Try(PickupMacro, newIndex)
	MacroSay("macro \"" .. m.name .. "\" " .. (index and "updated" or "created") .. " and on your cursor: click an action bar slot to place it (it is also in /macro).")
	Wowie.Render()
end

function Wowie.UndoMacro()
	local u = db.macroUndo
	if not u then MacroSay("nothing to undo."); return end
	if InCombatLockdown() then MacroSay("macros can't be changed in combat."); return end
	local index = FindMacro(u.name, u.char)
	if not index then MacroSay("macro \"" .. u.name .. "\" is gone already."); db.macroUndo = nil; return end
	if MacroFrame and MacroFrame:IsShown() then Try(HideUIPanel, MacroFrame); index = FindMacro(u.name, u.char) end
	if u.created then
		Try(DeleteMacro, index)
		MacroSay("removed macro \"" .. u.name .. "\".")
	else
		Try(EditMacro, index, u.name, u.icon, u.body)
		MacroSay("macro \"" .. u.name .. "\" is back to what it was.")
	end
	db.macroUndo = nil
	Wowie.Render()
end

---------------------------------------------------------------------------
-- Rendering
---------------------------------------------------------------------------

function Wowie.UpdateStatus()
	if not ui.status then return end
	local c = ActiveChat()
	local mode = db.settings.mode
	local s
	if c and c.pendingId then
		local id = c.pendingId
		local elapsed = run.sentAt and (GetTime() - run.sentAt) or 0
		local rec = run.outbound[id]
		if mode == "pixel" then
			if run.slotsMissing then
				s = "Reply slots missing · Connection ... has reload recovery"
			elseif run.slotsExhausted then
				s = "Reply slots exhausted · reload to free them"
			elseif run.pixelFailed then
				s = "Delivery not acknowledged · retry or reload in Connection ..."
			elseif (run.replyPhase and (run.replyPhase[c.id] == "context" or run.replyPhase[c.id] == "context_query")) then
				s = "Reading shared context · " .. ChatAgentName(c) .. " is waiting for selected information"
			elseif c.progress or (run.act and run.act[c.id] and run.act[c.id].count > 0) then
				s = ChatAgentName(c) .. " is working on #" .. id .. " - " .. ActivityLine(c)
			elseif rec and not rec.acked then
				s = "Sending #" .. id .. (rec.tries and rec.tries > 1 and (" (try " .. rec.tries .. "/" .. STRIP_TRIES .. ")") or "") .. "..."
				local state = Wowie.BridgeState()
				if state == "down" then s = s .. " - bridge not seen lately, is the bridge running?" end
			else
				s = "Waiting for #" .. id .. " (checked " .. (run.polls or 0) .. "x)"
				if elapsed > 45 then
					s = s .. " - no sign of the bridge. Is the bridge running? /wowie resend"
				end
			end
		else
			s = "Waiting for reply #" .. id .. " · Check reply or reload to check now"
			if db.settings.autoRefresh then
				s = s .. "; auto on next keypress after " .. db.settings.interval .. "s"
			end
		end
	elseif not Wowie.IsConnected() then
		if run.connectingAt and run.sendOnConnect then
			s = "Checking bridge... your message goes out after verification"
		elseif run.connectingAt then
			s = "Checking bridge..."
		elseif run.connectFailed then
			s = "Bridge not responding · Reconnect checks again; your draft is saved"
		else
			s = "Idle / not verified · Send checks automatically, or use Reconnect"
		end
	elseif c and c.draft and c.draft ~= "" then
		s = "Draft saved · Enter to send"
	elseif run.restoring then
		s = "Checking bridge..."
	else
		s = "Ready"
	end
	local short = s
	if not (c and c.pendingId) then
		short = run.connectingAt and "Checking bridge..." or (run.connectFailed and "Bridge unavailable" or (c and c.draft and c.draft ~= "" and "Draft saved" or "Ready to send"))
	elseif s:find("Reading shared context", 1, true) then short = "Reading selected information..."
	elseif c.progress then short = ChatAgentName(c) .. " is working..."
	elseif run.slotsMissing or run.slotsExhausted then short = "Reply slots need attention"
	elseif run.pixelFailed then short = "Delivery needs attention" end
	ui.status:SetText(short)
	run.statusText = s
	Wowie.UpdateDot()
	Wowie.UpdateConnect()
	if ui.title then ui.title:SetText(c and Display(c.name) or "Conversation") end
	local folder = ChatFolder(c)
	local folderName = FolderName(folder)
	ui.cwd:SetText(folderName ~= "" and ("Workspace: " .. Display(folderName)) or "Ask about your character or work with your agent")
	if ui.cwdArea then ui.cwdArea.path = folder end
	Wowie.UpdateSelectors()
	Wowie.UpdateMini()
end

-- Only the activity strip animates; reply text and selections stay untouched.
local function AnimateActivity(self, elapsed)
	self.tick = self.tick + elapsed
	if self.tick < 0.2 then return end
	self.tick = self.tick % 0.2
	self.step = self.step % 3 + 1
	for i, dot in ipairs(self.dots) do dot:SetAlpha(i == self.step and 1 or 0.25) end
	local seconds = math.max(0, time() - self.startedAt)
	if self.seconds ~= seconds then
		self.seconds = seconds
		self.label:SetText(self.phaseText .. " · " .. seconds .. "s")
	end
end

-- Message bodies are selectable in place; readonly guards never change history.
local function GetBubble(i)
	local b = ui.bubbles[i]
	if b then return b end
	b = CreateFrame("Frame", nil, ui.content)
	b.bg = b:CreateTexture(nil, "BACKGROUND")
	b.bg:SetAllPoints()
	b.rule = UI.Rule(b, "border", 0.5)
	b.rule:SetPoint("BOTTOMLEFT", b, "BOTTOMLEFT", 16, 0)
	b.rule:SetPoint("BOTTOMRIGHT", b, "BOTTOMRIGHT", -16, 0)
	b.who = UI.Label(b, "", 12)
	b.who:SetPoint("TOPLEFT", b, "TOPLEFT", 16, -14)
	b.who:SetPoint("RIGHT", b, "RIGHT", -140, 0)
	b.who:SetWordWrap(false)
	b.copy = UI.Button(b, "Copy", 56, function() Wowie.ShowCopy(b.text or "") end, "quiet", "WowieMessageCopy" .. i)
	b.copy:SetHeight(24)
	b.copy:SetPoint("TOPRIGHT", b, "TOPRIGHT", -10, -8)
	UI.Tooltip(b.copy, "Copy full reply", "Opens the original text, including sources and details. You can also select any visible paragraph directly.")
	b.when = UI.Label(b, "", 10, "muted")
	b.when:SetPoint("RIGHT", b.copy, "LEFT", -10, 0)
	b.body = Wowie.ReplyView.Create(b, "WowieMessageText" .. i)
	b.body:SetPoint("TOPLEFT", b, "TOPLEFT", 16, -42)
	b.layoutOptions = { onResize = function() Wowie.Render() end }
	b.activity = CreateFrame("Frame", "WowieMessageActivity" .. i, b)
	b.activity:SetPoint("TOPLEFT", b, "TOPLEFT", 16, -42)
	b.activity:SetPoint("TOPRIGHT", b, "TOPRIGHT", -16, -42)
	b.activity:SetHeight(24)
	b.activity.dots = {}
	for k = 1, 3 do
		local dot = b.activity:CreateTexture(nil, "ARTWORK")
		dot:SetColorTexture(unpack(UI.colors.accent))
		dot:SetSize(5, 5)
		dot:SetPoint("LEFT", b.activity, "LEFT", (k - 1) * 9, 0)
		b.activity.dots[k] = dot
	end
	b.activity.label = UI.Label(b.activity, "", 14, "accent")
	b.activity.label:SetPoint("LEFT", b.activity, "LEFT", 32, 0)
	b.activity.label:SetPoint("RIGHT", b.activity, "RIGHT")
	b.activity.label:SetWordWrap(false)
	b.activity:Hide()
	b.allow = UI.Button(b, "Approve tools & retry", 180, function(self) Wowie.Allow(self.chatId, self.rules) end, "primary")
	b.allow:SetPoint("TOPLEFT", b.body, "BOTTOMLEFT", 0, -12)
	b.allow:SetScript("OnEnter", function(self)
		GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
		GameTooltip:SetText("Approve these host tools and retry")
		GameTooltip:AddLine(Display(table.concat(self.rules or {}, "\n")), 0.92, 0.94, 0.97, true)
		GameTooltip:AddLine("Adds these rules to the agent configuration.", 0.97, 0.72, 0.38, true)
		GameTooltip:Show()
	end)
	b.allow:SetScript("OnLeave", function() GameTooltip:Hide() end)
	b.allow:Hide()
	b.macroBtns = {}
	b:SetScript("OnHide", function()
		b.body:ClearSelection()
		b.activity:SetScript("OnUpdate", nil)
	end)
	b:SetScript("OnShow", function()
		if b.activity:IsShown() then b.activity:SetScript("OnUpdate", AnimateActivity) end
	end)
	ui.bubbles[i] = b
	return b
end

function Wowie.Render()
	local c = ActiveChat()
	if ui.content and c then
		local oldChat = ui.renderedChat
		local oldScroll, oldRange = ui.scroll:GetVerticalScroll(), ui.scroll:GetVerticalScrollRange()
		local wasLatest = oldRange - oldScroll <= 32
		if oldChat and oldChat ~= c.id then ui.chatScrollPositions[oldChat] = not wasLatest and oldScroll or nil end
		local targetScroll
		if oldChat == c.id then
			if not wasLatest then targetScroll = oldScroll end
		else targetScroll = ui.chatScrollPositions[c.id] end
		ui.renderedChat = c.id
		local width = ui.scroll:GetWidth()
		if not width or width < 80 then width = 400 end
		ui.content:SetWidth(width)
		local y, n = 0, 0
		local function Place(role, text, when, dim, denied, agent, macros, record, phaseText)
			text = tostring(text or "")
			n = n + 1
			local b = GetBubble(n)
			local st = ROLE_STYLE[role] or ROLE_STYLE.system
			b:SetWidth(width)
			b.bg:SetColorTexture(st.bg[1], st.bg[2], st.bg[3], st.bg[4])
			b.who:SetText(st == ROLE_STYLE.assistant and ReplyAgentName(c, agent) or st.label)
			b.who:SetTextColor(st.color[1], st.color[2], st.color[3])
			b.when:SetText(when or "")
			if b.record ~= record or b.chatId ~= c.id then
				b.body:ClearSelection()
				b.record, b.chatId = record, c.id
			end
			local activity = b.activity
			if dim then
				if activity.request ~= record or not activity.startedAt then
					activity.request, activity.startedAt = record, record and record.startedAt or time()
					activity.tick, activity.step, activity.seconds = 0.2, 0, nil
				end
				local label = Display(phaseText)
				if activity.phaseText ~= label then
					activity.phaseText, activity.seconds, activity.tick = label, nil, 0.2
				end
				AnimateActivity(activity, 0)
			else
				activity.request, activity.startedAt = nil, nil
			end
			activity:SetShown(dim)
			activity:SetScript("OnUpdate", dim and AnimateActivity or nil)
			local activityHeight = dim and 30 or 0
			b.body:ClearAllPoints()
			b.body:SetPoint("TOPLEFT", b, "TOPLEFT", 16, -42 - activityHeight)
			local options = b.layoutOptions
			options.formatted, options.muted = role == "assistant" and not dim, dim
			options.identity, options.fontSize = record, db.settings.replyFontSize or 14
			local h = Wowie.ReplyView.Layout(b.body, text, math.max(80, width - 32), options)
			b.body:SetShown(not dim or text ~= "")
			if dim and text == "" then h = 0 end
			b.copy:SetShown(not dim)
			local extra = 0
			if denied then
				b.allow:SetWidth(math.min(width - 32, 180))
				b.allow.chatId = c.id
				b.allow.rules = denied
				b.allow:Show()
				extra = 44
			else
				b.allow:Hide()
			end
			-- One button per macro the agent handed over.
			local shownMacros = 0
			for k, m in ipairs(macros or {}) do
				local mb = b.macroBtns[k]
				if not mb then
					mb = UI.Button(b, "", 180, function(self) Wowie.InstallMacro(self.macro) end, "secondary")
					mb:SetScript("OnEnter", function(self)
						GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
						GameTooltip:AddLine(Display(self.macro.name))
						GameTooltip:AddLine(Display(self.macro.body), 1, 1, 1, true)
						GameTooltip:Show()
					end)
					mb:SetScript("OnLeave", function() GameTooltip:Hide() end)
					b.macroBtns[k] = mb
				end
				mb.macro = m
				mb:SetText(Wowie.MacroLabel(m))
				mb:SetWidth(math.min(width - 32, math.max(160, mb:GetFontString():GetStringWidth() + 30)))
				mb:ClearAllPoints()
				mb:SetPoint("TOPLEFT", b.body, "BOTTOMLEFT", 0, -12 - extra)
				mb:Show()
				extra = extra + 44
				shownMacros = k
			end
			for k = shownMacros + 1, #b.macroBtns do b.macroBtns[k]:Hide() end
			b:SetHeight(42 + activityHeight + h + 16 + extra)
			b:ClearAllPoints()
			b:SetPoint("TOPLEFT", ui.content, "TOPLEFT", 0, -y)
			b.text = text
			b:Show()
			y = y + b:GetHeight() + 16
		end
		local last = #c.history
		for i, m in ipairs(c.history) do
			-- The Allow button only makes sense on the newest reply, and only while idle.
			local denied = (i == last and not c.pendingId and type(m.denied) == "table" and #m.denied > 0) and m.denied or nil
			Place(m.role, m.text, m.t and date("%H:%M", m.t) or "", false, denied, m.agent, m.macros, m)
		end
		local empty = #c.history == 0 and not c.pendingId
		ui.empty:SetShown(empty)
		ui.empty:SetWidth(math.max(200, width - 28))
		if empty then y = 216 end
		if empty and oldChat ~= c.id and targetScroll == nil then targetScroll = 0 end
		if c.pendingId then
			local p = c.progress
			local rec = run.outbound[c.pendingId]
			local phase = run.replyPhase and run.replyPhase[c.id]
			local head = (phase == "context" or phase == "context_query") and "Reading shared context"
				or (phase == "queued" and ("Queued for " .. ChatAgentName(c)))
				or (rec and not rec.acked and "Sending message" or (ChatAgentName(c) .. " is working"))
			Place("assistant", p or "", "", true, nil, ChatAgent(c), nil, c.request, head)
		end
		for i = n + 1, #ui.bubbles do
			ui.bubbles[i]:Hide()
		end
		ui.content:SetHeight(math.max(y, 1))
		ui.scroll:UpdateScrollChildRect()
		local range = ui.scroll:GetVerticalScrollRange()
		ui.scroll:SetVerticalScroll(targetScroll and math.min(targetScroll, range) or range)
		ui.latest:SetShown(range - ui.scroll:GetVerticalScroll() > 32)
	end
	Wowie.UpdateStatus()
	Wowie.RenderChatList()
end

-- Copy box (/wowie copy): a selectable EditBox with the last reply pre-highlighted for Ctrl+C.
function Wowie.ShowCopy(text)
	if not ui.copy then
		local cf = CreateFrame("Frame", "WowieCopy", UIParent, "BackdropTemplate")
		UI.FitPanel(cf, 600, 380)
		cf:SetPoint("CENTER")
		cf:SetFrameStrata("FULLSCREEN_DIALOG")
		cf:SetMovable(true)
		cf:SetClampedToScreen(true)
		cf:EnableMouse(true)
		local drag = CreateFrame("Frame", nil, cf)
		drag:SetPoint("TOPLEFT", cf, "TOPLEFT")
		drag:SetPoint("TOPRIGHT", cf, "TOPRIGHT", -80, 0)
		drag:SetHeight(44)
		drag:EnableMouse(true)
		drag:RegisterForDrag("LeftButton")
		drag:SetScript("OnDragStart", function() cf:StartMoving() end)
		drag:SetScript("OnDragStop", function() cf:StopMovingOrSizing() end)
		UI.Window(cf, 44)
		tinsert(UISpecialFrames, "WowieCopy")

		local t = UI.Title(cf, "Copy message · Ctrl+C, then Esc", 14)
		t:SetPoint("TOPLEFT", cf, "TOPLEFT", 16, -16)

		local x = UI.Button(cf, "Close", 66, function() cf:Hide() end, "quiet", "WowieCopyClose")
		x:SetPoint("TOPRIGHT", cf, "TOPRIGHT", -8, -8)

		local sc = UI.ScrollFrame(cf, "WowieCopyScroll")
		sc:SetPoint("TOPLEFT", cf, "TOPLEFT", 16, -52)
		sc:SetPoint("BOTTOMRIGHT", cf, "BOTTOMRIGHT", -32, 14)
		local eb = CreateFrame("EditBox", "WowieCopyBox", sc)
		eb:SetMultiLine(true)
		eb:SetAutoFocus(false)
		eb:SetFont(UI.font, 14, "")
		eb:SetMaxLetters(0)
		eb:SetSize(500, 260)
		eb:SetScript("OnEscapePressed", function() cf:Hide() end)
		sc:SetScrollChild(eb)
		sc:HookScript("OnSizeChanged", function(self, w) eb:SetWidth(w) end)
		cf:SetScript("OnHide", function() eb:ClearFocus() end)
		ui.copy, ui.copyBox = cf, eb
	end
	ui.copyBox:SetText(text)
	ui.copy:Show()
	UI.RaisePanel(ui.copy)
	ui.copyBox:SetFocus()
	ui.copyBox:HighlightText()
end

function Wowie.RenderChatList()
	if not ui.chatButtons then return end
	local query = ui.chatSearch:GetText():lower()
	local n = 0
	local rowStep = CHAT_ROW_HEIGHT + CHAT_ROW_GAP
	for _, c in ipairs(db.chats) do
		local searchable = (c.name .. " " .. ChatFolder(c) .. " " .. ChatAgentName(c)):lower()
		if query == "" or searchable:find(query, 1, true) then
			n = n + 1
			local btn = ui.chatButtons[n]
			local detail = Display(FolderName(ChatFolder(c)))
			if detail == "" then detail = ChatAgentName(c) else detail = detail .. " · " .. ChatAgentName(c) end
			if c.pendingId then detail = "Working · " .. detail
			elseif (c.unread or 0) > 0 then detail = c.unread .. " new · " .. detail end
			btn.label:SetText(Display(c.name))
			btn.detail:SetText(detail)
			btn.detail:SetTextColor(unpack(UI.colors[c.pendingId and "warning" or ((c.unread or 0) > 0 and "success" or "muted")]))
			btn.chatId = c.id
			btn.selected:SetShown(c.id == db.activeChat)
			btn.selectedLine:SetShown(c.id == db.activeChat)
			btn.label:SetTextColor(unpack(UI.colors[c.id == db.activeChat and "accent" or "text"]))
			btn:ClearAllPoints()
			btn:SetPoint("TOPLEFT", ui.chatContent, "TOPLEFT", 0, -(n - 1) * rowStep)
			btn:Show()
		end
	end
	for i = n + 1, #ui.chatButtons do ui.chatButtons[i]:Hide(); ui.chatButtons[i].chatId = nil end
	ui.chatContent:SetHeight(math.max(n * rowStep - CHAT_ROW_GAP, 36))
	ui.chatScroll:UpdateScrollChildRect()
	ui.chatEmpty:SetShown(n == 0)
	ui.chatCount:SetText(#db.chats .. "/" .. MAX_CHATS)
	ui.newChat:SetEnabled(#db.chats < MAX_CHATS)
end

function Wowie.UpdateMini()
	if not ui.miniBadge then return end
	local unread, working = 0, 0
	for _, c in ipairs(db.chats) do
		unread = unread + (c.unread or 0)
		if c.pendingId then working = working + 1 end
	end
	local t
	if working > 0 and unread > 0 then
		t = "|cff55ff55" .. unread .. " new|r |cffffd100" .. working .. " working|r"
	elseif working > 0 then
		t = "|cffffd100" .. (working == 1 and "working..." or (working .. " working...")) .. "|r"
	elseif unread > 0 then
		t = "|cff55ff55" .. unread .. (unread == 1 and " new reply" or " new replies") .. "|r"
	else
		t = db.settings.mode == "reload" and "Reload transport · ready" or ConnectionLabel()
	end
	ui.miniBadge:SetText(t)
end

local ECHO_DEFAULT = 4000 -- characters of a reply to print into the game chat ("/wowie echo <n>")

local function ChatLinks(chat)
	return "  |Hwowie:reply:" .. chat.id .. "|h|cff55ff55[reply]|r|h |Hwowie:open:" .. chat.id .. "|h|cff7ec8ff[open]|r|h"
end

-- Print a reply into the game chat: prefix on the first line, then the text line
-- by line up to the limit, then clickable links. `short` prints one preview line.
local function EchoToChat(chat, text, agent)
	local mode = db.settings.echo
	if mode == "off" then return end
	local prefix = "|cff7ec8ff[" .. ReplyAgentName(chat, agent) .. " · " .. Display(chat.name) .. "]|r "
	local body = Display(text)
	if mode == "short" then
		local flat = (body:gsub("%s+", " "))
		if #flat > 200 then flat = flat:sub(1, 200) .. " ..." end
		print(prefix .. flat .. ChatLinks(chat))
		return
	end
	local limit = tonumber(mode) or ECHO_DEFAULT
	local first, shown = true, 0
	for line in (body .. "\n"):gmatch("(.-)\n") do
		if line:match("%S") then
			if shown + #line > limit then
				print("    |cff888888... " .. (#body - shown) .. " more characters, click [open] to read it all|r")
				break
			end
			print((first and prefix or "    ") .. line)
			first = false
			shown = shown + #line
		end
	end
	print("    " .. ChatLinks(chat):sub(3))
end

-- A reply landed. Always play the sound and echo it to the game chat; if that
-- chat isn't on screen, also flash the screen text and light up the mini bar.
function Wowie.Notify(chat, text, agent)
	pcall(PlaySound, 3081)
	Wowie.UpdateMini()
	-- Until a real whisper arrives, /r replies to this chat.
	run.lastMessenger = "agent"
	run.lastReplyChat = chat.id
	EchoToChat(chat, text, agent)
	if ui.frame and ui.frame:IsShown() and db.activeChat == chat.id then return end
	if UIErrorsFrame then
		UIErrorsFrame:AddMessage(ReplyAgentName(chat, agent) .. " replied in " .. Display(chat.name), 0.5, 0.8, 1, 1)
	end
end

-- /r goes to the agent when it was the last one to message you, exactly like
-- whisper reply, and the box shows a "To Codex [chat]:" header while you type.
--
-- The chat type underneath is left alone (a custom type would leak into chat
-- settings); instead the box remembers an agent target, the header is repainted
-- over the game's own, and the send entry points are intercepted. Any other chat
-- type, Tab, Esc or a cleared box drops the target again.
local AGENT_R, AGENT_G, AGENT_B = 0.49, 0.78, 1.0

local function PaintAgentHeader(eb, chat)
	local header = _G[eb:GetName() .. "Header"]
	local suffix = _G[eb:GetName() .. "HeaderSuffix"]
	if not header then return end
	eb.agentPainting = true
	eb:UpdateHeader() -- lay out normally first, then repaint
	eb.agentPainting = nil
	header:SetWidth(0)
	header:SetText("To " .. ChatAgentName(chat) .. " [" .. Display(chat.name) .. "]: ")
	header:SetTextColor(AGENT_R, AGENT_G, AGENT_B)
	if suffix then suffix:Hide() end
	eb:SetTextInsets(15 + header:GetWidth(), 13, 0, 0)
	eb:SetTextColor(AGENT_R, AGENT_G, AGENT_B)
end

local function SendBoxToAgent(eb)
	local chat = FindChat(eb.agentTarget)
	local text = Trim(eb:GetText() or "")
	eb.agentTarget = nil
	eb:ClearChat()
	if chat and db.activeChat ~= chat.id then Wowie.SwitchChat(chat.id) end
	if text ~= "" then
		Wowie.Send(text)
	else
		Wowie.Toggle(true)
		if ui.input then ui.input:SetFocus() end
	end
end

local function HookReplyCommand()
	for i = 1, (NUM_CHAT_WINDOWS or 10) do
		local eb = _G["ChatFrame" .. i .. "EditBox"]
		if eb and eb.ProcessChatType and not eb.agentReplyHooked then
			eb.agentReplyHooked = true

			local origProcess = eb.ProcessChatType
			eb.ProcessChatType = function(self, msg, index, send, ...)
				if index ~= "REPLY" then
					self.agentTarget = nil
					return origProcess(self, msg, index, send, ...)
				end
				if not (db and run.lastMessenger == "agent") then
					return origProcess(self, msg, index, send, ...)
				end
				local chat = FindChat(run.lastReplyChat) or ActiveChat()
				if send == 1 then
					self:SetText(msg or "")
					self.agentTarget = chat and chat.id
					SendBoxToAgent(self)
					return true
				end
				self.agentTarget = chat and chat.id
				self:SetText(msg or "")
				if chat then PaintAgentHeader(self, chat) end
				return true
			end

			-- Enter arrives here; nothing below us ever sees an agent-targeted box.
			for _, name in ipairs({ "SendMessage", "SendText" }) do
				local orig = eb[name]
				if orig then
					eb[name] = function(self, ...)
						if self.agentTarget then
							SendBoxToAgent(self)
							return
						end
						return orig(self, ...)
					end
				end
			end

			-- Anything that repaints the header normally (Tab, /s, sticky reset) ends agent mode.
			hooksecurefunc(eb, "UpdateHeader", function(self)
				if not self.agentPainting then self.agentTarget = nil end
			end)
			hooksecurefunc(eb, "ClearChat", function(self)
				self.agentTarget = nil
			end)
		end
	end
end

-- Clicks on our [reply] / [open] links in the chat frame.
hooksecurefunc("SetItemRef", function(link)
	local action, chatId = tostring(link):match("^wowie:(%a+):(%w+)")
	if not action or not db then return end
	if FindChat(chatId) then Wowie.SwitchChat(chatId) end
	Wowie.Toggle(true)
	if action == "reply" and ui.input then ui.input:SetFocus() end
end)

-- Shift-clicking an item, spell, quest or name puts its link into the chat box
-- being typed in. Blizzard's insert function only knows its own boxes, so when
-- ours has the keyboard, take the link too. With no box focused the shift-click
-- keeps its normal meaning (splitting a stack, for one).
--
-- On this client (modern UI code, Blizzard_ChatFrameUtil) every shift-click
-- ends in ChatFrameUtil.InsertLink; ChatEdit_InsertLink is the older global
-- name, hooked only where the new one is missing so one click inserts once.
local function TakeLink(text)
	if text and text ~= "" and ui.input and ui.input:HasFocus() then
		ui.input:Insert(text)
	end
end
if type(ChatFrameUtil) == "table" and type(ChatFrameUtil.InsertLink) == "function" then
	hooksecurefunc(ChatFrameUtil, "InsertLink", TakeLink)
elseif type(ChatEdit_InsertLink) == "function" then
	hooksecurefunc("ChatEdit_InsertLink", TakeLink)
end

---------------------------------------------------------------------------
-- UI
---------------------------------------------------------------------------

local PANEL_W = 212

local function EditField(parent, name, placeholder)
	local bg = CreateFrame("Frame", nil, parent, "BackdropTemplate")
	bg:SetHeight(30)
	local field = CreateFrame("EditBox", name, bg)
	UI.Input(bg, field)
	field:SetAutoFocus(false)
	field:SetFont(UI.font, 13, "")
	field:SetPoint("TOPLEFT", bg, "TOPLEFT", 9, -6)
	field:SetPoint("BOTTOMRIGHT", bg, "BOTTOMRIGHT", -9, 6)
	field:SetScript("OnEscapePressed", function(self) self:ClearFocus() end)
	local hint = UI.Label(bg, placeholder, 12, "muted")
	hint:SetPoint("LEFT", field, "LEFT")
	hint:SetPoint("RIGHT", field, "RIGHT")
	hint:SetWordWrap(false)
	field:HookScript("OnTextChanged", function(self) hint:SetShown(self:GetText() == "") end)
	bg:SetScript("OnMouseDown", function() field:SetFocus() end)
	return bg, field
end

local function MakeSelectorRow(parent, name, defaults, compact)
	local row = CreateFrame("Frame", name, parent)
	row:SetHeight(compact and 28 or 49)
	row.buttons, row.compact = {}, compact
	for i, spec in ipairs({
		{ "agent", "Agent", "Changing agent clears this chat's model and reasoning choices." },
		{ "model", "Model", "Default inherits addon settings, then the bridge / CLI. Custom model IDs are supported." },
		{ "reasoning", "Reasoning", "Available levels come from the selected agent. Unsupported agents have no reasoning switch." },
	}) do
		local key = spec[1]
		local b = UI.Button(row, "", 120, function(self) Wowie.ShowSelection(key, self, nil, defaults) end, "secondary", name .. spec[2])
		b.fieldLabel = spec[2]
		b:SetHeight(compact and 28 or 30)
		b:SetPoint("TOPLEFT", row, "TOPLEFT", 0, compact and 0 or -18)
		b.label:SetJustifyH("LEFT")
		b.label:ClearAllPoints()
		b.label:SetPoint("LEFT", b, "LEFT", 8, 0)
		b.label:SetPoint("RIGHT", b, "RIGHT", -20, 0)
		if not compact then
			local title = UI.Label(row, spec[2], 11, "muted")
			title:SetPoint("BOTTOMLEFT", b, "TOPLEFT", 1, 4)
		end
		local arrow = UI.Label(b, "v", 10, "muted")
		arrow:SetPoint("RIGHT", b, "RIGHT", -7, 0)
		b:SetScript("OnEnter", function(self)
			GameTooltip:SetOwner(self, "ANCHOR_TOP")
			GameTooltip:SetText(spec[2] .. ": " .. (self.valueText or "Default"))
			GameTooltip:AddLine(spec[3], 0.75, 0.81, 0.89, true)
			GameTooltip:Show()
		end)
		b:SetScript("OnLeave", function() GameTooltip:Hide() end)
		row.buttons[i], row.buttons[key] = b, b
	end
	local function Layout(_, width)
		local available = math.max(240, width - 12)
		local agentWidth, modelWidth = available * 0.27, available * 0.45
		row.buttons.agent:SetWidth(agentWidth)
		row.buttons.model:SetWidth(modelWidth)
		row.buttons.reasoning:SetWidth(available - agentWidth - modelWidth)
		row.buttons.model:ClearAllPoints()
		row.buttons.model:SetPoint("LEFT", row.buttons.agent, "RIGHT", 6, 0)
		row.buttons.reasoning:ClearAllPoints()
		row.buttons.reasoning:SetPoint("LEFT", row.buttons.model, "RIGHT", 6, 0)
	end
	row:HookScript("OnSizeChanged", Layout)
	Layout(row, row:GetWidth())
	return row
end

-- Inherited values are display hints; requests still leave CLI defaults unresolved.
local function SelectorDefault(c, key, options, defaults)
	local value = not defaults and InheritedChoice(c, key) or ""
	return value ~= "" and value or (options[key] or "")
end

local function MakeSelectors(parent)
	local row = MakeSelectorRow(parent, "WowieSelectors", false, true)
	ui.selectorRow = row
	for _, key in ipairs({ "agent", "model", "reasoning" }) do ui[key .. "Selector"] = row.buttons[key] end
	local menu = UI.Window(CreateFrame("Frame", "WowieSelectionMenu", parent, "BackdropTemplate"), 36)
	menu:SetFrameStrata("FULLSCREEN_DIALOG")
	menu:SetClampedToScreen(true)
	menu:EnableMouse(true)
	tinsert(UISpecialFrames, "WowieSelectionMenu")
	menu.title = UI.Title(menu, "Choose", 14)
	menu.title:SetPoint("TOPLEFT", menu, "TOPLEFT", 12, -12)
	local close = UI.Button(menu, "X", 28, function() menu:Hide() end, "quiet", "WowieSelectionClose")
	close:SetPoint("TOPRIGHT", menu, "TOPRIGHT", -6, -5)
	local searchBg, search = EditField(menu, "WowieSelectionSearch", "Search choices...")
	searchBg:SetPoint("TOPLEFT", menu, "TOPLEFT", 10, -42)
	searchBg:SetPoint("TOPRIGHT", menu, "TOPRIGHT", -10, -42)
	local scroll = UI.ScrollFrame(menu, "WowieSelectionScroll")
	scroll:SetPoint("TOPLEFT", searchBg, "BOTTOMLEFT", 0, -8)
	scroll:SetPoint("BOTTOMRIGHT", menu, "BOTTOMRIGHT", -30, 12)
	local content = CreateFrame("Frame", nil, scroll)
	scroll:SetScrollChild(content)
	menu.items = {}
	menu.empty = UI.Label(content, "No matching choices", 12, "muted")
	menu.empty:SetPoint("TOPLEFT", content, "TOPLEFT", 8, -8)
	local function RenderChoices()
		local query = search:GetText():lower()
		local n = 0
		for _, choice in ipairs(menu.choices or {}) do
			if choice.action or query == "" or choice.label:lower():find(query, 1, true) then
				n = n + 1
				local b = menu.items[n]
				if not b then
					b = UI.Button(content, "", 280, nil, "quiet")
					b.label:SetJustifyH("LEFT")
					menu.items[n] = b
				end
				b:ClearAllPoints()
				b:SetPoint("TOPLEFT", content, "TOPLEFT", 0, -(n - 1) * 32)
				b:SetWidth(menu:GetWidth() - 42)
				b.value = choice.value
				b:SetText(Display(choice.label))
				UI.SetSelected(b, not choice.action and choice.value == menu.selected)
				b:SetScript("OnClick", function()
					menu:Hide()
					if choice.action then choice.action()
					elseif menu.defaults then Wowie.SetDefaultChoice(menu.key, choice.value)
					else
						local c = FindChat(menu.chatId)
						if not c then return end
						if menu.key == "agent" then Wowie.SetAgent(choice.value, c)
						elseif menu.key == "model" then Wowie.SetModel(choice.value, c)
						else Wowie.SetReasoning(choice.value, c) end
					end
				end)
				b:Show()
			end
		end
		for i = n + 1, #menu.items do menu.items[i]:Hide() end
		menu.empty:SetShown(n == 0)
		content:SetSize(menu:GetWidth() - 42, math.max(32, n * 32))
		scroll:SetVerticalScroll(0)
	end
	search:HookScript("OnTextChanged", RenderChoices)
	search:SetScript("OnEscapePressed", function() menu:Hide(); search:ClearFocus() end)
	search:SetScript("OnEnterPressed", function()
		if menu.items[1] and menu.items[1]:IsShown() then menu.items[1]:GetScript("OnClick")(menu.items[1]) end
	end)
	menu:SetScript("OnHide", function() search:ClearFocus() end)
	menu:Hide()
	ui.selectionMenu = menu

	function Wowie.ShowSelection(key, anchor, id, defaults)
		local c
		if defaults then c = ui.defaultsDraft else c = (id and FindChat(id)) or ActiveChat() end
		if not c or (defaults and key ~= "agent" and c.agent == "") then return end
		anchor = anchor or (defaults and ui.defaultsRow.buttons[key] or ui[key .. "Selector"])
		local targetId = defaults and "defaults" or c.id
		if menu:IsShown() and menu.owner == anchor and menu.key == key and menu.chatId == targetId then menu:Hide(); return end
		if ui.chatMenu then ui.chatMenu:Hide() end
		local agent = defaults and (c.agent ~= "" and c.agent or run.bridgeAgent) or ChatAgent(c)
		local o, choices = (run.agentOptions or NO_OPTIONS)[agent or ""] or NO_OPTIONS, {}
		local function Choice(value, label, action) table.insert(choices, { value = value, label = label, action = action }) end
		if key == "agent" then
			Choice("", (defaults and "Bridge default (" or "Inherit default (") .. AgentName(defaults and (run.bridgeAgent or "") or DefaultAgent()) .. ")")
			for _, value in ipairs(run.bridgeAgents or { "claude", "codex", "grok", "agy", "hermes" }) do Choice(value, AgentName(value)) end
		elseif key == "model" then
			local inherited = SelectorDefault(c, key, o, defaults)
			Choice("", inherited ~= "" and ("Inherit default (" .. inherited .. ")") or "Inherit bridge / CLI default")
			local models = {}
			if c.model ~= "" then table.insert(models, c.model) end
			if inherited ~= "" and not Contains(models, inherited) then table.insert(models, inherited) end
			for _, value in ipairs(o.models or {}) do if not Contains(models, value) then table.insert(models, value) end end
			for _, value in ipairs(models) do Choice(value, value) end
			Choice(nil, "Custom model ID...", function() Wowie.ModelPrompt(c.id, defaults) end)
		elseif key == "reasoning" then
			if not o.reasoningLevels or #o.reasoningLevels == 0 then return end
			local inherited = SelectorDefault(c, key, o, defaults)
			Choice("", inherited ~= "" and ("Inherit default (" .. inherited .. ")") or "Inherit bridge / CLI default")
			for _, value in ipairs(o.reasoningLevels) do Choice(value, AgentName(value)) end
		else return end
		menu.owner, menu.key, menu.chatId, menu.defaults = anchor, key, targetId, defaults
		menu.selected, menu.choices = c[key] or "", choices
		menu.title:SetText("Choose " .. key .. (defaults and " default" or " for this chat"))
		menu:SetSize(math.min(420, math.max(320, anchor:GetWidth())), 304)
		menu:ClearAllPoints()
		menu:SetPoint("BOTTOMRIGHT", anchor, "TOPRIGHT", 0, 6)
		search:SetText("")
		RenderChoices()
		menu:Show()
		UI.RaisePanel(menu)
	end
	return row
end

local function UpdateSelectorRow(row, c, defaults)
	local inheritedAgent = defaults and (run.bridgeAgent or "") or DefaultAgent()
	local agent = c.agent ~= "" and c.agent or inheritedAgent
	local o = (run.agentOptions or NO_OPTIONS)[agent] or NO_OPTIONS
	local function Set(button, value, compactValue)
		button.valueText = value
		button:SetText(Display(row.compact and (button.fieldLabel .. ": " .. compactValue) or value))
	end
	Set(row.buttons.agent, c.agent ~= "" and AgentName(c.agent) or ((defaults and "Bridge (" or "Default (") .. AgentName(inheritedAgent) .. ")"), AgentName(agent))
	local model = SelectorDefault(c, "model", o, defaults)
	local chooseAgent = defaults and c.agent == ""
	row.buttons.model:SetEnabled(not chooseAgent)
	Set(row.buttons.model, chooseAgent and "Choose agent" or (c.model ~= "" and c.model or (model ~= "" and ("Default (" .. model .. ")") or "Default")), c.model ~= "" and c.model or (model ~= "" and model or "Automatic"))
	local supported = o.reasoningLevels and #o.reasoningLevels > 0
	row.buttons.reasoning:SetEnabled(supported and not chooseAgent and true or false)
	local reasoning = SelectorDefault(c, "reasoning", o, defaults)
	Set(row.buttons.reasoning, chooseAgent and "Choose agent" or (supported and (c.reasoning ~= "" and AgentName(c.reasoning) or (reasoning ~= "" and ("Default (" .. reasoning .. ")") or "Default")) or (run.agentOptions and "Not supported" or "Connect first")), supported and AgentName(c.reasoning ~= "" and c.reasoning or (reasoning ~= "" and reasoning or "Automatic")) or "Unavailable")
end

function Wowie.UpdateSelectors()
	local c = ActiveChat()
	if c and ui.selectorRow then UpdateSelectorRow(ui.selectorRow, c) end
	if ui.defaultsDraft and ui.defaultsRow then UpdateSelectorRow(ui.defaultsRow, ui.defaultsDraft, true) end
end

function Wowie.ShowReplyPreview()
	if not ui.replyPreview then
		local preview = UI.Window(CreateFrame("Frame", "WowieReplyPreview", UIParent, "BackdropTemplate"), 48)
		UI.FitPanel(preview, 660, 560)
		preview:SetPoint("CENTER", UIParent, "CENTER")
		preview:SetClampedToScreen(true)
		preview:EnableMouse(true)
		local title = UI.Title(preview, "Reply preview", 18)
		title:SetPoint("TOPLEFT", preview, "TOPLEFT", 20, -16)
		local close = UI.Button(preview, "Back to Settings", 150, function() preview:Hide() end, "secondary", "WowieReplyPreviewClose")
		close:SetPoint("TOPRIGHT", preview, "TOPRIGHT", -12, -8)
		local note = UI.Label(preview, "Formatting example only. Nothing is sent to an AI or saved in your chats.", 12, "muted")
		note:SetPoint("TOPLEFT", preview, "TOPLEFT", 20, -62)
		note:SetWidth(620)
		local scroll = UI.ScrollFrame(preview, "WowieReplyPreviewScroll")
		scroll:SetPoint("TOPLEFT", preview, "TOPLEFT", 20, -94)
		scroll:SetPoint("BOTTOMRIGHT", preview, "BOTTOMRIGHT", -36, 20)
		local body = Wowie.ReplyView.Create(scroll, "WowieReplyPreviewText")
		scroll:SetScrollChild(body)
		preview.body, preview.scroll = body, scroll
		preview.sample = "## A clearer answer\n**Start here:** Lead with the recommendation, then explain only what matters. See [the example guide](https://example.com/guide).\n\n### Compare your options\n- **Pros:** Short, labeled points make the important differences easy to find.\n- **Cons:** A long explanation inside one bullet is still hard to scan, even when it wraps neatly beneath the text instead of the marker.\n- **Best for:** Reading an answer while you play.\n\n### Your next steps\n1. Review the information you want to share.\n2. Ask a question in the conversation.\n\n> Drag-select text to copy it. The message Copy button keeps the complete original.\n\n### A code example\n```lua\nlocal greeting = \"Hello, adventurer\"\nprint(greeting)\n```\n\n[bridge] Example technical detail, kept separate from the answer."
		preview.options = { formatted = true, identity = preview, onResize = function() Wowie.ShowReplyPreview() end }
		preview:SetScript("OnHide", function()
			body:ClearSelection()
			if ui.previewReturn and ui.defaultsDraft and ui.frame and ui.frame:IsShown() then
				ui.previewReturn = nil
				ui.defaultsPanel:Show()
				UI.RaisePanel(ui.defaultsPanel)
			end
		end)
		tinsert(UISpecialFrames, "WowieReplyPreview")
		ui.replyPreview = preview
	end
	local preview = ui.replyPreview
	if ui.defaultsPanel and ui.defaultsPanel:IsShown() then
		ui.previewReturn, ui.previewTransition = true, true
		ui.defaultsPanel:Hide()
		ui.previewTransition = nil
	end
	preview.options.fontSize = ui.defaultsDraft and ui.defaultsDraft.replyFontSize or db.settings.replyFontSize
	UI.FitPanel(preview, 660, 560)
	Wowie.ReplyView.Layout(preview.body, preview.sample, 604, preview.options)
	preview:Show()
	UI.RaisePanel(preview)
	preview.scroll:UpdateScrollChildRect()
end

local function MakeDefaultsPanel(parent)
	local panel = UI.Window(CreateFrame("Frame", "WowieDefaults", parent, "BackdropTemplate"), 48)
	UI.FitPanel(panel, 620, 540)
	panel:SetPoint("CENTER", UIParent, "CENTER")
	panel:SetToplevel(true)
	panel:SetClampedToScreen(true)
	panel:EnableMouse(true)
	panel:SetMovable(true)
	local drag = CreateFrame("Frame", nil, panel)
	drag:SetPoint("TOPLEFT", panel, "TOPLEFT")
	drag:SetPoint("TOPRIGHT", panel, "TOPRIGHT")
	drag:SetHeight(46)
	drag:EnableMouse(true)
	drag:RegisterForDrag("LeftButton")
	drag:SetScript("OnDragStart", function() panel:StartMoving() end)
	drag:SetScript("OnDragStop", function() panel:StopMovingOrSizing() end)
	tinsert(UISpecialFrames, "WowieDefaults")
	local title = UI.Title(panel, "Settings", 18)
	title:SetPoint("TOPLEFT", panel, "TOPLEFT", 20, -16)
	local description = UI.Label(panel, "Assistant defaults", 14)
	description:SetPoint("TOPLEFT", panel, "TOPLEFT", 20, -68)
	local row = MakeSelectorRow(panel, "WowieDefaultSelectors", true)
	row:SetPoint("TOPLEFT", panel, "TOPLEFT", 20, -96)
	row:SetPoint("TOPRIGHT", panel, "TOPRIGHT", -20, -96)
	local note = UI.Label(panel, "Used by chats set to Default. Choose an agent before its model or reasoning.\nCurrent requests and bridge configuration stay unchanged.", 12, "muted")
	note:SetPoint("TOPLEFT", panel, "TOPLEFT", 20, -158)
	note:SetWidth(580)
	note:SetHeight(34)
	local transportTitle = UI.Label(panel, "Pixel display", 14)
	transportTitle:SetPoint("TOPLEFT", panel, "TOPLEFT", 20, -210)
	ui.pixelButtons = {}
	for i, display in ipairs({ "robust", "compact", "quiet" }) do
		local button = UI.Button(panel, Codec.DISPLAYS[display].label, 188, function()
			if ui.defaultsDraft then ui.defaultsDraft.pixelDisplay = display; tx.UpdateSettings() end
		end, "secondary", "WowiePixelDisplay" .. Codec.DISPLAYS[display].label)
		button:SetPoint("TOPLEFT", panel, "TOPLEFT", 20 + (i - 1) * 196, -238)
		ui.pixelButtons[display] = button
	end
	local transportNote = UI.Label(panel, "Robust favors reliability. Compact is smaller. Quiet uses dark colors.\nSave checks the display before enabling a different mode.", 12, "muted")
	transportNote:SetPoint("TOPLEFT", panel, "TOPLEFT", 20, -282)
	transportNote:SetWidth(580)
	transportNote:SetHeight(34)
	ui.pixelStatus = UI.Label(panel, "", 11, "muted")
	ui.pixelStatus:SetPoint("TOPLEFT", panel, "TOPLEFT", 20, -324)
	ui.pixelStatus:SetWidth(580)
	ui.pixelStatus:SetHeight(38)
	local appearance = UI.Label(panel, "Reading", 14)
	appearance:SetPoint("TOPLEFT", panel, "TOPLEFT", 20, -386)
	local sizes = {}
	local function UpdateReading()
		for value, button in pairs(sizes) do UI.SetSelected(button, ui.defaultsDraft and ui.defaultsDraft.replyFontSize == value) end
	end
	for i, spec in ipairs({ {13, "Small"}, {14, "Medium"}, {16, "Large"} }) do
		local value = spec[1]
		local button = UI.Button(panel, spec[2], 102, function()
			if ui.defaultsDraft then ui.defaultsDraft.replyFontSize = value; UpdateReading() end
		end, "secondary", "WowieReadingSize" .. value)
		button:SetPoint("TOPLEFT", panel, "TOPLEFT", 20 + (i - 1) * 110, -414)
		sizes[value] = button
	end
	local preview = UI.Button(panel, "Preview formatting", 168, Wowie.ShowReplyPreview, "secondary", "WowiePreviewFormatting")
	preview:SetPoint("TOPRIGHT", panel, "TOPRIGHT", -20, -414)
	local reset = UI.Button(panel, "Use bridge defaults", 156, function()
		ui.defaultsDraft = { agent = "", model = "", reasoning = "", pixelDisplay = ui.defaultsDraft.pixelDisplay, replyFontSize = ui.defaultsDraft.replyFontSize }
		if ui.selectionMenu then ui.selectionMenu:Hide() end
		Wowie.UpdateSelectors()
	end, "secondary", "WowieDefaultsReset")
	reset:SetPoint("BOTTOMLEFT", panel, "BOTTOMLEFT", 18, 16)
	local save = UI.Button(panel, "Save", 80, Wowie.SaveDefaults, "primary", "WowieDefaultsSave")
	save:SetPoint("BOTTOMRIGHT", panel, "BOTTOMRIGHT", -18, 16)
	local cancel = UI.Button(panel, "Cancel", 80, function() panel:Hide() end, "secondary", "WowieDefaultsCancel")
	cancel:SetPoint("RIGHT", save, "LEFT", -8, 0)
	panel:Hide()
	panel:SetScript("OnHide", function()
		if ui.previewTransition then return end
		ui.previewReturn = nil
		if ui.selectionMenu and ui.selectionMenu.defaults then ui.selectionMenu:Hide() end
		if ui.replyPreview then ui.replyPreview:Hide() end
		ui.defaultsDraft = nil
	end)
	ui.defaultsPanel, ui.defaultsRow = panel, row

	function Wowie.ShowDefaults()
		ui.previewReturn = nil
		if ui.replyPreview then ui.replyPreview:Hide() end
		local d = db.settings.defaults
		ui.defaultsDraft = { agent = d.agent, model = d.model, reasoning = d.reasoning, pixelDisplay = db.settings.pixelDisplay, replyFontSize = db.settings.replyFontSize }
		if ui.selectionMenu then ui.selectionMenu:Hide() end
		Wowie.Toggle(true)
		panel:Show()
		UI.FitPanel(panel, 620, 540)
		UI.RaisePanel(panel)
		UpdateReading()
		Wowie.UpdateSelectors()
		tx.UpdateSettings()
	end

	function Wowie.SetDefaultChoice(key, value)
		local d = ui.defaultsDraft
		if not d then return end
		value = Trim(value or "")
		if value == "-" or value == "default" then value = "" end
		if key == "agent" then
			d.agent, d.model, d.reasoning = value, "", ""
		elseif d.agent ~= "" and key == "model" then
			d.model = value
		elseif d.agent ~= "" and key == "reasoning" then
			local o = ChatOptions(d)
			if value ~= "" and not Contains(o.reasoningLevels, value) then return end
			d.reasoning = value
		end
		Wowie.UpdateSelectors()
	end
end


function Wowie.UpdateSharingSummary()
	if not ui.sharingSummary then return end
	local summary = WowieContextUI and WowieContextUI.Summary and WowieContextUI.Summary()
	if summary then
		local selected = WowieContext.GetPreset()
		local preset = selected == "recommended" and "Recommended" or (selected == "minimal" and "Minimal" or "Custom")
		local delivery = WowieContext.GetDelivery() == "smart" and "Smart" or "Full snapshot"
		ui.sharingSummary:SetText((summary.enabled and ("Sharing: " .. preset) or "Sharing paused") .. "\n" .. delivery .. " · " .. summary.selected .. " sources")
		ui.sharingSummary:SetTextColor(unpack(UI.colors[summary.enabled and "muted" or "warning"]))
	else ui.sharingSummary:SetText("Choose what the AI may read") end
end

StaticPopupDialogs["WOWIE_CLEAR"] = {
	text = "Clear the visible transcript for \"%s\"? This does not reset the agent session.",
	button1 = "Clear", button2 = CANCEL, timeout = 0, whileDead = true, hideOnEscape = true,
	OnAccept = function(_, data)
		local c = FindChat(data.id)
		if c then wipe(c.history); Wowie.Render() end
	end,
}

function Wowie.LayoutWorkspace()
	if not ui.contentEdge then return end
	local collapsed = db.settings.sidebarCollapsed == true
	ui.sidebar:SetShown(not collapsed)
	ui.contentEdge:ClearAllPoints()
	ui.contentEdge:SetPoint("TOPLEFT", ui.frame, "TOPLEFT", collapsed and 0 or PANEL_W + 12, -60)
	ui.contentEdge:SetPoint("BOTTOMLEFT", ui.frame, "BOTTOMLEFT", collapsed and 0 or PANEL_W + 12, 12)
	UI.SetSelected(ui.sidebarToggle, not collapsed)
end

local function BuildUI()
	if ui.frame then return end
	local s = db.settings
	local screenW, screenH = math.max(1, UIParent:GetWidth() - 24), math.max(1, UIParent:GetHeight() - 24)
	local scale = math.min(1, screenW / 720, screenH / 500)
	local minW, minH = 720, 500
	local maxW, maxH = screenW / scale, screenH / scale
	s.width, s.height = math.min(maxW, math.max(minW, s.width)), math.min(maxH, math.max(minH, s.height))
	local f = UI.Window(CreateFrame("Frame", "WowieFrame", UIParent, "BackdropTemplate"), 52)
	ui.frame = f
	f:SetScale(scale)
	f:SetSize(s.width, s.height)
	if s.point then f:SetPoint(s.point, UIParent, s.relPoint or s.point, s.x or 0, s.y or 0) else f:SetPoint("CENTER") end
	f:SetFrameStrata("DIALOG")
	f:SetMovable(true)
	f:SetResizable(true)
	f:SetClampedToScreen(true)
	f:SetResizeBounds(minW, minH, maxW, maxH)
	f:EnableMouse(true)
	local drag = CreateFrame("Frame", "WowieDragHeader", f)
	drag:SetPoint("TOPLEFT", f, "TOPLEFT", 0, 0)
	-- The right edge is anchored to Navigation once the header actions exist.
	drag:SetHeight(50)
	drag:EnableMouse(true)
	drag:RegisterForDrag("LeftButton")
	drag:SetScript("OnDragStart", function() f:StartMoving() end)
	drag:SetScript("OnDragStop", function()
		f:StopMovingOrSizing()
		local point, _, relPoint, x, y = f:GetPoint()
		s.point, s.relPoint, s.x, s.y = point, relPoint, x, y
	end)
	f:Hide()
	tinsert(UISpecialFrames, "WowieFrame")

	local identity = UI.Title(f, "Wowie", 19)
	identity:SetPoint("TOPLEFT", f, "TOPLEFT", 18, -16)
	identity:SetTextColor(unpack(UI.colors.accent))
	local chatsToggle = UI.Button(f, "Chats", 58, function()
		s.sidebarCollapsed = not s.sidebarCollapsed
		Wowie.LayoutWorkspace()
		Wowie.Render()
	end, "quiet", "WowieToggleSidebar")
	chatsToggle:SetPoint("TOPLEFT", f, "TOPLEFT", 96, -10)
	ui.sidebarToggle = chatsToggle
	UI.Tooltip(chatsToggle, "Show or hide conversations", "Hide the sidebar to give the current conversation more room.")
	local function MakeDot(parent)
		local holder = CreateFrame("Frame", nil, parent)
		holder:SetSize(14, 14)
		local dot = holder:CreateTexture(nil, "OVERLAY")
		dot:SetAllPoints()
		holder:EnableMouse(true)
		holder:SetScript("OnEnter", function(self)
			GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
			GameTooltip:SetText(dot.tip or "Bridge connection")
			GameTooltip:Show()
		end)
		holder:SetScript("OnLeave", function() GameTooltip:Hide() end)
		return holder, dot
	end
	local dotHolder, dot = MakeDot(f)
	dotHolder:SetPoint("LEFT", chatsToggle, "RIGHT", 14, 0)
	ui.dot = dot
	ui.connection = UI.Label(f, "Idle / not verified", 12, "muted")
	ui.connection:SetPoint("LEFT", dotHolder, "RIGHT", 5, 0)
	ui.connection:SetWordWrap(false)
	local minimize = UI.Button(f, "—", 30, function() Wowie.Minimize(true) end, "quiet", "WowieMinimize")
	minimize:SetPoint("TOPRIGHT", f, "TOPRIGHT", -10, -10)
	UI.Tooltip(minimize, "Minimize · Esc", "Keep waiting in the compact bar without taking keyboard focus.")
	local settings = UI.Button(f, "Settings", 70, function() Wowie.ShowDefaults() end, "quiet", "WowieSettings")
	settings:SetPoint("RIGHT", minimize, "LEFT", -8, 0)
	local sharing = UI.Button(f, "Sharing", 70, function()
		if WowieContextUI then WowieContextUI.Show() end
	end, "quiet", "WowieSharing")
	sharing:SetPoint("RIGHT", settings, "LEFT", -6, 0)
	local navigation = UI.Button(f, "Navigation", 110, function()
		local map = WowieMap
		if map and type(map.ShowNavigation) == "function" and type(map.GetNavigationState) == "function" then
			map.ShowNavigation()
		end
	end, "quiet", "WowieNavigation")
	navigation:SetPoint("RIGHT", sharing, "LEFT", -6, 0)
	navigation:SetMotionScriptsWhileDisabled(true)
	ui.navigation = navigation
	navigation:SetScript("OnEnter", function(self)
		GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
		GameTooltip:SetText(self.navigationTitle or "Navigation")
		GameTooltip:AddLine(self.navigationBody or "", 0.75, 0.81, 0.89, true)
		GameTooltip:Show()
	end)
	navigation:SetScript("OnLeave", function() GameTooltip:Hide() end)
	drag:SetPoint("TOPRIGHT", navigation, "TOPLEFT", -6, 10)
	ui.connection:SetPoint("RIGHT", navigation, "LEFT", -8, 0)
	Wowie.UpdateNavigation()

	f:SetScript("OnHide", function()
		ui.previewReturn = nil
		if ui.replyPreview then ui.replyPreview:Hide() end
		ui.defaultsDraft = nil
		if ui.input then ui.input:ClearFocus() end
		if ui.selectionMenu then ui.selectionMenu:Hide() end
		if ui.chatMenu then ui.chatMenu:Hide() end
		if ui.recoveryMenu then ui.recoveryMenu:Hide() end
		if ui.defaultsPanel then ui.defaultsPanel:Hide() end
		if ui.quitting then ui.quitting = nil; return end
		if not db or not db.settings.shown or not UIParent:IsShown() then return end
		s.minimized = true
		if ui.mini then ui.mini:Show() end
		Wowie.UpdateMini()
	end)

	local panel = UI.Surface(CreateFrame("Frame", "WowieConversations", f, "BackdropTemplate"))
	panel:SetPoint("TOPLEFT", f, "TOPLEFT", 12, -60)
	panel:SetPoint("BOTTOMLEFT", f, "BOTTOMLEFT", 12, 12)
	panel:SetWidth(PANEL_W)
	panel:SetBackdropBorderColor(0, 0, 0, 0)
	ui.sidebar = panel
	local edge = CreateFrame("Frame", "WowieContentEdge", f)
	edge:SetWidth(1)
	ui.contentEdge = edge
	Wowie.LayoutWorkspace()
	local sidebarRule = UI.Rule(panel, "border", 0.55, true)
	sidebarRule:ClearAllPoints()
	sidebarRule:SetPoint("TOPRIGHT", panel, "TOPRIGHT", 0, 0)
	sidebarRule:SetPoint("BOTTOMRIGHT", panel, "BOTTOMRIGHT", 0, 0)
	sidebarRule:SetWidth(1)
	local heading = UI.Label(panel, "Conversations", 12)
	heading:SetPoint("TOPLEFT", panel, "TOPLEFT", 12, -14)
	ui.chatCount = UI.Label(panel, "", 11, "muted")
	ui.chatCount:SetPoint("TOPRIGHT", panel, "TOPRIGHT", -12, -15)
	local newChat = UI.Button(panel, "+ New chat", PANEL_W - 20, function() Wowie.NewChat() end, "secondary", "WowieNewChat")
	newChat:SetPoint("TOPLEFT", panel, "TOPLEFT", 10, -38)
	newChat:SetHeight(28)
	ui.newChat = newChat
	local searchBg, search = EditField(panel, "WowieChatSearch", "Search chats")
	searchBg:SetPoint("TOPLEFT", newChat, "BOTTOMLEFT", 0, -8)
	searchBg:SetPoint("TOPRIGHT", newChat, "BOTTOMRIGHT", 0, -8)
	ui.chatSearch = search
	local chatScroll = UI.ScrollFrame(panel, "WowieChatScroll")
	chatScroll:SetPoint("TOPLEFT", searchBg, "BOTTOMLEFT", 0, -10)
	chatScroll:SetPoint("BOTTOMRIGHT", panel, "BOTTOMRIGHT", -24, 54)
	local chatContent = CreateFrame("Frame", "WowieChatList", chatScroll)
	chatContent:SetSize(PANEL_W - 34, 1)
	chatScroll:SetScrollChild(chatContent)
	ui.chatContent, ui.chatScroll = chatContent, chatScroll
	ui.chatEmpty = UI.Label(chatContent, "No conversations match.", 12, "muted")
	ui.chatEmpty:SetPoint("TOPLEFT", chatContent, "TOPLEFT", 4, -8)
	ui.chatEmpty:SetWidth(PANEL_W - 48)
	search:HookScript("OnTextChanged", function() chatScroll:SetVerticalScroll(0); Wowie.RenderChatList() end)
	ui.sharingSummary = UI.Label(panel, "", 11, "muted")
	ui.sharingSummary:SetPoint("BOTTOMLEFT", panel, "BOTTOMLEFT", 12, 18)
	ui.sharingSummary:SetWidth(PANEL_W - 24)
	ui.sharingSummary:SetWordWrap(true)
	local sharingRule = UI.Rule(panel)
	sharingRule:SetPoint("BOTTOMLEFT", panel, "BOTTOMLEFT", 10, 46)
	sharingRule:SetPoint("BOTTOMRIGHT", panel, "BOTTOMRIGHT", -10, 46)
	Wowie.UpdateSharingSummary()

	local menu = UI.Window(CreateFrame("Frame", "WowieChatMenu", f, "BackdropTemplate"), 26)
	menu:SetSize(220, 292)
	menu:SetFrameStrata("FULLSCREEN_DIALOG")
	menu:SetClampedToScreen(true)
	menu:EnableMouse(true)
	menu.title = UI.Label(menu, "", 12, "muted")
	menu.title:SetPoint("TOPLEFT", menu, "TOPLEFT", 12, -10)
	menu.title:SetWidth(196)
	menu.title:SetWordWrap(false)
	local actions = {
		{ "Rename...", Wowie.RenamePrompt }, { "Working folder...", Wowie.FolderPrompt },
		{ "Choose agent...", Wowie.AgentPrompt },
		{ "Copy latest reply", function(id)
			local c = FindChat(id)
			if not c then return end
			for i = #c.history, 1, -1 do if c.history[i].role == "assistant" then Wowie.ShowCopy(c.history[i].text); return end end
		end },
		{ "Reset next session", function(id)
			local c = FindChat(id)
			if c then c.resetNext = true; AddHistory(c, "system", "Next message starts a fresh agent session."); Wowie.Render() end
		end },
		{ "Clear transcript...", function(id)
			local c = FindChat(id)
			if c then StaticPopup_Show("WOWIE_CLEAR", Display(c.name), nil, { id = id }) end
		end },
		{ "Delete conversation...", Wowie.ConfirmDelete, "danger" },
		{ "Close menu", function() end },
	}
	for i, action in ipairs(actions) do
		local item = UI.Button(menu, action[1], 204, function() local id = menu.chatId; menu:Hide(); action[2](id) end, action[3] or "quiet")
		item:SetPoint("TOPLEFT", menu, "TOPLEFT", 8, -30 - (i - 1) * 32)
	end
	menu:Hide()
	tinsert(UISpecialFrames, "WowieChatMenu")
	ui.chatMenu = menu
	function Wowie.ShowChatMenu(id, anchor)
		local c = FindChat(id)
		if not c then return end
		if menu:IsShown() and menu.chatId == id then menu:Hide(); return end
		if ui.selectionMenu then ui.selectionMenu:Hide() end
		menu.chatId, menu.owner = id, anchor
		menu.title:SetText(Display(c.name))
		menu:ClearAllPoints()
		menu:SetPoint("TOPLEFT", anchor, "BOTTOMLEFT", 0, -4)
		menu:Show()
		UI.RaisePanel(menu)
	end

	ui.chatButtons = {}
	for i = 1, MAX_CHATS do
		local b = CreateFrame("Button", "WowieChatRow" .. i, chatContent)
		b:SetSize(PANEL_W - 34, CHAT_ROW_HEIGHT)
		b.selected = b:CreateTexture(nil, "BACKGROUND")
		b.selected:SetAllPoints()
		b.selected:SetColorTexture(unpack(UI.colors.primary))
		b.selectedLine = UI.Rule(b, "accent", 0.85, true)
		b.selectedLine:SetPoint("TOPLEFT", b, "TOPLEFT", 0, -4)
		b.selectedLine:SetPoint("BOTTOMLEFT", b, "BOTTOMLEFT", 0, 4)
		b.selectedLine:SetWidth(2)
		local hover = b:CreateTexture(nil, "HIGHLIGHT")
		hover:SetAllPoints()
		hover:SetColorTexture(UI.colors.accent[1], UI.colors.accent[2], UI.colors.accent[3], 0.055)
		b.label = UI.Label(b, "", 12)
		b.label:SetPoint("TOPLEFT", b, "TOPLEFT", 8, -7)
		b.label:SetSize(PANEL_W - 76, 16)
		b.label:SetWordWrap(false)
		b.label:SetJustifyV("TOP")
		b.detail = UI.Label(b, "", 10, "muted")
		b.detail:SetPoint("TOPLEFT", b, "TOPLEFT", 8, -26)
		b.detail:SetSize(PANEL_W - 76, 12)
		b.detail:SetWordWrap(false)
		b.menu = UI.Button(b, "...", 26, function() Wowie.ShowChatMenu(b.chatId, b) end, "quiet", "WowieChatRowMenu" .. i)
		b.menu:SetHeight(28)
		b.menu:SetPoint("RIGHT", b, "RIGHT", -2, 0)
		UI.Tooltip(b.menu, "Conversation actions", "Rename, folder, agent, copy, reset, clear or delete.")
		b:RegisterForClicks("LeftButtonUp", "RightButtonUp")
		b:SetScript("OnClick", function(self, button)
			if button == "RightButton" then Wowie.ShowChatMenu(self.chatId, self) else Wowie.SwitchChat(self.chatId) end
		end)
		b:SetScript("OnDoubleClick", function(self) Wowie.SwitchChat(self.chatId); Wowie.RenamePrompt(self.chatId) end)
		b:SetScript("OnEnter", function(self)
			local chat = FindChat(self.chatId)
			if not chat then return end
			GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
			GameTooltip:SetText(Display(chat.name), 0.92, 0.94, 0.97, 1, true)
			GameTooltip:AddLine(Display(ChatFolder(chat)), 0.64, 0.69, 0.75, true)
			GameTooltip:Show()
		end)
		b:SetScript("OnLeave", function() GameTooltip:Hide() end)
		b:Hide()
		ui.chatButtons[i] = b
	end

	ui.title = UI.Label(f, "", 17)
	ui.title:SetPoint("TOPLEFT", edge, "TOPRIGHT", 16, -4)
	ui.title:SetPoint("TOPRIGHT", f, "TOPRIGHT", -194, -64)
	ui.title:SetWordWrap(false)
	local chatActions = UI.Button(f, "Chat options", 100, function(self)
		local c = ActiveChat(); if c then Wowie.ShowChatMenu(c.id, self) end
	end, "quiet", "WowieChatActions")
	chatActions:SetPoint("TOPRIGHT", f, "TOPRIGHT", -16, -60)
	ui.cwd = UI.Label(f, "", 11, "muted")
	ui.cwd:SetPoint("TOPLEFT", edge, "TOPRIGHT", 16, -28)
	ui.cwd:SetPoint("RIGHT", f, "RIGHT", -24, 0)
	ui.cwd:SetWordWrap(false)
	local cwdArea = CreateFrame("Frame", "WowieWorkspacePath", f)
	cwdArea:SetPoint("TOPLEFT", ui.cwd, "TOPLEFT")
	cwdArea:SetPoint("BOTTOMRIGHT", ui.cwd, "BOTTOMRIGHT")
	cwdArea:EnableMouse(true)
	cwdArea:SetScript("OnEnter", function(self)
		GameTooltip:SetOwner(self, "ANCHOR_TOP")
		GameTooltip:SetText("Agent working folder")
		GameTooltip:AddLine(Display(self.path ~= "" and self.path or "Uses the bridge default. Change it in Chat options."), 0.92, 0.94, 0.97, true)
		GameTooltip:Show()
	end)
	cwdArea:SetScript("OnLeave", function() GameTooltip:Hide() end)
	ui.cwdArea = cwdArea
	local selectors = MakeSelectors(f)
	selectors:SetPoint("TOPLEFT", edge, "TOPRIGHT", 16, -48)
	selectors:SetPoint("TOPRIGHT", f, "TOPRIGHT", -16, -108)
	MakeDefaultsPanel(f)

	local scroll = UI.ScrollFrame(f, "WowieScroll")
	scroll:SetPoint("TOPLEFT", edge, "TOPRIGHT", 16, -88)
	scroll:SetPoint("BOTTOMRIGHT", f, "BOTTOMRIGHT", -34, 126)
	ui.scroll = scroll
	local content = CreateFrame("Frame", "WowieContent", scroll)
	content:SetSize(500, 1)
	scroll:SetScrollChild(content)
	ui.content, ui.bubbles, ui.chatScrollPositions = content, {}, {}
	scroll:HookScript("OnSizeChanged", function() if f:IsShown() then Wowie.Render() end end)
	local latest = UI.Button(f, "Latest", 70, function()
		scroll:SetVerticalScroll(scroll:GetVerticalScrollRange())
		if ui.renderedChat then ui.chatScrollPositions[ui.renderedChat] = nil end
		ui.latest:Hide()
	end, "secondary", "WowieLatest")
	latest:SetHeight(26)
	latest:SetPoint("RIGHT", chatActions, "LEFT", -8, 0)
	latest:Hide()
	latest:SetFrameLevel(scroll:GetFrameLevel() + 4)
	ui.latest = latest
	scroll:HookScript("OnVerticalScroll", function(self, value) ui.latest:SetShown(self:GetVerticalScrollRange() - value > 32) end)
	local empty = CreateFrame("Frame", "WowieEmptyState", content)
	empty:SetSize(460, 184)
	empty:SetPoint("TOPLEFT", content, "TOPLEFT", 14, -18)
	local welcome = UI.Title(empty, "How can I help?", 22)
	welcome:SetPoint("TOPLEFT", empty, "TOPLEFT")
	welcome:SetPoint("RIGHT", empty, "RIGHT")
	local explain = UI.Label(empty, "Ask about your character, items or quests.\nThe assistant can read the information you allow in Sharing.", 13, "muted")
	explain:SetPoint("TOPLEFT", welcome, "BOTTOMLEFT", 0, -12)
	explain:SetPoint("RIGHT", empty, "RIGHT")
	for i, prompt in ipairs({ "What should I work on next?", "Explain my action bars.", "Help me write a macro." }) do
		local b = UI.Button(empty, prompt, 330, function() ui.input:SetText(prompt); ui.input:SetFocus() end, "quiet", "WowieStarter" .. i)
		b:SetPoint("TOPLEFT", empty, "TOPLEFT", 0, -76 - (i - 1) * 34)
		b:SetPoint("RIGHT", empty, "RIGHT", -8, 0)
	end
	ui.empty = empty

	local inputBg = CreateFrame("Frame", "WowieComposer", f, "BackdropTemplate")
	inputBg:SetPoint("BOTTOMLEFT", edge, "BOTTOMRIGHT", 16, 40)
	inputBg:SetPoint("BOTTOMRIGHT", f, "BOTTOMRIGHT", -16, 52)
	inputBg:SetHeight(62)
	local inScroll = UI.ScrollFrame(inputBg, "WowieInputScroll")
	inScroll:SetPoint("TOPLEFT", inputBg, "TOPLEFT", 12, -10)
	inScroll:SetPoint("BOTTOMRIGHT", inputBg, "BOTTOMRIGHT", -24, 10)
	local input = CreateFrame("EditBox", "WowieInput", inScroll)
	UI.Input(inputBg, input)
	input:SetMultiLine(true)
	input:SetAutoFocus(false)
	input:SetFont(UI.font, 14, "")
	input:SetMaxLetters(0)
	input:SetSize(500, 34)
	input:SetScript("OnEnterPressed", function(self)
		if IsShiftKeyDown() then self:Insert("\n") else Wowie.SendFromInput() end
	end)
	input:SetScript("OnEscapePressed", function(self) self:ClearFocus() end)
	inScroll:SetScrollChild(input)
	inScroll:HookScript("OnSizeChanged", function(_, w) input:SetWidth(w) end)
	input:SetScript("OnCursorChanged", function(_, _, y, _, height)
		local top = math.max(0, -y)
		local offset = inScroll:GetVerticalScroll()
		inScroll:UpdateScrollChildRect()
		if top < offset then inScroll:SetVerticalScroll(top)
		elseif top + height > offset + inScroll:GetHeight() then
			inScroll:SetVerticalScroll(math.max(0, top + height - inScroll:GetHeight()))
		end
	end)
	inputBg:SetScript("OnMouseDown", function() input:SetFocus() end)
	ui.input = input
	ui.placeholder = UI.Label(inputBg, "Ask a question... Shift-click an item, spell or quest to include it.", 12, "muted")
	ui.placeholder:SetPoint("TOPLEFT", inputBg, "TOPLEFT", 12, -12)
	ui.placeholder:SetPoint("RIGHT", inputBg, "RIGHT", -30, 0)
	ui.placeholder:SetWordWrap(true)
	input:SetScript("OnTextChanged", function(self)
		local c = ActiveChat()
		local text = self:GetText() or ""
		if c then c.draft = text ~= "" and text or nil end
		ui.placeholder:SetShown(text == "")
	end)
	UI.Tooltip(inputBg, "Message composer", "Enter sends. Shift+Enter inserts a newline. Esc releases focus. While waiting, Enter checks the reply and keeps your next-message draft.")
	local actionsRow = CreateFrame("Frame", "WowieActions", f)
	actionsRow:SetPoint("BOTTOMLEFT", edge, "BOTTOMRIGHT", 16, 0)
	actionsRow:SetPoint("BOTTOMRIGHT", f, "BOTTOMRIGHT", -16, 12)
	actionsRow:SetHeight(32)
	local send = UI.Button(actionsRow, "Send", 106, Wowie.SendFromInput, "primary", "WowieSend")
	send:SetHeight(32)
	send:SetPoint("RIGHT", actionsRow, "RIGHT", 0, 0)
	ui.send = send
	local cancel = UI.Button(actionsRow, "Stop waiting", 100, function() SlashCmdList.WOWIE("cancel") end, "secondary", "WowieCancelWait")
	cancel:SetHeight(32)
	cancel:SetPoint("RIGHT", send, "LEFT", -8, 0)
	UI.Tooltip(cancel, "Stop waiting for this reply", "This forgets the pending reply locally. It does not stop the external agent or undo actions already taken.")
	ui.cancel = cancel
	local reconnect = UI.Button(actionsRow, "Reconnect", 76, Wowie.Connect, "secondary", "WowieReconnect")
	reconnect:SetHeight(32)
	reconnect:SetPoint("LEFT", actionsRow, "LEFT", 0, 0)
	reconnect.label:SetPoint("LEFT", reconnect, "LEFT", 3, 0)
	reconnect.label:SetPoint("RIGHT", reconnect, "RIGHT", -3, 0)
	UI.Tooltip(reconnect, "Verify local bridge", "Send a fresh connection challenge. This does not send a question by itself.")
	ui.reconnect = reconnect
	local recovery = UI.Button(actionsRow, "...", 28, function()
		ui.recoveryMenu:SetShown(not ui.recoveryMenu:IsShown())
		if ui.recoveryMenu:IsShown() then UI.RaisePanel(ui.recoveryMenu) end
	end, "quiet", "WowieRecovery")
	recovery:SetHeight(32)
	recovery:SetPoint("LEFT", reconnect, "RIGHT", 4, 0)
	UI.Tooltip(recovery, "Connection recovery", "Check replies, retry delivery, reload or show diagnostics.")
	local statusArea = CreateFrame("Frame", "WowieStatus", actionsRow)
	statusArea:SetPoint("LEFT", recovery, "RIGHT", 8, 0)
	statusArea:SetPoint("RIGHT", cancel, "LEFT", -8, 0)
	statusArea:SetHeight(20)
	statusArea:EnableMouse(true)
	ui.statusArea = statusArea
	ui.status = UI.Label(statusArea, "", 11, "muted")
	ui.status:SetAllPoints()
	ui.status:SetWordWrap(false)
	statusArea:SetScript("OnEnter", function(self)
		GameTooltip:SetOwner(self, "ANCHOR_TOP")
		GameTooltip:SetText(run.statusText or "Ready", 0.91, 0.94, 0.98, 1, true)
		GameTooltip:Show()
	end)
	statusArea:SetScript("OnLeave", function() GameTooltip:Hide() end)
	local recoveryMenu = UI.Window(CreateFrame("Frame", "WowieRecoveryMenu", f, "BackdropTemplate"), 0)
	recoveryMenu:SetSize(226, 178)
	recoveryMenu:SetPoint("BOTTOMRIGHT", recovery, "TOPRIGHT", 0, 6)
	recoveryMenu:SetFrameStrata("FULLSCREEN_DIALOG")
	recoveryMenu:EnableMouse(true)
	ui.recoveryMenu = recoveryMenu
	for i, action in ipairs({
		{ "Check for reply", function() Wowie.Send("") end },
		{ "Retry pending delivery", Wowie.Resend },
		{ "Connect / reconnect", Wowie.Connect },
		{ "Reload UI / free reply slots", SafeReload },
		{ "Connection diagnostics", function() SlashCmdList.WOWIE("diag") end },
	}) do
		local b = UI.Button(recoveryMenu, action[1], 210, function() recoveryMenu:Hide(); action[2]() end, "quiet")
		b:SetPoint("TOPLEFT", recoveryMenu, "TOPLEFT", 8, -8 - (i - 1) * 32)
	end
	recoveryMenu:Hide()
	tinsert(UISpecialFrames, "WowieRecoveryMenu")
	local hotkey = CreateFrame("Button", "WowieRefreshButton", UIParent)
	hotkey:SetSize(1, 1)
	hotkey:SetPoint("TOPLEFT", UIParent, "TOPLEFT", -10, 10)
	hotkey:SetScript("OnClick", function()
		local c = ActiveChat(); if c and c.pendingId then Wowie.Send("") else Wowie.Toggle() end
	end)
	local grip = CreateFrame("Button", "WowieResize", f)
	grip:SetSize(14, 14)
	grip:SetPoint("BOTTOMRIGHT", f, "BOTTOMRIGHT", -1, 1)
	for i = 1, 3 do
		local line = UI.Rule(grip, "muted", 0.7)
		line:SetWidth(i * 3)
		line:SetPoint("BOTTOMRIGHT", grip, "BOTTOMRIGHT", -3, 3 + (i - 1) * 3)
	end
	grip:SetScript("OnMouseDown", function() f:StartSizing("BOTTOMRIGHT") end)
	grip:SetScript("OnMouseUp", function() f:StopMovingOrSizing(); s.width, s.height = f:GetSize() end)

	local m = UI.Window(CreateFrame("Frame", "WowieMini", UIParent, "BackdropTemplate"), 0)
	ui.mini = m
	m:SetSize(370, 42)
	if s.miniPoint then m:SetPoint(s.miniPoint, UIParent, s.miniRelPoint or s.miniPoint, s.miniX or 0, s.miniY or 0)
	else m:SetPoint("TOP", UIParent, "TOP", 0, -40) end
	m:SetFrameStrata("DIALOG")
	m:SetMovable(true)
	m:SetClampedToScreen(true)
	m:EnableMouse(true)
	m:RegisterForDrag("LeftButton")
	m:SetScript("OnDragStart", function(self) self.dragging = true; self:StartMoving() end)
	m:SetScript("OnDragStop", function(self)
		self:StopMovingOrSizing()
		local point, _, relPoint, x, y = self:GetPoint()
		s.miniPoint, s.miniRelPoint, s.miniX, s.miniY = point, relPoint, x, y
		C_Timer.After(0, function() self.dragging = nil end)
	end)
	m:SetScript("OnMouseUp", function(self, button) if button == "LeftButton" and not self.dragging then Wowie.Minimize(false) end end)
	local miniDotHolder, miniDot = MakeDot(m)
	miniDotHolder:SetPoint("LEFT", m, "LEFT", 10, 0)
	ui.miniDot = miniDot
	local miniTitle = UI.Title(m, "Wowie", 12)
	miniTitle:SetPoint("TOPLEFT", m, "TOPLEFT", 30, -7)
	ui.miniBadge = UI.Label(m, "", 10, "muted")
	ui.miniBadge:SetPoint("TOPLEFT", miniTitle, "BOTTOMLEFT", 0, -3)
	ui.miniBadge:SetWidth(218)
	ui.miniBadge:SetWordWrap(false)
	local open = UI.Button(m, "Open", 60, function() Wowie.Minimize(false) end, "primary", "WowieMiniOpen")
	open:SetPoint("RIGHT", m, "RIGHT", -6, 0)
	m:Hide()
end

function Wowie.Toggle(show)
	if not ui.frame then return end
	if show == nil then show = not ui.frame:IsShown() end
	if show then
		db.settings.minimized = false
		local c = ActiveChat()
		if c then c.unread = 0 end
	end
	if ui.mini then ui.mini:Hide() end
	if not show then ui.quitting = true end
	ui.frame:SetShown(show)
	ui.quitting = nil
	db.settings.shown = show
	if show then
		Wowie.Render()
		Wowie.UpdateNavigation()
		-- No auto-focus: the game keeps the keyboard until you click the box.
		-- Opening the panel alone does not send anything; Send checks the bridge
		-- automatically, and the direct Reconnect action is always available.
	end
	Wowie.UpdateMini()
end

function Wowie.Minimize(mini)
	if not ui.frame then return end
	if mini == nil then mini = not db.settings.minimized end
	if mini then
		db.settings.minimized = true
		db.settings.shown = true
		ui.frame:Hide() -- OnHide shows the mini bar
		if ui.mini and not ui.mini:IsShown() then ui.mini:Show() end
		Wowie.UpdateMini()
	else
		Wowie.Toggle(true)
	end
end

---------------------------------------------------------------------------
-- Slash commands
---------------------------------------------------------------------------

local HELP = table.concat({
	"/wowie                        toggle the window (/ai and /ask are the same command)",
	"/wowie mini                   collapse to the small bar (click the bar to expand)",
	"/wowie hide                   hide the window completely",
	"/ai <text>                         send <text> to the current chat straight from the game chat box (/wowie <text> too). A message that starts with a command word is still sent when the rest of the line doesn't fit that command",
	"/r <text>                          replies to the agent when it was the last to message you (else normal whisper reply)",
	"/wowie echo short|full|off|<chars>   how much of each reply to print in the game chat (short = a preview of the answer)",
	"/wowie longchat on|off        let the game chat box take 4000 characters (for long /ai messages)",
	"/wowie new [name]             start a new chat (its own agent session, like a new terminal)",
	"/wowie chat <n|name>          switch chats (or click one in the left panel)",
	"/wowie rename [name]          rename the current chat (no name = dialog; right-clicking the chat in the left panel offers it too)",
	"/wowie delete                 delete the current chat",
	"/wowie cd <folder>            folder this chat's agent works in (relative to the bridge's folder; no folder = back to default). Right-clicking the chat in the left panel and picking Folder does the same",
	"/wowie agent [name]           which agent this chat talks to (no name = show; default = saved addon default, then the bridge's). Settings in the window sets addon-wide agent/model/reasoning",
	"/wowie reset                  next message in this chat starts a fresh agent session",
	"/wowie context [on|off]       what the agent is told about your character and where you are (no argument = show it)",
	"/wowie map [...]              map layers the agent drew, the route navigator and herb/ore nodes (no argument = status and subcommands; /aimap is the same)",
	"/wowie mode pixel             no-reload transport (default)",
	"/wowie mode reload            fallback transport: a /reload per step",
	"/wowie resend                 show the strip again if the bridge missed it",
	"/wowie reload                 reload now (also frees the slot pool)",
	"/wowie cancel                 stop waiting on this chat's reply",
	"/wowie copy                   open the last reply in a selectable box for Ctrl+C",
	"/wowie macro undo             undo the last macro the agent's button created or changed",
	"/wowie bind <key>             hotkey: checks for a reply while waiting, else toggles the window",
	"/wowie auto on|off            reload-mode only: auto-reload on your next keypress after the interval",
	"/wowie signal on|off          the cheap sound-file readiness check (off if it spams errors)",
	"/wowie slots                  how many reply slots are still free this session",
	"/wowie diag                   transport diagnostics (is the cheap sound-file channel working?)",
	"/wowie clear                  clear this chat's transcript",
}, "\n")

-- What each subcommand accepts, so that free text which happens to start with
-- one of these words ("delete the unused imports", "help me with this macro")
-- is sent as a message instead of run as a command. 0 = no arguments, 1 = at
-- most one word, a table = one of those words, a function decides, true = anything.
local function OnOffOrNumber(rest)
	return rest == "" or rest == "on" or rest == "off" or tonumber(rest) ~= nil
end

local function ChatArgument(rest)
	if rest == "" or tonumber(rest) or not rest:find("%s") then return true end
	for _, ch in ipairs(db.chats) do
		if ch.name:lower() == rest:lower() then return true end
	end
	return false
end

local COMMAND_ARGS = {
	mini = 0, min = 0, hide = 0, quit = 0, help = 0, clear = 0, delete = 0, reset = 0, copy = 0,
	cancel = 0, resend = 0, reload = 0, refresh = 0, slots = 0, diag = 0,
	context = { [""] = true, on = true, off = true }, ctx = { [""] = true, on = true, off = true },
	mode = { [""] = true, pixel = true, reload = true },
	signal = { [""] = true, on = true, off = true }, longchat = { [""] = true, on = true, off = true },
	auto = OnOffOrNumber,
	echo = function(rest) return rest == "" or rest == "full" or rest == "short" or rest == "off" or tonumber(rest) ~= nil end,
	bind = 1, agent = 1,
	chat = ChatArgument, chats = ChatArgument,
	cd = true, new = true, rename = true,
	map = true, -- /wowie map ...: Map.lua (layers, navigator, herb/ore nodes)
	macro = { undo = true }, -- /wowie macro undo; "/ai macro for my warrior" still goes to the agent
}

local function IsCommand(cmd, rest)
	local spec = COMMAND_ARGS[cmd]
	if spec == nil then return false end
	if spec == true then return true end
	if spec == 0 then return rest == "" end
	if spec == 1 then return not rest:find("%s") end
	if type(spec) == "table" then return spec[rest:lower()] == true end
	return spec(rest) == true
end

local function ApplyLongChat()
	local box = ChatFrame1EditBox
	if not box or not box.SetMaxLetters then return end
	box:SetMaxLetters(db.settings.longchat and 4000 or 255)
end

SLASH_WOWIE1 = "/wowie"
SLASH_WOWIE2 = "/ai"
SLASH_WOWIE3 = "/ask"
SlashCmdList["WOWIE"] = function(msg)
	msg = Trim(msg or "")
	local cmd, rest = msg:match("^(%S+)%s*(.-)$")
	cmd = cmd and cmd:lower() or ""
	local s = db.settings
	local c = ActiveChat()

	-- Anything that isn't a command, or a command word followed by something it
	-- doesn't take, is a message for the agent.
	if cmd ~= "" and not IsCommand(cmd, rest) then
		Wowie.Send(msg)
		return
	end
	if cmd == "" then
		Wowie.Toggle()
	elseif cmd == "mini" or cmd == "min" then
		Wowie.Minimize(true)
	elseif cmd == "new" then
		Wowie.NewChat(rest)
	elseif cmd == "chat" or cmd == "chats" then
		local n = tonumber(rest)
		local target = n and db.chats[n]
		if not target and rest ~= "" then
			for _, ch in ipairs(db.chats) do
				if ch.name:lower() == rest:lower() then target = ch end
			end
		end
		if target then
			Wowie.SwitchChat(target.id)
		else
			local lines = {}
			for i, ch in ipairs(db.chats) do
				table.insert(lines, i .. ". " .. ch.name .. (ch.id == db.activeChat and "  (current)" or "") .. (ch.pendingId and "  working" or "") .. ((ch.unread or 0) > 0 and ("  " .. ch.unread .. " new") or ""))
			end
			AddHistory(c, "system", "Chats:\n" .. table.concat(lines, "\n"))
			Wowie.Render()
		end
		Wowie.Toggle(true)
	elseif cmd == "rename" then
		if rest ~= "" then
			c.name = rest:sub(1, 24)
			Wowie.Render()
		else
			Wowie.RenameActive()
		end
		Wowie.Toggle(true)
	elseif cmd == "delete" then
		Wowie.DeleteChat()
	elseif cmd == "cd" then
		Wowie.SetFolder(rest, c)
		Wowie.Toggle(true)
	elseif cmd == "map" then
		if WowieMap then WowieMap.Command(rest) else print("|cff66ccff[Wowie]|r the map module did not load") end
	elseif cmd == "agent" then
		Wowie.SetAgent(rest, c)
		Wowie.Toggle(true)
	elseif cmd == "reset" then
		c.resetNext = true
		local where = ChatFolder(c)
		AddHistory(c, "system", "Next message starts a fresh " .. ChatAgentName(c) .. " session" .. (where ~= "" and (" in " .. where) or ""))
		Wowie.Render()
		Wowie.Toggle(true)
	elseif cmd == "context" or cmd == "ctx" then
		rest = rest:lower()
		if rest == "on" or rest == "off" then
			Wowie.SetContextEnabled(rest == "on")
		end
		local ctx = Wowie.GameContext()
		AddHistory(c, "system", (s.context
			and "Game context is ON. Sharing... in the window selects which information the AI may read. Changes affect future snapshots and current queries.\n\n"
			or "Game context is OFF. No new character snapshot or read-only query data is shared.\n\n") .. ctx
			.. "\n\nOpen Sharing... to select individual data categories and native API permissions. Shift-clicked item, spell and quest links still include their tooltip.")
		Wowie.Render()
		Wowie.Toggle(true)
	elseif cmd == "mode" then
		if rest == "pixel" or rest == "reload" then
			s.mode = rest
			AddHistory(c, "system", "mode set to " .. rest)
		else
			AddHistory(c, "system", "mode is " .. s.mode .. " (pixel or reload)")
		end
		Wowie.Render()
		Wowie.Toggle(true)
	elseif cmd == "resend" then
		Wowie.Resend()
	elseif cmd == "auto" then
		local n = tonumber(rest)
		if n then
			s.interval = math.max(5, math.floor(n))
			s.autoRefresh = true
		elseif rest == "on" then
			s.autoRefresh = true
		elseif rest == "off" then
			s.autoRefresh = false
		end
		Wowie.UpdateStatus()
		Wowie.ArmAutoRefresh()
	elseif cmd == "hide" or cmd == "quit" then
		Wowie.Toggle(false)
	elseif cmd == "macro" and rest == "undo" then
		Wowie.UndoMacro()
	elseif cmd == "copy" then
		for i = #c.history, 1, -1 do
			if c.history[i].role == "assistant" then
				Wowie.ShowCopy(c.history[i].text)
				break
			end
		end
	elseif cmd == "echo" then
		if rest == "full" or rest == "short" or rest == "off" then
			s.echo = rest
		elseif tonumber(rest) then
			s.echo = tostring(math.max(200, math.floor(tonumber(rest))))
		end
		AddHistory(c, "system", "replies in game chat: " .. s.echo .. " (short = a preview, full = " .. ECHO_DEFAULT .. " chars, off, or a number of characters)")
		Wowie.Render()
	elseif cmd == "longchat" then
		if rest == "on" then s.longchat = true elseif rest == "off" then s.longchat = false end
		ApplyLongChat()
		AddHistory(c, "system", "game chat box limit: " .. (s.longchat and "4000 characters (fine for /ai; real chat over 255 may be rejected by the server)" or "255 (default)"))
		Wowie.Render()
	elseif cmd == "signal" then
		if rest == "on" then s.signal = true elseif rest == "off" then s.signal = false end
		AddHistory(c, "system", "signal check is " .. (s.signal and "on" or "off"))
		Wowie.Render()
	elseif cmd == "slots" then
		local free = 0
		for i = 1, SLOT_COUNT do
			if not C_AddOns.IsAddOnLoaded(SlotName(i)) then free = free + 1 end
		end
		AddHistory(c, "system", free .. " of " .. SLOT_COUNT .. " reply slots free this session (a reload frees all)")
		Wowie.Render()
		Wowie.Toggle(true)
	elseif cmd == "refresh" or cmd == "reload" then
		SafeReload()
	elseif cmd == "bind" then
		local key = rest:upper()
		if key ~= "" and not InCombatLockdown() then
			SetBinding(key, "CLICK WowieRefreshButton:LeftButton")
			SaveBindings(GetCurrentBindingSet())
			AddHistory(c, "system", key .. " is now bound: checks for a reply while waiting, otherwise toggles this window")
		end
		Wowie.Render()
		Wowie.Toggle(true)
	elseif cmd == "diag" then
		local free = 0
		for i = 1, SLOT_COUNT do
			if not C_AddOns.IsAddOnLoaded(SlotName(i)) then free = free + 1 end
		end
		local lines = {
			"sound channel: " .. (signalAvailable and "usable" or "UNUSABLE") .. " (self-test: " .. tostring(signalStats.selftest) .. ")" .. (signalStats.error and (" error: " .. signalStats.error) or ""),
			"signal setting: " .. tostring(s.signal) .. ", marked unreliable this session: " .. tostring(run.signalUnreliable or false),
			"sound checks: " .. signalStats.checks .. ", valid hits: " .. signalStats.hits .. (signalStats.lastHit and (", last hit " .. FmtDur(GetTime() - signalStats.lastHit) .. " ago") or ""),
			"slot polls this session: " .. (run.polls or 0) .. ", free slots: " .. free .. "/" .. SLOT_COUNT,
			"presence: head at " .. tostring(run.presence and run.presence.last or "?") .. ", beats seen: " .. tostring(run.presence and run.presence.beats or 0),
			PresenceStatus(),
			select(5, Wowie.BridgeState()),
			"mode: " .. s.mode .. ", session token: " .. tostring(db.session),
		}
		for _, ch in ipairs(db.chats) do
			local a = run.act and run.act[ch.id]
			if ch.pendingId then
				table.insert(lines, ch.name .. ": pending #" .. ch.pendingId .. (a and (", heartbeat " .. (a.unreliable and "unreliable" or (a.count .. " beats"))) or ", no heartbeat state"))
			end
		end
		AddHistory(c, "system", "Diagnostics:\n" .. table.concat(lines, "\n"))
		Wowie.Render()
		Wowie.Toggle(true)
	elseif cmd == "cancel" then
		if run.sendOnConnect and run.sendOnConnect.chat == c.id then run.sendOnConnect = nil end
		if c.pendingId then
			AddHistory(c, "system", "Gave up waiting on #" .. c.pendingId)
			run.outbound[c.pendingId] = nil
			if db.outbox and db.outbox.id == c.pendingId and db.outbox.nonce == c.request.nonce then db.outbox = nil end
			if db.contextOutbox and db.contextOutbox.id == c.pendingId and db.contextOutbox.nonce == c.request.nonce then db.contextOutbox = nil end
			c.queryReply, c.snapshotAcked = nil, nil
			if run.act then run.act[c.id] = nil end
			c.pendingId = nil
			c.request = nil
			c.progress = nil
			RefreshStrip()
			Wowie.ArmAutoRefresh()
		end
		Wowie.Render()
	elseif cmd == "clear" then
		wipe(c.history)
		Wowie.Render()
	elseif cmd == "help" then
		AddHistory(c, "system", HELP)
		Wowie.Render()
		Wowie.Toggle(true)
	end
end

---------------------------------------------------------------------------
-- Events
---------------------------------------------------------------------------

local ev = CreateFrame("Frame")
ev:RegisterEvent("ADDON_LOADED")
ev:RegisterEvent("PLAYER_LOGIN")
ev:RegisterEvent("UI_SCALE_CHANGED")
ev:RegisterEvent("DISPLAY_SIZE_CHANGED")
ev:RegisterEvent("PLAYER_REGEN_ENABLED")
ev:RegisterEvent("UPDATE_MACROS")
ev:RegisterEvent("CHAT_MSG_WHISPER")
ev:RegisterEvent("CHAT_MSG_BN_WHISPER")
ev:SetScript("OnEvent", function(self, event, arg1)
	if event == "ADDON_LOADED" then
		if arg1 == ADDON_NAME then
			InitDB()
		end
	elseif event == "CHAT_MSG_WHISPER" or event == "CHAT_MSG_BN_WHISPER" then
		-- A real person whispered: /r belongs to them again.
		run.lastMessenger = "player"
	elseif event == "UI_SCALE_CHANGED" or event == "DISPLAY_SIZE_CHANGED" then
		tx.Invalidate()
		if ui.frame then
			local maxW, maxH = math.max(360, UIParent:GetWidth() - 24), math.max(360, UIParent:GetHeight() - 24)
			ui.frame:SetResizeBounds(math.min(720, maxW), math.min(500, maxH), maxW, maxH)
			ui.frame:SetSize(math.min(maxW, math.max(math.min(720, maxW), ui.frame:GetWidth())), math.min(maxH, math.max(math.min(500, maxH), ui.frame:GetHeight())))
			db.settings.width, db.settings.height = ui.frame:GetSize()
		end
	elseif event == "PLAYER_LOGIN" then
		if not db then InitDB() end
		BuildUI()
		run = { outbound = {}, reconcilePending = true }
		Wowie.nextAutoRefresh = nil
		RefreshControlOutbox()
		HideStrip()
		tx.active, tx.probe, tx.failed, tx.retryDisplay, tx.reason = "robust", nil, nil, nil, ""
		tx.interval, tx.displays, tx.captureInterval, tx.nextFrameAt, tx.lastSignalCheck = 0.5, nil, nil, nil, nil
		SelfTestSignals()
		ApplyBridgeData(Wowie_Inbox)
		if AnyPending() then
			-- Still waiting after a reload: resume polling with a fresh slot pool.
			run.sentAt = GetTime()
			run.polls = 0
			run.act = {}
			for _, ch in ipairs(db.chats) do
				if ch.pendingId then
					-- Beats already written stay valid, so the counter catches up on its own.
					run.act[ch.id] = { next = 1, count = 0, startedAt = GetTime() }
				end
			end
			ScheduleNextPoll()
		end
		local c = ActiveChat()
		if c and c.draft and c.draft ~= "" then
			ui.input:SetText(c.draft)
		end
		Wowie.Render()
		if db.settings.shown then
			if db.settings.minimized then
				Wowie.Minimize(true)
			else
				Wowie.Toggle(true)
			end
		end
		Wowie.ArmAutoRefresh()
		Wowie.UpdateDot()
		if db.settings.longchat then ApplyLongChat() end
		HookReplyCommand()
		C_Timer.NewTicker(TICK_SECONDS, Tick)
		C_Timer.NewTicker(TRANSPORT_SECONDS, TransportTick)
		C_Timer.After(3, Wowie.SayHello)
	elseif event == "UPDATE_MACROS" then
		-- "Create" / "Update" on the macro buttons follows what exists now.
		if ui.frame and ui.frame:IsShown() then Wowie.Render() end
	elseif event == "PLAYER_REGEN_ENABLED" then
		if Wowie.reloadAfterCombat then
			Wowie.reloadAfterCombat = nil
			ReloadUI()
		elseif db then
			Wowie.ArmAutoRefresh()
		end
	end
end)
