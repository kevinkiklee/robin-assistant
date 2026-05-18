#!/usr/bin/env node
// Drive realistic daemon traffic via real CLI surfaces for the given duration.
// Used by log-baseline.js --active.

import { spawn } from 'node:child_process';
import process from 'node:process';

const durationMs = Number(process.argv[2] || '180000');
const start = Date.now();

const rememberContents = [
  'baseline test note 1',
  'baseline test note 2',
  'baseline test note 3',
];

function callCli(args) {
  return new Promise((resolve) => {
    const proc = spawn('node', ['system/bin/robin', ...args], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    proc.on('exit', () => resolve());
    proc.on('error', () => resolve());
  });
}

async function run() {
  let i = 0;
  while (Date.now() - start < durationMs) {
    const roll = Math.random();
    if (roll < 0.6) {
      await callCli(['hot']);
    } else if (roll < 0.8) {
      await callCli(['journal']);
    } else if (roll < 0.9) {
      const c = rememberContents[i % rememberContents.length];
      await callCli(['remember', c]);
    } else {
      // idle interleave
    }
    i += 1;
    await new Promise((r) => setTimeout(r, 5000));
  }
}

run();
