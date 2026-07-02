import { createDefaultAppSmokeDeps, runAppSmokeCommand } from '../src/cli/app-smoke.js';

process.exitCode = await runAppSmokeCommand(process.argv.slice(2), createDefaultAppSmokeDeps());
