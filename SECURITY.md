# Security policy

## Reporting a vulnerability

Please do not open a public issue for a vulnerability that could expose local
credentials, DSH session data, private remote files, or arbitrary command
execution. Use GitHub's private vulnerability reporting for this repository.
Include the affected version, host operating system, DSH version, reproduction
steps, and the security boundary you expected.

Do not include real private keys, access tokens, SSH config contents, sensitive
remote paths, or session logs in a report. Replace them with minimal synthetic
examples.

## Security model

`dsh-ssh-gateway` deliberately executes commands and file operations with the
permissions of the configured remote SSH account. It is not a remote sandbox.
Remote Bash and file mutations require the DSH session to be in Full access.
Operators should use a dedicated, least-privileged SSH account when possible.

The plugin:

- invokes the system `ssh` executable without a shell;
- enables BatchMode and strict host-key checking;
- disables SSH agent forwarding;
- sends a bounded helper over stdin instead of installing a remote daemon;
- stores target metadata but not passwords, private-key contents, or model keys;
- authenticates its local management routes through the DSH owner connection;
- does not automatically retry operations with side effects.

A configured identity-file path and the user's SSH config remain sensitive local
metadata. Keep the DSH home directory and the host account protected.

## Supported versions

Security fixes are applied to the current default branch and the newest release.
Older snapshots are not guaranteed to receive backports.
