import {
  doctorExitCode,
  renderDoctorReport,
  runChecks,
} from '../lib/doctor/index.js';
import type { FetchFn } from '../lib/forge/index.js';
import type { FleetContext } from './context.js';
import { openFleetOrExit, type PipelineOptions } from './pipeline.js';

export interface DoctorCommandOptions extends PipelineOptions {
  json?: boolean;
  strict?: boolean;
  color?: boolean;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  fetchFn?: FetchFn;
  now?: () => number;
  platform?: string;
  home?: string;
  nodeVersion?: string;
  isPidAlive?: (pid: number) => boolean;
}

export async function runDoctor(
  options: DoctorCommandOptions = {},
): Promise<number> {
  const write = options.stdout ?? ((text: string) => console.log(text));
  const writeError = options.stderr ?? ((text: string) => console.error(text));

  // No forge client, because doctor resolves each token itself and reports
  // the failure rather than being stopped by it. And no state lock, because
  // doctor changes nothing and is exactly what you run during an apply that
  // is going wrong.
  const opened = await openFleetOrExit(
    { ...options, forges: false },
    writeError,
  );
  if (typeof opened === 'number') {
    return opened;
  }
  const fleet: FleetContext = opened;

  try {
    const report = await runChecks({
      fleet,
      ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.probeTimeoutMs === undefined
        ? {}
        : { probeTimeoutMs: options.probeTimeoutMs }),
      ...(options.resolveToken === undefined
        ? {}
        : { resolveToken: options.resolveToken }),
      ...(options.platform === undefined ? {} : { platform: options.platform }),
      ...(options.home === undefined ? {} : { home: options.home }),
      ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
      ...(options.nodeVersion === undefined
        ? {}
        : { nodeVersion: options.nodeVersion }),
      ...(options.isPidAlive === undefined
        ? {}
        : { isPidAlive: options.isPidAlive }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });

    write(
      options.json === true
        ? JSON.stringify(report, null, 2)
        : renderDoctorReport(report, {
            ...(options.color === undefined ? {} : { color: options.color }),
            ...(options.strict === undefined ? {} : { strict: options.strict }),
          }),
    );
    return doctorExitCode(report, options.strict === true);
  } finally {
    await fleet.close();
  }
}
