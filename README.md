# grove

One YAML file describes a fleet of self-hosted GitHub and GitLab runners. grove makes the hosts match it, watches what happens, and restarts what wedges.

grove is agentless. One control node holds the config and reaches every host over SSH, or over a local transport when the host is the control node itself. Nothing is installed on the hosts except the runners.

## Status

Milestone 4 of six. grove manages GitHub and GitLab runners in Docker containers, and GitHub runners as processes on the host under launchd on macOS and systemd on Linux. `config`, `plan`, `apply`, `status`, `logs` and `teardown` work on every one of them. The daemon and stuck detection arrive in milestone 5, and `doctor` and Prometheus metrics in milestone 6.

Switching a group from `docker` to `native`, or back, takes two applies. The first drains the seat on the stack it runs on today, deregisters it and retires its record. The second creates it on the new stack. grove refuses to run one runner name on two supervisors at once, so it waits for the record to go before it makes the new seat.

## Install

```bash
npm install -g @cestoliv/grove
```

grove needs Node 22.13 or newer on the control node, because it stores its history with `node:sqlite`. It also needs the `ssh` binary for any host that is not the control node, and a Docker daemon on every host that runs a `stack: docker` group. A host that runs only native groups needs no Docker at all, and [What a native host needs](#what-a-native-host-needs) says what it needs instead.

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
| CLI delegation | no `auth` block at all, which runs `gh auth token` on a GitHub forge and `glab config get token --host <host>` on a GitLab one |

A literal that matches a token pattern is rejected. Nothing that looks like a credential belongs in the file.

`${VAR}` interpolation applies everywhere in the config except inside a group's `raw` block. grove passes `raw` through to the runner verbatim, so a `${...}` meant for the runner survives untouched.

### Each forge keeps its own vocabulary

`scope.level` takes `enterprise`, `organization` or `repository` on GitHub, and `instance`, `group` or `project` on GitLab. A mismatch is rejected and the three valid values are named. GitHub groups use `labels`, GitLab groups use `tags`, and using the wrong one is an error rather than a silent no-op.

### GitLab

grove speaks the current registration flow and nothing else. It calls `POST /api/v4/user/runners`, receives a `glrt-` authentication token, and starts `count:` containers against that one token.

The legacy `--registration-token` flow has been disabled by default since GitLab 17.0 and is scheduled for removal in GitLab 20.0. Runners registered the old way keep working until then, and grove will not adopt them. Tear them down by hand, then let grove create the group.

`count: 3` means something different on each forge.

| | GitHub, `count: 3` | GitLab, `count: 3` |
|---|---|---|
| Containers | 3 | 3 |
| Forge objects | 3 runner records | 1 runner entity, for example #48 |
| Tokens | 3, one per runner | 1 shared `glrt-` token |
| Labels or tags | may differ per runner | one tag set for all three |
| Scaling one down | deregisters that runner | stops that container only |

Deleting the entity would take all three managers with it, so grove deletes it only when the last container has gone, or when `teardown` removes the whole group. A GitLab scale-down calls no forge endpoint at all.

A GitLab group reads `image`, `build`, `tags`, `privileged`, `volumes`, `concurrent`, `limit` and `pull_policy`. `tags` reach the entity when grove creates it. The rest reach the runner container or the jobs it starts, and [What grove creates](#what-grove-creates) says which.

grove mounts the host Docker socket into every GitLab runner container, so a GitLab group with `privileged: true` warns whether or not it lists that socket under `volumes`. Any job on that runner can take root on the host. grove proceeds anyway.

The token grove receives is shown once by GitLab and never again, so grove stores it in `grove.db`. It never prints it, never puts it in a plan line, and never puts it in an error. It does sit in the container's command line, so anyone who can run `docker inspect` on the host reads it. That is the same trust boundary as the Docker socket the runner already mounts.

grove does not read or track `token_expires_at`. An instance that expires runner authentication tokens stops accepting the stored one without telling grove, and the failure shows up as a manager that never registers rather than as anything grove says. Delete the group and let grove create it again.

The credential grove uses needs the `api` scope. `read_api` is not enough, because grove deletes the entity when the last container goes. The token also needs the Owner role on the namespace the scope names. An `instance` level group needs a token that belongs to an instance administrator, and grove says so when GitLab answers 403.

With no `auth` block, grove runs `glab config get token --host <host>` on the control node. `glab auth status --show-token` writes to stderr and exits non-zero when any configured instance fails, so it is not the command grove uses.

A GitLab group's name may not end in a dash and digits, because the entity description would then name two different runners. [Ownership](#ownership) says why.

GitLab's `/groups/:id/runners` endpoint answers for the group and for its subgroups and projects. A group scope at a parent therefore sees entities grove did not create in that scope, and `grove status` reports them as unmanaged. grove deletes nothing it does not own, so the extra rows are noise and never risk.

#### Which manager is which container

GitLab's managers endpoint exposes a `system_id` for each running process and no name at all, so nothing in the API says which manager is which container. `gitlab-runner` writes that id to `.runner_system_id` next to `config.toml` at first start. grove mounts that directory from the host, reads the file on every pass, and stores the id on the runner's record.

A container that has never run has no id to read. grove stores what it reads on `grove status` and on `grove apply`, so a manager shows up from the first of those that follows its container's first start. `grove plan` never writes to the database, because writing is an act, so a manager grove has not stored yet reads as offline in a plan.

A manager whose container grove stopped stays listed at GitLab until it goes stale. grove leaves it alone and shows the count in the shared runner table of `grove status`, so `2/3` means one container is not calling home.

### Native runners

A native group runs the GitHub Actions runner as a process on the host, supervised by a launchd agent on macOS and a systemd user unit on Linux. It is what you want for an iOS build, because Xcode does not run in a Linux container and a macOS container is not a thing.

```yaml
  - name: ios
    forge: gh-overload
    scope: { level: organization, target: Overload-coach }
    placement: { host: mac, count: 1 }
    stack: native
    labels: [macos, xcode]
    work_root: ~/ci/ios
    max_job_duration: 90m
    max_work_size: 120G
    raw:
      runner_version: "2.328.0"
      env:
        DEVELOPER_DIR: /Applications/Xcode.app/Contents/Developer
```

Native supports GitHub forges only. A native group on a GitLab forge is a config error, named with its path and its fix, and grove refuses the run before it touches a host. The GitLab shape for a host-installed runner is a `gitlab-runner` binary with a shell executor, which is a different stack rather than a variant of this one.

grove downloads the runner release itself. It asks `api.github.com` for the latest `actions/runner` release once per run, and `raw.runner_version` pins a version instead, which is what you want on a host that cannot reach GitHub's API or in a fleet you want reproducible. Every failure of that lookup names `raw.runner_version` as the fix. The runner is configured with `--disableupdate`, so it keeps the version grove installed rather than replacing itself behind grove's back.

`image`, `build`, `privileged`, `volumes`, `pull_policy`, `concurrent` and `limit` describe a container, so a native group that sets one gets a warning naming the key. `labels`, `arch`, `drain_timeout` and `work_root` all reach the seat. `cache_root` names a directory grove creates and hands to nothing yet, and `max_job_duration` and `max_work_size` are carried on the seat for the daemon of milestone 5, which is what they do on a Docker seat too.

grove writes a native seat's install directory and work directory onto its record when it creates the seat. That is what lets `apply` and `teardown` take the seat down after its group has left the config, when the file no longer says where its files are. `grove logs` still needs the group, because it derives the log path from the config rather than from the record, and it says so rather than guessing.

#### What a native host needs

grove never provisions a host. These are the things it will tell you about rather than fix.

On macOS:

- The Xcode command line tools, so `git`, `curl` and `tar` exist. `xcode-select -p` should print a developer directory.
- Xcode itself for an iOS build, and `raw.env.DEVELOPER_DIR` when more than one version is installed.
- Nothing else. launchd is always there, and grove installs the agent into the per-user domain with no `sudo`.

On Linux:

- A systemd user session that survives logout. Run `loginctl enable-linger` as the runner user once, or grove's `systemctl --user` calls fail and it says so with that command in the message.
- `curl` and `tar`.
- `journalctl`, if you want `grove logs` to read the unit's output.

grove's agent carries `PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin`, because launchd hands an agent a minimal PATH and a job that cannot find `xcodebuild` or a Homebrew tool is the first thing a native runner gets wrong. Anything in `raw.env` is added to that, and a `PATH` there replaces it.

#### One host, both stacks

A host runs whichever stacks its groups ask for, and each is queried on its own. A Mac with no Docker keeps converging its native groups, and a Linux box with no systemd user session keeps converging its Docker groups. A host that answers at all is reachable, and whichever query failed degrades only the seats behind it, with `plan` naming the reason on each of those seats.

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
  create      grove-overload-arm-2  on mac, registering at gh-overload
  create      grove-ios-1  on mac, registering at gh-overload, native

2 change(s) planned. grove plan changes nothing. Run grove apply to make them.
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

`grove status` prints one row per runner, joining what Docker and the host supervisors report with what the forge believes, and marks each row managed, unmanaged or record-only. `STACK` says which supervisor answered for the row, `PROCESS` is the container state, the unit state or `missing`, and `DETAIL` is what that supervisor said about it. It writes one liveness sample per managed runner into the history database on every run.

```
config  /work/grove.yaml

Runners
  GROUP         HOST  RUNNER                STACK   PROCESS  DETAIL                    FORGE    OWNER
  overload-arm  mac   grove-overload-arm-1  docker  running  Up 3 hours                busy     managed
  overload-arm  mac   grove-overload-arm-2  docker  exited   Exited (0) 4 minutes ago  offline  managed
  ios           mac   grove-ios-1           native  running  pid 4242                  online   managed
  legacy        mac   grove-legacy-1        docker  running  Up 2 days                 online   unmanaged

Every host and forge answered.
```

The `FORGE` column carries the forge's opinion of the runner, which is `online`, `offline`, `busy` or `unknown`. There is no column for the job a busy runner is running, because the GitHub API does not expose it. `--json` prints the same report with the forge name the table leaves out.

A fleet with a GitLab group gets one more column and one more table. `MANAGER` carries the state GitLab reports for the manager process behind a seat, and it appears only when a forge in the fleet reports managers at all. `Shared runners` lists one row per runner entity, with its id, its tags, and how many managers GitLab lists out of how many containers the config asks for.

```
Shared runners
  FORGE      GROUP        ENTITY  TAGS         MANAGERS
  gl-chevro  chevro-dind  48      docker,dind  2/3
```

`grove logs` takes a group name or a runner name, and reads whichever stack that runner uses. A Docker seat goes to `docker logs`. A native seat on macOS goes to `tail` on the two files launchd redirects into, `<install_dir>/stdout.log` and `<install_dir>/stderr.log`. A native seat on Linux goes to `journalctl --user -u grove-<group>-<index>.service`, and grove points at the runner's own `_diag` directory when `journalctl` is not installed. A group with several runners prints each in turn with a header. `--follow` needs exactly one runner. `--tail` defaults to 200 lines.

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

On a native seat `--include-unmanaged` reads the install directory from the config, because an unmanaged seat has no record to read it from. grove removes `<work_root>/<group>-<index>-runner` and refuses any other path, so a foreign seat of the same name that lives somewhere else keeps its files. A seat whose group has also left the config has no directory in either place, and grove reports that it needs the record rather than guessing.

On a GitLab forge it also reaches a runner entity described `grove-<group>` that no active record and no stored registration backs. An entity grove minted is not unmanaged, however few containers point at it, so a plain `teardown` still removes that one.

An unreachable host or forge stops the teardown of the runners behind it, and grove reports each one instead.

A runner that exists only at the forge is the one case grove cannot read. Its container may be gone, or it may be running on a host that did not answer. Deregistering the second one strands a working runner: it keeps its job and loses its registration. So `--include-unmanaged` deregisters a forge-only runner only when every host in the config answered. If any host is unreachable or was never observed, grove reports the runner and leaves it alone.

A record with no container and no forge runner behind it is an orphan. `teardown` reports it and leaves it alone. `apply` retires it, because nothing is left for the record to protect.

Run `teardown` before you delete a group from the config. grove deregisters a runner only when it can still see it in a scope the config names, so a group deleted while its runners still exist leaves the forge records behind, reported as orphans.

## What grove creates

Every managed artifact derives its name from the group and a one-based index.

| Artifact | Name |
|---|---|
| Docker container | `grove-<group>-<index>` |
| launchd label, native macOS | `com.cestoliv.grove.<group>-<index>` |
| launchd plist, native macOS | `~/Library/LaunchAgents/com.cestoliv.grove.<group>-<index>.plist` |
| systemd user unit, native Linux | `~/.config/systemd/user/grove-<group>-<index>.service` |
| Runner name at the forge | `grove-<group>-<index>` |
| Work dir | `<work_root>/<group>-<index>` |
| Cache dir | `<cache_root>/<group>-<index>` |
| Config dir, GitLab only | `<work_root>/<group>-<index>-config` |
| Install dir, native only | `<work_root>/<group>-<index>-runner` |

Indexes run from 1 to the group's total count across every host in the placement. A group spread over two hosts still numbers its seats once, so no name appears twice.

The work root defaults to `/var/tmp/grove`, and the cache root defaults to a sibling of the work root, so `/Volumes/ci/grove` gives `/Volumes/ci/grove-cache`. Both are mounted into the container at the identical path, because a job that runs `docker` talks to the host daemon and the host daemon resolves every path against the host. For a Docker group grove creates both directories with mode `0777`, because the runner runs as an unprivileged user inside the container and the bind mount carries host ownership. A native group needs no such thing, because its runner is the host user itself, so those two directories take the host umask.

A group on a GitHub forge with no `image:` and no `build:` runs `ghcr.io/actions/actions-runner:latest`, configured with `./config.sh --url ... --token ... --name ... --work ... --unattended --replace` and started with `./run.sh`. `--replace` lets a recreated runner take its own name back at the forge. There is no `--ephemeral`, so runners are persistent and their caches stay warm. The work directory is wiped when a runner is created and kept across restarts.

The registration token sits in the container's command line. Anyone who can run `docker inspect` on the host reads it until it expires.

A group on a GitLab forge with no `image:` and no `build:` runs `gitlab/gitlab-runner:latest`. grove overrides the entrypoint with `sh` and hands it one script. The script registers once, guarded on a `[[runners]]` section in `config.toml`, then `exec`s `gitlab-runner run`. A restart therefore reuses the runner it already registered instead of adding a second one on every start. A `register` that fails deletes the half written `config.toml` and exits non-zero, so the next start retries instead of running a runner that registered with nobody.

The config directory is mounted at `/etc/gitlab-runner` and created mode `0700`, because `config.toml` holds the runner authentication token after registration. It is a sibling of the work dir, so `apply --clean` does not wipe it and a restart keeps its registration. Creating a runner wipes it, so the new container registers against the token that create resolved.

The runner container gets the host Docker socket, because the Docker executor starts every job as a sibling container and needs a daemon to talk to. `privileged: true` and `volumes:` apply to those job containers, not to the runner container. That is what the `chevro-dind` shape in the example config means: privileged jobs with the socket, an unprivileged runner.

`concurrent` is a global key in `config.toml` with no flag and no environment variable, so grove writes it before `register` runs and lets `register` merge its own section underneath. `limit` becomes `--limit` on the runner itself. `pull_policy: missing` becomes `--docker-pull-policy if-not-present`, which is how gitlab-runner spells it. The work dir and the cache dir reach the job containers at the same host paths, so a job writes where the runner mounted. Tags are never passed to `register`, because the entity already carries them and the current flow ignores them there.

Jobs that name no image get `alpine:latest`. Set `raw.job_image` to change that.

A native group installs the runner itself. grove creates `<work_root>/<group>-<index>-runner` mode `0700`, downloads `actions-runner-<os>-<arch>-<version>.tar.gz` into it with `curl`, unpacks it with `tar`, then runs `./config.sh --url ... --token ... --name ... --work ... --unattended --replace --disableupdate [--labels a,b]` from that directory. The install dir is a sibling of the work dir, so `apply --clean` wipes the work dir and leaves the runner and its credentials in place. Creating a runner wipes both.

The registration token sits in the argument vector of `config.sh` while it runs. Anyone who can read the process table on the host reads it until it expires, exactly as with the Docker stack.

`.credentials` in the install dir holds the runner's private key after registration, which is why that directory is `0700`. Removing a native seat deletes the install dir, because the key dies with the forge record grove deletes beside it, and keeps the work dir, exactly as a removed container leaves its work dir behind.

Both supervisors run `<install_dir>/bin/runsvc.sh`, which is the entry point the runner's own service templates name. It traps SIGTERM and sends the listener SIGINT, and SIGINT is the signal that means stop taking work, finish the job you hold, then exit. `run.sh` traps nothing, so a SIGTERM there kills the wrapper and leaves the listener running its job with no parent. The systemd unit carries `KillMode=process`, so only that entry point is signalled and not the job's own children. The plist sets `ProcessType=Interactive`, because launchd throttles the CPU and the I/O of a background job and a 40 minute Xcode build is exactly the workload that pays for it.

The launchd plist carries `RunAtLoad` and no `KeepAlive`, and the systemd unit carries `Restart=no`. grove owns crash recovery on every stack, and its fast tick is what brings a dead runner back.

Draining a native seat sends SIGTERM, through `launchctl bootout` on macOS and `systemctl --user stop` on Linux. The runner finishes the job it holds and exits. The timer belongs to the supervisor: the plist carries `ExitTimeOut` and the unit carries `TimeoutStopSec`, both from `drain_timeout`, and each supervisor escalates to SIGKILL there. grove never kills a process itself, because the pid a supervisor reports is the entry point rather than the listener, and killing it would orphan the job. On macOS grove polls `launchctl list` until the seat is gone, for up to five seconds past the drain, and reports a failure if it is still there. So nothing deletes an install directory under a live runner, and the next pass tries again.

`--force` sets the drain to zero. On Linux grove asks systemd for SIGKILL and the unit goes at once. On macOS the plist's `ExitTimeOut` is still what launchd escalates at, and grove has no way to kill the job faster without orphaning the process the runner is holding, so a forced seat that is still running a job is reported as still stopping rather than killed.

grove deregisters a native runner through the GitHub API, with the runner id it already holds, rather than running `config.sh remove`. That means one code path for every stack, and it works even when the host has gone.

Containers run with `--restart no`. grove owns crash recovery, so nothing resurrects a runner behind its back.

### The escape hatch

For a Docker group on a GitHub forge, grove reads exactly two keys out of `raw`.

```yaml
    raw:
      docker_run_args: ["--dns", "1.1.1.1"]
      env:
        HTTPS_PROXY: http://proxy:3128
```

For a Docker group on a GitLab forge it reads four.

```yaml
    raw:
      docker_run_args: ["--dns", "1.1.1.1"]
      env:
        HTTPS_PROXY: http://proxy:3128
      job_image: node:22
      register_args: ["--docker-network-mode", "host"]
```

For a native group it reads two.

```yaml
    raw:
      runner_version: "2.328.0"
      env:
        DEVELOPER_DIR: /Applications/Xcode.app/Contents/Developer
```

`runner_version` pins the `actions/runner` release. `env` becomes the agent's environment, on top of the PATH grove sets.

`docker_run_args` is appended to `docker run` just before the image. `env` becomes `--env NAME=value` on the runner container. `job_image` is the image a job gets when it names none. `register_args` is appended to `gitlab-runner register`, last, so it wins. Any other key is reported as an unused warning and passed nowhere. A `raw` block of the wrong shape is a config error, and grove refuses the run before it touches a host.

### An absent disk

If the work root sits under `/Volumes/`, `/mnt/` or `/media/`, grove compares the device id of the mount point with the device id of `/` before starting anything. A match means the disk is not mounted, and grove refuses rather than quietly filling the boot disk. grove never creates a mount point itself.

## Ownership

grove manages only what it created, and proving that takes two facts that must agree: the name matches `grove-<group>-<index>`, and an active record exists in grove's database.

| | Name does not match | Name matches |
|---|---|---|
| **Record: yes** | record only, reported, untouched | **managed**, grove may drain, deregister and remove |
| **Record: no** | foreign, invisible to grove | unmanaged, reported, untouched |

grove never imports an existing runner. `teardown --include-unmanaged` is the only way to reach the unmanaged cell.

A GitLab runner entity is owned the same way. Its description is `grove-<group>`, and grove destroys it only when a record or a stored registration backs it. An entity whose description matches with nothing behind it is unmanaged, reported and left alone, and `teardown --include-unmanaged` is the only thing that removes it. That is also why a GitLab group's name may not end in a dash and digits: `grove-chevro-2` would be both the entity of group `chevro-2` and the second seat of group `chevro`, and grove refuses the config rather than guess.

## State

grove keeps its history in one directory. `GROVE_STATE_DIR` overrides it.

| Platform | Default |
|---|---|
| Linux | `$XDG_STATE_HOME/grove`, falling back to `~/.local/state/grove` |
| macOS | `~/Library/Application Support/grove` |

`grove.db` is a SQLite database opened with `node:sqlite`. It records which runners grove created, their lifecycle events, liveness samples, and one row per GitLab group holding that group's runner entity id and its `glrt-` authentication token. Everything but that token is history and ownership proof, and every decision comes from `docker ps` and the forge API, so a lost database changes what grove can tell you about last week, never what it does to your fleet. The token is the exception, because GitLab shows it once and grove needs it to start another manager later.

The state directory is created mode `0700` and `grove.db` mode `0600`, because that file holds a runner authentication token. Treat it like an SSH private key. If you lose it, tear the GitLab group down and let grove create it again.

SQLite writes `grove.db-wal` beside the database while grove runs, and that file gets whatever the umask allows. The `0700` directory is what keeps it private, so leave the directory mode alone even if the `-wal` file looks loose.

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
