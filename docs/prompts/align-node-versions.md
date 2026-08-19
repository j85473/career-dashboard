# One Node version, anchored at 22

Supersedes the earlier "pin CI down to 20" version of this prompt. Homebridge is
dormant and the NAS bridge is Samba/NFS, not Node, so upgrading the Pi is the
better direction — and it is what the prebuilt-artifact work will need anyway.

## The problem

| where | version | runs |
| --- | --- | --- |
| GitHub Actions runtime | 20 → 24 (GitHub's own) | action code only — not ours |
| CI (`node-version: '22'`) | 22 | `npm ci`, `npm test`, `npm run build` — the deploy gate |
| The Raspberry Pi | **v20.20.2** | the application, in production |

The deploy gate runs on a runtime production does not use. `package.json`
declares `"node": ">=20.19.0 <27.0.0"`, wide enough that both pass and the drift
never surfaces.

## Measured environment

- Pi Node is **NodeSource apt**: `nodejs 20.20.2-1nodesource1`, `/usr/bin/node`.
- **`/home/j85473/.nvm` also exists**, so a second Node may shadow the system one
  depending on how a shell is invoked. Any systemd unit or cron entry should use
  an absolute interpreter path, not bare `node`.
- Running services that use Node: `career-dashboard.service` and
  `homebridge.service`. Nothing else — `smbd`/`nmbd`/`nfs-blkmap` are C daemons.
- Debian 13 (trixie), aarch64, PostgreSQL 17.

## Split of work

**Joseph does the Pi upgrade by hand** (you have no ssh access, and must not
attempt it):

```
sudo apt-get install -y ca-certificates curl gnupg
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v && npm -v
systemctl status career-dashboard.service homebridge.service --no-pager
```

**You do the repo side:**

1. Add `.nvmrc` containing `22` (or the exact version Joseph lands on — ask him
   to report `node -v` after the upgrade and use that).
2. In `.github/workflows/deploy.yml`, replace `node-version: '22'` with
   `node-version-file: '.nvmrc'`, so the version is declared in exactly one
   place and cannot drift again.
3. Narrow `engines.node` in `package.json` to the supported line
   (e.g. `>=22.0.0 <23.0.0`) so an accidental mismatch fails loudly.
4. Bump `actions/checkout` and `actions/setup-node` to their current majors —
   the real answer to GitHub's Node 20 deprecation notice.
5. Check whether `career-dashboard.service` or any installed crontab invokes a
   bare `node`/`npm`. Given `~/.nvm` exists, a bare invocation can resolve to a
   different Node than the one just installed. If
   `scripts/deployment/install-crontab-remote.sh` or the service unit does this,
   note it clearly for Joseph — do not silently rewrite deployment plumbing you
   cannot test.

## The one thing that must not happen

`node_modules` on the Pi was installed under Node 20. Any ABI-bound native
module will fail under 22. The reuse path added in the previous change keys on
`sha256(package-lock.json) + node --version`, so the version change invalidates
it and forces a full `npm ci` — **verify that this is what actually happens on
the first deploy after the upgrade** rather than assuming it. If the fingerprint
comparison somehow passes, the Pi will run Node 22 against Node 20 binaries.

## Constraints

- `.github/workflows/deploy.yml` is read by `deploymentCron.test.ts` and
  `rapidApiKeySync.test.ts` — source-text contract tests matching literal
  strings. Check them before editing.
- Gates: `npm test` (baseline **603 pass, 0 fail**), `npm run build`,
  `bash -n scripts/deploy.sh`.
- `git commit -am` does not stage new files. Use `git add -A`.
- **Do not `git push`**, run `ssh`, or touch the Pi.

## Definition of done

- One declared Node version consumed by CI from `.nvmrc`.
- `engines.node` narrowed; actions bumped.
- A written note on whether any deployment plumbing invokes a bare `node`.
- Gates green, commit local, not pushed.
