import type { ContainerState, DockerContainer } from './types.js';

// `--format json` differs between Docker releases. `{{json .}}` does not.
export const PS_ARGS = [
  'ps',
  '-a',
  '--no-trunc',
  '--filter',
  'name=^grove-',
  '--format',
  '{{json .}}',
];

const STATES: ContainerState[] = [
  'created',
  'running',
  'restarting',
  'exited',
  'paused',
  'dead',
  'removing',
];

function toState(value: string): ContainerState {
  const found = STATES.find((state) => state === value.toLowerCase());
  return found ?? 'unknown';
}

export function parsePsOutput(text: string): DockerContainer[] {
  const containers: DockerContainer[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const name = String(row.Names ?? '').split(',')[0];
    if (name === '') {
      continue;
    }
    containers.push({
      name,
      containerId: String(row.ID ?? ''),
      state: toState(String(row.State ?? '')),
      image: String(row.Image ?? ''),
      status: String(row.Status ?? ''),
      createdAt: String(row.CreatedAt ?? ''),
    });
  }
  return containers;
}
