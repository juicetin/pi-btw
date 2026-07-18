# Read-only BTW sandbox

The `juicetin/pi-btw` dashboard branch runs every BTW sub-session with two tools:

- `read`, restricted to non-secret files inside the current project
- `bash`, executed inside Bubblewrap with the project and system directories mounted read-only

The main Pi session is unchanged.

## Host requirements

This fork requires Linux, a running systemd user manager, and Bubblewrap. It fails before executing a tool when `bwrap`, `systemd-run`, or `systemctl` is missing. It does not fall back to host bash.

Install Bubblewrap on Debian or Ubuntu:

```bash
sudo apt-get update
sudo apt-get install -y bubblewrap
```

Confirm the required commands:

```bash
bwrap --version
systemd-run --user --pipe --wait --collect --quiet /bin/true
```

## Filesystem boundary

The sandbox builds an empty mount namespace for each command. It exposes:

- `/usr` and the required `/bin` and library links as read-only
- the current project at its original absolute path as read-only
- a minimal `/etc` subset for DNS and TLS certificate lookup
- an isolated `/proc` and `/dev`
- an empty `/home/btw`
- a writable, memory-accounted `/tmp`

The host home directory, SSH agent, cloud configuration, Docker socket, browser data, and user service sockets are not mounted. Unix-domain sockets are excluded from the service address families, and project socket paths are masked. The process environment is cleared before bash starts.

The project scan masks `.git`, `.worktrees`, known credential directories and file names, private keys, Terraform variable files, and `.env` variants except documented example, sample, and template files. The scan fails closed after 200,000 entries, 64 directory levels, or 5 seconds. The same path policy blocks the `read` tool. Symbolic links that resolve outside the project are rejected by `read`; bash cannot reach host paths that were not mounted.

The mask uses known path patterns, not content inspection. A project file with an unrecognized name can still contain sensitive data and remain readable. Add a new pattern and regression test before using the fork in a repository with another credential-file convention.

Bash output is kept to the last 50 KiB. Earlier output is discarded and is not written to a host-side full-output file. `read` rejects files larger than 10 MiB before returning their contents to Pi. Image reads are blocked because Pi's image decoding would otherwise run in the unsandboxed parent process.

## Resource limits

Each command runs in a transient systemd user service with these limits:

- runtime: 60 seconds
- memory: 1 GiB
- swap: disabled
- processes: 128
- CPU quota: 400 percent, equivalent to four fully used cores

Timeout and abort paths stop the transient unit for bash and read operations. systemd gives the command one second to stop, then kills the complete control group. If abort arrives before systemd has registered the transient unit, cleanup retries only the explicit `unit not found` race up to five times at 25-millisecond intervals. Other stop failures are returned immediately. A limit failure is returned as a tool error. There are no command retries or larger-limit fallbacks.

## Network boundary

The sandbox inherits outbound network access. This is an explicit fork policy so inspection commands can use HTTP and HTTPS. The systemd unit blocks link-local addresses, the AWS IPv6 metadata address, and Alibaba Cloud's metadata address. This prevents the common instance-metadata credential paths while retaining ordinary web and loopback access.

The read-only guarantee applies to the host and project filesystem. It does not prevent external side effects. A shell command can still send mutating HTTP requests or reach an unauthenticated local service. The BTW system prompt instructs the model not to perform network mutations, but that instruction is not an enforcement boundary.

## Validation

Run the complete suite:

```bash
npm test
npx tsc --noEmit
```

`tests/read-only-tools.test.ts` executes real Bubblewrap and systemd units. It checks project write rejection, temporary writes, nested secret masking, symlink containment, environment isolation, bounded output and reads, blocked parent-process image decoding, scan limits, read and bash cancellation, timeout, memory enforcement, configured cgroup and network properties, and approved loopback HTTP access.

## Rollback

Switch Pi back to an upstream `pi-btw` release and run `/reload`. This removes the read-only fork policy and restores upstream's `read`, `bash`, `edit`, and `write` BTW tool set. Do not use that rollback when read-only BTW behavior is a security requirement.
