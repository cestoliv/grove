export {
  type ActivityState,
  type ActivityTarget,
  buildActivityScript,
  parseActivityOutput,
  readActivity,
} from './activity.js';
export {
  type DaemonInstallOptions,
  type DaemonInstallResult,
  daemonUnitPathFor,
  installDaemon,
  readDaemonInstalled,
  uninstallDaemon,
} from './install.js';
export {
  isPidAlive,
  LockHeldError,
  type LockHolder,
  readLockHolder,
  StateLock,
  type StateLockOptions,
} from './lock.js';
export {
  DaemonLog,
  type DaemonLogOptions,
  formatLogLine,
  LOG_MAX_BYTES,
  type LogLevel,
} from './log.js';
export {
  controlPersistFor,
  type DaemonLoopOptions,
  runDaemonLoop,
  type TickIntervals,
  waitFor,
} from './loop.js';
export {
  DAEMON_LOCK_FILE,
  DAEMON_LOG_FILE,
  DAEMON_STDERR_FILE,
  DAEMON_STDOUT_FILE,
  daemonLockPath,
  daemonLogPath,
  daemonStderrPath,
  daemonStdoutPath,
} from './paths.js';
export {
  buildEntriesScript,
  buildRemoveArgs,
  buildUsageScript,
  type PruneResult,
  type PruneTarget,
  parseEntries,
  parseUsage,
  pruneWorkDirs,
  selectForRemoval,
  type WorkEntry,
} from './prune.js';
export {
  MAX_RESTARTS_PER_HOUR,
  RESTART_COOLDOWN_MS,
  RESTART_WINDOW_MS,
  type SuperviseOptions,
  type SuperviseResult,
  type SuspectFinding,
  superviseFleet,
} from './supervise.js';
export {
  lastLines,
  TAIL_POLL_INTERVAL_MS,
  TAIL_WINDOW_BYTES,
  type TailOptions,
  tailFile,
} from './tail.js';
export {
  fleetSignature,
  type RefreshOptions,
  type RefreshResult,
  refreshFleet,
  runTick,
  type TickKind,
  type TickOptions,
  type TickSummary,
} from './tick.js';
export {
  buildDaemonPlist,
  buildDaemonSpec,
  buildDaemonUnit,
  DAEMON_PATH,
  DAEMON_RESTART_SECONDS,
  type DaemonCommand,
  type DaemonSpecInput,
  type DaemonUnitSpec,
  resolveDaemonCommand,
} from './units.js';
