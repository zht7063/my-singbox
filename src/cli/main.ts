import { run } from './commands.js';
import { realSystem } from '../doctor/system.js';

process.exitCode = await run(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  system: realSystem(),
});
