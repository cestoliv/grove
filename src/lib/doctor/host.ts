import { errorMessage } from '../errors.js';
import { BASIC_HOST_CHECKS, reachableCheck } from './host-basic.js';
import type { HostCheckContext } from './host-context.js';
import { DOCKER_HOST_CHECKS } from './host-docker.js';
import { SUPERVISOR_HOST_CHECKS } from './host-supervisor.js';
import { WORK_ROOT_HOST_CHECKS } from './host-workroot.js';
import { type Check, type CheckReport, fail, skip } from './types.js';

// Printing order, which is also the order an operator reads them in: can grove
// reach the host at all, does it have Docker, does it have somewhere to work,
// and does its supervisor answer.
export const HOST_CHECKS: Check<HostCheckContext>[] = [
  ...BASIC_HOST_CHECKS,
  ...DOCKER_HOST_CHECKS,
  ...WORK_ROOT_HOST_CHECKS,
  ...SUPERVISOR_HOST_CHECKS,
];

/**
 * Serial within one host, because the transport is one SSH connection and two
 * `docker` calls racing on one daemon is exactly what the spec's "parallel
 * across hosts, serial within one" rule exists to prevent.
 *
 * A host that did not answer skips everything after the probe rather than
 * spending nineteen timeouts proving the same thing.
 */
export async function runHostChecks(
  context: HostCheckContext,
): Promise<CheckReport[]> {
  const target = { kind: 'host' as const, name: context.host };
  const reports: CheckReport[] = [];

  const probe = await context.probe();
  if (!probe.reachable) {
    for (const check of HOST_CHECKS) {
      const results =
        check.id === reachableCheck.id
          ? await reachableCheck.run(context)
          : [skip('the host did not answer, so grove asked nothing else')];
      for (const result of results) {
        reports.push({ ...result, id: check.id, target });
      }
    }
    return reports;
  }

  for (const check of HOST_CHECKS) {
    try {
      for (const result of await check.run(context)) {
        reports.push({ ...result, id: check.id, target });
      }
    } catch (error) {
      // One check that throws must not take the other nineteen with it, and
      // it must not read as a pass either.
      reports.push({
        ...fail(
          errorMessage(error),
          'This is a grove bug or a host that answered something grove cannot parse. Run the command by hand on the host and open an issue with what it printed.',
        ),
        id: check.id,
        target,
      });
    }
  }
  return reports;
}
