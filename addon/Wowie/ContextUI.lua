-- Permission editing is local: the bridge need not be connected.
WowieContextUI = WowieContextUI or {}

local UI = Wowie.UI
local unpack = unpack or table.unpack
local panel
local catalog
local ROW_HEIGHT = 64
local views = {
	{ id = "character", label = "Character", control = "WowieContextTabCharacter" },
	{ id = "private", label = "Private", control = "WowieContextTabPrivate" },
	{ id = "advanced", label = "API scopes", control = "WowieContextTabAdvanced" },
	{ id = "selected", label = "Selected", control = "WowieContextTabSelected" },
}

local function MasterEnabled()
	return not WowieDB or not WowieDB.settings or WowieDB.settings.context ~= false
end

local function LoadCatalog()
	catalog = {}
	for _, category in ipairs(WowieContext.Categories()) do
		local view = category.id:sub(1, 4) == "api:" and "advanced" or (category.sensitive and "private" or "character")
		catalog[#catalog + 1] = {
			category = category,
			view = view,
			search = string.lower((category.label or "") .. " " .. category.id .. " " ..
				(category.description or "") .. (category.sensitive and " sensitive private social" or "")),
		}
	end
end

local function Selected(category)
	local sharing = WowieDB and WowieDB.settings and WowieDB.settings.sharing
	if sharing and sharing[category.id] ~= nil then return sharing[category.id] == true end
	return category.enabled == true
end

-- Categories reads metadata only. Discover once before the panel is opened,
-- then refresh on Show, not whenever the workspace refreshes its status badge.
function WowieContextUI.Summary()
	if not catalog then LoadCatalog() end
	local selected = 0
	for _, entry in ipairs(catalog) do
		if Selected(entry.category) then selected = selected + 1 end
	end
	return { enabled = MasterEnabled(), selected = selected, total = #catalog }
end

local function NotifyChanged()
	if Wowie.UpdateSharingSummary then Wowie.UpdateSharingSummary() end
end

local function HideTooltip()
	if GameTooltip then GameTooltip:Hide() end
end

local function CategoryTooltip(row)
	local category = row.category
	if not category or not GameTooltip then return end
	GameTooltip:SetOwner(row, "ANCHOR_RIGHT")
	GameTooltip:SetText(category.label or category.id)
	GameTooltip:AddLine(category.id, 0.58, 0.65, 0.74, true)
	GameTooltip:AddLine(category.description or "", 0.91, 0.94, 0.98, true)
	if category.sensitive then
		GameTooltip:AddLine("Private / broad access: enable only if you want this information shared.", 0.96, 0.72, 0.36, true)
	end
	if category.available == false then
		GameTooltip:AddLine("Unavailable: " .. (category.reason or "This source is not available on this client."), 0.96, 0.72, 0.36, true)
	end
	if category.queryOnly or category.id:sub(1, 4) == "api:" then
		GameTooltip:AddLine("Query-only: never attached in full to every message.", 0.58, 0.65, 0.74, true)
	end
	if category.id == "mail_body" then
		GameTooltip:AddLine("Reading message bodies marks mail as read.", 0.96, 0.72, 0.36, true)
	end
	if Selected(category) and MasterEnabled() and category.available == false then
		GameTooltip:AddLine("Permission saved, but this source is currently unavailable.", 0.96, 0.72, 0.36, true)
	elseif Selected(category) and MasterEnabled() then
		GameTooltip:AddLine("Selected: the AI may request this information directly.", 0.32, 0.81, 0.59, true)
	elseif Selected(category) then
		GameTooltip:AddLine("Selected, but sharing is paused. Queries are blocked until sharing resumes.", 0.96, 0.72, 0.36, true)
	else
		GameTooltip:AddLine("Not selected: queries are blocked.", 0.58, 0.65, 0.74, true)
	end
	GameTooltip:AddLine("Changes cannot recall information already sent.", 0.58, 0.65, 0.74, true)
	GameTooltip:Show()
end

local FilterCategories
local RenderRows

local function MakeRow()
	local row = CreateFrame("Button", nil, panel.content, "BackdropTemplate")
	UI.Surface(row)
	row:SetHeight(ROW_HEIGHT - 4)
	row.check = CreateFrame("CheckButton", nil, row, "BackdropTemplate")
	UI.Surface(row.check, "raised")
	row.check:SetSize(22, 22)
	row.check:SetPoint("TOPLEFT", row, "TOPLEFT", 10, -10)
	row.check:SetCheckedTexture("Interface\\Buttons\\UI-CheckBox-Check")
	row.label = UI.Label(row, "", 13)
	row.label:SetPoint("TOPLEFT", row, "TOPLEFT", 42, -8)
	row.label:SetPoint("TOPRIGHT", row, "TOPRIGHT", -12, -8)
	row.label:SetHeight(18)
	row.description = UI.Label(row, "", 11, "muted")
	row.description:SetPoint("TOPLEFT", row, "TOPLEFT", 42, -28)
	row.description:SetPoint("TOPRIGHT", row, "TOPRIGHT", -12, -28)
	row.description:SetHeight(28)
	function row:Paint()
		local selected = self.category and Selected(self.category)
		local fill = UI.colors[selected and "primary" or (self.hover and "hover" or "surface")]
		self:SetBackdropColor(unpack(fill))
		self:SetBackdropBorderColor(0, 0, 0, 0)
		self.check:SetBackdropBorderColor(unpack(UI.colors[selected and "accent" or "border"]))
	end
	row.description:SetJustifyV("TOP")
	local function Toggle()
		-- Resolve from the reused row at click time, never a former slot/index.
		if not row.category then return end
		if WowieContext.SetEnabled(row.category.id, not Selected(row.category)) then
			FilterCategories(false)
			NotifyChanged()
		end
	end
	row:SetScript("OnClick", Toggle)
	row.check:SetScript("OnClick", Toggle)
	row:SetScript("OnEnter", function() CategoryTooltip(row) end)
	row.check:SetScript("OnEnter", function() CategoryTooltip(row) end)
	row:SetScript("OnLeave", HideTooltip)
	row.check:SetScript("OnLeave", HideTooltip)
	local function Enter() row.hover = true; row:Paint() end
	local function Leave() row.hover = nil; row:Paint() end
	row:HookScript("OnEnter", Enter)
	row.check:HookScript("OnEnter", Enter)
	row:HookScript("OnLeave", Leave)
	row.check:HookScript("OnLeave", Leave)
	return row
end

-- Only viewport-sized rows are allocated, even for hundreds of API scopes.
RenderRows = function()
	if not panel or not panel.filtered then return end
	if not panel.expanded then
		for _, row in ipairs(panel.rows) do row:Hide() end
		return
	end
	local width = math.max(1, panel.scroll:GetWidth() - 4)
	local first = math.floor(panel.scroll:GetVerticalScroll() / ROW_HEIGHT) + 1
	local visible = math.ceil(math.max(1, panel.scroll:GetHeight()) / ROW_HEIGHT) + 1
	for slot = 1, visible do
		local category = panel.filtered[first + slot - 1]
		local row = panel.rows[slot]
		if category then
			if not row then
				row = MakeRow()
				panel.rows[slot] = row
			end
			row.category = category
			row:ClearAllPoints()
			row:SetPoint("TOPLEFT", panel.content, "TOPLEFT", 0, -(first + slot - 2) * ROW_HEIGHT)
			row:SetWidth(width)
			row.check:SetChecked(Selected(category))
			local label = category.label or category.id
			if category.sensitive then label = label .. "  [Private]" end
			if category.available == false then label = label .. "  [Unavailable]" end
			row.label:SetText(label)
			row.label:SetTextColor(unpack(UI.colors[(category.sensitive or category.available == false) and "warning" or (Selected(category) and "accent" or "text")]))
			row.description:SetText(category.available == false and (category.reason or "Source unavailable; your saved choice is kept.")
				or ((category.queryOnly and "On request only. " or "") .. (category.description or category.id)))
			row:Paint()
			row:Show()
		elseif row then
			row.category = nil
			row:Hide()
		end
	end
	for slot = visible + 1, #panel.rows do
		panel.rows[slot].category = nil
		panel.rows[slot]:Hide()
	end
end

FilterCategories = function(resetScroll)
	if not panel then return end
	HideTooltip()
	local search = string.lower(panel.search:GetText() or "")
	panel.filtered = {}
	local counts = { character = 0, private = 0, advanced = 0, selected = 0 }
	for _, entry in ipairs(catalog or {}) do
		local selected = Selected(entry.category)
		counts[entry.view] = counts[entry.view] + 1
		if selected then counts.selected = counts.selected + 1 end
		if (panel.view == entry.view or (panel.view == "selected" and selected)) and
			(search == "" or string.find(entry.search, search, 1, true)) then
			panel.filtered[#panel.filtered + 1] = entry.category
		end
	end
	for _, view in ipairs(views) do
		local tab = panel.tabs[view.id]
		tab:SetText(view.label .. " (" .. counts[view.id] .. ")")
		tab.restoreAppearance()
	end
	panel.count:SetText(counts.selected .. " selected     ·     " .. #panel.filtered .. " in this view")
	panel.empty:SetText(search ~= "" and "No permissions match this search in this view."
		or (panel.view == "selected" and "No permissions selected. Choose categories in the other views."
		or (panel.view == "advanced" and "No documented API scopes available on this client. Reopen after addons load."
		or "No permissions available in this view.")))
	panel.empty:SetShown(#panel.filtered == 0)
	local enabled = MasterEnabled()
	panel.master:SetChecked(enabled)
	panel.master:SetBackdropBorderColor(unpack(UI.colors[enabled and "accent" or "border"]))
	panel.masterTitle:SetText(enabled and "Sharing on" or "Sharing paused")
	panel.masterTitle:SetTextColor(unpack(UI.colors[enabled and "success" or "warning"]))
	panel.masterStatus:SetText(enabled and "The AI can read your selected information. Changes save immediately."
		or "All reads are blocked. Your choices stay saved and editable.")
	local preset = WowieContext.GetPreset()
	UI.SetSelected(panel.recommended, preset == "recommended")
	UI.SetSelected(panel.minimal, preset == "minimal")
	panel.presetStatus:SetText(preset == "recommended" and "Character, gear, bags, quests, action bars and optional prices."
		or (preset == "minimal" and "Identity and location only."
		or ("Custom: " .. counts.selected .. " categories. Choosing a preset replaces these choices.")))
	local delivery = WowieContext.GetDelivery()
	UI.SetSelected(panel.smart, delivery == "smart")
	UI.SetSelected(panel.full, delivery == "full")
	panel.deliverySummary:SetText(delivery == "smart"
		and "Essentials travel with your question; other selected information is read on request."
		or "Selected information travels with every question. Prices and APIs stay on request.")
	local private = counts.private
	local selectedPrivate, selectedAdvanced = 0, 0
	local auctionator
	for _, entry in ipairs(catalog or {}) do
		if entry.category.id == "auctionator" then auctionator = entry.category end
		if Selected(entry.category) then
			if entry.view == "private" then selectedPrivate = selectedPrivate + 1 end
			if entry.view == "advanced" then selectedAdvanced = selectedAdvanced + 1 end
		end
	end
	panel.privacy:SetText((selectedPrivate == 0 and selectedAdvanced == 0)
		and "Private information and broad API access are off. Review individual choices in Customize."
		or ("Private access: " .. selectedPrivate .. "/" .. private .. " categories · API access: " .. selectedAdvanced .. " scopes."))
	panel.privacy:SetTextColor(unpack(UI.colors[(selectedPrivate > 0 or selectedAdvanced > 0) and "warning" or "muted"]))
	local auctionStatus = not auctionator and "Unavailable on this client."
		or (auctionator.available == false and ("Unavailable: " .. (auctionator.reason or "No supported cached prices found."))
		or "Available: cached prices/history only, never scans or trading.")
	panel.auctionator:SetText("Optional Auctionator — " .. auctionStatus ..
		(auctionator and (Selected(auctionator) and " Permission saved: on." or " Permission: off.") or ""))
	panel.auctionator:SetTextColor(unpack(UI.colors[(not auctionator or auctionator.available == false) and "warning" or "muted"]))
	panel.content:SetWidth(math.max(1, panel.scroll:GetWidth() - 4))
	panel.content:SetHeight(math.max(1, #panel.filtered * ROW_HEIGHT))
	local maximum = math.max(0, #panel.filtered * ROW_HEIGHT - panel.scroll:GetHeight())
	panel.scroll:SetVerticalScroll(resetScroll and 0 or math.min(panel.scroll:GetVerticalScroll(), maximum))
	RenderRows()
end

local function RefreshCategories(resetScroll)
	LoadCatalog()
	FilterCategories(resetScroll)
end

-- Expanded mode replaces the overview instead of stacking a list below it.
local function FitPanel()
	local width = math.max(640, math.min(760, UIParent:GetWidth() - 24))
	local height = panel.expanded and math.max(520, math.min(840, UIParent:GetHeight() - 24)) or 432
	UI.FitPanel(panel, width, height)
	panel.masterCard:SetHeight(panel.expanded and 40 or 64)
	panel.masterStatus:SetShown(not panel.expanded)
	for _, control in ipairs(panel.overview) do control:SetShown(not panel.expanded) end
	panel.details:SetSize(width - 32, height - 160)
	panel.scroll:SetSize(width - 54, math.max(1, height - 264))
	local tabWidth = (width - 56) / 4
	for _, tab in pairs(panel.tabs) do tab:SetWidth(tabWidth) end
	panel.details:SetShown(panel.expanded)
	panel.scroll:SetShown(panel.expanded)
	panel.clear:SetShown(panel.expanded)
	if not panel.expanded then
		panel.scroll.bar:Hide()
		panel.search:ClearFocus()
		HideTooltip()
	end
	panel.customize:SetText(panel.expanded and "Back to overview" or "Customize...")
	UI.SetSelected(panel.customize, panel.expanded)
end

local function CreatePanel()
	panel = CreateFrame("Frame", "WowieContextPermissions", UIParent, "BackdropTemplate")
	panel:SetPoint("CENTER")
	panel:SetFrameStrata("FULLSCREEN_DIALOG")
	panel:SetToplevel(true)
	panel:SetClampedToScreen(true)
	panel:EnableMouse(true)
	panel:SetMovable(true)
	UI.Window(panel, 48)
	panel.header = CreateFrame("Frame", "WowieContextHeader", panel)
	panel.header:SetPoint("TOPLEFT", panel, "TOPLEFT", 0, 0)
	panel.header:SetPoint("TOPRIGHT", panel, "TOPRIGHT", -104, 0)
	panel.header:SetHeight(48)
	panel.header:EnableMouse(true)
	panel.header:RegisterForDrag("LeftButton")
	panel.header:SetScript("OnDragStart", function() UI.RaisePanel(panel); panel:StartMoving() end)
	panel.header:SetScript("OnDragStop", function() panel:StopMovingOrSizing() end)
	table.insert(UISpecialFrames, "WowieContextPermissions")
	panel.rows, panel.filtered, panel.tabs = {}, {}, {}
	panel.view, panel.expanded = "character", false

	local title = UI.Title(panel.header, "Sharing", 20)
	title:SetPoint("TOPLEFT", panel.header, "TOPLEFT", 20, -14)
	local close = UI.Button(panel, "Close", 72, function() panel:Hide() end, "quiet")
	close:SetPoint("TOPRIGHT", panel, "TOPRIGHT", -16, -14)

	local masterCard = CreateFrame("Frame", nil, panel, "BackdropTemplate")
	panel.masterCard = masterCard
	UI.Surface(masterCard)
	masterCard:SetPoint("TOPLEFT", panel, "TOPLEFT", 16, -56)
	masterCard:SetPoint("TOPRIGHT", panel, "TOPRIGHT", -16, -56)
	masterCard:SetHeight(64)
	panel.master = CreateFrame("CheckButton", "WowieContextMaster", masterCard, "BackdropTemplate")
	UI.Surface(panel.master, "raised")
	panel.master:SetSize(26, 26)
	panel.master:SetPoint("TOPLEFT", masterCard, "TOPLEFT", 12, -7)
	panel.master:SetCheckedTexture("Interface\\Buttons\\UI-CheckBox-Check")
	panel.master:SetScript("OnClick", function(self)
		Wowie.SetContextEnabled(self:GetChecked() and true or false)
		FilterCategories(false)
		NotifyChanged()
	end)
	UI.Tooltip(panel.master, "Master sharing permission", "Pause to block all context reads without losing your choices. Presets and customization remain editable while paused.")
	panel.masterTitle = UI.Label(masterCard, "", 15)
	panel.masterTitle:SetPoint("TOPLEFT", masterCard, "TOPLEFT", 50, -10)
	panel.masterStatus = UI.Label(masterCard, "", 12, "muted")
	panel.masterStatus:SetPoint("TOPLEFT", masterCard, "TOPLEFT", 50, -31)
	panel.masterStatus:SetPoint("TOPRIGHT", masterCard, "TOPRIGHT", -12, -31)
	panel.masterStatus:SetHeight(28)

	local function Preset(id)
		if WowieContext.ApplyPreset(id) then
			RefreshCategories(true)
			NotifyChanged()
		end
	end
	panel.recommended = UI.Button(panel, "Recommended", 180, function() Preset("recommended") end, "secondary", "WowieContextRecommended")
	panel.recommended:SetPoint("TOPLEFT", panel, "TOPLEFT", 16, -136)
	UI.Tooltip(panel.recommended, "Recommended", "Allow useful character information, including action bars and keybinds. Private/social information, macro bodies and advanced API scopes are off. Replaces current choices, not your paused or delivery setting.")
	panel.minimal = UI.Button(panel, "Minimal", 150, function() Preset("minimal") end, "secondary", "WowieContextMinimal")
	panel.minimal:SetPoint("LEFT", panel.recommended, "RIGHT", 8, 0)
	UI.Tooltip(panel.minimal, "Minimal", "Allow identity and location only. Replaces current choices, not your paused or delivery setting.")
	panel.presetStatus = UI.Label(panel, "", 11, "muted")
	panel.presetStatus:SetPoint("TOPLEFT", panel, "TOPLEFT", 20, -176)
	panel.presetStatus:SetPoint("TOPRIGHT", panel, "TOPRIGHT", -20, -176)
	panel.presetStatus:SetHeight(32)
	panel.deliverySummary = UI.Label(panel, "", 12, "muted")
	panel.deliverySummary:SetPoint("TOPLEFT", panel, "TOPLEFT", 20, -256)
	panel.deliverySummary:SetPoint("TOPRIGHT", panel, "TOPRIGHT", -20, -256)
	panel.deliverySummary:SetHeight(32)
	panel.auctionator = UI.Label(panel, "", 11, "muted")
	panel.auctionator:SetPoint("TOPLEFT", panel, "TOPLEFT", 20, -296)
	panel.auctionator:SetPoint("TOPRIGHT", panel, "TOPRIGHT", -20, -296)
	panel.auctionator:SetHeight(32)
	panel.privacy = UI.Label(panel, "", 12, "muted")
	panel.privacy:SetPoint("TOPLEFT", panel, "TOPLEFT", 20, -336)
	panel.privacy:SetPoint("TOPRIGHT", panel, "TOPRIGHT", -20, -336)
	panel.privacy:SetHeight(32)
	panel.customize = UI.Button(panel, "Customize...", 180, function()
		panel.expanded = not panel.expanded
		FitPanel()
		RefreshCategories(false)
	end, "secondary", "WowieContextCustomize")
	panel.customize:SetPoint("BOTTOMLEFT", panel, "BOTTOMLEFT", 16, 16)
	local done = UI.Button(panel, "Done", 88, function() panel:Hide() end, "secondary", "WowieContextClose")
	done:SetPoint("BOTTOMRIGHT", panel, "BOTTOMRIGHT", -16, 16)

	panel.details = CreateFrame("Frame", "WowieContextDetails", panel)
	panel.details:SetPoint("TOPLEFT", panel, "TOPLEFT", 16, -104)
	local function Delivery(mode)
		if WowieContext.SetDelivery(mode) then
			FilterCategories(false)
			NotifyChanged()
		end
	end
	panel.smart = UI.Button(panel, "Smart / on request", 180, function() Delivery("smart") end, "secondary", "WowieContextDeliverySmart")
	panel.smart:SetPoint("TOPLEFT", panel, "TOPLEFT", 16, -216)
	panel.full = UI.Button(panel, "Full snapshot", 150, function() Delivery("full") end, "secondary", "WowieContextDeliveryFull")
	panel.full:SetPoint("LEFT", panel.smart, "RIGHT", 8, 0)
	UI.Tooltip(panel.smart, "Smart delivery", "Send essentials with each question. The AI can request any selected category; permissions do not change.")
	UI.Tooltip(panel.full, "Full delivery", "Attach selected information to each question. Auctionator and API scopes remain on request.")
	panel.overview = { panel.recommended, panel.minimal, panel.presetStatus, panel.smart, panel.full,
		panel.deliverySummary, panel.auctionator, panel.privacy }

	local previous
	for _, view in ipairs(views) do
		local viewID = view.id
		local tab = UI.Button(panel.details, view.label, 160, function()
			panel.view = viewID
			FilterCategories(true)
		end, "secondary", view.control)
		panel.tabs[viewID] = tab
		tab.restoreAppearance = function() UI.SetSelected(tab, panel.view == viewID) end
		if previous then tab:SetPoint("LEFT", previous, "RIGHT", 8, 0)
		else tab:SetPoint("TOPLEFT", panel.details, "TOPLEFT", 0, 0) end
		previous = tab
	end

	local searchLabel = UI.Label(panel.details, "Filter this view", 12, "muted")
	searchLabel:SetPoint("TOPLEFT", panel.details, "TOPLEFT", 4, -49)
	panel.search = CreateFrame("EditBox", "WowieContextSearch", panel.details, "BackdropTemplate")
	UI.Input(panel.search)
	panel.search:SetPoint("TOPLEFT", panel.details, "TOPLEFT", 104, -40)
	panel.search:SetPoint("TOPRIGHT", panel.details, "TOPRIGHT", -68, -40)
	panel.search:SetHeight(32)
	panel.search:SetFont(UI.font, 13, "")
	panel.search:SetTextInsets(9, 9, 0, 0)
	panel.search:SetAutoFocus(false)
	panel.search:SetMaxLetters(160)
	panel.search:SetScript("OnTextChanged", function() FilterCategories(true) end)
	panel.search:SetScript("OnEscapePressed", function(self) self:ClearFocus() end)
	panel.search:SetScript("OnEnterPressed", function(self) self:ClearFocus() end)
	local clearSearch = UI.Button(panel.details, "Clear", 60, function()
		panel.search:SetText("")
	end, "quiet", "WowieContextClearSearch")
	clearSearch:SetPoint("TOPRIGHT", panel.details, "TOPRIGHT", 0, -40)
	panel.count = UI.Label(panel.details, "", 12, "muted")
	panel.count:SetPoint("TOPLEFT", panel.details, "TOPLEFT", 4, -80)

	panel.scroll = UI.ScrollFrame(panel.details, "WowieContextScroll")
	panel.scroll:SetPoint("TOPLEFT", panel.details, "TOPLEFT", 0, -104)
	panel.content = CreateFrame("Frame", nil, panel.scroll)
	panel.content:SetSize(726, 1)
	panel.scroll:SetScrollChild(panel.content)
	panel.scroll:HookScript("OnVerticalScroll", function()
		HideTooltip()
		RenderRows()
	end)
	panel.scroll:HookScript("OnSizeChanged", function()
		FilterCategories(false)
	end)
	panel.empty = UI.Label(panel.details, "", 13, "muted")
	panel.empty:SetPoint("TOPLEFT", panel.scroll, "TOPLEFT", 12, -16)
	panel.empty:SetPoint("TOPRIGHT", panel.scroll, "TOPRIGHT", -12, -16)
	panel.empty:SetHeight(48)

	local clear = UI.Button(panel, "Clear all choices", 150, function()
		-- Reset first to discard scopes whose documentation is unavailable.
		WowieContext.ResetDefaults()
		for _, category in ipairs(WowieContext.Categories()) do
			WowieContext.SetEnabled(category.id, false)
		end
		RefreshCategories(true)
		NotifyChanged()
	end, "danger", "WowieContextClear")
	clear:SetPoint("BOTTOMRIGHT", panel, "BOTTOMRIGHT", -112, 16)
	UI.Tooltip(clear, "Clear all choices", "Turn off all category permissions and discard saved unavailable scopes. Sharing and delivery settings are unchanged.")
	panel.clear = clear
	panel:SetScript("OnHide", function()
		panel.search:ClearFocus()
		HideTooltip()
	end)
	UIParent:HookScript("OnSizeChanged", function()
		if panel:IsShown() then
			FitPanel()
			FilterCategories(false)
		end
	end)
	panel:Hide()
end

function WowieContextUI.Show()
	if not panel then CreatePanel() end
	FitPanel()
	RefreshCategories(false)
	panel:Show()
	UI.RaisePanel(panel)
	RenderRows()
	NotifyChanged()
end
