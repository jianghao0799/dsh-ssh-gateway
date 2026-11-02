# Third-party notices

## Better Sidebar SSH adapter

The optional `sidebar-adapter/` directory is a modified build of
[DSH Better Sidebar](https://github.com/omdsh-dev/DSH-better-sidebar), based on
version 0.28.1. It adds a session-aware SSH file backend used by this project.

The upstream project and this derivative are distributed under the MIT
License. The adapter retains its own `LICENSE` file and upstream attribution.
The adapter package is optional: the SSH gateway and the `remote_exec` /
`remote_files` tools work without it.
