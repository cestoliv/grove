# grove

One YAML file describes a fleet of self-hosted GitHub and GitLab runners. grove makes the hosts match it, watches what happens, and restarts what wedges.

grove is agentless. One control node holds the config and reaches every host over SSH, or over a local transport when the host is the control node itself. Nothing is installed on the hosts except the runners.

## Status

Milestone 1 of six. Only `grove config` and `grove plan` exist. `grove plan` validates the config and probes host reachability. It does not call forges or Docker yet. `apply`, `status`, `logs`, `doctor`, `teardown` and `daemon` land in later milestones.

## Install

```bash
npm install -g @cestoliv/grove
```

grove needs Node 20 or newer on the control node, and the `ssh` binary for any host that is not the control node.

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
| CLI delegation | no `auth` block at all, which uses `gh` or `glab` |

A literal that matches a token pattern is rejected. Nothing that looks like a credential belongs in the file.

`${VAR}` interpolation applies everywhere in the config except inside a group's `raw` block. grove passes `raw` through to the runner verbatim, so a `${...}` meant for the runner (for example a GitLab CI runtime variable) survives untouched.

### Each forge keeps its own vocabulary

`scope.level` takes `enterprise`, `organization` or `repository` on GitHub, and `instance`, `group` or `project` on GitLab. A mismatch is rejected and the three valid values are named. GitHub groups use `labels`, GitLab groups use `tags`, and using the wrong one is an error rather than a silent no-op.

### Placement

`placement` takes two forms. `{ host: mac, count: 2 }` targets one host. `{ mac: 2, atlas: 1 }` spans hosts in one group.

### Architecture is a request

`arch` never blocks anything. Asking for `amd64` on an `arm64` host warns and proceeds, because the person asking usually knows why.

## Plan

```bash
grove plan
grove --config ./ci/grove.yaml plan
```

`grove plan` validates the config, probes every host in parallel, and prints what it found. It never touches a runner.

```
config  /work/grove.yaml

Hosts
  HOST   TYPE   TARGET        STATE        DETAIL
  mac    local  this machine  ok           arm64
  atlas  ssh    atlas         unreachable  ssh: connect to host atlas port 22: No route to host

Groups grove would manage
  GROUP         FORGE                 SCOPE                        STACK   ARCH   PLACEMENT  RUNNERS
  overload-arm  gh-overload (github)  organization Overload-coach  docker  arm64  mac x2     2
  chevro-dind   gl-chevro (gitlab)    instance                     docker  amd64  atlas x3   3

Warnings
  warning  groups[1]: group "chevro-dind" runs privileged and mounts /var/run/docker.sock. Any job on that runner can take root on the host. grove proceeds anyway.

Unreachable hosts: atlas
```

Exit codes:

| Code | Meaning |
|---|---|
| 0 | Config valid, every host answered |
| 1 | Config valid, at least one host unreachable |
| 2 | Config missing or invalid |

In milestone 2 `grove plan` also prints the diff between the config and what is actually running. Today it reports reachability and the groups it would manage.

SSH control sockets that `grove plan` opens for reuse live under `~/.ssh/grove/`.

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

Tests sit next to the code they cover as `*.test.ts`. Nothing in the suite opens an SSH connection or calls a forge. Anything that touches a host goes through `FakeTransport`, and the SSH transport is tested by asserting on the argv it builds with an injected spawn function.

## License

MIT
