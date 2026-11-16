'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

function vm() {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = (code, argument) => {
    if (lauxlib.luaL_loadstring(L, to_luastring(code)) !== lua.LUA_OK) {
      throw new Error(to_jsstring(lua.lua_tostring(L, -1)));
    }
    if (argument !== undefined) lua.lua_pushstring(L, to_luastring(argument));
    if (lua.lua_pcall(L, argument === undefined ? 0 : 1, 0, 0) !== lua.LUA_OK) {
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
  run(String.raw`
    MEASURE_CALLS = 0
    -- Exercise glyph wrapping, not the default stub's constant 14px height.
    -- Native FontStrings interpret WoW escapes; native EditBoxes hold literals.
    function DisplayText(text)
      text = text:gsub('||', '\1')
      text = text:gsub('|H.-|h(.-)|h', '%1')
      text = text:gsub('|c%x%x%x%x%x%x%x%x', ''):gsub('|r', ''):gsub('|T.-|t', ''):gsub('|A.-|a', '')
      return (text:gsub('\1', '|'))
    end
    function PaintedHeight(text, width, size, spacing)
      local lines, x = 1, 0
      for glyph in text:gmatch('[%z\1-\127\194-\244][\128-\191]*') do
        if glyph == '\n' then lines, x = lines + 1, 0
        elseif glyph ~= '\r' then
          local advance = glyph == '\t' and size * 2.4 or (#glyph > 1 and size or size * .58)
          if x > 0 and x + advance > width then lines, x = lines + 1, 0 end
          x = x + advance
        end
      end
      return lines * (size + 3) + (lines - 1) * spacing
    end
    local create = CreateFrame
    CreateFrame = function(...)
      local frame = create(...)
      local setText, createFontString = frame.SetText, frame.CreateFontString
      frame.SetText = function(self, text)
        self.textWrites = (self.textWrites or 0) + 1
        setText(self, text)
      end
      frame.EnableMouse = function(self, enabled) self.mouseEnabled = enabled end
      frame.SetAutoFocus = function(self, enabled) self.autoFocus = enabled end
      frame.SetMultiLine = function(self, enabled) self.multiLine = enabled end
      frame.SetMaxLetters = function(self, maximum) self.maxLetters = maximum end
      frame.SetHyperlinksEnabled = function(self, enabled) self.hyperlinksEnabled = enabled end
      frame.SetTextColor = function(self, ...) self.textColor = {...} end
      frame.CreateFontString = function(self, ...)
        local label = createFontString(self, ...)
        label.SetTextColor = function(self, ...) self.textColor = {...} end
        label.GetStringHeight = function(self)
          MEASURE_CALLS = MEASURE_CALLS + 1
          local text = DisplayText(self:GetText())
          local _, size = self:GetFont()
          return PaintedHeight(text, self:GetWidth(), size, self:GetSpacing())
        end
        label.GetStringWidth = function(self)
          local _, size = self:GetFont()
          return #DisplayText(self:GetText()):gsub('[\128-\191]', '') * size * .58
        end
        return label
      end
      return frame
    end
    local tooltipText = GameTooltip.SetText
    function GameTooltip:SetText(text) self.lines = {}; tooltipText(self, text) end
    function GameTooltip:AddLine(text) self.lines[#self.lines + 1] = text end
    GameTooltip:Hide()
  `);
  for (const file of ['Codec.lua', 'Inbox.lua', 'Wowie.lua', 'ReplyView.lua']) {
    run(fs.readFileSync(path.join(__dirname, '../addon/Wowie', file), 'utf8'), 'Wowie');
  }
  run(String.raw`
    V = Wowie.ReplyView.Create(UIParent, 'SelectableReply')
    RECORD = {}
    OPTIONS = { formatted = true, identity = RECORD, fontSize = 14,
      onResize = function() RESIZES = (RESIZES or 0) + 1 end }
    function Parse(text, formatted) P = Wowie.ReplyView.Parse(text, formatted) end
    function Layout(text, width) return Wowie.ReplyView.Layout(V, text, width or 360, OPTIONS) end
    function Click(button) button:GetScript('OnClick')(button) end
    function CitationLink(row, occurrence)
      local text = row.displayLabel and row.displayLabel:GetText():gsub('||', '\1') or ''
      for link in text:gmatch('|H([^|]+)|h') do
        occurrence = occurrence - 1
        if occurrence == 0 then return link end
      end
      return nil
    end
    function ClickCitation(row, occurrence)
      local link = assert(CitationLink(row, occurrence), 'citation is not rendered as a hyperlink')
      row.body:GetScript('OnHyperlinkClick')(row.body, link, '', 'LeftButton')
    end
    function HoverCitation(row, occurrence)
      local link = assert(CitationLink(row, occurrence), 'citation is not rendered as a hyperlink')
      row.body:GetScript('OnHyperlinkEnter')(row.body, link)
    end
    function BlockText(blocks)
      local parts = {}
      for _, block in ipairs(blocks) do parts[#parts + 1] = block.text end
      return table.concat(parts, '\n')
    end
    function Kind(kind)
      for _, block in ipairs(P.blocks) do if block.kind == kind then return block end end
    end
    function Fits()
      for _, row in ipairs(V.blocks) do
        if row:IsShown() then
          local body = row.body
          local _, size = body:GetFont()
          if body:IsShown() and body:GetHeight() < PaintedHeight(body:GetText(), body:GetWidth(), size, body:GetSpacing()) then return false end
          if row.displayLabel and row.displayLabel:IsShown() and row.displayLabel:GetStringHeight() > body:GetHeight() then return false end
          if row:GetWidth() > V:GetWidth() or body:GetWidth() + body.x > row:GetWidth() then return false end
          if -row.y + row:GetHeight() > V:GetHeight() then return false end
          if body:GetHeight() - body.y > row:GetHeight() then return false end
        end
      end
      return true
    end
  `);
  return {
    run, value,
    num: expression => Number(value(expression)),
    text: text => run('TEXT = ...', text),
  };
}

test('plain mode preserves every byte and creates native in-place selectable readonly text', () => {
  const v = vm();
  const text = '  Épée 雪 | literal pipes\n\tindented **not markdown**\nhttps://example.test/a  \n';
  v.text(text);
  v.run('OPTIONS.formatted = false; Layout(TEXT); Parse(TEXT, false)');
  assert.equal(v.value('P.blocks[1].text'), text);
  assert.equal(v.value('SelectableReply:GetText()'), text);
  assert.equal(v.value('P.source'), text);
  assert.equal(v.num('#P.links'), 0);
  assert.equal(v.value('SelectableReply:GetScript("OnMouseDown")'), 'nil', 'native drag selection is not replaced by a focus-only click handler');
  v.run('SelectableReply:SetFocus(); SelectableReply:HighlightText(2, 16); SelectableReply:SetCursorPosition(16)');
  const writes = v.num('SelectableReply.textWrites');
  const measures = v.num('MEASURE_CALLS');
  v.run('Layout(TEXT); Layout(TEXT)');
  assert.equal(v.num('SelectableReply.textWrites'), writes);
  assert.equal(v.num('MEASURE_CALLS'), measures);
  assert.equal(v.value('SelectableReply:HasFocus()'), 'true');
  assert.equal(v.num('SelectableReply.highlightEnd'), 16);
  v.run('SelectableReply:SetText("accidental paste")');
  assert.equal(v.value('SelectableReply:GetText()'), text);
  assert.equal(v.value('TEXT'), text);
  v.run('SelectableReply:GetScript("OnEscapePressed")(SelectableReply)');
  assert.equal(v.value('SelectableReply:HasFocus()'), 'false');
  assert.equal(v.value('SelectableReply.highlightStart'), 'nil');
});

test('structured paragraphs, emphasis, steps, quotes, code and simple tables retain readable content', () => {
  const v = vm();
  const code = '  local name = "Épée | 雪"\n\tprint(name)\nTL;DR: literal example\n[bridge] not a receipt\nhttps://example.test/code\n';
  v.text('# Travel plan\n\nA **careful** route with `local_name` intact.\n\n1. Find the gate\n2) Speak to the guard\n- Bring food\n\n> Watch for patrols.\n> Wait before crossing.\n\n```lua\n' + code + '```\n\n---\n\n| Stop | Reason |\n| --- | :---: |\n| Épée | Safe rest |\n\n**Next steps**');
  v.run('Parse(TEXT, true); Layout(TEXT)');
  assert.equal(v.value('P.blocks[1].kind'), 'heading');
  assert.equal(v.value('P.blocks[1].text'), 'Travel plan');
  assert.equal(v.value('P.blocks[2].text'), 'A careful route with local_name intact.');
  assert.equal(v.value('Kind("list").text'), 'Find the gate');
  assert.equal(v.value('Kind("list").marker'), '1.');
  assert.equal(v.value('Kind("quote").text'), 'Watch for patrols.\nWait before crossing.');
  assert.equal(v.value('Kind("code").text'), code);
  assert.equal(v.value('Kind("code").language'), 'lua');
  assert.equal(v.value('Kind("table").text'), 'Stop: Épée\nReason: Safe rest');
  assert.equal(v.value('Kind("rule").kind'), 'rule');
  assert.equal(v.num('#P.links'), 0, 'URLs in code are not extracted');
  assert.equal(v.num('#P.details'), 0);
  assert.equal(v.value('Fits()'), 'true');
  assert.ok(v.num('V.blocks[1].fontSize') > v.num('V.blocks[2].fontSize'));
});

test('emphasis stays visible without turning literal escapes into links or changing copied text', () => {
  const v = vm();
  const plain = 'Pros: Tough |cffff0000red|r and |HwowieSource:1|h[fake]|h.';
  v.text(plain.replace('Pros:', '**Pros:**'));
  v.run('Layout(TEXT)');
  assert.equal(v.value('SelectableReply:GetText()'), plain);
  assert.equal(v.value('DisplayText(V.blocks[1].displayLabel:GetText())'), plain);
  assert.match(v.value('V.blocks[1].displayLabel:GetText()'), /^\|cff[0-9a-f]{6}Pros:\|r /);
  assert.equal(v.value('SelectableReply.hyperlinksEnabled'), 'false');
  assert.equal(v.value('CitationLink(V.blocks[1], 1)'), 'nil');
  assert.equal(v.num('SelectableReply.textColor[4]'), 0);
  v.run('SelectableReply:SetFocus(); SelectableReply:HighlightText(0, 15)');
  const writes = v.num('SelectableReply.textWrites');
  for (const width of [100, 760]) {
    v.run(`Layout(TEXT, ${width})`);
    assert.equal(v.value('Fits()'), 'true');
    assert.equal(v.num('SelectableReply.highlightEnd'), 15);
    assert.equal(v.num('SelectableReply.textWrites'), writes);
  }
  v.text(plain);
  v.run('Layout(TEXT)');
  assert.equal(v.value('V.blocks[1].displayLabel:IsShown()'), 'false');
  assert.equal(v.num('SelectableReply.textColor[4]'), 1, 'removing emphasis must not leave invisible text');
  assert.equal(v.num('SelectableReply.textWrites'), writes, 'style-only changes preserve plain copyable text');

  v.text('**Read [the guide](https://example.test/guide) first**, then decide.');
  v.run('Layout(TEXT); Wowie.ShowCopy = function(text) COPIED = text end; ClickCitation(V.blocks[1], 1)');
  assert.equal(v.value('COPIED'), 'https://example.test/guide');
  assert.equal(v.value('DisplayText(V.blocks[1].displayLabel:GetText())'), 'Read the guide [1] first, then decide.');
  assert.match(v.value('V.blocks[1].displayLabel:GetText()'), /\[1\]\|h\|cff[0-9a-f]{6} first\|r/);
});

test('wrapped lists hang below their text and sections stay distinct at every reading size', () => {
  const v = vm();
  const text = 'Choose a companion for the job.\n\n### Voidwalker\n- **Pros:** Keeps enemies busy while you cast from a safe distance. [Guide](https://example.test/pet)\n  - Bring food and supplies for a long trip.\n12. Choose your companion before pulling the next group of enemies.\n\n### Imp\nRanged support.\n\n```lua\nlocal example = 1\n```';
  v.text(text);
  for (const size of [13, 14, 16]) {
    v.run(`OPTIONS.fontSize = ${size}`);
    for (const width of [90, 360, 960]) {
      v.run(`Layout(TEXT, ${width})`);
      assert.equal(v.value('Fits()'), 'true');
      assert.equal(v.value('V.parsed.source'), text);
      v.run(`
        local heading, first, nested, numbered, nextHeading = V.blocks[2], V.blocks[3], V.blocks[4], V.blocks[5], V.blocks[6]
        for _, row in ipairs({first, nested, numbered}) do
          assert(row.markerLabel.x + row.markerLabel:GetWidth() < row.body.x, "list marker overlaps selectable text")
          assert(row.body.x > 0, "wrapped lines need a hanging indent")
        end
        assert(nested.body.x > first.body.x, "nested items need a deeper text column")
        assert(-nextHeading.y - (-numbered.y + numbered:GetHeight()) > -first.y - (-heading.y + heading:GetHeight()), "sections need more separation than their contents")
        assert(heading.body.textColor[1] == Wowie.UI.colors.accent[1], "section heading must be visually distinct")
      `);
      assert.equal(v.value('V.blocks[5].markerLabel:GetText()'), '12.');
      assert.ok(v.num('V.blocks[1]:GetWidth()') <= size * 46);
      assert.equal(v.num('V.blocks[8]:GetWidth()'), width, 'code keeps the full available width');
    }
  }
  v.run('V.blocks[3].body:SetFocus(); V.blocks[3].body:HighlightText(0, 20)');
  const writes = v.num('V.blocks[3].body.textWrites');
  v.run('Layout(TEXT, 280)');
  assert.equal(v.num('V.blocks[3].body.textWrites'), writes);
  assert.equal(v.num('V.blocks[3].body.highlightEnd'), 20);
  assert.equal(v.value('DisplayText(V.blocks[3].displayLabel:GetText())'), v.value('V.blocks[3].body:GetText()'));
  v.text('A heading\n\nA paragraph.\n\nNo list marker here.');
  v.run('Layout(TEXT)');
  assert.equal(v.value('V.blocks[3].markerLabel:IsShown()'), 'false');
  assert.equal(v.num('V.blocks[3].body.x'), 0);
  assert.equal(v.value('V.blocks[3].body.sourceLinks'), 'nil');
});

test('balanced Markdown and bare URLs become readable deduplicated inline citations', () => {
  const v = vm();
  const url = 'https://example.test/wiki/Place_(North)?lang=fr&name=Épée';
  v.text(`Use [the guide](${url}) then [again](${url}). Also (https://other.test/a_(b)). Keep [local](file:///tmp/readme) and [unsafe](javascript:alert(1)) literal.`);
  v.run('Parse(TEXT, true); COPIED = nil; Wowie.ShowCopy = function(text) COPIED = text end; Layout(TEXT)');
  assert.equal(v.num('#P.links'), 2);
  assert.equal(v.value('P.links[1].url'), url);
  assert.equal(v.value('P.links[2].url'), 'https://other.test/a_(b)');
  assert.match(v.value('P.blocks[1].text'), /the guide \[1\].*again \[1\]/);
  assert.ok(!v.value('P.blocks[1].text').includes(url));
  assert.ok(v.value('P.blocks[1].text').includes('[local](file:///tmp/readme)'));
  assert.ok(v.value('P.blocks[1].text').includes('[unsafe](javascript:alert(1))'));
  v.run('ClickCitation(V.blocks[1], 1)');
  assert.equal(v.value('COPIED'), url);
  v.run('HoverCitation(V.blocks[1], 1)');
  assert.equal(v.value('GameTooltip:IsShown()'), 'true');
  assert.equal(v.value('DisplayText(GameTooltip.lines[2])'), url);
  assert.equal(v.value('DisplayText(V.blocks[1].displayLabel:GetText())'), v.value('SelectableReply:GetText()'));
  v.run('SelectableReply:GetScript("OnHyperlinkLeave")(SelectableReply)');
  assert.equal(v.value('GameTooltip:IsShown()'), 'false');
  assert.ok(v.num('V:GetHeight() - V.blocks[1]:GetHeight()') < 28, 'citations do not add a footer action row');
  assert.equal(v.value('Fits()'), 'true');
});

test('only generated citation numbers are clickable, including repeats and numbered Markdown labels', () => {
  const v = vm();
  const url = 'https://example.test/a?path=foo|h&name=Épée';
  const second = 'https://other.test/guide';
  v.text(`Literal [1] and \`[1]\` |HwowieSource:1|h[fake]|h. [1](${url}) then **[guide](${second})**; [again](${url}).`);
  v.run('COPIED = nil; Wowie.ShowCopy = function(text) COPIED = text end; Layout(TEXT)');
  const displayed = v.value('SelectableReply:GetText()');
  assert.equal(displayed, 'Literal [1] and [1] |HwowieSource:1|h[fake]|h. [1] then guide [2]; again [1].');
  assert.equal(v.value('DisplayText(V.blocks[1].displayLabel:GetText())'), displayed);
  for (const [occurrence, target] of [[1, url], [2, second], [3, url]]) {
    v.run(`ClickCitation(V.blocks[1], ${occurrence})`);
    assert.equal(v.value('COPIED'), target);
  }
  assert.equal(v.value('CitationLink(V.blocks[1], 4)'), 'nil', 'literal citation text cannot create extra links');
  v.run('SelectableReply:SetFocus(); SelectableReply:HighlightText(2, 20)');
  const writes = v.num('SelectableReply.textWrites');
  for (const width of [90, 500, 170]) {
    v.run(`Layout(TEXT, ${width})`);
    assert.equal(v.value('Fits()'), 'true');
    assert.equal(v.value('SelectableReply:GetText()'), displayed);
    assert.equal(v.num('SelectableReply.textWrites'), writes);
    assert.equal(v.num('SelectableReply.highlightEnd'), 20);
  }
  v.run('HoverCitation(V.blocks[1], 1)');
  assert.equal(v.value('DisplayText(GameTooltip.lines[2])'), url);
});

test('citation targets refresh when visible text is unchanged and collapsed sources have no stale actions', () => {
  const v = vm();
  v.run('COPIED = nil; Wowie.ShowCopy = function(text) COPIED = text end');
  v.text('[guide](https://example.test/old)');
  v.run('Layout(TEXT); ClickCitation(V.blocks[1], 1); HoverCitation(V.blocks[1], 1)');
  assert.equal(v.value('COPIED'), 'https://example.test/old');
  const displayed = v.value('SelectableReply:GetText()');
  v.text('[guide](https://example.test/new)');
  v.run('Layout(TEXT); ClickCitation(V.blocks[1], 1)');
  assert.equal(v.value('SelectableReply:GetText()'), displayed);
  assert.equal(v.value('COPIED'), 'https://example.test/new');
  assert.equal(v.value('GameTooltip:IsShown()'), 'false');
  v.text('Main paragraph.\n\n[bridge] See [the receipt source](https://example.test/receipt).');
  v.run('Layout(TEXT); Click(V.detailsButton); ClickCitation(V.blocks[2], 1); HoverCitation(V.blocks[2], 1)');
  assert.equal(v.value('COPIED'), 'https://example.test/receipt');
  v.run(`
    OLD_BODY, OLD_LINK = V.blocks[2].body, CitationLink(V.blocks[2], 1)
    COPIED = nil
    Click(V.detailsButton)
    OLD_BODY:GetScript('OnHyperlinkClick')(OLD_BODY, OLD_LINK, '', 'LeftButton')
  `);
  assert.equal(v.value('COPIED'), 'nil');
  assert.equal(v.value('GameTooltip:IsShown()'), 'false');
  v.run('Click(V.detailsButton); ClickCitation(V.blocks[2], 1)');
  assert.equal(v.value('COPIED'), 'https://example.test/receipt');
  v.run('V:Hide()');
  assert.equal(v.value('GameTooltip:IsShown()'), 'false');
});

test('voluntary TL;DR remains visible while routine receipts fold and errors and navigation stay accessible', () => {
  const v = vm();
  v.text('Take the northern road.\n\n**TL;DR:** Follow the road.\n\n[bridge] map: layer secret_internal_name: 2 point(s)\n\n[bridge] parser failed: missing event');
  v.run('WowieMap = { ShowNavigation = function() NAVIGATED = true end }; Parse(TEXT, true); Layout(TEXT)');
  assert.equal(v.value('BlockText(P.blocks)'), 'Take the northern road.\nTL;DR: Follow the road.');
  assert.equal(v.num('#P.details'), 2);
  assert.equal(v.value('V.blocks[2]:IsShown()'), 'true');
  assert.equal(v.value('V.blocks[3]:IsShown()'), 'false');
  assert.equal(v.value('V.blocks[4]:IsShown()'), 'true', 'errors must not disappear behind a collapsed receipt');
  assert.equal(v.value('V.navigationButton:IsShown()'), 'true');
  v.run('Click(V.navigationButton)');
  assert.equal(v.value('NAVIGATED'), 'true');
  const initial = v.num('V:GetHeight()');
  v.run('Click(V.detailsButton)');
  assert.equal(v.value('V.blocks[3]:IsShown()'), 'true');
  assert.ok(v.num('V:GetHeight()') > initial);
  assert.equal(v.num('RESIZES'), 1);
  v.run('V.blocks[3].body:SetFocus(); V.blocks[3].body:HighlightText(0, 6); Click(V.detailsButton)');
  assert.equal(v.value('V.blocks[3].body:HasFocus()'), 'false');
  assert.equal(v.value('V.blocks[3].body.highlightStart'), 'nil');
  assert.equal(v.value('Fits()'), 'true');
  v.run('WowieMap = nil; Layout(TEXT)');
  assert.equal(v.value('V.navigationButton:IsShown()'), 'false', 'no fake navigation action if the map module is absent');
  v.text('TL;DR: This is the entire answer.');
  v.run('Parse(TEXT, true); Layout(TEXT)');
  assert.equal(v.value('P.blocks[1].text'), 'TL;DR: This is the entire answer.');
  assert.equal(v.value('V.blocks[1]:IsShown()'), 'true');
});

test('ordinary TL;DR headings and malformed markup remain readable rather than disappearing', () => {
  const v = vm();
  v.text('TL;DR: An introduction.\n\n# More detail\n\nKeep **unfinished and [brackets.\n\n```lua\n  unfinished = "雪"\n');
  v.run('Parse(TEXT, true); Layout(TEXT)');
  assert.equal(v.value('P.blocks[1].text'), 'TL;DR: An introduction.');
  assert.ok(v.value('BlockText(P.blocks)').includes('Keep **unfinished and [brackets.'));
  assert.equal(v.value('Kind("code").text'), '```lua\n  unfinished = "雪"\n');
  assert.equal(v.value('P.source'), v.value('TEXT'));
  assert.equal(v.value('Fits()'), 'true');
});

test('long unbroken text, Unicode and inert WoW escapes are fully measured at every width', () => {
  const v = vm();
  const code = '\t' + '雪'.repeat(450) + '\n' + 'A'.repeat(1300) + '\n';
  const text = 'Literal |cffff0000red|r |TInterface\\Icons\\INV_Misc_QuestionMark:999|t |Hitem:1|h[label]|h and |A:atlas:999:999|a.\n\n```\n' + code + '```\n\n' + 'Épée'.repeat(700) + '\n\nhttps://example.test/' + 'path'.repeat(800);
  v.text(text);
  v.run('Layout(TEXT); Parse(TEXT, true)');
  assert.equal(v.value('P.source'), text);
  assert.equal(v.value('Kind("code").text'), code);
  assert.ok(v.value('SelectableReply:GetText()').includes('|cffff0000red|r'));
  v.run('SelectableReply:SetFocus(); SelectableReply:HighlightText(3, 14)');
  const writes = v.num('SelectableReply.textWrites');
  let narrow;
  for (const width of [150, 680, 240, 360]) {
    v.run(`Layout(TEXT, ${width})`);
    assert.equal(v.value('Fits()'), 'true', `all painted glyphs fit at ${width}px`);
    assert.equal(v.num('V:GetWidth()'), width);
    assert.equal(v.num('SelectableReply.textWrites'), writes);
    assert.equal(v.num('SelectableReply.highlightEnd'), 14);
    if (width === 150) narrow = v.num('V:GetHeight()');
    if (width === 680) assert.ok(v.num('V:GetHeight()') < narrow);
  }
  v.run('Wowie.ShowCopy = function(text) COPIED = text end; ClickCitation(V.blocks[#V.blocks], 1)');
  assert.equal(v.value('COPIED'), 'https://example.test/' + 'path'.repeat(800));
});

test('recycling, identity changes and hiding release every selection without retaining stale source actions', () => {
  const v = vm();
  v.text('First paragraph.\n\nSecond paragraph.\n\nhttps://example.test/source\n\nTL;DR: Short version.');
  v.run(`
    Layout(TEXT)
    SOURCE_BODY, SOURCE_LINK = V.blocks[3].body, CitationLink(V.blocks[3], 1)
    COPIED = nil
    Wowie.ShowCopy = function(text) COPIED = text end
    V.blocks[4].body:SetFocus()
    V.blocks[4].body:HighlightText(0, 5)
  `);
  v.run('OPTIONS.identity = {}; Layout(TEXT)');
  assert.equal(v.value('STUB.focus'), 'nil');
  assert.equal(v.value('V.blocks[4].body.highlightStart'), 'nil');
  assert.equal(v.value('V.detailsOpen'), 'false');
  v.run('V.blocks[2].body:SetFocus(); V.blocks[2].body:HighlightText(0, 3); Layout("Replacement")');
  assert.equal(v.value('V.blocks[2]:IsShown()'), 'false');
  assert.equal(v.value('V.blocks[2].body.highlightStart'), 'nil');
  v.run('SOURCE_BODY:GetScript("OnHyperlinkClick")(SOURCE_BODY, SOURCE_LINK, "", "LeftButton")');
  assert.equal(v.value('COPIED'), 'nil');
  assert.equal(v.value('SelectableReply:GetText()'), 'Replacement');
  v.run('SelectableReply:SetFocus(); SelectableReply:HighlightText(0, 5); V:Hide()');
  assert.equal(v.value('STUB.focus'), 'nil');
  assert.equal(v.value('SelectableReply.highlightStart'), 'nil');
});

test('pathological unmatched delimiters and large source content are not truncated', () => {
  const v = vm();
  const text = '['.repeat(6000) + '雪 Épée ' + '_'.repeat(5000) + '\n\n```\n' + 'x'.repeat(40000);
  v.text(text);
  v.run('Parse(TEXT, true)');
  assert.equal(v.value('P.source'), text);
  assert.equal(v.value('P.blocks[1].text'), text.split('\n\n')[0]);
  assert.equal(v.value('Kind("code").text'), '```\n' + 'x'.repeat(40000));
});

test('nested balanced delimiters and CRLF fenced code retain their source content', () => {
  const v = vm();
  const brackets = '['.repeat(5000) + '雪' + ']'.repeat(5000);
  const code = '\tlocal value = "Épée"\r\n  print(value)\r\n';
  v.text(brackets + '\r\n\r\n```lua\r\n' + code + '```');
  v.run('Parse(TEXT, true)');
  assert.equal(v.value('P.blocks[1].text'), brackets);
  assert.equal(v.value('Kind("code").text'), code);
});

test('wheel gestures over selectable text scroll the native enclosing viewport without changing selection', () => {
  const v = vm();
  v.run(`
    SCROLL = Wowie.UI.ScrollFrame(UIParent, 'ReplyScroll')
    SCROLL:SetSize(360, 100)
    CONTENT = CreateFrame('Frame', nil, SCROLL)
    CONTENT:SetSize(360, 1000)
    SCROLL:SetScrollChild(CONTENT)
    WHEEL_VIEW = Wowie.ReplyView.Create(CONTENT, 'WheelReply')
    Wowie.ReplyView.Layout(WHEEL_VIEW, 'Selectable text', 360, OPTIONS)
    WheelReply:SetFocus()
    WheelReply:HighlightText(2, 9)
    WheelReply:GetScript('OnMouseWheel')(WheelReply, -1)
  `);
  assert.ok(v.num('SCROLL:GetVerticalScroll()') > 0);
  assert.equal(v.value('WheelReply:HasFocus()'), 'true');
  assert.equal(v.num('WheelReply.highlightEnd'), 9);
});

test('reply actions share a compact row and wrap without overlap on narrow replies', () => {
  const v = vm();
  v.text('Read [the guide](https://example.test/guide).\n\nTL;DR: Take the road.\n\n[bridge] map: layer route: 1 point(s)');
  v.run('WowieMap={ShowNavigation=function() end}; Layout(TEXT,600)');
  assert.equal(v.num('V.detailsButton.y'), v.num('V.navigationButton.y'), 'routine actions must not each consume a full-width row');
  for (const width of [600, 220, 120]) {
    v.run(`
      Layout(TEXT,${width})
      local controls={V.detailsButton,V.navigationButton}
      for i,a in ipairs(controls) do
        assert(a.x>=0 and a.x+a:GetWidth()<=V:GetWidth(),"reply action exceeds the content width")
        for j=i+1,#controls do
          local b=controls[j]
          assert(a.x+a:GetWidth()<=b.x or b.x+b:GetWidth()<=a.x
            or -a.y+a:GetHeight()<=-b.y or -b.y+b:GetHeight()<=-a.y,"reply actions overlap")
        end
      end
    `);
    assert.equal(v.value('Fits()'), 'true');
  }
});
