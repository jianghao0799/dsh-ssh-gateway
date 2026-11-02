# dsh-ssh-gateway

English · [简体中文](./README.md)

Use the system OpenSSH client to run DeepSeek Harness workspace file operations and non-interactive Bash on remote Linux projects. Harness, model credentials, session history, skills, memory, and other plugins stay on the local machine. The remote host needs neither DSH nor a model API key.

> Current version: 0.3.2. Requires Node.js 22.19+, DSH 0.2.1-rc.3+, and a local `ssh` executable.

## Features

- Manage multiple SSH targets and remote project roots from the DSH sidebar or settings.
- Register `remote_exec` and `remote_files` only for bound local sessions; existing local tools keep their original meaning.
- Use SSH config, identity files, custom ports, and `ProxyJump`. Strict host-key checking and BatchMode are enabled, while agent forwarding is disabled.
- Read, write, edit, list, glob, grep, and inspect images in remote workspaces.
- Protect mutations with SHA-256 versions, same-directory atomic replacement, and create-if-absent semantics.
- Bound command output, file reads, searches, and media sizes. Cancellation and timeouts stop SSH child processes owned by the plugin.
- Let child agents inherit their parent's SSH binding. Unbinding, disconnecting, or unloading releases scoped tools and resources.
- Optionally install a maintained Better Sidebar build for a remote tree and text/image/PDF/HTML previews.

## Installation

Install the default GitHub branch:

```sh
dsh plugin --profile web add github:jianghao0799/dsh-ssh-gateway
```

Or clone the repository and install the local directory through DSH's plugin manager:

```sh
git clone https://github.com/jianghao0799/dsh-ssh-gateway.git
```

Refresh the DSH Web GUI after installation. If the plugin manager reports `restart-required`, fully quit and reopen DSH; refreshing the page does not restart the Host process.

## Usage

1. Confirm in a system terminal that the target supports non-interactive login, for example `ssh my-cluster`. Verify and accept a new host fingerprint yourself before using the plugin.
2. Open **SSH execution workspaces** in the DSH sidebar or settings.
3. Enter a label, an SSH alias or `user@host`, and an absolute POSIX project path. Empty port and identity-file fields defer to SSH config.
4. Select **Connect and inspect**. The remote host needs Linux, Bash, and Python 3. The helper is sent over SSH stdin and is not installed as a persistent service.
5. Create a local session or bind an existing one. Binding an existing Bot session retains that Bot's identity, memory, and conversation.
6. Use `remote_exec` and `remote_files` in that session.

### Permission model

Remote reads and searches are available in confined sessions. Remote Bash and file mutations require the DSH session to use **Full access**. This plugin does not provide a remote OS sandbox, so local read-only/workspace-write confinement must not be treated as remote isolation.

The plugin never elevates session permissions, automatically replays a failed command or write, or falls back to the local filesystem after an SSH failure. A timeout or connection loss can leave the remote outcome unknown; inspect the real files or processes before retrying a side-effecting operation.

## Tools

| Tool | Behavior |
| --- | --- |
| `remote_exec` | Runs non-interactive Bash in the bound remote Linux project. Every call starts a fresh process; `cd`, variables, and shell state do not persist. Returns exit code, stdout/stderr, timeout, and truncation data. |
| `remote_files` | Provides remote `read`, `write`, `edit`, `list`, `glob`, `grep`, and `read_image`. Relative paths resolve from the bound remote project root. |

Read an existing file first and pass its returned `version` to a mutation. Use `expected_version: "missing"` for a new file. Text files are limited to 4 MiB and images to 10 MiB; other response types are bounded as well.

A local path referenced by a local skill is not executable on the remote host. Explicitly transfer the script text or install the required tool and dependencies remotely.

## State and credentials

Runtime state is stored at `ssh-workspaces/state.json` under DSH home. It contains SSH targets, remote paths, local workspace anchors, and session bindings. It does not contain passwords, private-key contents, or model credentials.

- Authentication is delegated to system OpenSSH and the user's SSH config, agent, or identity file.
- Interactive password prompts are not supported.
- Management HTTP routes reuse DSH same-origin authentication and permit only the owner to manage bindings.
- State files are created with mode 0600 on POSIX; Windows uses the existing directory permissions.

See [SECURITY.md](./SECURITY.md) for vulnerability reporting and deployment guidance.

## Optional remote file sidebar

`sidebar-adapter/` is an MIT-licensed maintained build based on [DSH Better Sidebar 0.28.1](https://github.com/omdsh-dev/DSH-better-sidebar). It adds a session-aware SSH file backend and is not required for `remote_exec` or `remote_files`.

Its package name remains `dsh-better-sidebar`, so it cannot be installed alongside the upstream package. To use it:

1. Clone this repository.
2. Remove the installed `dsh-better-sidebar` in DSH's plugin manager.
3. Install the local `sidebar-adapter/` directory.
4. Refresh the GUI, or fully restart DSH if the Host requests it.

The adapter currently provides read-only remote browsing and previews. Save, upload, rename, delete, Git, and archive actions return explicit unsupported errors; use `remote_files` or `remote_exec` for remote mutations. HTML and SVG previews are sandboxed so remote content cannot acquire the GUI's same-origin privileges.

See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) and `sidebar-adapter/LICENSE` for provenance and licensing.

## Development and validation

```sh
npm run build
npm run check
npm test
npm run test:python
npm pack --dry-run
```

A few Linux Bash/process-group or symlink-privilege checks are skipped on Windows. The remaining tests cover persisted-field filtering, SSH argument allowlisting, version-guarded file mutations, protocol isolation, permission denial, cancellation and timeouts, inherited bindings, atomic persistence, HTTP authentication, remote sidebar reads, and plugin cleanup.

Real SSH acceptance is intentionally excluded from CI. Use a target you are authorized to test:

```sh
# PowerShell
$env:SSH_TARGET = "my-cluster"
$env:SSH_REMOTE_PATH = "/home/me/project"
node scripts/probe-ssh.mjs
node scripts/verify-ssh.mjs
```

Optional variables are `SSH_PYTHON`, `SSH_PORT`, and `SSH_IDENTITY_FILE`. `verify-ssh.mjs` creates an owned directory under remote `/tmp`, tests create/read/edit/search/timeout/cancellation behavior, and removes the directory in its cleanup path.

## Known limitations

- Remote hosts must provide Linux, Bash, Python 3, and OpenSSH access.
- There is no interactive PTY, SSHFS mount, or remote OS sandbox.
- Each operation uses an independent short SSH connection; shell state is not retained.
- Third-party plugins that call local `node:fs` or native process APIs continue to operate locally and need their own remote adaptation.
- The optional sidebar adapter is read-only and pinned to Better Sidebar 0.28.1.

## License

This project is released under the [MIT License](./LICENSE). The optional Better Sidebar derivative retains its MIT license and upstream attribution.
