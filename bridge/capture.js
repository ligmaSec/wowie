'use strict';

const path = require('node:path');

// Config is the capture subtree. No filesystem or process-launch side effects.
function captureCommand(config = {}, options = {}) {
  const cap = Object.assign({ processName: 'Wow', cellPx: 4, cellsPerRow: 200, maxRows: 48, intervalMs: 50 }, config);
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const here = options.here ?? __dirname;
  const interval = Number.isFinite(Number(cap.intervalMs)) && Number(cap.intervalMs) > 0 ? Number(cap.intervalMs) : 50;
  const backend = cap.backend ?? 'auto';
  if (!['auto', 'wayland', 'x11'].includes(backend)) {
    throw new Error(`Invalid capture.backend ${JSON.stringify(backend)}; use "auto", "wayland", or "x11" in bridge/config.json.`);
  }
  if (platform === 'win32') {
    if (options.probe) throw new Error('The Windows capture helper does not support --probe; use normal bridge capture on Windows.');
    return ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'capture.ps1'),
      '-Cell', String(cap.cellPx), '-Cells', String(cap.cellsPerRow), '-MaxRows', String(cap.maxRows),
      '-IntervalMs', String(interval), '-ProcessName', cap.processName,
      '-ClientFolder', path.win32.basename(options.clientDir ?? '')]];
  }
  const wayland = platform === 'linux' && (backend === 'wayland' || (backend === 'auto' &&
    (Boolean(env.WAYLAND_DISPLAY) || String(env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland')));
  const helper = platform === 'darwin' ? 'capture_mac.py' : wayland ? 'capture_wayland.py' : 'capture_x11.py';
  const args = [path.join(here, helper), '--cell', String(cap.cellPx), '--cells', String(cap.cellsPerRow),
    '--max-rows', String(cap.maxRows), '--interval-ms', String(interval)];
  args.push('--process-name', cap.processName);
  if (cap.windowName) args.push('--window-name', cap.windowName);
  if (!wayland && platform !== 'darwin' && cap.keepComposited) args.push('--keep-composited');
  if (options.probe) args.push('--probe', options.probe);
  return [cap.python || 'python3', args];
}

module.exports = { captureCommand };
