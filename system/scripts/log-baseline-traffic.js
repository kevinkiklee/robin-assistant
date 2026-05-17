#!/usr/bin/env node
// Drive recall + remember + integration_status traffic for the given duration.
// Used by log-baseline.js --active.

import { spawn } from 'node:child_process';
import process from 'node:process';

const durationMs = Number(process.argv[2] || '180000');
const start = Date.now();

const queries = [
  'what did I eat yesterday',
  'photography projects',
  'recent corrections',
  'whoop sleep',
  'gmail subscriptions',
];
const remembers = [
  'baseline test note 1',
  'baseline test note 2',
];

async function callTool(name, args) {
  return new Promise((resolve) => {
    const proc = spawn('node', ['system/bin/robin', name, JSON.stringify(args)], {
      stdio: 'ignore',
    });
    proc.on('exit', () => resolve());
    proc.on('error', () => resolve());
  });
}

async function run() {
  let i = 0;
  while (Date.now() - start < durationMs) {
    const q = queries[i % queries.length];
    await callTool('recall', { query: q, limit: 10 });
    if (i % 5 === 0) {
      const c = remembers[Math.floor(Math.random() * remembers.length)];
      await callTool('remember', { content: c });
    }
    i += 1;
    await new Promise((r) => setTimeout(r, 5000));
  }
}

run();
