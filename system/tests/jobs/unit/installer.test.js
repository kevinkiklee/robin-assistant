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
      robinPath: '/usr/local/bin/robin',
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
      robinPath: '/r',
      workspaceDir: '/ws',
      schedule: '0 4 * * *',
    });
    assert.match(xml, /<key>ROBIN_WORKSPACE<\/key>\s*<string>\/ws<\/string>/);
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
      robinPath: '/usr/local/bin/robin',
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
  test('produces expected PowerShell shape', () => {
    const cmd = buildRegisterCommand({
      name: 'dream',
      robinPath: 'C:\\Program Files\\nodejs\\node.exe',
      workspaceDir: 'C:\\workspace',
      schedule: '0 4 * * *',
    });
    assert.ok(cmd);
    assert.match(cmd, /Register-ScheduledTask/);
    assert.match(cmd, new RegExp(`-TaskPath '${TASK_FOLDER.replace(/\\/g, '\\\\')}'`));
    assert.match(cmd, /-Argument 'run dream'/);
  });

  test('returns null for unrepresentable cron', () => {
    const cmd = buildRegisterCommand({
      name: 'x',
      robinPath: 'r',
      workspaceDir: 'w',
      schedule: '0 9 1 * *',
    });
    assert.equal(cmd, null);
  });
});
