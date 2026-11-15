-- Presentation only: source/history text is never rewritten by this module.
local UI = Wowie.UI
local unpack = unpack or table.unpack
local ReplyView = {}
Wowie.ReplyView = ReplyView

local function Trim(text)
	return (text:gsub("^%s+", ""):gsub("%s+$", ""))
end

-- EditBoxes display literal text. FontStrings (including button labels and the
-- measuring surface) interpret escape sequences, so their pipes must be escaped.
local function Literal(text)
	return (text:gsub("|", "||"))
end

local function WebURL(text)
	return text:match("^[Hh][Tt][Tt][Pp][Ss]?://[^%s]+$") ~= nil
end

local function Host(url)
	return url:match("^[^:]+://([^/?#]+)") or url
end

local function Balanced(text, start, opening, closing)
	local depth = 0
	for i = start, #text do
		local c = text:sub(i, i)
		if c == opening then depth = depth + 1
		elseif c == closing then
			depth = depth - 1
			if depth == 0 then return i end
		end
	end
end

local function Inline(text, result, depth)
	depth = depth or 0
	if depth > 16 then return text end
	local out, i = {}, 1
	local function Source(label, url)
		local index = result.linkIndex[url]
		if not index then
			index = #result.links + 1
			result.linkIndex[url] = index
			result.links[index] = { label = label, url = url }
		end
		return label .. " [" .. index .. "]"
	end
	while i <= #text do
		local c, consumed = text:sub(i, i), false
		if c == "`" then
			local run = text:match("^`+", i)
			local close = text:find(run, i + #run, true)
			if close then
				out[#out + 1] = text:sub(i + #run, close - 1)
				i, consumed = close + #run, true
			else
				out[#out + 1] = run
				i, consumed = i + #run, true
			end
		elseif c == "[" then
			local labelEnd = Balanced(text, i, "[", "]")
			if not labelEnd then out[#out + 1] = text:sub(i); break end
			if labelEnd and text:sub(labelEnd + 1, labelEnd + 1) == "(" then
				local finish = Balanced(text, labelEnd + 1, "(", ")")
				if finish then
					local url = text:sub(labelEnd + 2, finish - 1)
					if WebURL(url) then
						local label = text:sub(i + 1, labelEnd - 1)
						if label == "" or WebURL(label) then label = Host(url)
						else label = Inline(label, result, depth + 1) end
						out[#out + 1] = Source(label, url)
					else
						-- Unsupported schemes are inert and remain copyable verbatim.
						out[#out + 1] = text:sub(i, finish)
					end
					i, consumed = finish + 1, true
				else out[#out + 1] = text:sub(i); break end
			else
				-- Consume a literal balanced span once, including deeply nested
				-- brackets; rescanning at each opening bracket is quadratic.
				out[#out + 1] = text:sub(i, labelEnd)
				i, consumed = labelEnd + 1, true
			end
		end
		if not consumed then
			local url = (c == "h" or c == "H") and text:match("^[Hh][Tt][Tt][Pp][Ss]?://[^%s<>\"`]+", i)
			if url then
				url = url:gsub("[.,;:!?]+$", "")
				for _, pair in ipairs({ { "(", ")" }, { "[", "]" }, { "{", "}" } }) do
					local _, opens = url:gsub("%" .. pair[1], "")
					local _, closes = url:gsub("%" .. pair[2], "")
					while closes > opens and url:sub(-1) == pair[2] do
						url, closes = url:sub(1, -2), closes - 1
					end
				end
				out[#out + 1] = Source(Host(url), url)
				i = i + #url
			elseif c == "*" or c == "_" then
				local double = text:sub(i, i + 1) == c .. c
				local mark = double and c .. c or c
				local close = text:find(mark, i + #mark, true)
				-- Single underscores inside identifiers are not emphasis.
				local boundary = c ~= "_" or i == 1 or not text:sub(i - 1, i - 1):match("[%w_]")
				if boundary and close and close > i + #mark and not text:sub(i + #mark, i + #mark):match("%s") then
					out[#out + 1] = Inline(text:sub(i + #mark, close - 1), result, depth + 1)
					i = close + #mark
				else out[#out + 1], i = c, i + 1 end
			else out[#out + 1], i = c, i + 1 end
		end
	end
	return table.concat(out)
end

local function SummaryLine(line)
	local value = Trim(line):gsub("^#+%s*", "")
	value = value:gsub("^%*%*", ""):gsub("^__", "")
	local _, finish = value:upper():find("^TL;?DR%s*:?")
	if not finish then return nil end
	local nextChar = value:sub(finish + 1, finish + 1)
	if nextChar ~= "" and not nextChar:match("[%s:*_#]") and value:sub(finish, finish) ~= ":" then return nil end
	return Trim(value:sub(finish + 1):gsub("^%*%*", ""):gsub("^__", ""):gsub("%s+#+$", ""))
end

local function Fence(line)
	local trimmed = line:match("^%s*(.-)%s*$")
	local marker = trimmed:match("^(```+)") or trimmed:match("^(~~~+)")
	if marker then return marker, Trim(trimmed:sub(#marker + 1)) end
end

local function Heading(line)
	local hashes, text = line:match("^%s*(#+)%s+(.+)$")
	if hashes and #hashes <= 6 then return text:gsub("%s+#+$", ""), #hashes end
	local bold = line:match("^%s*%*%*(.+)%*%*%s*$") or line:match("^%s*__(.+)__%s*$")
	if bold then return bold, 3 end
end

local function Rule(line)
	local compact = line:gsub("%s", "")
	return #compact >= 3 and (compact:match("^%-+$") or compact:match("^%*+$") or compact:match("^_+$"))
end

local function TableCells(line)
	local text = Trim(line)
	if not text:find("|", 1, true) or text:find("`", 1, true) then return nil end
	text = text:gsub("^|", ""):gsub("|$", "")
	local cells, current, escaped = {}, {}, false
	for i = 1, #text do
		local c = text:sub(i, i)
		if escaped then
			if c ~= "|" then current[#current + 1] = "\\" end
			current[#current + 1], escaped = c, false
		elseif c == "\\" then escaped = true
		elseif c == "|" then cells[#cells + 1], current = Trim(table.concat(current)), {}
		else current[#current + 1] = c end
	end
	if escaped then current[#current + 1] = "\\" end
	cells[#cells + 1] = Trim(table.concat(current))
	return cells
end

local function TableSeparator(line)
	local cells = TableCells(line)
	if not cells then return false end
	for _, cell in ipairs(cells) do if not cell:match("^:?[%-][%-][%-]+:?$") then return false end end
	return true
end

local function ErrorNote(text)
	local lower = text:lower()
	return lower:find("error", 1, true) or lower:find("failed", 1, true) or lower:find("denied", 1, true)
		or lower:find("invalid", 1, true) or lower:find("could not", 1, true) or lower:find("unable", 1, true)
		or lower:find("rejected", 1, true) or lower:find("dropped", 1, true)
		or lower:find("bad layer", 1, true) or lower:find("unknown op", 1, true) or lower:find("must be", 1, true)
		or lower:find("no valid", 1, true) or lower:find("not an object", 1, true) or lower:find("unreadable", 1, true)
		or lower:find("timeout", 1, true) or lower:find("timed out", 1, true) or lower:find("warning", 1, true)
end

function ReplyView.Parse(text, formatted)
	text = tostring(text or "")
	local result = { blocks = {}, links = {}, summary = {}, details = {}, source = text, linkIndex = {} }
	if formatted == false then
		result.blocks[1] = { kind = "paragraph", text = text, raw = text }
		return result
	end
	local lines = {}
	for line in (text .. "\n"):gmatch("(.-)\n") do lines[#lines + 1] = line end
	local tokens, paragraph, i = {}, {}, 1
	local function Add(kind, value, extra)
		local block = extra or {}
		block.kind, block.text, block.raw = kind, value, value
		tokens[#tokens + 1] = block
	end
	local function Flush()
		if #paragraph > 0 then Add("paragraph", table.concat(paragraph, "\n")); paragraph = {} end
	end
	while i <= #lines do
		local line = lines[i]:gsub("\r$", "")
		local fence, language = Fence(line)
		local heading, level = Heading(line)
		local summary = SummaryLine(line)
		local bulletIndent, bullet, item = line:match("^(%s*)([-+*])%s+(.+)$")
		local numberIndent, number, step = line:match("^(%s*)(%d+[.)])%s+(.+)$")
		if fence then
			Flush()
			local code, start, closed = {}, i, false
			i = i + 1
			while i <= #lines do
				local ending, suffix = Fence(lines[i])
				if ending and ending:sub(1, 1) == fence:sub(1, 1) and #ending >= #fence and suffix == "" then closed = true; break end
				code[#code + 1], i = lines[i], i + 1
			end
			local value = table.concat(code, "\n")
			if closed and #code > 0 then value = value .. "\n" end
			if not closed then value = lines[start] .. "\n" .. value end
			Add("code", value, { language = language, closed = closed })
		elseif line:match("^%s*%[bridge%]") then
			Flush()
			local notes = { (line:gsub("^%s*%[bridge%]%s*", "")) }
			while lines[i + 1] and Trim(lines[i + 1]) ~= "" and not lines[i + 1]:match("^%s*%[bridge%]") and not Fence(lines[i + 1]) do
				i = i + 1; notes[#notes + 1] = lines[i]
			end
			local note = table.concat(notes, "\n")
			Add("detail", note, { error = ErrorNote(note) and true or false, navigation = note:lower():match("^map:") ~= nil })
		elseif summary ~= nil then Flush(); Add("summaryMarker", summary)
		elseif Trim(line) == "" then Flush()
		elseif lines[i + 1] and TableSeparator(lines[i + 1]) and TableCells(line) then
			Flush()
			local headers = TableCells(line)
			Add("heading", table.concat(headers, " / "), { level = 3 })
			i = i + 2
			while lines[i] do
				local cells = TableCells(lines[i])
				if not cells then break end
				local values = {}
				for index, cell in ipairs(cells) do
					values[#values + 1] = ((headers[index] and headers[index] ~= "") and headers[index] .. ": " or "") .. cell
				end
				Add("table", table.concat(values, "\n"))
				i = i + 1
			end
			i = i - 1
		elseif Rule(line) then Flush(); Add("rule", "")
		elseif heading then Flush(); Add("heading", heading, { level = level })
		elseif bullet or number then
			Flush()
			Add("list", (number or "•") .. " " .. (step or item), { indent = #(numberIndent or bulletIndent), ordered = number ~= nil })
		elseif line:match("^%s*>") then
			Flush()
			local quote = { (line:gsub("^%s*>%s?", "")) }
			while lines[i + 1] and lines[i + 1]:match("^%s*>") do
				i = i + 1; quote[#quote + 1] = lines[i]:gsub("^%s*>%s?", "")
			end
			Add("quote", table.concat(quote, "\n"))
		else paragraph[#paragraph + 1] = line end
		i = i + 1
	end
	Flush()
	local summaryAt
	for index, block in ipairs(tokens) do
		if block.kind == "summaryMarker" then summaryAt = index
		elseif summaryAt and block.kind == "heading" then summaryAt = nil end
	end
	local mainExists = false
	for index, block in ipairs(tokens) do
		if (not summaryAt or index < summaryAt) and block.kind ~= "detail" and block.kind ~= "rule" and Trim(block.text) ~= "" then mainExists = true; break end
	end
	for index, block in ipairs(tokens) do
		local target = result.blocks
		if block.kind == "detail" then
			target = result.details
			result.navigation = result.navigation or block.navigation
			result.hasErrors = result.hasErrors or block.error
		elseif summaryAt and index >= summaryAt and mainExists then target = result.summary end
		if block.kind == "summaryMarker" then
			block.kind = "paragraph"
			if index ~= summaryAt then block.text = "TL;DR: " .. block.text end
		end
		if block.kind ~= "code" then block.text = Inline(block.text, result) end
		if block.text ~= "" or block.kind == "code" or block.kind == "rule" then target[#target + 1] = block end
	end
	return result
end

local function Release(row)
	row.body:ClearFocus()
	row.body:ClearHighlightText()
	row:Hide()
end

local function ScrollParent(self, delta)
	local parent = self:GetParent()
	while parent do
		local handler = parent:GetScript("OnMouseWheel")
		if handler then handler(parent, delta); return end
		parent = parent:GetParent()
	end
end

local function Row(view, index)
	if view.blocks[index] then return view.blocks[index] end
	local row = CreateFrame("Frame", nil, view, "BackdropTemplate")
	UI.Surface(row, "input")
	local name = view.bodyName and (index == 1 and view.bodyName or view.bodyName .. "Block" .. index)
	local body = CreateFrame("EditBox", name, row)
	row.body = body
	body:SetMultiLine(true)
	body:SetAutoFocus(false)
	body:EnableMouse(true)
	body:EnableMouseWheel(true)
	body:SetScript("OnMouseWheel", ScrollParent)
	body:SetMaxLetters(0)
	body:SetTextInsets(0, 0, 0, 0)
	body:SetSpacing(2)
	body:SetJustifyH("LEFT")
	body:SetJustifyV("TOP")
	body:SetHyperlinksEnabled(false)
	body:SetHighlightColor(unpack(UI.colors.highlight))
	body.messageText = ""
	body:SetScript("OnTextChanged", function(self)
		if self:GetText() == self.messageText then return end
		local cursor = self:GetCursorPosition()
		self:SetText(self.messageText)
		self:SetCursorPosition(math.min(cursor, #self.messageText))
	end)
	body:SetScript("OnEscapePressed", function(self) self:ClearFocus(); self:ClearHighlightText() end)
	body:SetScript("OnEnterPressed", function(self) self:ClearFocus() end)
	row:SetScript("OnHide", function() body:ClearFocus(); body:ClearHighlightText() end)
	row.rule = UI.Rule(row)
	row.rule:SetPoint("LEFT", row, "LEFT", 0, 0)
	row.rule:SetPoint("RIGHT", row, "RIGHT", 0, 0)
	view.blocks[index] = row
	return row
end

local function Fold(view, section)
	local button = UI.Button(view, "", 120, function()
		view[section .. "Open"] = not view[section .. "Open"]
		view.dirty = true
		ReplyView.Layout(view, view.text, view.width, view.options)
		if view.onResize then view.onResize() end
	end, "quiet")
	button.label:SetWordWrap(true)
	button.label:SetNonSpaceWrap(true)
	button:Hide()
	return button
end

function ReplyView.Create(parent, name)
	local view = CreateFrame("Frame", nil, parent)
	view.bodyName, view.blocks, view.sources = name, {}, {}
	view:EnableMouseWheel(true)
	view:SetScript("OnMouseWheel", ScrollParent)
	view.measure = UI.Label(view, "", 14)
	view.measure:SetWordWrap(true)
	view.measure:SetNonSpaceWrap(true)
	view.measure:SetJustifyV("TOP")
	view.measure:Hide()
	function view:ClearSelection()
		for _, row in ipairs(self.blocks) do row.body:ClearFocus(); row.body:ClearHighlightText() end
	end
	view:SetScript("OnHide", function(self) self:ClearSelection() end)
	view.summaryButton = Fold(view, "summary")
	view.detailsButton = Fold(view, "details")
	view.navigationButton = UI.Button(view, "Navigation", 120, function()
		if WowieMap and WowieMap.ShowNavigation then WowieMap.ShowNavigation() end
	end, "secondary")
	view.navigationButton:Hide()
	Row(view, 1)
	return view
end

local function Measure(view, text, width, font, size, spacing)
	local measure = view.measure
	measure:SetFont(font, size, "")
	measure:SetSpacing(spacing)
	measure:SetWidth(width)
	measure:SetText(Literal(text))
	return math.max(size + spacing, math.ceil(measure:GetStringHeight())) + 4
end

function ReplyView.Layout(view, text, width, options)
	options = options or {}
	text, width = tostring(text or ""), math.max(1, tonumber(width) or 1)
	local formatted, fontSize, muted = options.formatted ~= false, options.fontSize or 14, options.muted and true or false
	local identityChanged = view.identity ~= options.identity
	local contentChanged = view.text ~= text or view.formatted ~= formatted
	local navigation = WowieMap and WowieMap.ShowNavigation and true or false
	view.options, view.onResize = options, options.onResize
	if identityChanged then
		view:ClearSelection()
		view.summaryOpen, view.detailsOpen = false, false
		view.identity = options.identity
	end
	if not identityChanged and not contentChanged and not view.dirty and view.width == width and view.fontSize == fontSize and view.muted == muted and view.navigationAvailable == navigation then
		return view.height
	end
	if contentChanged then
		view:ClearSelection()
		view.parsed = ReplyView.Parse(text, formatted)
		view.summaryOpen, view.detailsOpen = false, false
	end
	view.text, view.formatted, view.width, view.fontSize, view.muted = text, formatted, width, fontSize, muted
	view.navigationAvailable, view.dirty = navigation, false
	local parsed, y, used = view.parsed, 0, 0
	local function PlaceBlock(block, visible)
		used = used + 1
		local row = view.blocks[used] or Row(view, used)
		if not visible then Release(row); return end
		local body = row.body
		local inset = (block.kind == "code" or block.kind == "quote" or block.kind == "table") and math.min(8, width / 4) or 0
		local indent = block.kind == "list" and math.min((block.indent or 0) * 4, width / 4) or 0
		local bodyWidth = math.max(1, width - inset * 2 - indent)
		local size = block.kind == "heading" and fontSize + (block.level == 1 and 6 or block.level == 2 and 3 or 1) or fontSize
		-- A client can register a bundled fixed-width font without assuming an
		-- OS font path is available in the game's virtual filesystem.
		local font = block.kind == "code" and UI.monoFont or UI.font
		if row.font ~= font or row.fontSize ~= size then
			if not body:SetFont(font, size, "") then font = UI.font; body:SetFont(font, size, "") end
		end
		if row.text ~= block.text then
			body:ClearFocus(); body:ClearHighlightText()
			body.messageText = block.text
			body:SetText(block.text)
			body:SetCursorPosition(0)
		end
		if row.text ~= block.text or row.bodyWidth ~= bodyWidth or row.font ~= font or row.fontSize ~= size or row.kind ~= block.kind then
			row.bodyHeight = block.kind == "rule" and 1 or Measure(view, block.text, bodyWidth, font, size, body:GetSpacing())
		end
		row.text, row.bodyWidth, row.font, row.fontSize, row.kind = block.text, bodyWidth, font, size, block.kind
		body:SetTextColor(unpack(UI.colors[block.error and "danger" or muted and "muted" or "text"]))
		body:SetSize(bodyWidth, row.bodyHeight)
		body:ClearAllPoints()
		body:SetPoint("TOPLEFT", row, "TOPLEFT", inset + indent, -inset)
		body:SetShown(block.kind ~= "rule")
		row.rule:SetShown(block.kind == "rule")
		if inset > 0 then UI.Surface(row, "input")
		else row:SetBackdropColor(0, 0, 0, 0); row:SetBackdropBorderColor(0, 0, 0, 0) end
		local height = row.bodyHeight + inset * 2
		row:SetSize(width, height)
		row:ClearAllPoints()
		row:SetPoint("TOPLEFT", view, "TOPLEFT", 0, -y)
		row:Show()
		y = y + height + (block.kind == "list" and 4 or 8)
	end
	for _, block in ipairs(parsed.blocks) do PlaceBlock(block, true) end
	local controlX, controlY, controls = 0, y, 0
	local function PlaceControl(button, label, preferredWidth)
		local buttonWidth = math.min(width, preferredWidth)
		if controlX > 0 and controlX + buttonWidth > width then controlX, controlY = 0, controlY + 36 end
		if button.replyLabel ~= label then button:SetText(Literal(label)); button.replyLabel = label end
		button.label:SetWordWrap(false)
		button.label:SetJustifyH("LEFT")
		button:SetSize(buttonWidth, 28)
		button:ClearAllPoints()
		button:SetPoint("TOPLEFT", view, "TOPLEFT", controlX, -controlY)
		button:Show()
		controlX, controls = controlX + buttonWidth + 8, controls + 1
	end
	if #parsed.summary > 0 then PlaceControl(view.summaryButton, (view.summaryOpen and "− " or "+ ") .. "Summary", 100) else view.summaryButton:Hide() end
	if #parsed.details > 0 then PlaceControl(view.detailsButton, (view.detailsOpen and "− " or "+ ") .. "Details", 84) else view.detailsButton:Hide() end
	if parsed.navigation and navigation then PlaceControl(view.navigationButton, "Navigation", 104) else view.navigationButton:Hide() end
	for index, link in ipairs(parsed.links) do
		local button = view.sources[index]
		if not button then
			button = UI.Button(view, "", 100, function(self) if Wowie.ShowCopy then Wowie.ShowCopy(self.url) end end, "quiet")
			view.sources[index] = button
			button:SetScript("OnEnter", function(self)
				GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
				GameTooltip:SetText("Copy source URL")
				GameTooltip:AddLine(Literal(self.sourceLabel or ""), 0.92, 0.94, 0.97, true)
				GameTooltip:AddLine(Literal(Host(self.url or "")), 0.64, 0.69, 0.75, true)
				GameTooltip:AddLine("Opens a selectable URL, not a browser.", 0.64, 0.69, 0.75, true)
				GameTooltip:Show()
			end)
			button:SetScript("OnLeave", function() GameTooltip:Hide() end)
		end
		button.url, button.sourceLabel = link.url, link.label
		PlaceControl(button, "Source " .. index, 84)
	end
	if controls > 0 then y = controlY + 36 end
	for _, block in ipairs(parsed.summary) do PlaceBlock(block, view.summaryOpen) end
	-- Errors remain visible even while routine receipts stay folded.
	for _, block in ipairs(parsed.details) do PlaceBlock(block, view.detailsOpen or block.error) end
	for index = used + 1, #view.blocks do Release(view.blocks[index]) end
	for index = #parsed.links + 1, #view.sources do view.sources[index]:Hide(); view.sources[index].url = nil end
	view.height = math.max(1, y)
	view:SetSize(width, view.height)
	return view.height
end
