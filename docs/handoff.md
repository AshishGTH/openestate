# Handoff — current operational state

Living doc, not append-only (unlike CLAUDE.md's Decisions log). Keep this
updated with whatever a new session needs to pick up work immediately;
prune stale facts rather than layering history on top of them. For *why*
a decision was made, see CLAUDE.md's Decisions log — this file is only
*what's true right now*.

## Verification VMs

IPs on this project drift session to session — always confirm current
before trusting this table, but as of 2026-08-18:

| Box | IP | User | Password | Role |
|---|---|---|---|---|
| Upgraded / walkthrough | 192.168.1.21 | `newopen` | `open@123` | Long-lived, carries real demo data + upgrade history — currently on v0.3.1 |

Only one box is currently known-reachable — the previous two-box table
(192.168.0.117/118) went fully unreachable (not just those hosts —
the entire 192.168.0.0/24 subnet, including the gateway, was
unroutable from the dev machine) before this address was given. If a
second (fresh-install) box reappears, add it back as its own row
rather than overwriting this one.

Reachable with the existing key, no password needed:
`ssh -i ~/.ssh/openestate_vm <user>@<ip>`. This box's key install
needed `plink` (PuTTY), not `ssh-copy-id`/piped-password `ssh` — the
OpenSSH client does not read a password from a pipe for its own auth
prompt (unlike sudo's prompt, which does read from the pty). Pattern
that worked:
```bash
plink -ssh -batch -hostkey "<fingerprint from the first connection attempt>" -pw '<password>' <user>@<ip> "mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '<pubkey contents>' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
```
If a genuinely new box shows up without `plink` available, `sshpass`
(if installable) or a Python/paramiko one-liner are the fallbacks —
plain `ssh`/`ssh-copy-id` with a piped password will hang or fail.

**sudo needs a real pty.** `deploy/native/upgrade-native.sh`
(and any other script using `sudo`) must be invoked via `ssh -tt`, with
the password piped in enough times to cover the outer `sudo` prompt plus
every nested `sudo -u postgres` call `run_as_superuser()` makes (2 in
`upgrade-native.sh`, so pipe the password ~4-5 times to be safe) — e.g.:

```bash
printf 'open@123\nopen@123\nopen@123\nopen@123\nopen@123\n' | ssh -tt -i ~/.ssh/openestate_vm newopen@192.168.1.21 "cd /opt/openestate-src/deploy/native && sudo ./upgrade-native.sh"
```

Without `-tt`, the nested `sudo -u postgres` call hangs indefinitely
instead of failing fast — this is the "sudo-rs nested-sudo hang"
documented in CLAUDE.md's native-install entries (this box uses `sudo-rs`,
the Rust sudo rewrite, not classic sudo). A plain `sudo -S` (piped
password, no pty) works for the OUTER sudo call only; it does not help
the inner ones.

The source checkout lives at `/opt/openestate-src`
(`git remote` → `https://github.com/AshishGTH/openestate.git`),
**root-owned** (from the documented `sudo git clone`) — `git pull` as
the regular SSH user fails with `Permission denied` on `.git/FETCH_HEAD`.
Pull as root instead: `sudo git pull origin master` (needs the same
`ssh -tt` + piped-password treatment as any other sudo call here).
`upgrade-native.sh` builds and deploys FROM that checkout; it does not
pull for you — do this first.

Native-install layout: deployed release symlink at
`/opt/openestate/current` → `/opt/openestate/releases/<timestamp>-<sha>`;
env file at `/etc/openestate/openestate.env`; nginx serves the built
frontends. Health: `curl -s http://localhost/api/v1/health`.

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
- Demo admin on the walkthrough box (192.168.1.21):
  `admin@demo-realty.com` / `ClickThrough#Verify1` (password was reset
  during a prior session's verification pass — the original generated
  password is not recoverable).
