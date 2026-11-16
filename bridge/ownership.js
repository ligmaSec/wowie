'use strict';
// The guardian owns the installation lock until every provider watchdog has
// reaped its process tree. Kernel socket ownership recovers without PID files.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { createHash } = require('node:crypto');
const { fork, spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const os = require('node:os');

function canonical(file) {
  let current = path.resolve(file), tail = [];
  while (!fs.existsSync(current)) { tail.unshift(path.basename(current)); const next = path.dirname(current); if (next === current) break; current = next; }
  const resolved = path.join(fs.realpathSync(current), ...tail);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
function send(peer, message) {
  if (peer.connected) peer.send(message, err => { if (err && err.code !== 'ERR_IPC_CHANNEL_CLOSED' && err.code !== 'EPIPE') console.error(`Wowie ownership IPC: ${err.message}`); });
}

async function acquire(installation) {
  // Debugger/preload hooks belong to the bridge, not its independent watchdog.
  const guardian = fork(__filename, ['guardian', canonical(installation)], { execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'], windowsHide: true });
  await new Promise((resolve, reject) => {
    const exited = (code) => reject(Object.assign(new Error(`Bridge ownership unavailable (guardian exited ${code})`), { exitCode: code === 2 ? 2 : 1 }));
    guardian.once('error', reject);
    guardian.once('exit', exited);
    guardian.once('message', message => {
      guardian.removeListener('exit', exited);
      if (message.type === 'ready') resolve();
      else reject(Object.assign(new Error(message.error || 'Bridge ownership unavailable'), { exitCode: 2 }));
    });
  });
  const children = new Map();
  let next = 0, closing = false;
  guardian.on('message', message => {
    const child = children.get(message.id);
    if (!child) return;
    if (message.type === 'stdout' || message.type === 'stderr') { if (!child[message.type].destroyed) child[message.type].write(Buffer.from(message.data, 'base64')); }
    else if (message.type === 'error') child.emit('error', new Error(message.error));
    else if (message.type === 'close') {
      children.delete(message.id);
      child.stdout.end(); child.stderr.end();
      child.emit('close', message.code, message.signal);
    }
  });
  guardian.on('exit', code => {
    if (!closing) {
      console.error(`Provider guardian exited unexpectedly (${code}); refusing further work`);
      process.exit(1);
    }
  });
  return {
    spawn(file, args, options) {
      const id = ++next, child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.stdin = new Writable({
        write(chunk, encoding, callback) { send(guardian, { type: 'stdin', id, data: chunk.toString('base64') }); callback(); },
        final(callback) { send(guardian, { type: 'end', id }); callback(); },
      });
      child.kill = () => send(guardian, { type: 'stop', id });
      children.set(id, child);
      send(guardian, { type: 'spawn', id, file, args, options });
      return child;
    },
    close() { closing = true; if (guardian.connected) guardian.disconnect(); },
  };
}

function guardianMain(installation) {
  const digest = createHash('sha256').update(installation).digest();
  // A hash collision intentionally fails closed instead of sharing ownership.
  const port = 16384 + digest.readUInt32BE(0) % 49152;
  const server = net.createServer(socket => socket.destroy());
  const children = new Map();
  let stopping = false, exitCode = 0;
  const done = () => { if (stopping && !children.size) server.close(() => process.exit(exitCode)); };
  const stop = () => {
    if (stopping) return;
    stopping = true;
    for (const child of children.values()) send(child, { type: 'stop' });
    done();
  };
  process.on('disconnect', stop);
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  server.on('error', err => { exitCode = 2; send(process, { type: 'error', error: `Another bridge owns this installation, or its exclusive lock is unavailable (${err.code}, localhost:${port}).` }); if (process.connected) process.disconnect(); });
  server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
    if (stopping) { done(); return; }
    send(process, { type: 'ready' });
    process.on('message', message => {
      if (stopping) return;
      if (message.type === 'spawn') {
        const child = fork(__filename, ['provider'], { execArgv: [], cwd: message.options.cwd, env: message.options.env, windowsHide: true,
          stdio: [message.options.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe', 'ipc'] });
        children.set(message.id, child);
        for (const stream of ['stdout', 'stderr']) child[stream].on('data', data => send(process, { type: stream, id: message.id, data: data.toString('base64') }));
        child.on('message', result => { if (result.type === 'error') send(process, { ...result, id: message.id }); });
        child.on('error', err => send(process, { type: 'error', id: message.id, error: err.message }));
        child.on('close', (code, signal) => {
          children.delete(message.id);
          send(process, { type: 'close', id: message.id, code, signal });
          done();
        });
        if (child.stdin) child.stdin.on('error', err => { if (err.code !== 'EPIPE' && err.code !== 'ERR_STREAM_DESTROYED') send(process, { type: 'error', id: message.id, error: err.message }); });
        send(child, { type: 'start', file: message.file, args: message.args, options: message.options });
      } else {
        const child = children.get(message.id);
        if (!child) return;
        if (message.type === 'stop') send(child, { type: 'stop' });
        else if (message.type === 'stdin' && child.stdin && !child.stdin.destroyed) child.stdin.write(Buffer.from(message.data, 'base64'));
        else if (message.type === 'end' && child.stdin) child.stdin.end();
      }
    });
  });
}

function providerMain() {
  let child, specDirectory, stopping = false, closed = false, exitCode = 1, exitSignal = null;
  const exit = () => {
    if (specDirectory) fs.rmSync(specDirectory, { recursive: true, force: true });
    if (exitSignal && process.platform !== 'win32') { process.removeAllListeners(exitSignal); process.kill(process.pid, exitSignal); }
    else process.exit(exitCode === null ? 1 : exitCode);
  };
  const cleanup = () => {
    if (stopping) return;
    stopping = true;
    if (!child || !child.pid) { exit(); return; }
    if (process.platform === 'win32') {
      // PowerShell owns a kernel Job Object, so killing its root closes the
      // sole job handle and kills descendants even if the provider has exited.
      if (closed) exit(); else child.kill();
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (err) { if (err.code !== 'ESRCH') throw err; }
      if (closed) exit();
    }
  };
  process.on('disconnect', cleanup);
  process.on('SIGTERM', cleanup); process.on('SIGINT', cleanup);
  process.on('message', message => {
    if (message.type === 'stop') { cleanup(); return; }
    if (message.type !== 'start' || child || stopping) return;
    if (process.platform === 'win32') {
      specDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'wowie-owned-'));
      const specFile = path.join(specDirectory, 'provider.json');
      const environment = Object.keys(message.options.env).sort((a, b) => a.toUpperCase().localeCompare(b.toUpperCase()))
        .map(key => `${key}=${message.options.env[key]}`).join('\0') + '\0\0';
      fs.writeFileSync(specFile, JSON.stringify({ file: message.file, args: message.args, cwd: message.options.cwd, environment }), { mode: 0o600 });
      const systemRoot = process.env.SystemRoot || process.env.WINDIR;
      if (!systemRoot) throw new Error('Windows process ownership requires SystemRoot');
      const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'ownership.ps1')],
        { cwd: message.options.cwd, env: { ...message.options.env, WOWIE_PROVIDER_SPEC_FILE: specFile }, windowsHide: true,
          stdio: [message.options.stdin ? 0 : 'ignore', 1, 2] });
    } else {
      child = spawn(message.file, message.args, { cwd: message.options.cwd, env: message.options.env, detached: true,
        stdio: [message.options.stdin ? 0 : 'ignore', 1, 2] });
    }
    child.on('error', err => { send(process, { type: 'error', error: err.message }); });
    child.on('close', (code, signal) => {
      closed = true; exitCode = code; exitSignal = signal;
      if (stopping) exit(); else cleanup();
    });
  });
}

if (require.main === module) {
  if (process.argv[2] === 'guardian') guardianMain(process.argv[3]);
  else if (process.argv[2] === 'provider') providerMain();
  else if (process.argv[2] === 'catalog') require('./agents').discoverModels(process.argv[3], JSON.parse(process.argv[4]))
    .then(models => { process.stdout.write(JSON.stringify(models)); }, err => { console.error(err.message); process.exitCode = 1; });
} else module.exports = { acquire };
