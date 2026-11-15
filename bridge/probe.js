#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { captureCommand } = require('./capture');

function probeCommand(argv = [], options = {}) {
  const here = options.here ?? __dirname;
  let output;
  for (const arg of argv) {
    if (arg.startsWith('-') || output !== undefined) {
      throw new Error('Usage: npm run probe -- [output.png]');
    }
    output = arg;
  }
  const file = path.join(here, 'config.json');
  let config = {};
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) {
    // A fresh checkout can probe with defaults; an existing broken config must not be ignored.
    if (err.code !== 'ENOENT') throw new Error(`Cannot read ${file}: ${err.message}`);
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(`Expected an object in ${file}.`);
  const clientDir = config.addonDir ? path.dirname(path.dirname(config.addonDir)) : '';
  return captureCommand(config.capture || {}, { ...options, here, clientDir,
    probe: output === undefined ? path.join(here, 'probe.png') : path.resolve(output) });
}

// Resolves to the helper's exit status, including terminal setup failures (2).
function runProbe(argv = [], options = {}) {
  const [file, args] = probeCommand(argv, options);
  return new Promise(resolve => {
    const child = spawn(file, args, { windowsHide: true, stdio: 'inherit', env: options.env ?? process.env });
    const stop = () => { try { child.kill(); } catch {} };
    const interrupt = () => { stop(); process.exit(130); };
    const terminate = () => { stop(); process.exit(143); };
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', terminate);
    process.once('exit', stop);
    const cleanup = () => {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', terminate);
      process.removeListener('exit', stop);
    };
    child.once('error', err => {
      console.error(`Capture probe could not start (${file}): ${err.message}`);
      cleanup();
      resolve(1);
    });
    child.once('close', (code, signal) => {
      cleanup();
      resolve(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1));
    });
  });
}

if (require.main === module) {
  try {
    runProbe(process.argv.slice(2)).then(code => { process.exitCode = code; });
  } catch (err) {
    console.error(err.message);
    process.exitCode = 2;
  }
}

module.exports = { probeCommand, runProbe };
