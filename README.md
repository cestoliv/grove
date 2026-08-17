# grove

One YAML file describes a fleet of self-hosted GitHub and GitLab runners. grove makes the hosts match it, watches what happens, and restarts what wedges.

grove is agentless. One control node holds the config and reaches every host over SSH, or over a local transport when the host is the control node itself. Nothing is installed on the hosts except the runners.

## Status

Milestone 6 of six, and the last one. grove manages GitHub and GitLab runners in Docker containers, and GitHub runners as processes on the host under launchd on macOS and systemd on Linux. `config`, `plan`, `apply`, `status`, `logs`, `doctor` and `teardown` work on every one of them. `grove daemon` converges the fleet on its own, detects stuck runners, prunes work directories against `max_work_size` and prunes its own history against `history.retention`. `grove doctor` checks every host, forge and group and prints the fix for each finding, and `metrics.listen` turns on a Prometheus exporter inside the daemon.

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

`grove status` also prints a `Storage` block saying what grove costs each host. `IMAGES` and `RECLAIMABLE` come from `docker system df`, so `RECLAIMABLE` is what `docker image prune` would give back. `WORK DIRS` is the total of one `du -sk` per managed seat, and `NOTE` names the largest of them. That is two commands per host per run, which is why only `grove status` and the full tick spend them. `--json` carries the same numbers under `storage`.

```
Storage
  HOST   IMAGES    RECLAIMABLE  WORK DIRS  NOTE
  mac    24.0 GiB  9.0 GiB      61.0 GiB   largest grove-overload-arm-1 at 38.0 GiB
  atlas  12.0 GiB  2.0 GiB      4.0 GiB    largest grove-chevro-dind-2 at 3.0 GiB
```

When a daemon has run on this control node, `grove status` closes with a `Daemon` block saying whether the loop is running, under which pid, and when each tick last ran. A `grove apply` that holds the lock is not the daemon and is never reported as one. A fleet with suspect runners gains a `Suspect runners` table naming each one, the host it sits on, when it became a suspect and why. [Stuck detection](#stuck-detection) says what makes one.

```
Daemon
  process    running, pid 4242 (daemon)
  last fast  2026-08-16T09:12:04.008Z
  last full  2026-08-16T08:44:11.412Z

Suspect runners
  RUNNER                HOST  SINCE                     REASON
  grove-overload-arm-1  mac   2026-08-16T08:44:11.412Z  the forge has said busy for 140m against a max_job_duration of 90m, but the work dir /Volumes/ci/grove/overload-arm-1 reads as active
```

`grove logs` takes a group name or a runner name, and reads whichever stack that runner uses. A Docker seat goes to `docker logs`. A native seat on macOS goes to `tail` on the two files launchd redirects into, `<install_dir>/stdout.log` and `<install_dir>/stderr.log`. A native seat on Linux goes to `journalctl --user -u grove-<group>-<index>.service`, and grove points at the runner's own `_diag` directory when `journalctl` is not installed. A group with several runners prints each in turn with a header. `--follow` needs exactly one runner. `--tail` defaults to 200 lines.

## Doctor

```bash
grove doctor
grove doctor --strict
grove doctor --json
```

grove never provisions a host, and that is the trade. `grove doctor` is what grove owes you in return: a precise diagnosis, with the fix printed for every failure.

| Target | What it checks |
|---|---|
| Every host | `host.reachable` that the transport answers at all, `host.shell` that `sh` prints only what it was asked to print, `host.platform` that the host is macOS or Linux and what architecture it is, `host.clock` the skew against the control node, `host.docker-cli` and `host.docker-daemon` that a Docker group has a daemon to run on, `host.image-store` how big the image store has grown, `host.work-dirs` what the seats spend under the work root, `host.curl` that a seat publishing a metrics port can be scraped |
| Every work root | `host.disk` free space and capacity, `host.work-root-exists` that the directory is there, `host.work-root-writable` that this user may write in it, `host.work-root-volume` that a root under `/Volumes`, `/mnt` or `/media` is a mounted disk and not the boot disk wearing its name |
| Every Linux host | `host.docker-group` that the daemon answers without `sudo`, `host.systemd-user` that the user manager answers, `host.lingering` that the user session survives a logout |
| Every macOS host | `host.launchd` that the `gui/<uid>` domain answers, `host.xcode-select` where Xcode is selected, `host.xcodebuild` that it runs and its licence is accepted, `host.simulators` that a runtime is installed |
| Every forge | `forge.credential` that grove resolves a token, `forge.token` that the forge accepts it, `forge.scopes` that it carries the scopes the declared levels need, `forge.admin` that an `instance` level scope has an administrator behind it, `forge.scope-access` that each declared scope is readable |
| Every group | `group.privileged-socket`, `group.arch`, `group.native-forge`, `group.native-platform`, `group.max-work-size`, `group.raw`, `group.native-option` and `group.metrics-port`. Each is a config warning `plan` already prints, and doctor is the one that also prints what to do about it |
| The control node | `control.node` the Node version, `control.state-dir` that the state directory is writable, `control.database-mode` that `grove.db` is not group or world readable, `control.ssh` that an `ssh` binary is there when a host needs one, `control.cli-delegation` that `gh` or `glab` is there when a forge has no `auth` block, `control.daemon` that the loop is installed and running, `control.metrics-listen` that the exporter address is valid and loopback |

Every check answers with one of four statuses.

| Status | What it means |
|---|---|
| `ok` | grove looked, and this is fine |
| `warn` | grove looked, this is worth reading, and nothing is blocked |
| `fail` | grove looked, and something grove needs is not there |
| `skip` | grove did not look, because nothing in this config depends on it, or because the host did not answer |

`grove doctor` exits 0 when nothing failed and 1 when something did. `--strict` makes a warning exit 1 too, which is what you want in CI. `--json` prints the whole report, sorted the same way the table is.

```
config  /work/grove.yaml

Host atlas
  CHECK                    SUBJECT            STATUS  SUMMARY
  host.reachable                              ok      answered as Linux amd64
  host.shell                                  ok      sh runs a command and prints only its output
  host.platform                               ok      Linux amd64
  host.clock                                  ok      clock agrees with this machine
  host.disk                /PROD/local/grove  warn    8.4 GiB free, 93% used
  host.docker-cli                             ok      the docker binary is on the PATH
  host.docker-daemon                          fail    Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?
  host.docker-group                           ok      the user is in the docker group
  host.image-store                            warn    the image store could not be measured: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?
  host.work-root-exists    /PROD/local/grove  ok      the work root is a directory
  host.work-root-writable  /PROD/local/grove  ok      the work root is writable
  host.work-root-volume    /PROD/local/grove  skip    the work root is not under /Volumes, /mnt or /media, so an absent mount cannot be mistaken for it
  host.work-dirs                              ok      0 B across 2 seats
  host.systemd-user                           ok      the systemd user manager is running
  host.lingering                              ok      lingering is enabled for the SSH user
  host.launchd                                skip    Linux runs systemd, not launchd
  host.xcode-select                           skip    Xcode is a macOS matter
  host.xcodebuild                             skip    Xcode is a macOS matter
  host.simulators                             skip    simulators are a macOS matter
  host.curl                                   skip    no seat on this host publishes a gitlab-runner metrics port

Fixes
  warn  host.disk  Host atlas, /PROD/local/grove
      8.4 GiB free, 93% used
      Free space on /PROD, or set max_work_size on the groups using this root so grove prunes them oldest-first on the full tick.

  fail  host.docker-daemon  Host atlas
      Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?
      Start the daemon with `sudo systemctl start docker`, and `sudo systemctl enable docker` so a reboot does not take the fleet with it.

  warn  host.image-store  Host atlas
      the image store could not be measured: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?
      Check that `docker system df` answers on the host. grove reports the image store rather than managing it, so this blocks nothing.

11 ok, 2 warnings, 1 failure, 6 skipped
Run the fixes above, then grove doctor again. grove apply runs the host checks before the first apply against a host it has no record of, and refuses a host with a failing check.
```

That is one host of a fleet. A real run prints the control node, then every host, then every forge, then every group, and one `Fixes` entry per warning and per failure.

The thresholds are these, so none of them is a surprise. A work root with less than 1 GiB free fails, because a job cannot pull one Docker layer into it, and one with less than 10 GiB free or at 90% or more of capacity warns. A host clock 5 minutes or more out of step with the control node fails, because a forge rejects a token signed that far away, and 30 seconds or more out warns. An image store of 20 GiB or more warns, and so does one where more than half of it is reclaimable.

Doctor never writes to a host. Writability is `test -w`, not a file grove creates. The GitHub scope proof is a runner read, not a minted registration token. Nothing in doctor creates a directory, a token or a container, and nothing in it removes one.

An unreachable host is one failure and nineteen skips, and every other host is still checked. A broken forge credential is a finding on that forge, and every other forge is still checked. One host that cannot answer never costs you the diagnosis of the rest of the fleet.

Host checks also run on their own, before the first `grove apply` against a host grove has no record of. A failure refuses the apply and prints the table above the refusal. `--skip-doctor` bypasses the whole gate. grove remembers a host that passed, in `meta` next to the tick stamps, so the second apply asks it nothing. Only the host family is gated: a broken token fails the apply anyway with an error that names it, and blocking an apply on a group warning would make `privileged: true` unusable. `grove teardown` is never gated, because removing runners from a host whose Docker is broken is a thing you may well be doing on purpose.

## Metrics

The exporter is off unless `metrics.listen` is set. Set it and `grove daemon run` serves `/metrics` and `/healthz` on that address, and nothing else.

```yaml
metrics: { listen: "127.0.0.1:9130", scrape_cache: 10s }
```

The daemon reloads the config before every tick, so the exporter follows it: set `metrics.listen` and it starts on the next tick, remove it and it stops, change it and it moves. An address grove cannot bind is logged and retried on the tick after, because a control loop that stops converging over a taken port is worse than one with no exporter.

`listen` is a real `host:port`. A bare `:9130` means every interface in Go's convention, and this endpoint should never bind every interface by accident, so grove wants the host spelled out and rejects port 0. The exporter binds exactly what you write and nothing else.

Bind loopback. The endpoint has no authentication. It exposes group names, host names, seat states and job counts, and no credential. Put an SSH tunnel or a reverse proxy in front of it if Prometheus runs on another machine. `grove doctor` warns when the address is not loopback.

| Metric | Type | What it says |
|---|---|---|
| `grove_up` | gauge | Always 1 while the exporter answers |
| `grove_build_info` | gauge | Always 1, labelled with the grove `version` this exporter runs |
| `grove_host_reachable` | gauge | Whether the `host` answered on the last tick |
| `grove_forge_reachable` | gauge | Whether the `forge` answered on the last full tick |
| `grove_runners` | gauge | Managed seats by `group`, `host`, `forge` and `state` |
| `grove_runners_expected` | gauge | Seats the config asks for, by `group` and `host` |
| `grove_suspect_runners` | gauge | How many seats one stuck signal agrees about |
| `grove_daemon_running` | gauge | Whether the control loop is running on this node |
| `grove_last_tick_timestamp_seconds` | gauge | When each tick last ran, by `kind`, which is `fast` or `full` |
| `grove_tick_duration_seconds` | gauge | How long the last tick of each `kind` took |
| `grove_snapshot_age_seconds` | gauge | How long ago the tick that produced the fleet gauges ran |
| `grove_restarts_total` | counter | Restarts grove made, by `group`, over retained history |
| `grove_jobs_total` | counter | Jobs seen, by `group` and `outcome`, over retained history |
| `grove_image_store_bytes` | gauge | Bytes the Docker image store takes, by `host` |
| `grove_image_store_reclaimable_bytes` | gauge | Bytes `docker image prune` would free, by `host` |
| `grove_host_work_dir_bytes` | gauge | Bytes every managed work dir takes, by `host` |
| `grove_work_dir_bytes` | gauge | Bytes one seat work dir takes, by `host` and `runner` |

The two halves of that table are fresh in different ways. The fleet gauges come from the last tick, so `grove_snapshot_age_seconds` is what tells "no runner is online" apart from "no tick has run since the daemon died". Alert on the age first, and on anything else second. The counters, the tick stamps and `grove_daemon_running` are read out of SQLite on every scrape, so they are current whatever the daemon is doing.

`state` on `grove_runners` is one reading of a seat, joining what the host said with what the forge said. It is `busy` when the forge says busy, `missing` when the container or the unit is not there, `online` when the host says running and the forge says online, `offline` otherwise, and `unknown` for a seat on a host that did not answer. Only a full tick calls a forge, so `busy` appears after one and not between them. Join a missing-seat alert with reachability anyway, so a host outage fires once rather than once per seat.

```
grove_runners{state="missing"} > 0
  and on (host) grove_host_reachable == 1
```

Two things are worth knowing about the counters. History pruning at `history.retention` drops the rows they are counted from, which makes them go down. Prometheus reads that as a counter reset and `rate()` handles it, so the graphs stay right. They are also keyed by group through the active records, so a retired seat's history stops being counted, which is a reset for the same reason and the honest answer: the seat no longer exists.

### The gitlab-runner re-export

`gitlab-runner` publishes its own metrics, and grove can carry them out on the same endpoint. Set `raw.metrics_port` on a GitLab Docker group.

```yaml
    raw:
      metrics_port: 9252
```

grove then writes `listen_address = ":9252"` into that seat's `config.toml`, publishes `127.0.0.1:<metrics_port + n - 1>:9252` on the host for seat n, and scrapes each seat with `curl` over the same SSH connection the ticks use. A group of three seats starting at 9252 takes 9252, 9253 and 9254, wherever those seats are placed. Every sample gains a `grove_runner` and a `host` label, so two seats never collide, and both expositions merge into one valid response with each family's `HELP` and `TYPE` appearing once. `grove_runner` is namespaced because `gitlab-runner` exports a `runner` label of its own, and `host` is the label grove's own metrics use for the machine, so one PromQL join covers both halves of the endpoint. A label grove is about to add that a sample already carries is left alone, so nothing the runner exports is ever overwritten or repeated. The port stays on the host's loopback and never reaches the network.

One scrape per seat is reused for `metrics.scrape_cache`, ten seconds by default, so two Prometheus servers do not double the `curl` calls landing on your hosts.

`raw.metrics_port` is GitLab only. A GitHub Actions runner exposes no metrics endpoint at all, and a native seat has no container to publish a port from. The whole range has to fit under 65535, so a base that pushes the group's last seat above it is a config error rather than a `docker run` failure at apply time.

The published port is part of `docker run`, so adding `raw.metrics_port` to a group takes effect the next time grove creates the container, not on the next apply. `grove apply` recreates a seat when its container is gone, so the quickest way is to remove the container and let the next tick rebuild it.

Point Prometheus at the exporter, not at the seats.

```yaml
scrape_configs:
  - job_name: grove
    static_configs: [{ targets: ["127.0.0.1:9130"] }]
```

## The daemon

```bash
grove daemon install
grove daemon status
grove daemon tail -n 200 --follow
grove daemon uninstall
```

| Command | What it does |
|---|---|
| `grove daemon install` | Write the launchd agent or the systemd user unit, load it, and start the loop |
| `grove daemon uninstall` | Unload and remove it. The runners keep running |
| `grove daemon run` | Run the loop in the foreground. This is what the installed unit executes |
| `grove daemon tail` | Print the last lines of the daemon's log, and follow it with `-f` |
| `grove daemon status` | Say whether the unit is installed, whether the loop is running, and when each tick last ran |

`grove daemon install` writes `~/Library/LaunchAgents/com.cestoliv.grove.daemon.plist` on macOS or `~/.config/systemd/user/grove-daemon.service` on Linux, loads it, and starts it. The unit names the exact node binary and the exact `dist/grove.js` path, because a supervisor resolves nothing. There is no `PATH` lookup for `node` and no working directory for a relative script. **Reinstall the daemon after upgrading grove**, or the supervisor keeps running the version you replaced. The install refuses a config that does not parse, so the daemon does not flap over it, and it refuses a source checkout, because plain node cannot load `src/grove.ts`.

The plist carries `KeepAlive` and the unit carries `Restart=on-failure` with `RestartSec=10`. The daemon is the one grove job a supervisor may resurrect: grove owns crash recovery for the runners, and the supervisor owns it for grove. A credential the daemon cannot resolve at startup makes it exit, and the restart ten seconds later is the retry.

`grove daemon uninstall` unloads and removes it. The runners keep running, and nothing restarts one that wedges. It also clears the suspects, because no tick is left to revisit them and a stale suspect in `grove status` is worse than none.

`grove daemon status` prints the config it reads, the state directory, the log path, the unit path and whether that unit is installed, whether the loop is running and under which pid, who holds the reconciler lock, when the daemon last started, and when each tick last ran. Liveness comes from the pid the running loop publishes in `meta`, not from the lock, because the lock is taken per tick and is free between them. It exits 1 when the loop is not running. A control node that will not answer the probe reads `unknown` rather than `not installed`, because sending an operator to reinstall something already there is worse than admitting grove does not know.

`grove daemon tail -n 200 -f` follows `<stateDir>/grove.log`. That is the daemon's own log, on the control node. `grove logs <group>` is a runner's log, read from the host that runs it. They are different files on different machines, which is why `daemon tail` counts lines with `-n`, the way `tail` does, and `grove logs` counts them with `--tail`.

`grove daemon run` is what the unit executes. Running it by hand in a terminal is a supported way to watch a tick happen, and Ctrl-C stops it cleanly.

On Linux a user session ends with the login shell unless the user lingers, and the daemon ends with it. Run `loginctl enable-linger $USER` once.

### The two ticks

| Tick | Default | What it does |
|---|---|---|
| fast | `tick.fast`, 2m | One `docker ps` and one supervisor query per host. Starts a seat whose container or unit has stopped. Calls no forge, so it creates nothing and removes nothing. |
| full | `tick.full`, 30m | Everything the fast tick does, plus the forge calls: creates missing seats, scales groups down, deregisters what left the config, detects stuck runners, prunes work dirs and prunes history. |

```yaml
tick: { fast: 2m, full: 30m }
```

The daemon executes destructive changes without asking. It has no prompt to offer, the config is the declared intent, and a group that shrank in the file loses seats on the next full tick. `--include-unmanaged` belongs to `teardown`, and the daemon never does it.

What that costs in recovery time:

| Failure | What brings it back | Latency |
|---|---|---|
| The container exited, or the launchd job stopped | `start-container` on the fast tick | up to `tick.fast`, 2 minutes by default |
| The container was removed, or the unit file is gone | `create-runner` on the full tick, because registration needs a forge call | up to `tick.full`, 30 minutes by default |
| The runner is wedged mid-job | `restart-runner` on the full tick, because the busy signal is a forge call | up to `tick.full` |
| The runner runs but no longer appears at the forge | stop, remove and create on the full tick, after the condition has held for one full tick | up to two `tick.full` |

The last row never applies to a GitLab group, where one runner entity is shared by every manager in the group. A seat GitLab does not list there means grove has not yet learned its system id, not that GitLab forgot it.

The first tick after an install is a full one and runs immediately, so `grove daemon install` converges the fleet now rather than in half an hour. A tick that overruns delays the next one instead of stacking behind it, and a full tick replaces the fast tick it coincides with.

The config is reloaded before every tick. A config that stops parsing keeps the last good one and logs why, because a daemon that stops converging over a typo is worse than one converging on yesterday's file. When the hosts, the forges or `tick.fast` change, grove reopens its connections, and the new context opens before the old one closes, so a failed reopen leaves the daemon with working connections rather than none. Editing a group costs nothing, and a `command:` credential is not re-run every thirty minutes.

`grove status` gains a `Daemon` block saying whether the loop is running and when each tick last ran, so the question "is anything watching this fleet" has an answer from the command you already run.

### Stuck detection

A wedged runner is one the forge still calls busy while nothing on the host moves. grove reads two signals, and only ever for a seat the forge says is busy, because an idle runner with a quiet work directory is a healthy runner.

| Signal | Where it comes from |
|---|---|
| forge | The runner has been busy longer than the group's `max_job_duration` |
| host | Nothing under the seat's work directory has changed since the previous full tick |

grove restarts a seat only when both agree. One alone makes the seat a **suspect**, which `grove status` lists with its reason and the time it started, and which nothing acts on. A group that sets no `max_job_duration` can never produce the forge signal, so grove reports it and never restarts it.

A restart skips the drain, because the job grove would wait for is the reason it is restarting. It wipes the work directory and keeps the install directory, so a native seat keeps the runner release and the credentials it registered with. It records a `restarted` event carrying the reason, and closes the job it killed with the outcome `restarted`.

Two limits stand between a wrong guess and a loop. grove waits 10 minutes after a restart before it restarts the same seat again, and it makes at most 3 restarts per seat per rolling hour. A restart blocked by either becomes a suspect naming which one blocked it. Both read the `events` table, so the operator reads the same history grove decided on.

Detection runs on the full tick, because the busy signal is a forge call. The latency is therefore `tick.full`, and a `max_job_duration` of 90 minutes with a detection latency of 30 minutes is a sound trade.

The host signal reads the work directory rather than a log file, because a Docker runner's log lives inside the container and a native runner's lives in `_diag`. grove keeps a stamp file beside the work directory, asks the host for the first file newer than it, and touches the stamp. Anything other than a clear "nothing changed" means grove does not know, and grove does nothing.

### Storage and history

A group that sets `max_work_size` gets its work directories measured on every full tick, in one exec per host. A seat over its ceiling loses whole top-level entries, oldest first, until it fits. grove removes only direct children of the work directory, never one whose name starts with a dot, and never one holding a slash, because grove deletes build output it can name and not hidden state something else left. A seat the forge calls busy is never measured and never pruned, and neither is a seat whose forge did not answer at all: deleting the tree a job is building in is worse than a full disk. A host grove cannot measure is left for the next tick.

`history.retention` says how long grove keeps lifecycle events, liveness samples and job rows in `grove.db`. It defaults to 90 days, and the full tick prunes what is older.

```yaml
history: { retention: 90d }
```

`meta` and `runner_watch` in `grove.db` are the exception to "every decision comes from the fleet, never from SQLite", alongside the GitLab authentication token. Every column in them is an observation grove made, kept only so the next observation can be compared with it, and losing a row costs one tick of latency and nothing else.

`<stateDir>/grove.log` records events, not a heartbeat. A fast tick that found nothing writes nothing, because 720 lines a day saying nothing happened is how a log stops being read. Reachability changes, executed actions, failures, fresh suspects, prunes and retention are logged, and a suspect is logged once when it appears rather than once per tick. The heartbeat lives in `grove daemon status` and in the `Daemon` block of `grove status`.

The log names hosts, groups and runner names, and it never prints a token. It does quote the stderr of a `command:` credential that failed, because that message is the only thing that explains why the daemon could not start, so keep the state directory as private as its `0700` mode makes it.

### One reconciler at a time

`apply`, `teardown` and the daemon take one lock, `<stateDir>/grove.pid`. Two reconcilers on one fleet would mint two registrations for a seat, or drain a container the other just started.

A command that finds the lock held names who holds it, by pid and by command, and exits 1.

```
another grove process holds /…/grove.pid: pid 4242 (daemon) since 2026-08-16T09:12:04.008Z. Wait for it to finish, or stop the daemon. grove plan, grove status and grove logs still work.
```

`plan`, `status`, `logs`, `config` and every `daemon` subcommand except `run` take nothing, so a fleet the daemon is converging is still readable. There is no `--force`, because a lock an operator can override is a lock that gets overridden at exactly the wrong moment. A stale lock, one whose pid is not alive, is taken over automatically, which is what a reboot leaves behind.

The daemon takes the lock per tick, not for its whole life. It holds the lock while a tick runs and releases it in between, so `grove apply` and `grove teardown` run in the gap between two ticks rather than needing `grove daemon uninstall` first. A tick that finds the lock held is skipped, the daemon says so once in `grove.log`, and the next tick picks up whatever the apply left behind.

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

| File | What it is |
|---|---|
| `grove.db` | The history and ownership database |
| `grove.log` | The daemon's append-only log, read with `grove daemon tail` |
| `grove.log.1` | The one previous log, kept across a rollover |
| `grove.pid` | The lock `apply`, `teardown` and the daemon share |
| `daemon.out.log` | What the daemon printed before its own logger opened, macOS only |
| `daemon.err.log` | What a crash printed on the way out, macOS only |

`grove.db` is a SQLite database opened with `node:sqlite`. It records which runners grove created, their lifecycle events, liveness samples, one row per job a runner ran, and one row per GitLab group holding that group's runner entity id and its `glrt-` authentication token. Everything but that token is history and ownership proof, and every decision comes from `docker ps` and the forge API, so a lost database changes what grove can tell you about last week, never what it does to your fleet. The token is the exception, because GitLab shows it once and grove needs it to start another manager later. `meta` and `runner_watch` are the other exception, and [Storage and history](#storage-and-history) says why.

A job row is derived from a busy transition between two full ticks, because neither forge tells grove how a job ended without a per-job call grove does not make. Its duration is therefore accurate to about one `tick.full`, and its outcome is `unknown` unless grove itself ended it, in which case it is `restarted`. A duration accurate to plus or minus thirty minutes is useful, and one pretending to be exact is not.

`grove.log` rolls over at 50 MB. grove renames it to `grove.log.1` and starts a new one, so exactly one previous file is kept and the directory never grows without bound. On Linux the daemon writes no separate stdout file, because the journal already holds that output.

The state directory is created mode `0700` and `grove.db` mode `0600`, because that file holds a runner authentication token. Treat it like an SSH private key. If you lose it, tear the GitLab group down and let grove create it again.

SQLite writes `grove.db-wal` beside the database while grove runs, and that file gets whatever the umask allows. The `0700` directory is what keeps it private, so leave the directory mode alone even if the `-wal` file looks loose.

## What grove does not do

- **Provisioning.** grove manages runner artifacts only. Docker, Xcode and system packages are somebody else's job, and `doctor` says exactly which is missing.
- **Adoption.** grove never imports an existing runner. It reports one as unmanaged and leaves it alone.
- **A web interface.** Terminal and Prometheus only.
- **GitHub Apps.** A personal access token and `gh` delegation, in this release. The auth block is a tagged union, so adding one later touches nothing else.
- **Secret scanning on your hosts.** grove checks the credentials it uses. It does not read your hosts looking for credentials somebody else left lying about. A GitLab registration token in a world-readable `README.md` is a real problem and grove will not find it for you.
- **Moving the Docker image store.** grove reports its size per host and warns when it grows. Where it lives belongs to OrbStack or Docker Desktop.

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

### Release

A release is a version bump on `main`. When a push to `main` carries a `package.json` version that npm does not have yet, the `publish` workflow publishes it to npm under `latest` with OIDC provenance, then tags the commit `v<version>` and opens a GitHub Release with generated notes. To try a branch before it lands, add the `publish-dev` label to its PR. That publishes a throwaway prerelease `<version>-pr<N>.g<sha>` under a `pr-<N>` dist-tag, comments the install command on the PR, and removes the label so you can add it again.

## License

MIT

---

Milestone 6 of six is complete. grove now does everything the design spec describes.

