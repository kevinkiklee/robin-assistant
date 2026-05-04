import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { cronToCalendarIntervals, generatePlist, LABEL_PREFIX } from '../../../scripts/jobs/installer/launchd.js';
import { buildManagedBlock, replaceManagedBlock, removeManagedBlock, BEGIN_MARKER, END_MARKER } from '../../../scripts/jobs/installer/cron-linux.js';
import { cronToTaskTrigger, buildRegisterCommand, TASK_FOLDER } from '../../../scripts/jobs/installer/taskscheduler.js';

describe('launchd: cronToCalendarIntervals', () => {
  test('daily 0 4 * * * → single dict { Hour: 4, Minute: 0 }', () => {
    const r = cronToCalendarIntervals('0 4 * * *');
    assert.deepEqual(r, [{ Minute: 0, Hour: 4 }]);
  });

  test('weekly Sunday 0 10 * * 0', () => {
    const r = cronToCalendarIntervals('0 10 * * 0');
    assert.deepEqual(r, [{ Minute: 0, Hour: 10, Weekday: 0 }]);
  });

  test('monthly day-of-month 0 9 1 * *', () => {
    const r = cronToCalendarIntervals('0 9 1 * *');
    assert.deepEqual(r, [{ Minute: 0, Hour: 9, Day: 1 }]);
  });

  test('every 6h 15 */6 * * * → 4 dicts', () => {
    const r = cronToCalendarIntervals('15 */6 * * *');
    assert.equal(r.length, 4);
    assert.equal(r[0].Minute, 15);
    assert.deepEqual(
      r.map((x) => x.Hour),
      [0, 6, 12, 18]
    );
  });
});

describe('launchd: generatePlist', () => {
  test('produces well-formed plist with key fields', () => {
    const xml = generatePlist({
      name: 'dream',
      argv: ['/usr/local/bin/robin'],
      workspaceDir: '/Users/x/ws',
      schedule: '0 4 * * *',
    });
    assert.match(xml, /<\?xml/);
    assert.match(xml, new RegExp(`<key>Label</key>\\s*<string>${LABEL_PREFIX}dream</string>`));
    assert.match(xml, /<key>WorkingDirectory<\/key>\s*<string>\/Users\/x\/ws<\/string>/);
    assert.match(xml, /<key>Hour<\/key>\s*<integer>4<\/integer>/);
    assert.match(xml, /run/);
  });

  test('adds ROBIN_WORKSPACE env', () => {
    const xml = generatePlist({
      name: 'x',
      argv: ['/r'],
      workspaceDir: '/ws',
      schedule: '0 4 * * *',
    });
    assert.match(xml, /<key>ROBIN_WORKSPACE<\/key>\s*<string>\/ws<\/string>/);
  });

  // Regression: launchd treats each <string> in ProgramArguments as one argv
  // element. Joining node-binary + script with a space produces a single
  // unfindable path; the job silently fails to exec. See dream not running
  // 2026-04-26 → 2026-04-30.
  test('regression: argv with two elements produces separate ProgramArguments entries', () => {
    const xml = generatePlist({
      name: 'dream',
      argv: ['/Users/x/.nvm/versions/node/v24.14.1/bin/node', '/Users/x/ws/bin/robin.js'],
      workspaceDir: '/Users/x/ws',
      schedule: '0 4 * * *',
    });
    assert.match(
      xml,
      /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/Users\/x\/\.nvm\/versions\/node\/v24\.14\.1\/bin\/node<\/string>\s*<string>\/Users\/x\/ws\/bin\/robin\.js<\/string>\s*<string>run<\/string>\s*<string>dream<\/string>\s*<\/array>/
    );
    // No <string> element should contain a literal space (each token must be its own element).
    const programArgsBlock = xml.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)[1];
    const stringTokens = [...programArgsBlock.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
    assert.equal(stringTokens.length, 4);
    for (const t of stringTokens) assert.equal(t.includes(' '), false, `argv element "${t}" must not contain a space`);
  });

  test('rejects missing or empty argv', () => {
    assert.throws(() => generatePlist({ name: 'x', workspaceDir: '/ws', schedule: '0 4 * * *' }), /argv/);
    assert.throws(() => generatePlist({ name: 'x', argv: [], workspaceDir: '/ws', schedule: '0 4 * * *' }), /argv/);
    assert.throws(
      () => generatePlist({ name: 'x', argv: [''], workspaceDir: '/ws', schedule: '0 4 * * *' }),
      /argv/
    );
  });

  test('runAtLoad: false (default) omits RunAtLoad key', () => {
    const xml = generatePlist({
      name: 'x',
      argv: ['/r'],
      workspaceDir: '/ws',
      schedule: '0 4 * * *',
    });
    assert.equal(xml.includes('<key>RunAtLoad</key>'), false);
  });

  test('runAtLoad: true emits RunAtLoad <true/>', () => {
    const xml = generatePlist({
      name: '_robin-sync',
      argv: ['/r'],
      workspaceDir: '/ws',
      schedule: '*/15 * * * *',
      runAtLoad: true,
    });
    assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  });
});

describe('cron-linux: managed block', () => {
  test('builds a complete block', () => {
    const jobs = new Map([
      ['dream', { frontmatter: { name: 'dream', schedule: '0 4 * * *', enabled: true } }],
      ['hidden', { frontmatter: { name: 'hidden', schedule: '0 4 * * *', enabled: false } }],
    ]);
    const block = buildManagedBlock({
      jobs,
      argv: ['/usr/local/bin/robin'],
      workspaceDir: '/home/x',
      generatedAt: new Date('2026-04-29T00:00:00Z'),
    });
    assert.match(block, new RegExp(BEGIN_MARKER));
    assert.match(block, new RegExp(END_MARKER));
    assert.match(block, /ROBIN_WORKSPACE=\/home\/x/);
    assert.match(block, /0 4 \* \* \* \/usr\/local\/bin\/robin run dream/);
    // disabled job not present
    assert.equal(block.includes('hidden'), false);
  });

  test('replaceManagedBlock preserves user lines outside markers', () => {
    const existing = `# my own
0 0 * * * /home/x/scripts/myjob.sh
${BEGIN_MARKER}
old content
${END_MARKER}
# tail line
`;
    const newBlock = `${BEGIN_MARKER}\nNEW\n${END_MARKER}\n`;
    const updated = replaceManagedBlock(existing, newBlock);
    assert.match(updated, /myjob.sh/);
    assert.match(updated, /tail line/);
    assert.match(updated, /NEW/);
    assert.equal(updated.includes('old content'), false);
  });

  test('replaceManagedBlock appends when absent', () => {
    const existing = `# foo\n0 0 * * * existing\n`;
    const newBlock = `${BEGIN_MARKER}\nXX\n${END_MARKER}\n`;
    const updated = replaceManagedBlock(existing, newBlock);
    assert.match(updated, /existing/);
    assert.match(updated, /XX/);
  });

  test('removeManagedBlock keeps user content', () => {
    const existing = `# foo
0 0 * * * preserved
${BEGIN_MARKER}
remove me
${END_MARKER}
# tail
`;
    const updated = removeManagedBlock(existing);
    assert.match(updated, /preserved/);
    assert.match(updated, /# tail/);
    assert.equal(updated.includes('remove me'), false);
  });
});

describe('taskscheduler: cronToTaskTrigger', () => {
  test('daily', () => {
    const t = cronToTaskTrigger('0 4 * * *');
    assert.ok(t && !Array.isArray(t));
    assert.match(t.expr, /-Daily/);
    assert.match(t.expr, /AddHours\(4\)/);
  });

  test('weekly Sunday', () => {
    const t = cronToTaskTrigger('0 10 * * 0');
    assert.match(t.expr, /-Weekly -DaysOfWeek Sunday/);
  });

  test('monthly day=1 → null (not natively expressible without /D flag)', () => {
    const t = cronToTaskTrigger('0 9 1 * *');
    // Our impl considers this not representable in the basic trigger primitives.
    assert.equal(t, null);
  });

  test('every 6h returns array of 4 daily triggers', () => {
    const t = cronToTaskTrigger('15 */6 * * *');
    assert.ok(Array.isArray(t));
    assert.equal(t.length, 4);
  });
});

describe('taskscheduler: buildRegisterCommand', () => {
  test('produces expected PowerShell shape with single-binary argv', () => {
    const cmd = buildRegisterCommand({
      name: 'dream',
      argv: ['C:\\Program Files\\nodejs\\node.exe'],
      workspaceDir: 'C:\\workspace',
      schedule: '0 4 * * *',
    });
    assert.ok(cmd);
    assert.match(cmd, /Register-ScheduledTask/);
    assert.match(cmd, new RegExp(`-TaskPath '${TASK_FOLDER.replace(/\\/g, '\\\\')}'`));
    assert.match(cmd, /-Argument 'run dream'/);
  });

  test('two-element argv: script path goes into -Argument as a quoted token, not into -Execute', () => {
    const cmd = buildRegisterCommand({
      name: 'dream',
      argv: ['C:\\Program Files\\nodejs\\node.exe', 'C:\\workspace\\bin\\robin.js'],
      workspaceDir: 'C:\\workspace',
      schedule: '0 4 * * *',
    });
    assert.ok(cmd);
    assert.match(cmd, /-Execute 'C:\\Program Files\\nodejs\\node\.exe'/);
    assert.match(cmd, /-Argument '"C:\\workspace\\bin\\robin\.js" run dream'/);
  });

  test('returns null for unrepresentable cron', () => {
    const cmd = buildRegisterCommand({
      name: 'x',
      argv: ['r'],
      workspaceDir: 'w',
      schedule: '0 9 1 * *',
    });
    assert.equal(cmd, null);
  });

  test('returns null for missing argv', () => {
    const cmd = buildRegisterCommand({
      name: 'x',
      workspaceDir: 'w',
      schedule: '0 4 * * *',
    });
    assert.equal(cmd, null);
  });
});
