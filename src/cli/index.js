import { version } from './commands/version.js';
import { help } from './commands/help.js';

export async function main(argv) {
  const [cmd] = argv;
  if (cmd === '--version' || cmd === '-v') return version();
  if (cmd === '--help' || cmd === '-h' || cmd === undefined) return help();
  if (cmd === 'migrate') {
    const { migrate } = await import('./commands/migrate.js');
    return migrate();
  }
  console.error(`unknown command: ${cmd}`);
  console.error('run `robin --help` for usage');
  process.exit(1);
}
