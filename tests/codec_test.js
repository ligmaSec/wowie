// Real Lua encoder and profile colors -> physical raster -> every native decoder
// available here. Python test-image mode deliberately needs no X11/macOS libraries.
'use strict';
const fengari = require('fengari');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib');
const { execFileSync } = require('child_process');

const CODEC = path.join(__dirname, '..', 'addon', 'WoWAI', 'Codec.lua');
const BRIDGE = path.join(__dirname, '..', 'bridge');
const CELLS = 200, MAXROWS = 48;
const decoders = [];
const available = command => {
  try { execFileSync(command, ['--version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
};
const python = ['python3', ...(process.platform === 'win32' ? ['python'] : [])].find(available);
if (python) {
  for (const script of ['capture_x11.py', 'capture_mac.py']) {
    decoders.push({ name: script, run: (file, cell) =>
      execFileSync(python, [path.join(BRIDGE, script), '--test-image', file, '--cell', String(cell)], { encoding: 'utf8' }) });
  }
}
if (process.platform === 'win32') {
  // System.Drawing and live Windows capture require Windows; pwsh on Unix is
  // not a supported System.Drawing runtime.
  for (const command of ['powershell.exe', 'pwsh.exe']) {
    try { execFileSync(command, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { stdio: 'ignore' }); }
    catch { continue; }
    decoders.push({ name: command + '/capture.ps1', run: (file, cell) =>
      execFileSync(command, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(BRIDGE, 'capture.ps1'), '-TestImage', file, '-Cell', String(cell)], { encoding: 'utf8' }) });
  }
}
if (!decoders.length) {
  console.log('SKIP codec round-trip: no Python or Windows PowerShell runtime.');
  process.exit(0);
}

function encodeWithLua(id, payload, display) {
  const bytes = Buffer.from(payload, 'utf8');
  const lit = '"' + [...bytes].map(b => '\\' + b).join('') + '"';
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  try {
    const code = fs.readFileSync(CODEC, 'utf8') +
      `\nlocal cells = WoWAI_Codec.Encode(${id}, ${lit})\n` +
      `local t = {}\nfor i = 1, #cells do t[i] = tostring(cells[i]) end\n` +
      `CELLS_RESULT = table.concat(t, ",")\n` +
      `local colors = {}\nfor v = 0, 7 do\n` +
      `  local r, g, b = WoWAI_Codec.CellColor(v, "${display}")\n` +
      `  colors[#colors + 1] = string.format("%.12f,%.12f,%.12f", r, g, b)\nend\n` +
      `COLORS_RESULT = table.concat(colors, ";")\n`;
    if (lauxlib.luaL_dostring(L, to_luastring(code)) !== 0) {
      throw new Error('Lua error: ' + to_jsstring(lua.lua_tostring(L, -1)));
    }
    lua.lua_getglobal(L, to_luastring('CELLS_RESULT'));
    const cells = to_jsstring(lua.lua_tostring(L, -1)).split(',').map(Number);
    lua.lua_getglobal(L, to_luastring('COLORS_RESULT'));
    const colors = to_jsstring(lua.lua_tostring(L, -1)).split(';').map(rgb => rgb.split(',').map(Number));
    return { cells, colors };
  } finally { lua.lua_close(L); }
}

function png(width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function render(encoded, t) {
  const cell = t.cell || (t.display === 'robust' || t.display === 'quiet4' ? 4 : 2);
  const ox = t.ox || 0, oy = t.oy || 0;
  const rows = t.small ? Math.ceil(encoded.cells.length / CELLS) : MAXROWS;
  const width = CELLS * cell + ox, height = rows * cell + oy;
  const rgb = Buffer.alloc(width * height * 3, 0x30);
  // Deterministic noise makes failures reproducible, including at calibration.
  let seed = 0x12345678;
  encoded.cells.forEach((original, i) => {
    const v = t.corrupt && i === 20 ? original ^ 4 : original;
    const color = encoded.colors[v];
    for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) {
      const offset = ((oy + Math.floor(i / CELLS) * cell + y) * width + ox + (i % CELLS) * cell + x) * 3;
      for (let ch = 0; ch < 3; ch++) {
        const gamma = Array.isArray(t.gamma) ? t.gamma[ch] : (t.gamma || 1);
        let value = 255 * Math.pow(color[ch], gamma);
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        value += t.noise ? Math.round((seed / 0x100000000 * 2 - 1) * t.noise) : 0;
        if (t.flat) value = 40;
        if (t.collapsed) value = color[ch] > 0.1 ? 45 : 40;
        if (t.badCalibration && i < 5 && ch === 1) value = 32;
        if (t.residual && i === 1 && ch === 0) value += 30;
        if (t.occluded && i === 25) value = 48;
        rgb[offset + ch] = Math.max(0, Math.min(255, Math.round(value)));
      }
    }
  });
  if (t.filtered) {
    // A spatial low-pass models a display pipeline that mixes neighboring data cells.
    const source = Buffer.from(rgb);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let ch = 0; ch < 3; ch++) {
      let total = 0;
      for (let dx = -2; dx <= 2; dx++) total += source[(y * width + Math.max(0, Math.min(width - 1, x + dx))) * 3 + ch];
      rgb[(y * width + x) * 3 + ch] = Math.round(total / 5);
    }
  }
  // A clipped packet still contains its intact header, but cannot be accepted.
  const finalHeight = t.clip ? Math.max(cell + oy, height - cell) : height;
  return png(width, finalHeight, rgb.subarray(0, width * finalHeight * 3));
}

const utf8 = 'sess\x1Fchat\x1F65000\x1FC:\\Users\\me\\项目\x1F\x1Fhéllo ✓ — "quotes" & \\backslash\\ 🧙';
const cases = [];
for (const display of ['robust', 'compact', 'quiet', 'quiet4']) {
  for (const [n, id] of [16384, 32768, 49152, 65535].entries()) {
    cases.push({ name: `${display}/high-id-${id}`, display, id, payload: utf8,
      gamma: display.startsWith('quiet') ? [0.6, 1, 1.8, [0.7, 1.2, 1.6]][n] : [0.6, 1, 1.8, 1][n],
      noise: display.startsWith('quiet') ? 2 : (n === 3 ? 120 : 60), ox: 8, oy: 8, small: true });
  }
  cases.push({ name: `${display}/maximum-utf8`, display, id: 65000, payload: '界'.repeat(1066) + 'ab',
    noise: display.startsWith('quiet') ? 2 : 100, ox: 7, oy: 5 });
  cases.push({ name: `${display}/empty`, display, id: 0, payload: '', small: true });
  cases.push({ name: `${display}/checksum`, display, id: 65535, payload: utf8, corrupt: true, reject: true });
  cases.push({ name: `${display}/clipped`, display, id: 65000, payload: 'x'.repeat(3200), clip: true, small: true, reject: true });
  cases.push({ name: `${display}/oversized-length`, display, id: 65000, payload: 'x'.repeat(3201), reject: true });
}
cases.push(
  { name: 'robust/physical-scale-150%', display: 'robust', id: 7, payload: utf8, cell: 6, configuredCell: 6, ox: 8, oy: 8 },
  { name: 'robust/physical-scale-75%', display: 'robust', id: 9, payload: utf8, cell: 3, configuredCell: 3, small: true },
  { name: 'robust/standard-fallback', display: 'robust', id: 42, payload: utf8, configuredCell: 6 },
  { name: 'compact/configured-robust6', display: 'compact', id: 42, payload: utf8, configuredCell: 6, small: true },
  { name: 'quiet/configured-robust6', display: 'quiet', id: 42, payload: utf8, configuredCell: 6, small: true },
  { name: 'quiet/flat', display: 'quiet', id: 65000, payload: utf8, flat: true, reject: true },
  { name: 'quiet/collapsed-levels', display: 'quiet', id: 65000, payload: utf8, collapsed: true, reject: true },
  { name: 'quiet/malformed-channel', display: 'quiet', id: 65000, payload: utf8, badCalibration: true, reject: true },
  { name: 'quiet/calibration-residual', display: 'quiet', id: 65000, payload: utf8, residual: true, reject: true },
  { name: 'quiet/occluded-payload', display: 'quiet', id: 65000, payload: utf8, occluded: true, reject: true },
  { name: 'quiet/beyond-origin-bound', display: 'quiet', id: 65000, payload: utf8, ox: 12, reject: true },
  { name: 'quiet/bright-gamma', display: 'quiet', id: 49152, payload: utf8, gamma: 0.4, small: true },
  { name: 'compact/after-quiet-cache', display: 'compact', id: 49152, payload: utf8, small: true },
  { name: 'quiet/moved-after-compact-cache', display: 'quiet', id: 16384, payload: utf8, ox: 8, oy: 8, small: true },
  { name: 'robust/after-quiet-fallback', display: 'robust', id: 65535, payload: utf8, small: true },
  { name: 'quiet4/after-compact-quiet-failure', display: 'quiet4', id: 65000, payload: '界'.repeat(1066) + 'ab', small: true },
  { name: 'robust/after-quiet4-cache', display: 'robust', id: 49152, payload: utf8, small: true },
  { name: 'quiet/spatial-filter-rejected', display: 'quiet', id: 65000, payload: utf8, filtered: true, small: true, reject: true },
  { name: 'quiet4/spatial-filter-readable', display: 'quiet4', id: 65000, payload: utf8, filtered: true, small: true }
);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wowai-codec-'));
let pass = 0, total = 0;
try {
  const groups = new Map();
  for (const [index, t] of cases.entries()) {
    const configuredCell = t.configuredCell || 4;
    if (!groups.has(configuredCell)) groups.set(configuredCell, []);
    const entries = groups.get(configuredCell);
    const directory = path.join(tmp, String(configuredCell));
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `${String(index).padStart(4, '0')}.png`);
    fs.writeFileSync(file, render(encodeWithLua(t.id, t.payload, t.display), t));
    entries.push(t);
  }
  for (const [configuredCell, entries] of groups) {
    for (const decoder of decoders) {
      let results = [], failure;
      try {
        results = decoder.run(path.join(tmp, String(configuredCell)), configuredCell)
          .trim().split(/\r?\n/).map(line => JSON.parse(line));
        if (results.length !== entries.length) failure = `Expected ${entries.length} frames, got ${results.length}`;
      } catch (error) { failure = error.message; }
      for (const [index, t] of entries.entries()) {
        total++;
        const result = results[index];
        const accepted = result && Number.isInteger(result.id) && typeof result.text === 'string';
        const ok = !failure && (t.reject
          ? !accepted && typeof result?.error === 'string'
          : accepted && result.id === t.id && result.text === t.payload && result.display === t.display);
        if (ok) pass++;
        console.log(`${ok ? 'PASS' : 'FAIL'} ${decoder.name} ${t.name}` +
          (ok ? '' : `\n  ${failure || JSON.stringify(result)}`));
      }
    }
  }
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
console.log(pass === total ? '>>> CODEC ROUND-TRIP PASS' : '>>> CODEC ROUND-TRIP FAIL');
process.exitCode = pass === total ? 0 : 1;
