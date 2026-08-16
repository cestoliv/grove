import type { Scope } from '../config/index.js';

export interface CreateRunnerAction {
  kind: 'create-runner';
  host: string;
  forge: string;
  group: string;
  index: number;
  name: string;
  // Set when a record already exists and only the container is missing.
  recordId?: number;
  destructive: false;
}

export interface StartContainerAction {
  kind: 'start-container';
  host: string;
  name: string;
  recordId?: number;
  destructive: false;
}

export interface StopContainerAction {
  kind: 'stop-container';
  host: string;
  name: string;
  recordId?: number;
  drainTimeoutMs: number;
  destructive: true;
}

export interface RemoveContainerAction {
  kind: 'remove-container';
  host: string;
  name: string;
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

export function describeAction(action: Action): string {
  switch (action.kind) {
    case 'create-runner':
      return line(
        action.kind,
        action.name,
        `on ${action.host}, registering at ${action.forge}`,
      );
    case 'start-container':
      return line(action.kind, action.name, `on ${action.host}`);
    case 'stop-container':
      return line(
        action.kind,
        action.name,
        `on ${action.host}, up to ${Math.round(action.drainTimeoutMs / 1000)}s`,
      );
    case 'remove-container':
      return line(action.kind, action.name, `on ${action.host}`);
    case 'deregister-runner':
      return line(
        action.kind,
        action.name,
        `at ${action.forge}, runner id ${action.forgeRunnerId}`,
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
