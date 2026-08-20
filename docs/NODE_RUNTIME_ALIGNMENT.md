# Node runtime alignment

The Career Dashboard supports one Node major: Node 24 LTS. The repository root
`.nvmrc` is the canonical declaration consumed by developers and GitHub
Actions. `package.json` expresses the same supported range for package tooling.

## Enforcement boundaries

- Local and GitHub-initiated deployments run
  `scripts/deployment/require-node-version.sh` before any Node-based deployment
  preparation.
- The staged Raspberry Pi release repeats that check against the Pi's resolved
  Node binary before dependency reuse, `npm ci`, Prisma generation, or the
  production build.
- Dependency reuse remains keyed to both the lockfile hash and the complete
  `node --version` output. A Node upgrade therefore forces a fresh `npm ci`
  even when `package-lock.json` is unchanged.
- The managed cron installer resolves `node` and `npm` once, validates the Node
  major, and writes the resolved absolute paths into the installed schedule.

## Pi operator shell

The `j85473` account loads nvm from `~/.bashrc`. Its nvm default alias must also
point to Node 24; otherwise an interactive login can shadow the aligned
`/usr/bin/node` with an older user-scoped runtime. This home-directory setting
is not deployed from Git. After a Pi Node change, verify both views:

```bash
node --version
/usr/bin/node --version
nvm current
nvm alias default
```

## Systemd boundary

`career-dashboard.service` is installed and owned on the Pi; this repository
does not rewrite its `ExecStart`. The deployment helpers inspect the unit to
resolve its service URL and verify its user and working directory. Before any
future service-unit or Node installation change, verify the live interpreter
path with:

```bash
systemctl show career-dashboard.service --property=ExecStart --value
command -v node
node --version
```

The expected application runtime is Node 24. A different major must be repaired
before the next deployment rather than bypassing the repository check.
