import type { ConfigIssue } from './errors.js';
import {
  type ForgeKind,
  GITHUB_LEVELS,
  GITLAB_LEVELS,
  type GroveConfig,
} from './schema.js';

function levelsFor(kind: ForgeKind): readonly string[] {
  return kind === 'github' ? GITHUB_LEVELS : GITLAB_LEVELS;
}

function listOrNone(names: string[]): string {
  return names.length > 0 ? names.join(', ') : '(none)';
}

export function validateReferences(config: GroveConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const hostNames = Object.keys(config.hosts);
  const knownHosts = new Set(hostNames);
  const forgeNames = Object.keys(config.forges);
  const seenGroupNames = new Set<string>();

  for (const [index, group] of config.groups.entries()) {
    const base = `groups[${index}]`;

    if (seenGroupNames.has(group.name)) {
      issues.push({
        path: `${base}.name`,
        message: `duplicate group name "${group.name}"`,
      });
    }
    seenGroupNames.add(group.name);

    const forge = config.forges[group.forge];
    if (forge === undefined) {
      issues.push({
        path: `${base}.forge`,
        message: `unknown forge "${group.forge}". Declared forges: ${listOrNone(forgeNames)}`,
      });
    } else {
      const levels = levelsFor(forge.kind);
      if (!levels.includes(group.scope.level)) {
        issues.push({
          path: `${base}.scope.level`,
          message: `"${group.scope.level}" is not valid for forge "${group.forge}" of kind ${forge.kind}. Valid values: ${levels.join(', ')}`,
        });
      }
      if (forge.kind === 'github' && group.tags !== undefined) {
        issues.push({
          path: `${base}.tags`,
          message: `tags belong to GitLab. Forge "${group.forge}" is a GitHub forge, so use labels.`,
        });
      }
      if (forge.kind === 'gitlab' && group.labels !== undefined) {
        issues.push({
          path: `${base}.labels`,
          message: `labels belong to GitHub. Forge "${group.forge}" is a GitLab forge, so use tags.`,
        });
      }
    }

    if (group.image !== undefined && group.build !== undefined) {
      issues.push({
        path: base,
        message:
          'set image or build, not both. image names a reference to pull, build names a Dockerfile on the host.',
      });
    }

    for (const host of Object.keys(group.placement)) {
      if (!knownHosts.has(host)) {
        issues.push({
          path: `${base}.placement.${host}`,
          message: `unknown host "${host}". Declared hosts: ${listOrNone(hostNames)}`,
        });
      }
    }
  }

  return issues;
}
