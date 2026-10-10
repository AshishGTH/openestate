# Handoff — current operational state

Living doc, not append-only (unlike CLAUDE.md's Decisions log). Keep it updated
with whatever a new session needs to pick up work immediately; prune stale facts
rather than layering history on top of them. For *why* a decision was made, see
CLAUDE.md's Decisions log; this file is only *what's true right now*.

**Last updated: 2026-10-10, after the v0.8.3 release.**

## Where things stand

- **v0.8.3 is released.** Master is `1f48533`, tag `v0.8.3` (annotated), GitHub
  release `v0.8.3`, all five CI jobs green on that commit. Advisory
  [GHSA-gq5m-m6q6-x32p](https://github.com/AshishGTH/openestate/security/advisories/GHSA-gq5m-m6q6-x32p)
  (Low, affected <= 0.8.2, patched 0.8.3) was published 2026-10-10 03:50 UTC.
  **The CVE number is still pending**; re-request it from the advisory page if
  none is assigned by about 2026-10-17.
- v0.8.3 contains: the portal document fix (broker sessions fetch only their own
  commission statements; customers only the document types their portal lists),
  sessions that end at once when a user stops being authorised, the refusal of
  tokens with no surface claim, UTC audit timestamps, and the upgrade-script
  fetch fix. See `CHANGELOG.md` and CLAUDE.md's "0.8.3" entry.
- **Next work is v0.8.4** (plan: `docs/testing/v0.8.3-plan.md`, the v0.8.4
  parts): **A** (restore the 71 foreign keys), **B** (constraint manifest and CI
  guard), **G** (harden the append-only escape hatch), **I** (safe system-role
  permission sync), **M** (the API listens on every interface), **N** (upgrade
  script downgrade guard), **O** (CI upgrade from the previous release tag), plus
  the small item **P** ("Failed to create bin" warnings). **A and G touch the
  frozen financial core and need the owner's explicit approval before any work
  starts.**

## The verification VM

One box is in use: `192.168.1.20`, user `textopen`, Ubuntu 24.04, reached from the
dev machine with the key already installed (`ssh openestate-vm`, no password).
IPs on this project drift, so confirm it before trusting it. Credentials are kept
outside this repo; ask a maintainer. Never put a real credential value in this
file or any tracked file.

- **`sudo` needs the owner.** `textopen` has no passwordless sudo. For a rehearsal
  the owner adds a temporary rule, `/etc/sudoers.d/90-uiaudit-temp` (NOPASSWD),
  typing their password in their own terminal, and it is removed at the end of the
  session. It must never be left in place or baked into a snapshot meant as a
  clean base.
- **Source checkout:** `/opt/openestate-src`. **Releases:**
  `/opt/openestate/releases/<timestamp>-<sha>`, with `/opt/openestate/current`
  pointing at the live one. **Health:** `curl -s http://127.0.0.1:3000/api/v1/health`.
- **Rehearsal material** on the VM: `~/uiaudit/` (scripts and logs). On the dev
  machine, outside the repo: `C:\Users\Ashis\.openestate-private\`.
- **Mobile-app staging also lives on this VM** (set up by another session on
  2026-10-07): HTTPS on port 443 with a self-signed certificate (expires
  2026-11-06), a `cloudflared` service that currently cannot connect, and
  `~/oe-staging` plus `/opt/openestate-released`. It is present in the
  `staging-2026-10-09` snapshot, not in `v0.8.3-clean`.

### Snapshots (VMware, tree as `vmrun listSnapshots` shows it)

```
Snapshot 1                        2026-09-08 23:02 IST  original install
  Snapshot 2                      2026-10-02 22:47 IST
    pre-P7                        2026-10-07 14:54 IST  genuine v0.8.2: build ...d337a736,
                                                         35 migrations, plain HTTP,
                                                         sudo rule present
      pre-v0.8.3                  2026-10-09 07:05 IST  NOT clean: the VM had been moved onto
                                                         a release-candidate branch
        staging-2026-10-09        2026-10-09 18:58 IST  the VM as the owner works with it:
                                                         mobile staging setup, HTTPS, the
                                                         portal-fix rehearsal build
      v0.8.3-clean                2026-10-10 09:37 IST  v0.8.3 from the public tag: release
                                                         ...1f485336, 37 migrations, plain
                                                         HTTP, no sudo rule
```

The VM is currently restored to **`staging-2026-10-09`**.

**`v0.8.3-clean` is the new clean base** for the v0.8.4 rehearsal (the previous
release is now v0.8.3). Before trusting any snapshot as a base, check the active
build, the git tag and the migration count (`SELECT count(*) FROM
_prisma_migrations`); never assume.

### Using the VM for tests

- **Check the clock first after any revert or resume**, before anything
  time-dependent (2FA codes, reset links, session expiry). `date` against a trusted
  clock is enough; do not trust `timedatectl`'s "synchronized" line. A restored
  snapshot can be anything from seconds to almost three days behind.
- **Use Incognito windows for browser checks.** The ordinary Chrome profile keeps
  Secure-only cookies and cached HTTPS redirects from the staging setup, which
  break plain-HTTP sign-ins. One Incognito window can hold one staff and one portal
  session; two staff accounts need two separate browsers.
- **Security checks need a control** that must succeed in the same window.
  Address-bar URLs do not carry the portal sign-in, so use a script in the
  signed-in window.
- **Upgrade with a release tag, never a branch name**, and for a rehearsal use the
  VM's *existing* `upgrade-native.sh` so the previous release's own script is
  exercised.
- The built-in browser pane of the desktop coding app is a separate browser with
  its own cookies; it can hold a second staff session next to Incognito.
- `psql` over an interactive session paginates; use `psql -P pager=off`.

## Dev machine (Windows)

- Test infrastructure is Docker only: containers `parts-postgres-1` and
  `parts-redis-1` (Postgres 16 and Redis 7, ports 5432 and 6379), provisioned by
  `scripts/test-setup.sh` (it needs a `psql` client; none is installed here, so a
  small stand-in that forwards to the container was used). They and Docker Desktop
  are still running after the v0.8.3 release and can be stopped.
- The private fork used for the portal fix was removed by GitHub when the
  advisory was published. `openestate-partS` is a leftover local clone of it
  (its `origin` no longer exists) and can be deleted.
- A PostgreSQL 17 and a Redis-on-Windows install were made by mistake earlier; the
  services are stopped and disabled and can be uninstalled.

## Open owner items

1. **CVE for GHSA-gq5m-m6q6-x32p** is pending (re-request by about 2026-10-17).
2. **v0.8.4 approvals:** Parts A and G (frozen core) need explicit approval.
3. **The restored staging VM's clock is still hours behind.** Fix:
   `ssh -t openestate-vm "sudo systemctl restart systemd-timesyncd && sleep 5 && date"`
   (not yet verified to work; a VM restart fixed it once).
4. **The Cloudflare tunnel token on the VM** (installed 2026-10-02) was typed on a
   command line, so it appears in the VM's auth log and shell history. Rotate it in
   the Cloudflare dashboard. The tunnel has no
   ingress rules and cannot connect from this network, and no request came through
   it in the logs checked on 2026-10-09 and -10.
5. **The API listens on `0.0.0.0:3000`** on every install (Part M in the plan); until
   it ships, advise operators to firewall port 3000.
6. **The mobile-app staging self-signed certificate expires 2026-11-06.**
7. **Old test data** remains on the VM (`UIAUDIT` users, projects, bookings and the
   backups under `/var/backups/openestate/`); nothing is a secret and none of it is
   needed again.
8. An older walkthrough box at `192.168.1.100` (user `newopen`, v0.4.0 as of
   2026-08-29) was not used in this release cycle; its state is unverified.
