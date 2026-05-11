import readline from 'node:readline/promises';

export async function input(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

export async function confirm(prompt) {
  const a = await input(`${prompt} [y/N] `);
  return /^y(es)?$/i.test(a.trim());
}

export async function radio({ question, options, defaultIndex = 0, inputFn = input }) {
  if (!Array.isArray(options) || options.length === 0) {
    throw new TypeError('radio: options must be a non-empty array');
  }
  for (;;) {
    const lines = [question, ''];
    options.forEach((opt, i) => {
      const tag = i === defaultIndex ? ' [default]' : '';
      lines.push(`  (${i + 1}) ${opt.label}${tag}`);
      if (opt.description) lines.push(`      ${opt.description}`);
    });
    lines.push('');
    console.log(lines.join('\n'));
    const raw = (
      await inputFn(`Choose [1-${options.length}, default ${defaultIndex + 1}]: `)
    ).trim();
    let idx;
    if (raw === '') idx = defaultIndex;
    else {
      const n = Number.parseInt(raw, 10);
      if (Number.isNaN(n) || n < 1 || n > options.length) {
        console.error(`Invalid choice: ${raw}. Enter a number between 1 and ${options.length}.`);
        continue;
      }
      idx = n - 1;
    }
    const picked = options[idx];
    if (typeof picked.customFn === 'function') {
      return await picked.customFn();
    }
    return picked.value;
  }
}
