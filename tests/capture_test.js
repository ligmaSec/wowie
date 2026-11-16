'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { captureCommand } = require('../bridge/capture');
const { probeCommand } = require('../bridge/probe');

const ROOT = path.resolve(__dirname, '..');
const HERE = path.join(os.tmpdir(), 'wowie-capture-helpers');
const linux = env => ({ platform: 'linux', env, here: HERE });
const helper = command => path.basename(command[1][0]);
const flag = (command, name) => command[1][command[1].indexOf(name) + 1];

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wowie-capture-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('auto detects Wayland even when DISPLAY coexists; otherwise it preserves X11', () => {
  for (const env of [{}, { DISPLAY: ':0' }, { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' }]) {
    assert.equal(helper(captureCommand({}, linux(env))), 'capture_x11.py');
  }
  for (const env of [
    { WAYLAND_DISPLAY: 'wayland-0' },
    { XDG_SESSION_TYPE: 'wayland' },
    { WAYLAND_DISPLAY: 'wayland-1', DISPLAY: ':0' },
    { XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0' },
  ]) assert.equal(helper(captureCommand({}, linux(env))), 'capture_wayland.py');
  assert.equal(helper(captureCommand({ backend: 'x11' }, linux({ WAYLAND_DISPLAY: 'wayland-1', DISPLAY: ':0' }))), 'capture_x11.py');
  assert.equal(helper(captureCommand({ backend: 'wayland' }, linux({ DISPLAY: ':0' }))), 'capture_wayland.py');
  assert.throws(() => captureCommand({ backend: 'portal' }, linux({})), /capture\.backend.*auto.*wayland.*x11/);
});

test('Wayland forwards process and title without picker, token or X11 compositor options', () => {
  const config = { backend: 'wayland', python: '/custom/python', cellPx: 7, cellsPerRow: 128, maxRows: 30,
    intervalMs: 125, processName: 'WowClassic', windowName: 'WoW', keepComposited: true, restoreTokenFile: '/state/obsolete.json' };
  const before = structuredClone(config);
  assert.deepEqual(captureCommand(config, { ...linux({}), probe: '/out/frame.png' }), [
    '/custom/python', [path.join(HERE, 'capture_wayland.py'), '--cell', '7', '--cells', '128', '--max-rows', '30',
      '--interval-ms', '125', '--process-name', 'WowClassic', '--window-name', 'WoW', '--probe', '/out/frame.png'],
  ]);
  assert.deepEqual(config, before, 'command construction does not mutate configuration');
  const defaults = captureCommand({}, linux({ WAYLAND_DISPLAY: 'wayland-0' }));
  assert.equal(defaults[0], 'python3');
  assert.equal(flag(defaults, '--cell'), '4');
  assert.equal(flag(defaults, '--cells'), '200');
  assert.equal(flag(defaults, '--max-rows'), '48');
  assert.equal(flag(defaults, '--interval-ms'), '50');
  assert.equal(flag(defaults, '--process-name'), 'Wow');
  for (const removed of ['--window-name', '--restore-token-file', '--select-source', '--keep-composited']) {
    assert.ok(!defaults[1].includes(removed), removed);
  }
  for (const intervalMs of [0, -1, 'bad']) {
    assert.equal(flag(captureCommand({ intervalMs }, linux({})), '--interval-ms'), '50');
  }
});

test('X11, macOS and Windows retain their platform-specific arguments', () => {
  const config = { processName: 'WowClassic', windowName: 'World of Warcraft', keepComposited: true,
    python: '/custom/python' };
  assert.deepEqual(captureCommand(config, linux({})), ['/custom/python', [
    path.join(HERE, 'capture_x11.py'), '--cell', '4', '--cells', '200', '--max-rows', '48', '--interval-ms', '50',
    '--process-name', 'WowClassic', '--window-name', 'World of Warcraft', '--keep-composited',
  ]]);
  assert.deepEqual(captureCommand(config, { platform: 'darwin', env: { WAYLAND_DISPLAY: 'wayland-0' }, here: HERE, probe: '/out/mac.png' }), [
    '/custom/python', [path.join(HERE, 'capture_mac.py'), '--cell', '4', '--cells', '200', '--max-rows', '48', '--interval-ms', '50',
      '--process-name', 'WowClassic', '--window-name', 'World of Warcraft', '--probe', '/out/mac.png'],
  ]);
  assert.deepEqual(captureCommand(config, { platform: 'win32', here: HERE, clientDir: 'C:\\Games\\WoW\\_forever_' }), [
    'powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'capture.ps1'),
      '-Cell', '4', '-Cells', '200', '-MaxRows', '48', '-IntervalMs', '50', '-ProcessName', 'WowClassic', '-ClientFolder', '_forever_'],
  ]);
  assert.throws(() => captureCommand({}, { platform: 'win32', probe: '/out/windows.png' }), /Windows.*does not support --probe/);
});

test('probe defaults only for missing config, forwards matching options and rejects removed picker options', t => {
  const dir = temporary(t), options = { ...linux({ WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }), here: dir };
  const command = probeCommand([], options);
  assert.equal(command[0], 'python3');
  assert.equal(helper(command), 'capture_wayland.py');
  assert.equal(flag(command, '--probe'), path.join(dir, 'probe.png'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ capture: {
    backend: 'wayland', python: '/configured/python', cellPx: 6, cellsPerRow: 99, maxRows: 31,
    intervalMs: 90, processName: 'WowClassic', windowName: 'World of Warcraft', enabled: false,
  } }));
  const configured = probeCommand(['custom-frame.png'], options);
  assert.equal(configured[0], '/configured/python');
  for (const [name, value] of [['--cell', '6'], ['--cells', '99'], ['--max-rows', '31'], ['--interval-ms', '90'],
    ['--process-name', 'WowClassic'], ['--window-name', 'World of Warcraft'], ['--probe', path.resolve('custom-frame.png')]]) {
    assert.equal(flag(configured, name), value);
  }
  for (const args of [['--select-source'], ['--select-source', 'frame.png'], ['--restore-token-file', 'token']]) {
    assert.throws(() => probeCommand(args, options), /Usage:/);
  }
  fs.writeFileSync(path.join(dir, 'config.json'), '{broken');
  assert.throws(() => probeCommand([], options), /Cannot read.*config\.json/);
  assert.throws(() => probeCommand(['--bogus'], options), /Usage:/);
  assert.throws(() => probeCommand(['one.png', 'two.png'], options), /Usage:/);
});

test('probe forwards helper output and exact successful, terminal and transient exit statuses', t => {
  const dir = temporary(t);
  for (const name of ['capture.js', 'probe.js']) fs.copyFileSync(path.join(ROOT, 'bridge', name), path.join(dir, name));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ capture: { backend: 'wayland', python: process.execPath, cellPx: 8 } }));
  fs.writeFileSync(path.join(dir, 'capture_wayland.py'), `
    console.log(JSON.stringify({info:'fixture helper',args:process.argv.slice(2)}));
    console.error('fixture diagnostic');
    process.exit(Number(process.env.FIXTURE_CAPTURE_EXIT));
  `);
  const runner = path.join(dir, 'runner.js');
  fs.writeFileSync(runner, `require('./probe').runProbe(process.argv.slice(2), {platform:'linux'}).then(code => {process.exitCode=code;});`);
  for (const code of [0, 2, 7]) {
    const result = spawnSync(process.execPath, [runner], {
      encoding: 'utf8', env: { ...process.env, FIXTURE_CAPTURE_EXIT: String(code) }, timeout: 10000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, code, result.stderr);
    const event = JSON.parse(result.stdout.trim());
    assert.equal(event.info, 'fixture helper');
    assert.equal(event.args[event.args.indexOf('--cell') + 1], '8');
    assert.equal(event.args[event.args.indexOf('--process-name') + 1], 'Wow');
    assert.equal(event.args[event.args.indexOf('--probe') + 1], path.join(dir, 'probe.png'));
    assert.ok(!event.args.includes('--select-source'));
    assert.match(result.stderr, /fixture diagnostic/);
  }
  fs.writeFileSync(path.join(dir, 'config.json'), '{broken');
  const invalid = spawnSync(process.execPath, [path.join(dir, 'probe.js')], { encoding: 'utf8', timeout: 10000 });
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /Cannot read.*config\.json/);
});

async function until(predicate, diagnostic = () => '') {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for capture fixture: ' + diagnostic());
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

function bridgeFixture(t, mode, normalExit = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wowie-capture-test-'));
  for (const name of fs.readdirSync(path.join(ROOT, 'bridge')).filter(name => name.endsWith('.js') || name === 'ownership.ps1')) {
    fs.copyFileSync(path.join(ROOT, 'bridge', name), path.join(dir, name));
  }
  const addons = path.join(dir, 'Interface', 'AddOns');
  fs.mkdirSync(path.join(addons, 'Wowie'), { recursive: true });
  fs.writeFileSync(path.join(addons, 'Wowie', 'Wowie.toc'), '## Interface: 16001\n');
  const config = { addonDir: addons, defaultCwd: dir, agent: 'claude', slots: 1, primerFile: '', gameContext: false,
    agents: Object.fromEntries(['claude', 'codex', 'grok', 'agy', 'hermes'].map(id => [id, { path: path.join(dir, 'absent-cli') }])),
    capture: { backend: 'wayland', python: process.execPath } };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(dir, 'capture_wayland.py'), `
    const fs = require('node:fs'), path = require('node:path');
    const starts = path.join(__dirname, 'starts');
    fs.appendFileSync(starts, String(process.pid)+'\\n');
    const count = fs.readFileSync(starts,'utf8').trim().split('\\n').length;
    console.log(JSON.stringify({info:'fixture capture started '+count}));
    if (${JSON.stringify(mode)} === 'terminal') process.exit(2);
    if (${JSON.stringify(mode)} === 'transient' && count === 1) process.exit(7);
    setInterval(() => {}, 1000);
  `);
  fs.writeFileSync(path.join(dir, 'capture.js'),
    `const path = require('node:path'); exports.captureCommand = () => [process.execPath, [path.join(__dirname, 'capture_wayland.py')]];`);
  const preload = path.join(dir, 'preload.js');
  fs.writeFileSync(preload, `
    ${normalExit ? "const fs=require('node:fs'),path=require('node:path'); const timer=setInterval(()=>{if(fs.existsSync(path.join(__dirname,'exit-parent'))){clearInterval(timer);process.exit(0);}},25);" : ''}
  `);
  const child = spawn(process.execPath, ['--require', preload, path.join(dir, 'bridge.js')], {
    cwd: dir, env: { ...process.env, PATH: '', WAYLAND_DISPLAY: 'fixture-wayland' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  const pids = () => fs.existsSync(path.join(dir, 'starts')) ? fs.readFileSync(path.join(dir, 'starts'), 'utf8').trim().split('\n').map(Number) : [];
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
    for (const pid of pids()) { try { process.kill(pid); } catch {} }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { child, closed, dir, pids, output: () => output };
}

test('bridge terminal capture failure does not restart capture', { timeout: 15000 }, async t => {
  const fixture = bridgeFixture(t, 'terminal');
  await until(() => fixture.output().includes('capture requires action (exit 2)'), fixture.output);
  await new Promise(resolve => setTimeout(resolve, 5300));
  assert.equal(fixture.pids().length, 1, fixture.output());
  assert.equal(fixture.child.exitCode, null, 'SavedVariables fallback remains running');
});

test('bridge transient capture failure restarts after five seconds', { timeout: 15000 }, async t => {
  const fixture = bridgeFixture(t, 'transient');
  await until(() => fixture.pids().length === 2, fixture.output);
  assert.match(fixture.output(), /capture exited \(7\); restarting in 5 s/);
});

for (const reason of ['SIGINT', 'SIGTERM', 'normal exit']) {
  test(`bridge ${reason} leaves no capture child`, { timeout: 15000 }, async t => {
    const fixture = bridgeFixture(t, 'running', reason === 'normal exit');
    await until(() => fixture.output().includes('fixture capture started 1'), fixture.output);
    const [pid] = fixture.pids();
    if (reason === 'normal exit') fs.writeFileSync(path.join(fixture.dir, 'exit-parent'), 'exit');
    else fixture.child.kill(reason);
    await fixture.closed;
    await until(() => { try { process.kill(pid, 0); return false; } catch (err) { return err.code === 'ESRCH'; } }, fixture.output);
  });
}
