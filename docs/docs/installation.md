---
id: installation
title: Installation Guide & SOP
sidebar_position: 1
---

# OpenEstate — Installation Guide & Standard Operating Procedure

This guide covers installing OpenEstate on a fresh Linux server, first-time
setup, day-to-day administration, backups, upgrades, and troubleshooting.
Written for a company IT admin or the founder setting this up themselves —
no coding knowledge required for installation, only comfort with a terminal.

OpenEstate installs **natively**: a systemd service talking to a
PostgreSQL and Redis you already run, static files served by nginx. There
is no bundled database container and no Docker involved in production —
you control Postgres/Redis the same way you'd run any other service on
this box, with your own backup tooling, monitoring, and upgrade cadence
for them. (Docker Compose still exists in the repo, but only as a
contributor tool for running the automated test suite — see
`CONTRIBUTING.md`.)

---

## 1. What you're installing

OpenEstate is a self-hosted, open-source real-estate CRM covering pre-sales
(lead management), post-sales (bookings, payment schedules, receipts, GST/TDS,
broker commissions), a customer portal, and a broker portal. It runs entirely
on your own server — no data leaves your infrastructure unless you configure
an integration.

---

## 2. Before you start — requirements

**Server:**
- Ubuntu 22.04 LTS or 24.04 LTS. Other systemd-based distros likely work
  but aren't tested — the install script assumes `apt`-family package
  names in its error messages.
- **Tested platforms**: Ubuntu 24.04 LTS with PostgreSQL 16, and Ubuntu
  25.10 with PostgreSQL 17 — both verified end-to-end (fresh install,
  real HTTP login, upgrade/rollback, backup/restore, uninstall) on a
  real VM. The scripts only check that a `psql` client is present,
  never an exact major version, so newer Ubuntu releases that ship a
  newer default PostgreSQL (25.10 ships 17, not 16) work without any
  script changes — `sudo apt-get install -y postgresql` is enough; only
  pin `postgresql-16` specifically if you need that exact major version.
  A later session additionally verified `upgrade-native.sh` fresh
  end-to-end on that same 24.04 VM (first real exercise of that script),
  plus full application-level flows (2FA/TOTP enrollment and recovery
  codes, broker NOC → cancel → commission clawback → statement PDF) —
  none of these are install-script concerns, but they confirm the
  deployed app itself is sound on 24.04, not just the installer.
  **Known gap**: this VM-based verification is the reason 24.04/PG16
  support is documented as tested at all; a `native-install` CI job
  (`.github/workflows/ci.yml`) runs the same install on a real
  `ubuntu-latest` GitHub-hosted runner on every push as the *ongoing*
  automated guarantee, but as of this writing that job is red — the
  deployed API crash-loops (SIGSEGV, `status=11/SEGV` in `journalctl`)
  specifically on that hosted-runner class, isolated to argon2's native
  module (`require('argon2').hash()` crashes identically outside the
  app entirely) and confirmed *not* reproducible on the VM. Four
  specific causes were tested and ruled out, each with a real coredump/
  exit-code comparison, not by inference: a bad prebuilt binary
  (forcing a from-source rebuild crashes identically), a threading bug
  in argon2's default 4-way parallelism (`parallelism:1` crashes
  identically), Node.js itself (a completely bare `node -e` runs
  clean), and a version-specific regression (0.45.0 → 0.45.1 crashes
  identically). The actual cause is still unknown — a coredump
  backtrace pointed at a generic Node/libuv semaphore-wait frame, which
  didn't point at argon2's own code and didn't survive being ruled out
  above either. Next step for whoever picks this up: try a different
  Node major version (22 LTS) for the native-install path, or file this
  exact backtrace upstream. Until that job is green, treat
  ubuntu-latest specifically (as opposed to Ubuntu 24.04 in general) as
  unverified; a real VM/server install is not known to be affected.
- Architecture: x86_64 (amd64). ARM is not yet officially supported.
- Minimum: 2 vCPU, 4 GB RAM, 40 GB disk. Recommended for a real company:
  4 vCPU, 8 GB RAM, 80 GB+ disk (grows with document/receipt volume).
- Root or sudo access.
- Open ports: 80/443 (if using a domain + HTTPS) or whatever port you
  choose for direct access.

**Software you install yourself, before running the installer** — the
installer verifies each of these and tells you exactly what to run if one
is missing or the wrong version, but it never installs them for you. That
split is deliberate: your database and cache are infrastructure you
already manage (backups, monitoring, tuning, security patching) — this
project isn't going to quietly take that over.

```bash
# PostgreSQL 16
sudo apt-get install -y postgresql-16 postgresql-client-16
sudo systemctl enable --now postgresql

# Redis
sudo apt-get install -y redis-server
sudo systemctl enable --now redis-server

# Node.js 20 (via NodeSource — Ubuntu's own repo ships an older version)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# nginx, git, openssl
sudo apt-get install -y nginx git openssl
```

**Recommended (for a real deployment, not a demo):**
- A domain name pointed at the server, with TLS via `certbot --nginx`
  (run after `install-native.sh`, against the site config it installs at
  `/etc/nginx/sites-available/openestate`) or another TLS-terminating
  proxy in front. The installer itself does not configure TLS.
- An outbound SMTP account and an SMS provider account (MSG91/Textlocal or
  similar) for notifications — optional at install time, configurable later.

---

## 3. Quick install

SSH into your server as a user with sudo access, install the prerequisites
above, then clone the repository and run the installer from inside it:

```bash
git clone https://github.com/AshishGTH/openestate.git /opt/openestate-src
cd /opt/openestate-src/deploy/native
sudo ./install-native.sh --server-name crm.yourcompany.com
```

(Omit `--server-name` for an IP-only install — nginx will listen on any
hostname. You can change it later by re-running with the flag, or editing
`/etc/nginx/sites-available/openestate` and `CORS_ALLOWLIST` in
`/etc/openestate/openestate.env` directly.)

The script verifies prerequisites, then:
1. Creates the `openestate` system user (no login shell) and the standard
   directories (`/opt/openestate`, `/etc/openestate`, `/var/log/openestate`,
   `/var/lib/openestate/uploads`).
2. Generates `/etc/openestate/openestate.env` (if it doesn't already
   exist) with cryptographically random secrets — database passwords, JWT
   signing keys, PAN/TOTP/plugin encryption keys. If the file already
   exists, the script leaves it alone (delete it first for fresh secrets).
3. Creates the `openestate` database and the `openestate_app`/
   `openestate_system` Postgres roles (`setup-database.sh` — safe to
   re-run, and runnable standalone if your DBA manages Postgres
   separately; see `--skip-database`).
4. Builds the application from source (`pnpm install && pnpm build`, then
   the same deploy sequence the retired Docker image used) into a new
   versioned release under `/opt/openestate/releases/`, symlinked as
   `/opt/openestate/current`.
5. Runs database migrations and seeds the default masters (Indian tax
   defaults, standard roles, sample charge types).
6. Installs and starts the `openestate-api` systemd service and the nginx
   site config.
7. Prints a **randomly generated initial admin password** — shown exactly
   once, for the fixed seeded login `admin@demo-realty.com`. Copy it
   immediately; it's also visible afterward via
   `journalctl -u openestate-api` if you scroll back far enough, but isn't
   stored in plaintext anywhere. See §8 if you lose it.

Total time: 5–15 minutes depending on server speed (most of it is the
first `pnpm install`/build).

> **If this is your first time on the internet with this server:** don't
> skip putting a firewall in front of it. At minimum, `ufw allow 22,80,443/tcp`
> and `ufw enable` before you finish setup, or use your cloud provider's
> security-group equivalent.

---

## 4. First login and initial setup SOP

1. Open the URL you configured (e.g. `https://crm.yourcompany.com` or
   `http://your-server-ip/`).
2. Log in with `admin@demo-realty.com` (the fixed seeded login) and the
   printed password. You can create additional admin accounts with a real
   email afterward via Settings → Users.
3. **You will be forced to change your password immediately** — this is
   enforced, not optional.
4. **Enable two-factor authentication (TOTP)** on the admin account — go to
   Profile → Security → Enable 2FA, scan the QR code with an authenticator
   app (Google Authenticator, Authy, etc.), and save the recovery codes
   somewhere safe (a password manager, not a sticky note).
5. **Set up company details**: Settings → Company Profile — legal name,
   GSTIN, GST state code, RERA registration details, logo, brand color
   (used on customer/broker-facing PDFs and portals).
6. **Review the seeded masters** (Settings → Masters): inquiry sources,
   charge types, GST rates, TDS rules, payment plan templates, letter
   templates. Defaults are sensible for India but review GST rates and TDS
   thresholds against current law before your first real transaction —
   these change with government notifications and OpenEstate does not
   auto-update them.
7. **Create staff roles and users**: Settings → Users — create accounts for
   your sales managers, sales executives, and accounts team. Assign the
   pre-seeded roles (`sales_manager`, `sales_executive`, `accounts`) or
   customize permissions.
8. **Create your first project**: Projects → New Project — enter RERA
   number, address, and generate your tower/floor/unit inventory (bulk
   generator or Excel import).
9. **Notifications currently log to the console (visible via
   `journalctl -u openestate-api`), not real SMS/email** — there is no
   settings screen or env variable to wire up a real SMTP or SMS
   (DLT-compliant template IDs for India) provider yet; the
   notification-sending code is written against a swappable interface
   (`CommunicationProvider`), but the only implementation shipped today
   is a console logger, bound in code
   (`apps/api/src/queues/queues.module.ts`). Everything else works fully
   — bookings, receipts, PDFs, the ledger — customers/brokers just won't
   get an actual SMS/email until a real provider implementation is built
   and wired in. Track this in the project's issue tracker if it matters
   for your deployment.
10. **Do a dry-run booking**: create a test applicant, book a unit, record
    a receipt, download the PDF, and check it looks right before you invite
    real customers to the portal. Then delete or archive the test data.

---

## 5. Daily / weekly operations SOP

**Daily:**
- Sales team logs in, works their "My Day" queue (assigned leads + overdue
  follow-ups).
- Accounts team processes receipts, verifies cheques in the Cheque Queue.

**Weekly:**
- Review the Dues Dashboard for overdue installments.
- Check the admin Audit Log for anything unexpected (failed logins, unusual
  permission changes).
- Confirm backups ran successfully (see §7).

**Monthly:**
- Reconcile the collection report against your bank statement.
- Review broker commission statements before payout.
- Check for OpenEstate updates (see §6) and read the release notes before
  upgrading.

**Per new booking:**
- Applicant KYC → Unit selection → Payment plan → Booking confirmation →
  Allotment letter → ongoing receipts → (eventually) registration or
  cancellation.

**Service basics you'll use routinely:**
```bash
systemctl status openestate-api        # is it running?
systemctl restart openestate-api       # restart after a config change
journalctl -u openestate-api -f        # follow logs live
journalctl -u openestate-api -n 200    # last 200 lines
```

---

## 6. Upgrading to a new version

```bash
cd /opt/openestate-src/deploy/native
sudo ./upgrade-native.sh --ref v0.2.0
```

This: takes an automatic backup first (same as `backup-native.sh`, unless
you pass `--no-backup`), checks out the given tag/branch in the source
checkout, builds a **new** versioned release without touching the one
currently running, runs database migrations, then cuts over the
`/opt/openestate/current` symlink and restarts the service. If the
post-upgrade healthcheck fails, it automatically rolls the symlink back to
the previous release and restarts again — but it does **not** attempt to
undo the database migration (migrations are forward-only by design; see
`CLAUDE.md`). If you suspect the migration itself broke something, use the
backup the script took at the start, and don't attempt anything destructive
without understanding what actually failed first — check
`journalctl -u openestate-api -n 200`.

**Before upgrading a production instance**, read the release notes for
that version. A major version bump may include breaking changes. If in
doubt, test the upgrade on a staging copy first (restore your latest
backup onto a second, non-public server via `restore-native.sh`).

---

## 7. Backups

```bash
# Anytime, from deploy/native/
sudo ./backup-native.sh
```

This dumps the database, tars `/var/lib/openestate/uploads`, and copies
`/etc/openestate/openestate.env` into one timestamped bundle under
`/var/backups/openestate/` (override with `--output`). **The env file is
not optional** — `PAN_ENCRYPTION_KEY`, `TOTP_ENCRYPTION_KEY`, and
`PLUGIN_SECRET_ENCRYPTION_KEYS` live only there, and encrypted database
columns are permanently unreadable without them. Copy backup bundles
somewhere off this server (they contain live secrets — treat them with
the same care as the database itself).

**Restore** (disaster recovery — test this before you need it for real):
```bash
sudo ./restore-native.sh --force /var/backups/openestate/20260415-030000
```
This is destructive by design — it drops and recreates the database — so
it requires `--force` plus typing the database name to confirm. It does
**not** overwrite `/etc/openestate/openestate.env` unless you also pass
`--restore-env` (with its own separate confirmation), since that would
silently replace live secrets on a still-running install.

**Practice this now, not during an outage:** spin up a second small VM,
copy a backup bundle to it, run a fresh `install-native.sh --skip-database`,
run `setup-database.sh` yourself, then `restore-native.sh` against it, and
confirm you can log in and see the restored data. This is the single most
important thing you can do before trusting this system with real customer
money.

---

## 8. Recovering a lost admin password

```bash
cat > /tmp/reset-admin.js <<'EOF'
const { PrismaClient } = require('/opt/openestate/current/api/node_modules/@prisma/client');
const argon2 = require('/opt/openestate/current/api/node_modules/argon2');
const { randomBytes } = require('crypto');
(async () => {
  const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL_SYSTEM });
  const newPassword = randomBytes(18).toString('base64url');
  const hash = await argon2.hash(newPassword, { type: argon2.argon2id });
  const { count } = await prisma.user.updateMany({
    where: { email: 'admin@demo-realty.com' },
    data: { passwordHash: hash, forcePasswordChange: true },
  });
  if (count === 0) { console.error('No user found with that email.'); process.exit(1); }
  console.log('New password:', newPassword);
  await prisma.$disconnect();
})();
EOF
set -a; source /etc/openestate/openestate.env; set +a
sudo -u openestate env DATABASE_URL_SYSTEM="$DATABASE_URL_SYSTEM" node /tmp/reset-admin.js
rm /tmp/reset-admin.js
```
Swap the `email` filter for a different admin account if you're recovering
one other than the seeded default. This prints a new random password and
forces a change on next login (same as the original install flow).
Requires server access — this is intentional (nobody, including us, can
reset your password remotely; your data is yours).

---

## 9. Local development / testing (not production)

To evaluate OpenEstate without a dedicated server, or to contribute code,
run the dev servers directly (`pnpm dev` at the repo root, after
`pnpm install`) against a local Postgres/Redis — no systemd or nginx
involved. This is a developer workflow, not a smaller version of
production install; see the repo's `README.md` for dev-server setup.
Docker Compose is also still available, but scoped to running the
automated test suite — see `CONTRIBUTING.md`.

---

## 10. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `install-native.sh` fails a prerequisite check | Postgres/Redis/Node/nginx missing or wrong version | The error message names the exact `apt-get`/NodeSource command to run — see §2 |
| `systemctl status openestate-api` shows `failed` | Bad env value, or Postgres/Redis unreachable | `journalctl -u openestate-api -n 100` — Nest's own boot errors name the exact bad variable |
| `journalctl` shows nothing since the last restart | Service never started | `systemctl status openestate-api` for the actual failure reason (often a missing `EnvironmentFile` or wrong `WorkingDirectory` after a manual edit) |
| nginx returns 502 on `/api/*` | API not listening on 127.0.0.1:3000 | Check `systemctl status openestate-api`; confirm `PORT` in `/etc/openestate/openestate.env` matches the nginx config's `proxy_pass` |
| nginx returns 404 for everything under `/portal/` | `/opt/openestate/current/portal` missing or the site config predates a rebuild | Confirm the symlink target has a `portal/` directory; re-run `install-native.sh` or `upgrade-native.sh` if it's missing |
| Out of memory during build | Server under the 4GB minimum, or building on a small server under load | Build on a bigger machine and `rsync` the release, or add swap temporarily |
| Can't log in after password reset | Browser has a stale session cookie | Clear cookies for the domain, or open an incognito window |
| SMS/Email not sending | No real provider is wired up — only a console-logging stub ships today | `journalctl -u openestate-api` for the logged message the notification would have sent; a real provider needs custom code, not a config change (see §4 step 9) |
| Upgrade fails mid-migration (§6) | A migration hit an error | `upgrade-native.sh` leaves the previous release running and unmodified — it does not retry automatically; restore from the pre-upgrade backup if you suspect the migration itself is the problem, then open a GitHub issue with the error output |
| `setup-database.sh` can't connect | Wrong `--host`/superuser credentials, or Postgres not accepting the auth method you're using | For a local install, run it as root/via sudo so it can `sudo -u postgres`; for remote, pass `--host` and set `PGPASSWORD` |

---

## 11. Getting help

- This documentation site (build it locally with `pnpm --filter @openestate/docs build`,
  or `pnpm --filter @openestate/docs dev` to browse it live — it isn't
  hosted anywhere public yet).
- GitHub Issues on [AshishGTH/openestate](https://github.com/AshishGTH/openestate): bug reports and feature requests.
- GitHub Discussions: usage questions, "how do I configure X".
- Security issues: **do not open a public issue** — see `SECURITY.md` for
  the private disclosure process (GitHub Security Advisories).

---

## 12. Uninstalling

```bash
cd /opt/openestate-src/deploy/native
sudo ./uninstall.sh            # stops the service, removes the nginx site — data left in place
sudo ./uninstall.sh --purge    # also deletes /opt/openestate, /etc/openestate, /var/log/openestate,
                                # /var/lib/openestate (uploads + the encryption keys)
```
Neither form touches PostgreSQL, Redis, or any data inside them — remove
the `openestate` database and roles yourself if you no longer need them.
Take a final backup first (§7) if you might ever want this data again.
