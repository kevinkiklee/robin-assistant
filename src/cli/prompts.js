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
