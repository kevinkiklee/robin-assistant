import { assertValidKey, saveSecret } from '../../../config/secrets.js';

function usage() {
  console.error('usage: robin secrets set <KEY>               # interactive (no echo)');
  console.error('       robin secrets set <KEY>=<value>       # warns about shell history');
  console.error('       robin secrets set <KEY> <value>       # warns about shell history');
  process.exit(1);
}

function warnHistory() {
  console.warn(
    'warning: value passed via CLI arg lands in shell history; prefer interactive `robin secrets set <KEY>`',
  );
}

export async function secretsSet(argv) {
  if (!argv[0] || argv.length > 2) return usage();

  let key;
  let value;

  if (argv.length === 2) {
    // robin secrets set <KEY> <value>
    key = argv[0];
    value = argv[1];
    warnHistory();
  } else {
    const arg = argv[0];
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      // robin secrets set <KEY>=<value>
      key = arg.slice(0, eq);
      value = arg.slice(eq + 1);
      warnHistory();
    } else {
      // robin secrets set <KEY>  (interactive)
      key = arg;
      // Validate the key shape *before* prompting so a misuse like
      // `robin secrets set AIzaSy...` fails fast instead of letting the user
      // type a hidden value that will be rejected anyway.
      assertValidKey(key);
      if (!process.stdin.isTTY) {
        console.error('interactive prompt requires a TTY');
        process.exit(1);
      }
      value = await readHidden(`Value for ${key} (input hidden): `);
    }
  }

  saveSecret(key, value);
  console.log(`saved ${key}`);
}

function readHidden(prompt) {
  process.stdin.setRawMode?.(true);
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    let buf = '';
    const onData = (data) => {
      for (const ch of data.toString()) {
        if (ch === '\r' || ch === '\n') {
          process.stdin.setRawMode?.(false);
          process.stdin.removeListener('data', onData);
          process.stdout.write('\n');
          return resolve(buf);
        }
        if (ch === '\x03') process.exit(1);
        if (ch === '\x7f' || ch === '\b') buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    process.stdin.on('data', onData);
  });
}
