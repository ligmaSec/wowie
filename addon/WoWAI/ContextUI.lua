-- Permission editing is local: the bridge need not be connected.
WoWAIContextUI = WoWAIContextUI or {}

local UI = WoWAI.UI
local unpack = unpack or table.unpack
local panel
local catalog
local ROW_HEIGHT = 64
local views = {
	{ id = "character", label = "Character", control = "WoWAIContextTabCharacter", width = 150 },
	{ id = "private", label = "Private / Social", control = "WoWAIContextTabPrivate", width = 192 },
	{ id = "advanced", label = "Advanced API", control = "WoWAIContextTabAdvanced", width = 176 },
	{ id = "selected", label = "Selected", control = "WoWAIContextTabSelected", width = 144 },
}

local function MasterEnabled()
	return not WoWAIDB or not WoWAIDB.settings or WoWAIDB.settings.context ~= false
end

local function LoadCatalog()
	catalog = {}
	for _, category in ipairs(WoWAIContext.Categories()) do
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
	local sharing = WoWAIDB and WoWAIDB.settings and WoWAIDB.settings.sharing
	if sharing and sharing[category.id] ~= nil then return sharing[category.id] == true end
	return category.enabled == true
end

-- Categories reads metadata only. Discover once before the panel is opened,
-- then refresh on Show, not whenever the workspace refreshes its status badge.
function WoWAIContextUI.Summary()
	if not catalog then LoadCatalog() end
	local selected = 0
	for _, entry in ipairs(catalog) do
		if Selected(entry.category) then selected = selected + 1 end
	end
	return { enabled = MasterEnabled(), selected = selected, total = #catalog }
end

local function NotifyChanged()
	if WoWAI.UpdateSharingSummary then WoWAI.UpdateSharingSummary() end
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
		GameTooltip:AddLine("Sensitive / broad access: this permission may expose private information or overlap other categories.", 0.96, 0.72, 0.36, true)
	end
	if category.id:sub(1, 4) == "api:" then
		GameTooltip:AddLine("Query-only: not collected automatically. Mail-body getters still require the separate mail-body permission.", 0.58, 0.65, 0.74, true)
	end
	if Selected(category) and MasterEnabled() then
		GameTooltip:AddLine("Selected: queries are allowed.", 0.32, 0.81, 0.59, true)
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
	row.description:SetJustifyV("TOP")
	local function Toggle()
		-- Resolve from the reused row at click time, never a former slot/index.
		if not row.category then return end
		if WoWAIContext.SetEnabled(row.category.id, not Selected(row.category)) then
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
	return row
end

-- Only viewport-sized rows are allocated, even for hundreds of API scopes.
RenderRows = function()
	if not panel or not panel.filtered then return end
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
			if category.sensitive then label = label .. "  [Sensitive]" end
			row.label:SetText(label)
			row.label:SetTextColor(unpack(UI.colors[category.sensitive and "warning" or "text"]))
			row.description:SetText(category.description or category.id)
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
	panel.count:SetText(counts.selected .. " selected / " .. #(catalog or {}) .. " available     ·     " .. #panel.filtered .. " shown")
	panel.empty:SetText(search ~= "" and "No permissions match this search in this view."
		or (panel.view == "selected" and "No permissions selected. Choose categories in the other views."
		or (panel.view == "advanced" and "No documented API scopes available on this client. Reopen after addons load."
		or "No permissions available in this view.")))
	panel.empty:SetShown(#panel.filtered == 0)
	local enabled = MasterEnabled()
	panel.master:SetChecked(enabled)
	panel.masterTitle:SetText(enabled and "Sharing on" or "Sharing paused")
	panel.masterTitle:SetTextColor(unpack(UI.colors[enabled and "success" or "warning"]))
	panel.masterStatus:SetText(enabled and "Only checked permissions allow access. Unchecked categories remain private."
		or "All context access is blocked. Your checkmarks are kept and remain editable.")
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

local function CreatePanel()
	panel = CreateFrame("Frame", "WoWAIContextPermissions", UIParent, "BackdropTemplate")
	panel:SetSize(780, 720)
	panel:SetScale(math.min(1, math.max(1, UIParent:GetWidth() - 24) / 780, math.max(1, UIParent:GetHeight() - 24) / 720))
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
	table.insert(UISpecialFrames, "WoWAIContextPermissions")
	panel.rows, panel.filtered, panel.tabs = {}, {}, {}
	panel.view = "character"

	local title = UI.Label(panel, "Sharing", 20)
	title:SetPoint("TOPLEFT", panel, "TOPLEFT", 20, -18)
	local close = UI.Button(panel, "Close", 72, function() panel:Hide() end, "quiet")
	close:SetPoint("TOPRIGHT", panel, "TOPRIGHT", -16, -14)
	local description = UI.Label(panel, "Choose what the AI may read. Permissions save immediately, even while disconnected.", 12, "muted")
	description:SetPoint("TOPLEFT", panel, "TOPLEFT", 20, -52)
	description:SetPoint("TOPRIGHT", panel, "TOPRIGHT", -20, -52)
	description:SetHeight(24)

	local masterCard = CreateFrame("Frame", nil, panel, "BackdropTemplate")
	UI.Surface(masterCard)
	masterCard:SetPoint("TOPLEFT", panel, "TOPLEFT", 16, -86)
	masterCard:SetPoint("TOPRIGHT", panel, "TOPRIGHT", -16, -86)
	masterCard:SetHeight(68)
	panel.master = CreateFrame("CheckButton", "WoWAIContextMaster", masterCard, "BackdropTemplate")
	UI.Surface(panel.master, "raised")
	panel.master:SetSize(26, 26)
	panel.master:SetPoint("TOPLEFT", masterCard, "TOPLEFT", 12, -14)
	panel.master:SetCheckedTexture("Interface\\Buttons\\UI-CheckBox-Check")
	panel.master:SetScript("OnClick", function(self)
		WoWAI.SetContextEnabled(self:GetChecked() and true or false)
		FilterCategories(false)
		NotifyChanged()
	end)
	UI.Tooltip(panel.master, "Master sharing permission", "Pause to block all context reads without losing your choices. Category permissions remain editable while paused.")
	panel.masterTitle = UI.Label(masterCard, "", 15)
	panel.masterTitle:SetPoint("TOPLEFT", masterCard, "TOPLEFT", 50, -12)
	panel.masterStatus = UI.Label(masterCard, "", 12, "muted")
	panel.masterStatus:SetPoint("TOPLEFT", masterCard, "TOPLEFT", 50, -35)
	panel.masterStatus:SetPoint("TOPRIGHT", masterCard, "TOPRIGHT", -12, -35)
	panel.masterStatus:SetHeight(28)

	local privacy = UI.Label(panel, "Checkmark = permission. Sensitive / broad scopes may expose private data. Advanced API scopes are query-only. Mail-body access is separate; reading message bodies marks mail as read.", 12, "muted")
	privacy:SetPoint("TOPLEFT", panel, "TOPLEFT", 20, -166)
	privacy:SetPoint("TOPRIGHT", panel, "TOPRIGHT", -20, -166)
	privacy:SetHeight(44)
	privacy:SetJustifyV("TOP")

	local previous
	for _, view in ipairs(views) do
		local viewID = view.id
		local tab = UI.Button(panel, view.label, view.width, function()
			panel.view = viewID
			FilterCategories(true)
		end, "secondary", view.control)
		panel.tabs[viewID] = tab
		tab.restoreAppearance = function()
			local selected = panel.view == viewID
			UI.Surface(tab, selected and "raised" or "surface")
			tab:GetFontString():SetTextColor(unpack(UI.colors[selected and "accent" or "text"]))
		end
		tab:HookScript("OnEnter", tab.restoreAppearance)
		tab:HookScript("OnLeave", tab.restoreAppearance)
		tab:HookScript("OnMouseUp", tab.restoreAppearance)
		if previous then tab:SetPoint("LEFT", previous, "RIGHT", 8, 0)
		else tab:SetPoint("TOPLEFT", panel, "TOPLEFT", 16, -220) end
		previous = tab
	end

	local searchLabel = UI.Label(panel, "Filter this view", 12, "muted")
	searchLabel:SetPoint("TOPLEFT", panel, "TOPLEFT", 20, -273)
	panel.search = CreateFrame("EditBox", "WoWAIContextSearch", panel, "BackdropTemplate")
	UI.Surface(panel.search, "raised")
	panel.search:SetPoint("TOPLEFT", panel, "TOPLEFT", 120, -264)
	panel.search:SetPoint("TOPRIGHT", panel, "TOPRIGHT", -84, -264)
	panel.search:SetHeight(32)
	panel.search:SetFontObject(ChatFontNormal)
	panel.search:SetTextInsets(9, 9, 0, 0)
	panel.search:SetAutoFocus(false)
	panel.search:SetMaxLetters(160)
	panel.search:SetScript("OnTextChanged", function() FilterCategories(true) end)
	panel.search:SetScript("OnEscapePressed", function() panel:Hide() end)
	panel.search:SetScript("OnEnterPressed", function(self) self:ClearFocus() end)
	local clearSearch = UI.Button(panel, "Clear", 60, function()
		panel.search:SetText("")
	end, "quiet", "WoWAIContextClearSearch")
	clearSearch:SetPoint("TOPRIGHT", panel, "TOPRIGHT", -16, -264)
	panel.count = UI.Label(panel, "", 12, "muted")
	panel.count:SetPoint("TOPLEFT", panel, "TOPLEFT", 20, -308)

	panel.scroll = UI.ScrollFrame(panel, "WoWAIContextScroll")
	panel.scroll:SetPoint("TOPLEFT", panel, "TOPLEFT", 16, -334)
	panel.scroll:SetPoint("BOTTOMRIGHT", panel, "BOTTOMRIGHT", -34, 130)
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
	panel.empty = UI.Label(panel, "", 13, "muted")
	panel.empty:SetPoint("TOPLEFT", panel.scroll, "TOPLEFT", 12, -16)
	panel.empty:SetPoint("TOPRIGHT", panel.scroll, "TOPRIGHT", -12, -16)
	panel.empty:SetHeight(48)

	local note = UI.Label(panel, "Saved immediately. Changes apply to future snapshots and current queries. Already-sent information cannot be recalled. Common defaults never enable sensitive permissions; Clear choices also removes saved unavailable scopes.", 12, "muted")
	note:SetPoint("BOTTOMLEFT", panel, "BOTTOMLEFT", 20, 60)
	note:SetPoint("BOTTOMRIGHT", panel, "BOTTOMRIGHT", -20, 60)
	note:SetHeight(56)
	local defaults = UI.Button(panel, "Common defaults", 150, function()
		WoWAIContext.ResetDefaults()
		RefreshCategories(false)
		NotifyChanged()
	end, "secondary", "WoWAIContextDefaults")
	defaults:SetPoint("BOTTOMLEFT", panel, "BOTTOMLEFT", 16, 18)
	local clear = UI.Button(panel, "Clear choices", 128, function()
		-- Reset first to discard scopes whose documentation is unavailable.
		WoWAIContext.ResetDefaults()
		for _, category in ipairs(WoWAIContext.Categories()) do
			WoWAIContext.SetEnabled(category.id, false)
		end
		RefreshCategories(false)
		NotifyChanged()
	end, "danger", "WoWAIContextClear")
	clear:SetPoint("LEFT", defaults, "RIGHT", 8, 0)
	local done = UI.Button(panel, "Close", 88, function() panel:Hide() end, "secondary", "WoWAIContextClose")
	done:SetPoint("BOTTOMRIGHT", panel, "BOTTOMRIGHT", -16, 18)
	panel:SetScript("OnHide", function()
		panel.search:ClearFocus()
		HideTooltip()
	end)
	panel:Hide()
end

function WoWAIContextUI.Show()
	if not panel then CreatePanel() end
	RefreshCategories(false)
	panel:Show()
	panel:Raise()
	RenderRows()
	NotifyChanged()
end
