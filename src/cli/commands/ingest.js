import { daemonRequest as defaultRequest } from '../daemon-request.js';

export async function ingestCmd(argv = [], deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));
  const request = deps.daemonRequest ?? defaultRequest;

  const body = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') {
      body.url = argv[++i];
    } else if (a === '--file') {
      body.file_path = argv[++i];
    } else if (!body.content) {
      body.content = a;
    }
  }
  if (!body.content && !body.url && !body.file_path) {
    err('usage: robin ingest <content> | --url <URL> | --file <PATH>');
    process.exitCode = 1;
    return;
  }

  const result = await request('/internal/knowledge/ingest', body);
  if (result?.ok) {
    if (result.deduped) {
      out(`ok — deduped (event ${result.event_id})`);
    } else {
      out(
        `ok — event=${result.event_id} entities=${result.entities_created} edges=${result.edges_created} knowledge=${result.knowledge_created}`,
      );
    }
  } else {
    err(
      `ingest failed: ${result?.reason ?? 'unknown'}${result?.detail ? ` (${result.detail})` : ''}`,
    );
    process.exitCode = 1;
  }
}
