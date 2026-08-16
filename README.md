# grove

One YAML file describes a fleet of self-hosted GitHub and GitLab runners. grove makes the hosts match it, watches what happens, and restarts what wedges.

grove is agentless. One control node holds the config and reaches every host over SSH, or over a local transport when the host is the control node itself. Nothing is installed on the hosts except the runners.

## Status

Milestone 2 of six. grove manages GitHub runners in Docker containers. `config`, `plan`, `apply`, `status`, `logs` and `teardown` work. GitLab arrives in milestone 3, native launchd and systemd runners in milestone 4, the daemon and stuck detection in milestone 5, and `doctor` and Prometheus metrics in milestone 6.

A group with `stack: native`, or a group on a GitLab forge, is reported as skipped and left alone rather than failing the run.

Switching a group that already runs to `native` or to a GitLab forge is a different thing. grove skips the group, so it plans no new runner for it, and the Docker runners the group left behind are no longer wanted by any group. `plan` reports the group as skipped and reaps those runners in the same pass. That is the intent, but the two lines read as a contradiction, so expect it.

## Install

```bash
npm install -g @cestoliv/grove
```

grove needs Node 22.13 or newer on the control node, because it stores its history with `node:sqlite`. It also needs the `ssh` binary for any host that is not the control node, and a Docker daemon on every host that runs a group.

## Configure

grove reads `./grove.yaml`. Override the location with `--config <path>` or the `GROVE_CONFIG` environment variable.

```bash
grove config --path      # print the path grove would read
grove config             # open that file in an editor
```

`grove config` opens `$VISUAL` if it is set, otherwise `$EDITOR`, otherwise `nano`.

See [`grove.example.yaml`](https://github.com/cestoliv/grove/blob/main/grove.example.yaml) on GitHub for a full example. The short version:

```yaml
hosts:
  mac:
    type: local
    work_root: /Volumes/ci/grove
  atlas:
    type: ssh
    host: atlas                            # a ~/.ssh/config alias

forges:
  gh-overload:
    kind: github
    auth: { token: "${GH_TOKEN}" }
  gl-chevro:
    kind: gitlab
    url: https://git.chevro.fr
    auth: { command: "op read op://infra/gitlab/pat" }

groups:
  - name: overload-arm
    forge: gh-overload
    scope: { level: organization, target: Overload-coach }
    placement: { host: mac, count: 2 }
    stack: docker
    arch: arm64
    labels: [arm64]

  - name: chevro-dind
    forge: gl-chevro
    scope: { level: instance }
    placement: { atlas: 3 }                # map form spans hosts
    stack: docker
    tags: [docker, dind]
    image: gitlab/gitlab-runner:latest
```

### Credentials

grove accepts three sources and no fourth.

| Source | Looks like |
|---|---|
| Environment | `auth: { token: "${GH_TOKEN}" }`, expanded when the config loads |
| Command | `auth: { command: "op read op://infra/gitlab/pat" }`, run only when a forge call needs it |
| CLI delegation | no `auth` block at all, which runs `gh auth token` on the control node |

GitLab delegation through `glab` arrives with the GitLab client in milestone 3. Until then grove skips every GitLab group, so it never asks a GitLab forge for a token.

A literal that matches a token pattern is rejected. Nothing that looks like a credential belongs in the file.

`${VAR}` interpolation applies everywhere in the config except inside a group's `raw` block. grove passes `raw` through to the runner verbatim, so a `${...}` meant for the runner survives untouched.

### Each forge keeps its own vocabulary

`scope.level` takes `enterprise`, `organization` or `repository` on GitHub, and `instance`, `group` or `project` on GitLab. A mismatch is rejected and the three valid values are named. GitHub groups use `labels`, GitLab groups use `tags`, and using the wrong one is an error rather than a silent no-op.

### Placement

`placement` takes two forms. `{ host: mac, count: 2 }` targets one host. `{ mac: 2, atlas: 1 }` spans hosts in one group.

### Architecture is a request

`arch` never blocks anything. Asking for `amd64` on an `arm64` host warns and proceeds, because the person asking usually knows why.

## Plan and apply

```bash
grove plan
grove apply
grove apply --dry-run
grove apply --yes --clean
```

`grove plan` validates the config, observes every reachable host and every forge, and prints what it would change. It never acts.

```
config  /work/grove.yaml

Hosts
  HOST   TYPE   TARGET        STATE  DETAIL
  mac    local  this machine  ok     arm64
  atlas  ssh    atlas         ok     amd64

Groups grove would manage
  GROUP         FORGE                 SCOPE                        STACK   ARCH   PLACEMENT  RUNNERS
  overload-arm  gh-overload (github)  organization Overload-coach  docker  arm64  mac x2     2
  ios           gh-overload (github)  organization Overload-coach  native  -      mac x1     1

Changes
  skipped     ios  native runners arrive in milestone 4
  create      grove-overload-arm-2  on mac, registering at gh-overload

1 change(s) planned. grove plan changes nothing. Run grove apply to make them.
```

A converged fleet closes with `Every host answered. Nothing to change.` instead.

`grove apply` prints the same report, closes it with `1 change(s) to apply.`, and then converges. It asks before the first destructive change. A pipe with no terminal answers no, and the refusal goes to stderr.

| Flag | What it does |
|---|---|
| `--dry-run` | Print the diff and change nothing |
| `--yes` | Answer yes to the confirmation |
| `--force` | Skip the drain wait and the confirmation |
| `--clean` | Wipe the work directory before starting an existing runner |

`--clean` acts only when grove starts a container that already exists. A runner grove creates always gets a fresh work directory, with or without the flag.

`--force` gives a busy runner no time to finish its job. Use `--yes` when you only want to skip the question.

Exit codes:

| Code | Meaning |
|---|---|
| 0 | Everything converged, every host and forge answered |
| 1 | At least one host or forge did not answer, or a runner is degraded |
| 2 | Config missing or invalid, or a credential could not be resolved |
| 3 | A destructive change was not confirmed |

SSH control sockets that grove opens for reuse live under `~/.ssh/grove/`.

### Silence is not absence

A host that does not answer is read-only for that pass. grove reports it, and leaves its runners and their forge records alone. A forge behaves the same way, and a forge missing from the observation counts as unreachable rather than as an empty forge. grove never deletes what it cannot see.

### Moving a seat takes two applies

Move a runner from one host to another and the first `apply` drains the old container, deregisters it, and retires its record. The second `apply` creates the replacement on the new host. grove refuses to run one name in two places at once, so it waits for the record to go before it makes the new seat.

## Status and logs

```bash
grove status
grove status --json
grove logs overload-arm
grove logs grove-overload-arm-1 --follow --tail 500
```

`grove status` prints one row per runner, joining what Docker reports with what the forge believes, and marks each row managed, unmanaged or record-only. It writes one liveness sample per managed runner into the history database on every run.

```
config  /work/grove.yaml

Runners
  GROUP         HOST  RUNNER                CONTAINER  DETAIL                    FORGE    OWNER
  overload-arm  mac   grove-overload-arm-1  running    Up 3 hours                busy     managed
  overload-arm  mac   grove-overload-arm-2  exited     Exited (0) 4 minutes ago  offline  managed
  legacy        mac   grove-legacy-1        running    Up 2 days                 online   unmanaged

Every host and forge answered.
```

The `FORGE` column carries the forge's opinion of the runner, which is `online`, `offline`, `busy` or `unknown`. There is no column for the job a busy runner is running, because the GitHub API does not expose it. `--json` prints the same report with the forge name the table leaves out.

`grove logs` takes a group name or a runner name. A group with several runners prints each in turn with a header. `--follow` needs exactly one runner. `--tail` defaults to 200 lines.

## Teardown

```bash
grove teardown
grove teardown --include-unmanaged
```

`teardown` drains, deregisters and removes every runner grove owns, then retires its record. It ignores what the config asks for.

| Flag | What it does |
|---|---|
| `--include-unmanaged` | Also reach names that match the convention but have no record |
| `--dry-run` | Print what would go and change nothing |
| `--yes` | Answer yes to the confirmation |
| `--force` | Skip the drain wait and the confirmation |

`--include-unmanaged` extends the run to containers and forge runners whose name matches `grove-<group>-<index>` but that grove has no record of. It is off by default, because a name collision is not consent. It never reaches a foreign name.

An unreachable host or forge stops the teardown of the runners behind it, and grove reports each one instead.

A runner that exists only at the forge is the one case grove cannot read. Its container may be gone, or it may be running on a host that did not answer. Deregistering the second one strands a working runner: it keeps its job and loses its registration. So `--include-unmanaged` deregisters a forge-only runner only when every host in the config answered. If any host is unreachable or was never observed, grove reports the runner and leaves it alone.

A record with no container and no forge runner behind it is an orphan. `teardown` reports it and leaves it alone. `apply` retires it, because nothing is left for the record to protect.

Run `teardown` before you delete a group from the config. grove deregisters a runner only when it can still see it in a scope the config names, so a group deleted while its runners still exist leaves the forge records behind, reported as orphans.

## What grove creates

Every managed artifact derives its name from the group and a one-based index.

| Artifact | Name |
|---|---|
| Docker container | `grove-<group>-<index>` |
| Runner name at the forge | `grove-<group>-<index>` |
| Work dir | `<work_root>/<group>-<index>` |
| Cache dir | `<cache_root>/<group>-<index>` |

Indexes run from 1 to the group's total count across every host in the placement. A group spread over two hosts still numbers its seats once, so no name appears twice.

The work root defaults to `/var/tmp/grove`, and the cache root defaults to a sibling of the work root, so `/Volumes/ci/grove` gives `/Volumes/ci/grove-cache`. Both are mounted into the container at the identical path, because a job that runs `docker` talks to the host daemon and the host daemon resolves every path against the host. grove creates both directories with mode `0777`, because the runner runs as an unprivileged user inside the container and the bind mount carries host ownership.

A group with no `image:` and no `build:` runs `ghcr.io/actions/actions-runner:latest`, configured with `./config.sh --url ... --token ... --name ... --work ... --unattended --replace` and started with `./run.sh`. `--replace` lets a recreated runner take its own name back at the forge. There is no `--ephemeral`, so runners are persistent and their caches stay warm. The work directory is wiped when a runner is created and kept across restarts.

The registration token sits in the container's command line. Anyone who can run `docker inspect` on the host reads it until it expires.

Containers run with `--restart no`. grove owns crash recovery, so nothing resurrects a runner behind its back.

### The escape hatch

For the Docker stack, grove reads exactly two keys out of a group's `raw` block.

```yaml
    raw:
      docker_run_args: ["--dns", "1.1.1.1"]
      env:
        HTTPS_PROXY: http://proxy:3128
```

`docker_run_args` is appended to `docker run` just before the image. `env` becomes `--env NAME=value`. Any other key is reported as an unused warning and passed nowhere. A `raw` block of the wrong shape is a config error, and grove refuses the run before it touches a host.

### An absent disk

If the work root sits under `/Volumes/`, `/mnt/` or `/media/`, grove compares the device id of the mount point with the device id of `/` before starting anything. A match means the disk is not mounted, and grove refuses rather than quietly filling the boot disk. grove never creates a mount point itself.

## Ownership

grove manages only what it created, and proving that takes two facts that must agree: the name matches `grove-<group>-<index>`, and an active record exists in grove's database.

| | Name does not match | Name matches |
|---|---|---|
| **Record: yes** | record only, reported, untouched | **managed**, grove may drain, deregister and remove |
| **Record: no** | foreign, invisible to grove | unmanaged, reported, untouched |

grove never imports an existing runner. `teardown --include-unmanaged` is the only way to reach the unmanaged cell.

## State

grove keeps its history in one directory. `GROVE_STATE_DIR` overrides it.

| Platform | Default |
|---|---|
| Linux | `$XDG_STATE_HOME/grove`, falling back to `~/.local/state/grove` |
| macOS | `~/Library/Application Support/grove` |

`grove.db` is a SQLite database opened with `node:sqlite`. It records which runners grove created, their lifecycle events, and liveness samples. It is history and ownership proof only. Every decision comes from `docker ps` and the forge API, so a lost database changes what grove can tell you about last week, never what it does to your fleet.

## Develop

```bash
npm install
npm run dev -- plan     # run from source
npm test
npm run typecheck
npm run lint
npm run format
npm run build
```

Tests sit next to the code they cover as `*.test.ts`. Nothing in the suite opens an SSH connection, calls a forge, or runs Docker. Anything that touches a host goes through `FakeTransport`, every forge call goes through a fake client or an injected `fetch`, and the state store opens `:memory:`.

## License

MIT
