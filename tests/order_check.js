// Every top-level `local` in the addon must be defined before any use of it.
// (A later local is invisible to earlier code: the use would hit a nil global.)
// Covers `local function X` and `local X = ...`; bare forward declarations
// (`local Finish`) are fine and are skipped.
'use strict';
const fs = require('fs');
const path = require('path');
const luaparse = require('luaparse');

const ADDON = process.argv[2] || path.join(__dirname, '..', 'addon', 'Wowie');
let bad = 0;
for (const f of ['Codec.lua', 'Wowie.lua', 'ReplyView.lua', 'Context.lua', 'ContextUI.lua', 'Inbox.lua', 'Map.lua']) {
  const src = fs.readFileSync(path.join(ADDON, f), 'utf8');
  const tree = luaparse.parse(src, { luaVersion: '5.1', ranges: true, comments: true });
  console.log('OK   ' + f + ' parses');
  // Literal text is not a variable reference. Use parser ranges so quoted "--"
  // and long-bracket strings/comments cannot hide code or invent early uses.
  const ignored = [], nodes = [tree];
  while (nodes.length) {
    const node = nodes.pop();
    if (node.type === 'StringLiteral' || node.type === 'Comment') {
      ignored.push(node.range);
      continue;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child === 'object') nodes.push(child);
      } else if (value && typeof value === 'object') nodes.push(value);
    }
  }
  ignored.sort((a, b) => a[0] - b[0]);
  const pieces = [];
  let at = 0;
  for (const [start, end] of ignored) {
    pieces.push(src.slice(at, start), src.slice(start, end).replace(/[^\n]/g, ' '));
    at = end;
  }
  pieces.push(src.slice(at));
  const code = pieces.join('');
  const forward = new Set([...code.matchAll(/^local (\w+)\s*$/gm)].map(m => m[1]));
  const defs = [
    ...[...code.matchAll(/^local function (\w+)/gm)].map(m => ({ name: m[1], at: m.index, kind: 'function' })),
    ...[...code.matchAll(/^local (\w+)\s*=/gm)].map(m => ({ name: m[1], at: m.index, kind: 'value' })),
  ];
  for (const d of defs) {
    if (forward.has(d.name)) continue;
    const use = d.kind === 'function'
      ? new RegExp('(?<![\\w.:])' + d.name + '\\s*\\(', 'g')
      : new RegExp('(?<![\\w.:])' + d.name + '(?![\\w])', 'g');
    for (const m of code.matchAll(use)) {
      if (m.index < d.at) {
        const line = code.slice(0, m.index).split('\n').length;
        bad++;
        console.log('USED BEFORE DEFINITION:', d.name, 'in', f, 'at line', line);
        break;
      }
    }
  }
}
console.log(bad ? '>>> ORDER FAIL' : '>>> ORDER PASS');
process.exit(bad ? 1 : 0);
