-- Permission editing is local: the bridge need not be connected.
WoWAIContextUI = WoWAIContextUI or {}

local panel
local ROW_HEIGHT = 68
local BACKDROP = {
	bgFile = "Interface\\Tooltips\\UI-Tooltip-Background",
	edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
	tile = true, tileSize = 16, edgeSize = 16,
	insets = { left = 4, right = 4, top = 4, bottom = 4 },
}

local function MasterEnabled()
	return not WoWAIDB or not WoWAIDB.settings or WoWAIDB.settings.context ~= false
end

local function HideTooltip()
	if GameTooltip then GameTooltip:Hide() end
end

local function CategoryTooltip(row)
	local category = row.category
	if not category or not GameTooltip then return end
	GameTooltip:SetOwner(row, "ANCHOR_RIGHT")
	GameTooltip:SetText(category.label or category.id)
	GameTooltip:AddLine(category.id, 0.65, 0.65, 0.65, true)
	GameTooltip:AddLine(category.description or "", 1, 1, 1, true)
	if category.sensitive then
		GameTooltip:AddLine("Sensitive / broad access: enable only if you want the AI to read this information.", 1, 0.65, 0.3, true)
	end
	if WoWAIContext.IsEnabled(category.id) then
		GameTooltip:AddLine("Queries are currently allowed for this category.", 0.4, 1, 0.4, true)
	elseif category.enabled and not MasterEnabled() then
		GameTooltip:AddLine("Selected, but sharing is paused. Queries are blocked until sharing resumes.", 1, 0.8, 0.3, true)
	else
		GameTooltip:AddLine("Queries are currently blocked for this category.", 0.8, 0.8, 0.8, true)
	end
	GameTooltip:AddLine("Changes affect future snapshots and current queries, not information already sent.", 0.8, 0.8, 0.8, true)
	GameTooltip:Show()
end

local RefreshCategories
local RenderRows

local function MakeRow()
	local row = CreateFrame("Button", nil, panel.content)
	row:SetHeight(ROW_HEIGHT)
	row.check = CreateFrame("CheckButton", nil, row, "UICheckButtonTemplate")
	row.check:SetSize(26, 26)
	row.check:SetPoint("TOPLEFT", row, "TOPLEFT", 0, 0)
	row.label = row:CreateFontString(nil, "OVERLAY", "GameFontNormal")
	row.label:SetPoint("TOPLEFT", row, "TOPLEFT", 32, -5)
	row.label:SetPoint("TOPRIGHT", row, "TOPRIGHT", -6, -5)
	row.label:SetHeight(16)
	row.label:SetJustifyH("LEFT")
	row.description = row:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
	row.description:SetPoint("TOPLEFT", row, "TOPLEFT", 32, -24)
	row.description:SetPoint("TOPRIGHT", row, "TOPRIGHT", -6, -24)
	row.description:SetHeight(36)
	row.description:SetJustifyH("LEFT")
	row.description:SetJustifyV("TOP")
	local function Toggle()
		if not row.category then return end
		WoWAIContext.SetEnabled(row.category.id, not row.category.enabled)
		RefreshCategories(false)
	end
	row:SetScript("OnClick", Toggle)
	row.check:SetScript("OnClick", Toggle)
	row:SetScript("OnEnter", function() CategoryTooltip(row) end)
	row.check:SetScript("OnEnter", function() CategoryTooltip(row) end)
	row:SetScript("OnLeave", HideTooltip)
	row.check:SetScript("OnLeave", HideTooltip)
	return row
end

-- Reuse only viewport-sized rows even when API documentation exposes hundreds
-- of namespaces. The scroll child still represents the entire filtered catalog.
RenderRows = function()
	if not panel or not panel.filtered then return end
	local width = math.max(1, panel.scroll:GetWidth() - 4)
	local height = math.max(1, panel.scroll:GetHeight())
	local first = math.floor(panel.scroll:GetVerticalScroll() / ROW_HEIGHT) + 1
	local visible = math.ceil(height / ROW_HEIGHT) + 1
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
			row.check:SetChecked(category.enabled == true)
			local label = category.label or category.id
			if category.sensitive then label = "|cffffaa55[Sensitive]|r " .. label end
			row.label:SetText(label)
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

local function FilterCategories(resetScroll)
	local search = string.lower(panel.search:GetText() or "")
	panel.filtered = {}
	local selected = 0
	for _, entry in ipairs(panel.catalog) do
		local category = entry.category
		if category.enabled then selected = selected + 1 end
		if search == "" or string.find(entry.search, search, 1, true) then
			panel.filtered[#panel.filtered + 1] = category
		end
	end
	panel.count:SetText(#panel.filtered .. " / " .. #panel.catalog .. " categories; " .. selected .. " selected")
	panel.empty:SetShown(#panel.filtered == 0)
	panel.content:SetWidth(math.max(1, panel.scroll:GetWidth() - 4))
	panel.content:SetHeight(math.max(1, #panel.filtered * ROW_HEIGHT))
	if resetScroll then
		panel.scroll:SetVerticalScroll(0)
	else
		local maximum = math.max(0, #panel.filtered * ROW_HEIGHT - panel.scroll:GetHeight())
		panel.scroll:SetVerticalScroll(math.min(panel.scroll:GetVerticalScroll(), maximum))
	end
	RenderRows()
end

RefreshCategories = function(resetScroll)
	panel.catalog = {}
	for _, category in ipairs(WoWAIContext.Categories()) do
		panel.catalog[#panel.catalog + 1] = {
			category = category,
			search = string.lower((category.label or "") .. " " .. category.id .. " " ..
				(category.description or "") .. (category.sensitive and " sensitive" or "")),
		}
	end
	local enabled = MasterEnabled()
	panel.master:SetChecked(enabled)
	panel.masterStatus:SetText(enabled
		and "Sharing is on. Only selected categories are allowed. Sensitive / broad scopes are marked below."
		or "Sharing is paused. Queries are blocked; your category choices are kept and can still be edited.")
	FilterCategories(resetScroll)
end

local function MakeButton(parent, text, width, onClick)
	local button = CreateFrame("Button", nil, parent, "UIPanelButtonTemplate")
	button:SetSize(width, 24)
	button:SetText(text)
	button:SetScript("OnClick", onClick)
	return button
end

local function CreatePanel()
	panel = CreateFrame("Frame", "WoWAIContextPermissions", UIParent, "BackdropTemplate")
	panel:SetSize(650, 620)
	panel:SetPoint("CENTER")
	panel:SetFrameStrata("DIALOG")
	panel:SetToplevel(true)
	panel:SetClampedToScreen(true)
	panel:EnableMouse(true)
	panel:SetMovable(true)
	panel:RegisterForDrag("LeftButton")
	panel:SetScript("OnDragStart", panel.StartMoving)
	panel:SetScript("OnDragStop", panel.StopMovingOrSizing)
	panel:SetBackdrop(BACKDROP)
	panel:SetBackdropColor(0.05, 0.05, 0.07, 0.98)
	panel:SetBackdropBorderColor(0.6, 0.6, 0.6, 1)
	table.insert(UISpecialFrames, "WoWAIContextPermissions")
	panel.rows = {}
	panel.catalog = {}
	panel.filtered = {}

	local title = panel:CreateFontString(nil, "OVERLAY", "GameFontNormalLarge")
	title:SetPoint("TOPLEFT", panel, "TOPLEFT", 16, -16)
	title:SetText("AI context permissions")
	local close = MakeButton(panel, "X", 26, function() panel:Hide() end)
	close:SetPoint("TOPRIGHT", panel, "TOPRIGHT", -12, -12)
	local description = panel:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
	description:SetPoint("TOPLEFT", panel, "TOPLEFT", 16, -46)
	description:SetPoint("TOPRIGHT", panel, "TOPRIGHT", -16, -46)
	description:SetHeight(30)
	description:SetJustifyH("LEFT")
	description:SetText("Choose what the AI may read. Native API scopes are discovered from this client; hover a category for details. No bridge connection is needed to edit permissions.")

	panel.master = CreateFrame("CheckButton", nil, panel, "UICheckButtonTemplate")
	panel.master:SetSize(26, 26)
	panel.master:SetPoint("TOPLEFT", panel, "TOPLEFT", 14, -80)
	local masterLabel = panel.master:CreateFontString(nil, "OVERLAY", "GameFontNormal")
	masterLabel:SetPoint("LEFT", panel.master, "RIGHT", 4, 0)
	masterLabel:SetText("Share selected context with the AI")
	panel.master:SetScript("OnClick", function(self)
		WoWAI.SetContextEnabled(self:GetChecked() and true or false)
		RefreshCategories(false)
	end)
	panel.masterStatus = panel:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
	panel.masterStatus:SetPoint("TOPLEFT", panel, "TOPLEFT", 18, -110)
	panel.masterStatus:SetPoint("TOPRIGHT", panel, "TOPRIGHT", -16, -110)
	panel.masterStatus:SetHeight(30)
	panel.masterStatus:SetJustifyH("LEFT")

	local searchLabel = panel:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
	searchLabel:SetPoint("TOPLEFT", panel, "TOPLEFT", 18, -148)
	searchLabel:SetText("Search:")
	panel.search = CreateFrame("EditBox", "WoWAIContextSearch", panel, "InputBoxTemplate")
	panel.search:SetPoint("TOPLEFT", panel, "TOPLEFT", 76, -141)
	panel.search:SetPoint("TOPRIGHT", panel, "TOPRIGHT", -24, -141)
	panel.search:SetHeight(26)
	panel.search:SetAutoFocus(false)
	panel.search:SetMaxLetters(160)
	panel.search:SetScript("OnTextChanged", function() FilterCategories(true) end)
	panel.search:SetScript("OnEscapePressed", function() panel:Hide() end)
	panel.search:SetScript("OnEnterPressed", function(self) self:ClearFocus() end)
	panel.count = panel:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
	panel.count:SetPoint("TOPLEFT", panel, "TOPLEFT", 18, -174)

	panel.scroll = CreateFrame("ScrollFrame", "WoWAIContextScroll", panel, "UIPanelScrollFrameTemplate")
	panel.scroll:SetPoint("TOPLEFT", panel, "TOPLEFT", 16, -194)
	panel.scroll:SetPoint("BOTTOMRIGHT", panel, "BOTTOMRIGHT", -34, 102)
	panel.content = CreateFrame("Frame", nil, panel.scroll)
	panel.content:SetSize(590, 1)
	panel.scroll:SetScrollChild(panel.content)
	panel.scroll:HookScript("OnVerticalScroll", function()
		HideTooltip()
		RenderRows()
	end)
	panel.scroll:HookScript("OnSizeChanged", function()
		panel.content:SetWidth(math.max(1, panel.scroll:GetWidth() - 4))
		RenderRows()
	end)
	panel.empty = panel:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
	panel.empty:SetPoint("TOPLEFT", panel.scroll, "TOPLEFT", 12, -12)
	panel.empty:SetText("No categories match your search.")

	local note = panel:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
	note:SetPoint("BOTTOMLEFT", panel, "BOTTOMLEFT", 18, 52)
	note:SetPoint("BOTTOMRIGHT", panel, "BOTTOMRIGHT", -18, 52)
	note:SetHeight(42)
	note:SetJustifyH("LEFT")
	note:SetText("Saved immediately. Changes affect future snapshots; current permissions gate queries. Already-sent information is not recalled. API scopes grant read-only queries, not gameplay actions.")
	local defaults = MakeButton(panel, "Common defaults", 140, function()
		WoWAIContext.ResetDefaults()
		RefreshCategories(false)
	end)
	defaults:SetPoint("BOTTOMLEFT", panel, "BOTTOMLEFT", 16, 16)
	local clear = MakeButton(panel, "Clear choices", 120, function()
		-- Also discard saved scopes whose documentation is not currently available.
		WoWAIContext.ResetDefaults()
		for _, category in ipairs(WoWAIContext.Categories()) do
			WoWAIContext.SetEnabled(category.id, false)
		end
		RefreshCategories(false)
	end)
	clear:SetPoint("LEFT", defaults, "RIGHT", 8, 0)
	local done = MakeButton(panel, "Close", 80, function() panel:Hide() end)
	done:SetPoint("BOTTOMRIGHT", panel, "BOTTOMRIGHT", -16, 16)
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
end
