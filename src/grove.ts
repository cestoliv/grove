import { installWarningFilter } from './lib/node-warnings.js';
import { buildProgram } from './program.js';

installWarningFilter();

try {
  await buildProgram().parseAsync(process.argv);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
