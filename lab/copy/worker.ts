// lab/copy/worker.ts — `node --import tsx lab/copy/worker.ts <job.json> <result.json>`
// One fresh process per copy-day (spec §6.2).
import { readFileSync, writeFileSync } from 'node:fs';
import { type CopyJob, runJob } from './job.ts';

const [jobPath, resultPath] = process.argv.slice(2);
if (!jobPath || !resultPath) {
  process.stderr.write('usage: worker.ts <job.json> <result.json>\n');
  process.exit(2);
}
const job = JSON.parse(readFileSync(jobPath, 'utf8')) as CopyJob;
try {
  const res = await runJob(job);
  writeFileSync(resultPath, JSON.stringify(res));
  process.exit(0);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  writeFileSync(resultPath, JSON.stringify({ error: message, day: job.day }));
  process.exit(1);
}
