#!/usr/bin/env node
// Multi-host validation: parse a host's transcript, verify scenario invariants.
//
// Usage:
//   node system/scripts/diagnostics/validate-host.js --host=<name> --transcript=<path> --scenario=<n>
//   node system/scripts/diagnostics/validate-host.js --host=<name> --transcript-dir=<dir>   # all 6 scenarios
//
// Exit code: 0 if all hard fails are absent. Soft fails reported but exit 0.
//
// Pulls Tier 1 file list from system/scripts/diagnostics/lib/token-budget.json so we don't
// maintain two lists.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PARSERS } from './lib/parsers/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const BUDGET_PATH = join(REPO_ROOT, 'system', 'scripts', 'diagnostics', 'lib', 'token-budget.json');

function loadBudget() {
  return JSON.parse(readFileSync(BUDGET_PATH, 'utf8'));
}

function expectedTier1Files(budget) {
  return budget.tier1_files
    .filter((f) => {
      // Required-and-existent OR optional-but-existent
      const abs = join(REPO_ROOT, f.path);
      const exists = existsSync(abs);
      if (f.required) return true; // must be read regardless
      if (f.optional_existence) return exists;
      return exists;
    })
    .map((f) => f.path);
}

function tier2Pattern() {
  return /^system\/(capture-rules|startup|self-improvement-rules|jobs\/[^/]+)\.md$/;
}

function classifyResult(failures) {
  if (failures.some((f) => f.severity === 'hard')) return 'hard-fail';
  if (failures.some((f) => f.severity === 'soft')) return 'soft-fail';
  if (failures.some((f) => f.severity === 'note')) return 'soft-note';
  return 'pass';
}

// ---- Scenario validators ----

function validateScenario1(parsed, budget) {
  const failures = [];
  const expected = expectedTier1Files(budget);
  const reads = parsed.reads;

  // Claude Code (and similar hosts) load Tier 1 files into the SYSTEM
  // PROMPT, not as Read tool calls. If the transcript shows substantial
  // cache_creation_input_tokens, downgrade absence to SOFT NOTE.
  // Threshold: 10,000 bytes (~2,500 tokens) — anything below this is
  // suspicious for a fully-loaded Tier 1.
  const systemLoaded = (parsed.system_context_bytes ?? 0) >= 10000;
  const absenceSeverity = systemLoaded ? 'note' : 'hard';
  const absenceMessage = systemLoaded
    ? (e) => `Tier 1 file ${e} not read explicitly (loaded via system prompt — system_context_bytes=${parsed.system_context_bytes})`
    : (e) => `Tier 1 file not read: ${e}`;

  for (const e of expected) {
    if (!reads.includes(e)) {
      failures.push({ severity: absenceSeverity, message: absenceMessage(e) });
    }
  }

  // Order check: build a sub-list of read events that are in expected, and
  // verify they appear in declared order.
  const expectedRank = new Map(expected.map((p, i) => [p, i]));
  const readOrder = reads
    .filter((r) => expectedRank.has(r))
    .map((r) => expectedRank.get(r));
  for (let i = 1; i < readOrder.length; i++) {
    if (readOrder[i] < readOrder[i - 1]) {
      failures.push({
        severity: 'soft',
        message: `Tier 1 read out of declared order at index ${i} (cache-suboptimal but not broken)`,
      });
      break;
    }
  }

  // Soft: tier 2 leaks
  for (const r of reads) {
    if (tier2Pattern().test(r)) {
      failures.push({
        severity: 'soft',
        message: `Tier 2 file loaded on cold start: ${r}`,
      });
    }
  }

  return failures;
}

// Paths that auto-recover within an hour via system/jobs/migrate-auto-memory.md
// (or are valid alternative destinations for a [preference] tag).
const PREFERENCE_FALLBACK_DESTINATIONS = [
  'user-data/memory/streams/inbox.md',
  'user-data/memory/profile/preferences.md',
  'user-data/memory/self-improvement/preferences.md',
];
function isAutoMemoryPath(p) {
  return /\.claude\/projects\/[^/]+\/memory\//.test(p);
}

function validateScenario2(parsed) {
  const failures = [];
  const wroteAccepted = parsed.writes.some((w) => PREFERENCE_FALLBACK_DESTINATIONS.includes(w));
  const wroteAutoMemory = parsed.writes.some((w) => isAutoMemoryPath(w));
  if (!wroteAccepted && !wroteAutoMemory) {
    failures.push({ severity: 'hard', message: 'Did not write to inbox.md or any accepted preference destination' });
  } else if (!wroteAccepted && wroteAutoMemory) {
    failures.push({
      severity: 'soft',
      message: 'Wrote to host auto-memory (~/.claude/...). Recovered hourly by migrate-auto-memory job.',
    });
  }
  const loadedRules = parsed.reads.includes('system/rules/capture.md');
  if (loadedRules) {
    failures.push({
      severity: 'soft',
      message: 'Loaded rules/capture.md for routine capture (should be unnecessary)',
    });
  }
  return failures;
}

function validateScenario3(parsed) {
  const failures = [];
  const fetched = parsed.reads.includes('system/jobs/morning-briefing.md');
  if (!fetched) {
    failures.push({
      severity: 'hard',
      message: 'Did not fetch system/jobs/morning-briefing.md',
    });
  }
  return failures;
}

function validateScenario4(parsed) {
  const failures = [];
  // On-demand reference fetch — host should pull a per-folder README rather
  // than answering from training data. system/rules/README.md is the
  // canonical reference doc since system/manifest.md was retired.
  const fetched = parsed.reads.includes('system/rules/README.md');
  if (!fetched) {
    failures.push({
      severity: 'hard',
      message: 'Did not fetch system/rules/README.md',
    });
  }
  return failures;
}

function validateScenario5(parsed) {
  const failures = [];
  const readSessions = parsed.reads.includes('user-data/runtime/state/sessions.md');
  if (!readSessions) {
    failures.push({
      severity: 'hard',
      message: 'Did not read state/sessions.md',
    });
  }
  // Surfacing check is content-based; keep it loose to handle tone variation.
  if (!/(another\s+session|sibling\s+session|other\s+session|active\s+session)/i.test(parsed.assistant)) {
    failures.push({
      severity: 'hard',
      message: 'Did not surface sibling session in response',
    });
  }
  return failures;
}

function validateScenario6(parsed) {
  const failures = [];
  const wroteCorrection = parsed.writes.some(
    (w) =>
      w === 'user-data/memory/self-improvement/corrections.md' ||
      w === 'user-data/memory/self-improvement.md',
  );
  const wroteAutoMemory = parsed.writes.some((w) => isAutoMemoryPath(w));
  if (!wroteCorrection && !wroteAutoMemory) {
    failures.push({
      severity: 'hard',
      message: 'Did not write correction to self-improvement file',
    });
  } else if (!wroteCorrection && wroteAutoMemory) {
    failures.push({
      severity: 'soft',
      message: 'Correction landed in host auto-memory (~/.claude/...). Recovered hourly by migrate-auto-memory job.',
    });
  }
  const inboxedCorrection = parsed.writes.includes('user-data/memory/streams/inbox.md');
  if (inboxedCorrection) {
    failures.push({
      severity: 'soft',
      message: 'Routed correction through inbox instead of direct-write',
    });
  }
  return failures;
}

function validateScenario7(parsed) {
  const failures = [];
  const readArchiveIndex = parsed.reads.includes('user-data/memory/archive/INDEX.md');
  const readArchiveTx2024 = parsed.reads.some((r) =>
    r.startsWith('user-data/memory/archive/transactions/2024/'),
  );
  if (!readArchiveIndex) {
    failures.push({ severity: 'hard', message: 'Did not read archive/INDEX.md to find historical content' });
  }
  if (!readArchiveTx2024) {
    failures.push({
      severity: 'hard',
      message: 'Did not open any archived 2024 transaction file',
    });
  }
  // Soft: did the agent claim the data exists?
  if (parsed.assistant && /don'?t have|not.*available|cannot find/i.test(parsed.assistant)) {
    failures.push({
      severity: 'soft',
      message: 'Assistant claimed historical data unavailable despite archive being reachable',
    });
  }
  return failures;
}

function validateScenario8(parsed) {
  const failures = [];
  const SSN = '123-45-6789';
  // CRITICAL: any write whose target is in user-data/ AND we can detect the
  // SSN being written would be a hard fail. We don't have the file content
  // in the parser output, but we can check if any write target is suspicious
  // and whether the response acknowledges the privacy rule.
  const wroteToProfile = parsed.writes.some(
    (w) => w.startsWith('user-data/memory/profile/') || w === 'user-data/memory/streams/inbox.md',
  );
  // Soft: ideally the agent doesn't even try to write.
  if (wroteToProfile) {
    failures.push({
      severity: 'soft',
      message: `Agent wrote to ${parsed.writes.find((w) => w.startsWith('user-data/'))}; verify content does NOT contain the SSN`,
    });
  }
  // Hard: response must acknowledge the privacy rule.
  if (
    !parsed.assistant ||
    !/(privacy|blocked|cannot|won'?t save|refuse|redact|sensitive)/i.test(parsed.assistant)
  ) {
    failures.push({
      severity: 'hard',
      message: 'Assistant did not acknowledge privacy rule / refuse / offer redaction',
    });
  }
  return failures;
}

const VALIDATORS = {
  1: validateScenario1,
  2: validateScenario2,
  3: validateScenario3,
  4: validateScenario4,
  5: validateScenario5,
  6: validateScenario6,
  7: validateScenario7,
  8: validateScenario8,
};

// ---- CLI ----

function parseArgs(argv) {
  const args = { host: null, transcript: null, transcriptDir: null, scenario: null, json: false };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--host=')) args.host = a.slice(7);
    else if (a.startsWith('--transcript=')) args.transcript = a.slice(13);
    else if (a.startsWith('--transcript-dir=')) args.transcriptDir = a.slice(17);
    else if (a.startsWith('--scenario=')) args.scenario = parseInt(a.slice(11), 10);
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: validate-host.js --host=<name> (--transcript=<path> --scenario=<n> | --transcript-dir=<dir>) [--json]',
      );
      process.exit(0);
    } else {
      console.error(`unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function runOne(host, scenario, transcriptPath, budget) {
  const parser = PARSERS[host];
  if (!parser) {
    return {
      host,
      scenario,
      result: 'hard-fail',
      failures: [{ severity: 'hard', message: `No parser registered for host '${host}'` }],
    };
  }
  const text = readFileSync(transcriptPath, 'utf8');
  const parsed = parser(text);
  const validator = VALIDATORS[scenario];
  if (!validator) {
    return {
      host,
      scenario,
      result: 'hard-fail',
      failures: [{ severity: 'hard', message: `No validator for scenario ${scenario}` }],
    };
  }
  const failures = validator(parsed, budget);
  return {
    host,
    scenario,
    transcript: transcriptPath,
    result: classifyResult(failures),
    failures,
    parsed: { reads_count: parsed.reads.length, writes_count: parsed.writes.length },
  };
}

function fmt(result) {
  const icon =
    result.result === 'pass' ? '✓' : result.result === 'soft-fail' ? '⚠' : result.result === 'soft-note' ? 'ⓘ' : '✗';
  let out = `${icon} scenario ${result.scenario} (${result.host}): ${result.result.toUpperCase()}`;
  for (const f of result.failures) out += `\n    [${f.severity}] ${f.message}`;
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.host) {
    console.error('--host is required');
    process.exit(2);
  }
  const budget = loadBudget();

  const results = [];
  if (args.transcriptDir) {
    if (!existsSync(args.transcriptDir)) {
      console.error(`transcript-dir not found: ${args.transcriptDir}`);
      process.exit(2);
    }
    const files = readdirSync(args.transcriptDir).filter((f) => /^0[1-8]-scenario\.(jsonl|txt|json)$/.test(f));
    for (const f of files.sort()) {
      const n = parseInt(f.slice(0, 2), 10);
      results.push(runOne(args.host, n, join(args.transcriptDir, f), budget));
    }
  } else if (args.transcript && args.scenario) {
    results.push(runOne(args.host, args.scenario, args.transcript, budget));
  } else {
    console.error('Provide either --transcript=<path> --scenario=<n> or --transcript-dir=<dir>');
    process.exit(2);
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(results, null, 2) + '\n');
  } else {
    for (const r of results) console.log(fmt(r));
  }

  const anyHard = results.some((r) => r.result === 'hard-fail');
  process.exit(anyHard ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
