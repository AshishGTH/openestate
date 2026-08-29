# Handoff — current operational state

Living doc, not append-only (unlike CLAUDE.md's Decisions log). Keep this
updated with whatever a new session needs to pick up work immediately;
prune stale facts rather than layering history on top of them. For *why*
a decision was made, see CLAUDE.md's Decisions log — this file is only
*what's true right now*.

## Verification VMs

IPs on this project drift session to session — always confirm current
before trusting this table, but as of 2026-08-29:

**Only one VM is currently live.** The previous second box (fresh-install,
last seen at `10.50.132.78`) and an earlier walkthrough-box address
(`192.168.1.21`, from before it moved to the IP below) have both been
destroyed by the user and are gone for good — do not attempt to reach
them, and do not carry their addresses forward into future notes.

| Box | IP | User | Role |
|---|---|---|---|
| Upgraded / walkthrough | 192.168.1.100 | `newopen` | Long-lived, carries real demo data + upgrade history. Password-auth only via plink (no working key for this session) — see the credentials note below for where the password lives. Currently v0.4.0, health endpoint reconfirmed live (`{"status":"ok","db":"ok","redis":"ok","version":"0.4.0"}`) on 2026-08-29. |

**VM credentials (SSH login password, demo-admin app password) are kept
outside this repo — ask a maintainer for the current values rather than
expecting them here.** This table used to carry a plaintext SSH password
and a later section carried a plaintext demo-admin password; both were
already public (this repo is public) by the time that was noticed. Both
have since been rotated and removed from this file. Do not reintroduce a
real credential value into this file, or any other tracked file, going
forward — a placeholder like `<password>` (already used in the plink
example below) is correct; a real value is not, even for a low-stakes
demo/test box.

Only one box is currently known-reachable. The previous 192.168.0.0/24
pair (192.168.0.117/118) went fully unreachable before this address was
given, and the two boxes named above (10.50.132.78, and 192.168.1.21
from before this box's IP changed) have since been destroyed outright.
If a second (fresh-install) box reappears, add it back as its own row
rather than overwriting this one.

No SSH key is installed on 192.168.1.100 — it is password-auth only via
`plink` (see the credentials note above for where the password lives).
The OpenSSH client does not read a password from a pipe for its own
auth prompt (unlike sudo's prompt, which does read from the pty), so a
genuinely new box needs `plink`, not `ssh-copy-id`/piped-password `ssh`,
to install a key:
```bash
plink -ssh -batch -hostkey "<fingerprint from the first connection attempt>" -pw '<password>' <user>@<ip> "mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '<pubkey contents>' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
```
If a genuinely new box shows up without `plink` available, `sshpass`
(if installable) or a Python/paramiko one-liner are the fallbacks —
plain `ssh`/`ssh-copy-id` with a piped password will hang or fail.

**sudo needs a real pty.** `deploy/native/upgrade-native.sh`
(and any other script using `sudo`) must be invoked with a pty allocated
(`plink -t` / `ssh -tt`), with the password piped in enough times to
cover the outer `sudo` prompt plus every nested `sudo -u postgres` call
`run_as_superuser()` makes (2 in `upgrade-native.sh`, so pipe the
password ~4-5 times to be safe) — e.g., confirmed working against
192.168.1.100 on 2026-08-29:

```bash
printf '<password>\n<password>\n<password>\n<password>\n<password>\n' | plink -ssh -t -hostkey "SHA256:c4scFWfwogyn6lSHSvVAClCA6jXGD0ZEh4x04SGi6tw" -pw '<password>' newopen@192.168.1.100 "cd /opt/openestate-src/deploy/native && sudo -S ./upgrade-native.sh"
```

Without a pty, the nested `sudo -u postgres` call hangs indefinitely
instead of failing fast — this is the "sudo-rs nested-sudo hang"
documented in CLAUDE.md's native-install entries (this box uses `sudo-rs`,
the Rust sudo rewrite, not classic sudo). A plain `sudo -S` (piped
password, no pty) works for the OUTER sudo call only; it does not help
the inner ones. Also confirmed this session: `psql` invoked over the
same pty session paginates its output and hangs waiting for a keypress
unless `PAGER=cat` and/or `psql -P pager=off` is set explicitly — add
both defensively for any ad hoc query run this way.

The source checkout lives at `/opt/openestate-src`
(`git remote` → `https://github.com/AshishGTH/openestate.git`).
**Now owned by `newopen`, not root** — was root-owned from the original
`sudo git clone` (making `git pull` as the regular SSH user fail with
`Permission denied` on `.git/FETCH_HEAD`, and `pnpm install`/`pnpm build`
as `newopen` fail with EACCES against root-owned `node_modules`/`dist`
build artifacts from earlier root-run production builds), `chown -R
newopen:newopen /opt/openestate-src` was run during the `scripts/
test-setup.sh` verification session (2026-08-23, see CLAUDE.md's
decisions log entry for that session) specifically because that
verification needed a normal, unprivileged `pnpm install`/`build`/`prisma
generate` to work the way a real contributor's checkout would — plain
`git pull`, `pnpm build`, etc. now work as `newopen`, no `sudo` needed for
any of that. **`upgrade-native.sh` itself still needs `sudo`** (it writes
to `/opt/openestate/releases`, `/etc/openestate`, and calls `systemctl` —
none of that changed) — only the SOURCE checkout's own ownership changed.
As of the same session: uncommitted, at `d118d89` (working tree carries
~100+ changed paths — Docker removal plus lead-stage-foundation work —
none of it pushed to origin, this is the SAME uncommitted state as the
Windows dev machine this session ran from, synced over via `pscp`, not a
`git pull`). `upgrade-native.sh` builds and deploys FROM that checkout; it
does not pull for you.

Native-install layout: deployed release symlink at
`/opt/openestate/current` → `/opt/openestate/releases/<timestamp>-<sha>`;
env file at `/etc/openestate/openestate.env`; nginx serves the built
frontends. Health: `curl -s http://localhost/api/v1/health`.

**192.168.1.100's system clock is ~4 days behind and NTP sync is failing**
(`timedatectl` reports `System clock synchronized: no`; confirmed by
`date` reading several days earlier than the box's own RTC/hardware
clock). Found 2026-08-23, not fixed — `hwclock --hctosys` / `timedatectl
set-ntp` are system-settings changes Claude sessions are not permitted to
make; this needs a human (or `sudo timedatectl set-ntp true` re-run once
whatever's blocking outbound NTP is fixed — unconfirmed whether that's a
firewall rule, a stopped `chronyd`/`systemd-timesyncd`, or something
else). **Concrete effect**: any TLS handshake to a server whose
certificate's "not before" date is more recent than the drifted clock
fails with `CERT_NOT_YET_VALID` — hit corepack's `registry.npmjs.org`
fetch this way (worked around: root's already-cached corepack pnpm build
copied to `newopen`'s cache); `cdn.playwright.dev` was unaffected (its
cert chain tolerated the drift). Two CPU cores total, and the live
production `openestate-api` service runs concurrently with anything else
on this box — full `pnpm test` runs here hit real resource-contention
timeouts that don't reproduce on a better-provisioned machine or in
isolated per-file runs; see CLAUDE.md's `scripts/test-setup.sh`
verification entry (2026-08-23) for the full read on which failures are
contention vs. real bugs, before assuming a full-suite red run here means
a regression.

Browser automation against these VMs: the Browser pane's per-site
approval gate has repeatedly blocked real-browser checks here across
sessions — use the `claude-in-chrome` MCP tools instead (real Chrome,
same approval model but has worked reliably). Native `confirm()` dialogs
in the staff/portal apps (e.g. Masters' Delete button) hang the CDP
connection — don't click through them; call the DELETE endpoint directly
via `node -e "fetch(...)"` on the VM instead (same pattern used
throughout this project's history for curl-less verification, since
these boxes don't have curl installed either).

## Repo / release state

- GitHub: `https://github.com/AshishGTH/openestate` (public).
- Latest tagged release: check `git tag --sort=-v:refname | head -1`
  before assuming — this file is not guaranteed current on version
  number, only on infra facts above.
- Demo admin on the walkthrough box (192.168.1.21): `admin@demo-realty.com`,
  password kept outside this repo (see the credentials note above) — it
  has been reset twice now (once mid-item-7, once during this cleanup)
  because the previously-documented value kept ending up in git history.
  If it's ever lost, `deploy/native/reset-admin-password.sh` recovers it
  without needing the old value.
