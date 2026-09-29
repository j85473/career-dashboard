# Node runtime alignment

Checked against the repository on September 29, 2026. Career Dashboard targets **Node 24**. The root `.nvmrc` declares that major, and `package.json` limits the supported engine range to Node 24.

| Environment | Runtime selection |
| --- | --- |
| Local development | `nvm install && nvm use` reads `.nvmrc`; confirm with `node --version` before `npm ci`. |
| GitHub deployment workflow | `actions/setup-node` reads `.nvmrc` before install, tests, and build. |
| M70 release build | The activation script runs the M70's installed Node and npm while building the staged release. |
| M70 services | The checked-in systemd units execute `/usr/local/bin/node` directly; the scheduler launches the npm script through that runtime. |

The repository also contains `scripts/deployment/require-node-version.sh`, a reusable explicit version check with unit coverage. The current M70 deployment workflow does **not** call that helper, so do not describe it as a deployment gate. If runtime drift is suspected, check the actual interpreter used by the M70 units and the staged build before the next release:

```bash
ssh m70 'node --version; /usr/local/bin/node --version; systemctl show career-dashboard.service --property=ExecStart --value'
```

The [M70 operations guide](M70_PRODUCTION_OPERATIONS.md) covers service and release behavior. The Raspberry Pi deployment and its old cron installer are retired; their historical runtime notes are not current setup instructions.
