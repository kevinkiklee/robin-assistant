import { saveSecret } from '../../secrets/dotenv-io.js';

export async function secretsSet(argv) {
  if (!argv[0]) {
    console.error('usage: robin secrets set <KEY>           # interactive (no echo)');
    console.error(
      '       robin secrets set <KEY>=<value>   # accepted but warns about shell history',
    );
    process.exit(1);
  }
  const arg = argv[0];
  const eq = arg.indexOf('=');
  let key;
  let value;
  if (eq !== -1) {
    key = arg.slice(0, eq);
    value = arg.slice(eq + 1);
    console.warn(
      'warning: value passed via CLI arg lands in shell history; prefer interactive `robin secrets set <KEY>`',
    );
  } else {
    key = arg;
    if (!process.stdin.isTTY) {
      console.error('interactive prompt requires a TTY');
      process.exit(1);
    }
    process.stdin.setRawMode?.(true);
    process.stdout.write(`Value for ${key} (input hidden): `);
    value = await new Promise((resolve) => {
      let buf = '';
      const onData = (data) => {
        const chunk = data.toString();
        for (const ch of chunk) {
          if (ch === '\r' || ch === '\n') {
            process.stdin.setRawMode?.(false);
            process.stdin.removeListener('data', onData);
            process.stdout.write('\n');
            return resolve(buf);
          }
          if (ch === '\x03') {
            process.exit(1);
          }
          if (ch === '\x7f' || ch === '\b') {
            buf = buf.slice(0, -1);
          } else {
            buf += ch;
          }
        }
      };
      process.stdin.on('data', onData);
    });
  }
  if (!key) {
    console.error('key required');
    process.exit(1);
  }
  saveSecret(key, value);
  console.log(`saved ${key}`);
}
