import type { Scope, StackKind } from '../config/index.js';

export interface CreateRunnerAction {
  kind: 'create-runner';
  host: string;
  forge: string;
  group: string;
  index: number;
  name: string;
  // Absent means docker, the only stack milestone 2 and 3 knew about. Read it
  // through actionStack rather than here, so the default lives in one place.
  stack?: StackKind;
  // Set when a record already exists and only the container is missing.
  recordId?: number;
  // The forge runner id the planner judged gone. Set when the group holds a
  // stored registration whose entity the forge no longer lists, so grove
  // mints a new one instead of registering against an id that is gone.
  // Carrying the id lets apply retire that row and no other.
  renewRegistration?: string;
  // A renewal discards the only copy of a token GitLab never shows again, so
  // that create is destructive and the rest are not.
  destructive: boolean;
}

export interface StartContainerAction {
  kind: 'start-container';
  host: string;
  name: string;
  stack?: StackKind;
  recordId?: number;
  destructive: false;
}

export interface StopContainerAction {
  kind: 'stop-container';
  host: string;
  name: string;
  stack?: StackKind;
  recordId?: number;
  drainTimeoutMs: number;
  destructive: true;
}

export interface RemoveContainerAction {
  kind: 'remove-container';
  host: string;
  name: string;
  stack?: StackKind;
  recordId?: number;
  destructive: true;
}

export interface DeregisterRunnerAction {
  kind: 'deregister-runner';
  // The host the runner lives on, so every action for one runner runs in
  // order inside the same host queue.
  host?: string;
  forge: string;
  scope: Scope;
  name: string;
  forgeRunnerId: string;
  recordId?: number;
  destructive: true;
}

// GitLab gives a whole group one runner entity, so deleting it takes every
// manager with it. It goes only when the last container has gone, which is
// why this is a separate action and not a deregister with a flag.
export interface DeleteSharedRunnerAction {
  kind: 'delete-shared-runner';
  host?: string;
  forge: string;
  scope: Scope;
  group: string;
  // The entity description, which is the name grove gave it.
  name: string;
  forgeRunnerId: string;
  // The grove.db row that holds the shared token, retired with the entity.
  registrationId?: number;
  destructive: true;
}

export interface RetireRecordAction {
  kind: 'retire-record';
  host?: string;
  name: string;
  recordId: number;
  destructive: true;
}

export interface ReportUnmanagedAction {
  kind: 'report-unmanaged';
  name: string;
  where: string;
  host?: string;
  destructive: false;
}

export interface ReportOrphanRecordAction {
  kind: 'report-orphan-record';
  name: string;
  recordId: number;
  reason: string;
  host?: string;
  destructive: false;
}

export interface ReportDegradedAction {
  kind: 'report-degraded';
  target: string;
  reason: string;
  host?: string;
  destructive: false;
}

export interface ReportUnsupportedAction {
  kind: 'report-unsupported';
  group: string;
  reason: string;
  destructive: false;
}

export type Action =
  | CreateRunnerAction
  | StartContainerAction
  | StopContainerAction
  | RemoveContainerAction
  | DeregisterRunnerAction
  | DeleteSharedRunnerAction
  | RetireRecordAction
  | ReportUnmanagedAction
  | ReportOrphanRecordAction
  | ReportDegradedAction
  | ReportUnsupportedAction;

export const ACTION_VERBS: Record<Action['kind'], string> = {
  'create-runner': 'create',
  'start-container': 'start',
  'stop-container': 'drain',
  'remove-container': 'remove',
  'deregister-runner': 'deregister',
  'delete-shared-runner': 'delete',
  'retire-record': 'retire',
  'report-unmanaged': 'unmanaged',
  'report-orphan-record': 'orphan',
  'report-degraded': 'degraded',
  'report-unsupported': 'skipped',
};

const VERB_WIDTH = 10;

function line(kind: Action['kind'], subject: string, detail: string): string {
  return `${ACTION_VERBS[kind].padEnd(VERB_WIDTH)}  ${subject}  ${detail}`;
}

// Nothing is appended for Docker, so every line milestone 2 and 3 printed is
// the line grove still prints.
function stackSuffix(action: Action): string {
  return actionStack(action) === 'docker' ? '' : `, ${actionStack(action)}`;
}

export function describeAction(action: Action): string {
  switch (action.kind) {
    case 'create-runner':
      return line(
        action.kind,
        action.name,
        `on ${action.host}, registering at ${action.forge}` +
          (action.renewRegistration === undefined
            ? ''
            : ', renewing the group registration') +
          stackSuffix(action),
      );
    case 'start-container':
      return line(
        action.kind,
        action.name,
        `on ${action.host}${stackSuffix(action)}`,
      );
    case 'stop-container':
      return line(
        action.kind,
        action.name,
        `on ${action.host}, up to ${Math.round(action.drainTimeoutMs / 1000)}s${stackSuffix(action)}`,
      );
    case 'remove-container':
      return line(
        action.kind,
        action.name,
        `on ${action.host}${stackSuffix(action)}`,
      );
    case 'deregister-runner':
      return line(
        action.kind,
        action.name,
        `at ${action.forge}, runner id ${action.forgeRunnerId}`,
      );
    case 'delete-shared-runner':
      return line(
        action.kind,
        action.name,
        `runner entity ${action.forgeRunnerId} at ${action.forge}, its last manager is gone`,
      );
    case 'retire-record':
      return line(action.kind, action.name, 'in the grove database');
    case 'report-unmanaged':
      return line(action.kind, action.name, action.where);
    case 'report-orphan-record':
      return line(action.kind, action.name, action.reason);
    case 'report-degraded':
      return line(action.kind, action.target, action.reason);
    case 'report-unsupported':
      return line(action.kind, action.group, action.reason);
  }
}

export function hasDestructive(actions: Action[]): boolean {
  return actions.some((action) => action.destructive);
}

export function isReport(action: Action): boolean {
  return action.kind.startsWith('report-');
}

/**
 * Which stack does the work an action describes. An action that names none is
 * a Docker action, because that is the only stack that existed when the kinds
 * were named, and renaming them would buy nothing.
 */
export function actionStack(action: Action): StackKind {
  return 'stack' in action && action.stack !== undefined
    ? action.stack
    : 'docker';
}
