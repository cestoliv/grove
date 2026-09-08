# Queue

Findings from probing a real fleet on 2026-09-08, not obvious from either forge's API docs.

## No forge exposes a fleet-wide queue

Neither GitHub nor GitLab reports queued jobs across an org, a group or an instance in one call. A sweep costs one call per repository or project.

GitHub has no org-wide queued-jobs endpoint. `listQueuedJobs` enumerates repositories with `GET /orgs/:org/repos`, then reads `GET /repos/:full_name/actions/runs?status=queued` per repository.

## GitLab's per-runner jobs endpoint refuses `pending`

`GET /runners/:id/jobs` takes a `status` filter, but rejects `pending`. A pending job has no runner assigned yet, so the runner-scoped endpoint cannot see it. Pending jobs come only from the per-project endpoint, `GET /projects/:id/jobs?scope[]=pending`.

## Label matching must fold case

A probe found a job asking for `macos` against a runner that reports `macOS`. Case-sensitive matching would make the feature report zero waiting jobs for that runner. `groupForJob` lowercases both sides before it compares them.

## An instance-wide GitLab sweep needs an admin token

`scope: { level: instance }` lists every project on the instance through `GET /projects`. A non-admin token sees only its own projects, not the fleet's. grove cannot tell a short list from a complete one, so an instance sweep on a non-admin token undercounts silently.

## Measured cost

A sweep against 3 active GitHub repositories and 2 GitLab projects took about 5 seconds and 10 API calls. `active_within` bounds the cost further by skipping a repository or project idle past the window.
