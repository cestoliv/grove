import {
  ConfigError,
  type LoadedConfig,
  loadConfig,
} from '../lib/config/index.js';
import { renderPlanReport } from '../lib/plan/render.js';
import { buildPlanReport } from '../lib/plan/report.js';
import type { ConnectFn } from '../lib/transport/index.js';

export const EXIT_OK = 0;
export const EXIT_UNREACHABLE = 1;
export const EXIT_INVALID_CONFIG = 2;

export interface PlanCommandOptions {
  config?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  connect?: ConnectFn;
  probeTimeoutMs?: number;
  color?: boolean;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export async function runPlan(
  options: PlanCommandOptions = {},
): Promise<number> {
  const write = options.stdout ?? ((text: string) => console.log(text));
  const writeError = options.stderr ?? ((text: string) => console.error(text));

  let loaded: LoadedConfig;
  try {
    loaded = await loadConfig({
      path: options.config,
      env: options.env,
      cwd: options.cwd,
    });
  } catch (error) {
    if (error instanceof ConfigError) {
      writeError(error.message);
      return EXIT_INVALID_CONFIG;
    }
    throw error;
  }

  const report = await buildPlanReport(loaded, {
    connect: options.connect,
    probeTimeoutMs: options.probeTimeoutMs,
  });
  write(renderPlanReport(report, { color: options.color }));
  return report.ok ? EXIT_OK : EXIT_UNREACHABLE;
}
