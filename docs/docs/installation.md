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
- A Linux VM (Ubuntu 24.04 LTS or Debian 12 recommended). Windows is **not**
  supported for production — see §9 if you're only testing on Windows.
- Architecture: x86_64 (amd64). ARM (e.g. AWS Graviton, Raspberry Pi) is not
  yet officially supported — check the release notes before trying.
- Minimum: 2 vCPU, 4 GB RAM, 40 GB disk. Recommended for a real company:
  4 vCPU, 8 GB RAM, 80 GB+ disk (grows with document/receipt volume).
- Root or sudo access.
- Open ports: 80/443 (if using a domain + HTTPS reverse proxy) or the port
  you choose for direct access (default 8080).

**Software (the installer checks and guides you, but good to know):**
- Docker Engine + Docker Compose plugin (installer will offer to install if
  missing).
- `curl` and `git`.

**Recommended (for a real deployment, not a demo):**
- A domain name pointed at the server, with a reverse proxy (Caddy, nginx,
  or Traefik) terminating HTTPS in front of OpenEstate. The bundled nginx
  handles internal routing only — put a real TLS-terminating proxy in front
  for anything customer-facing.
- An outbound SMTP account and an SMS provider account (MSG91/Textlocal or
  similar) for notifications — optional at install time, configurable later.

---

## 3. Quick install (recommended)

SSH into your server as a user with sudo access, then clone the repository
and run the installer from inside it (`install.sh` isn't set up to be
piped straight from `curl` yet — it needs to run from within a checked-out
copy of the repo):

```bash
git clone https://github.com/AshishGTH/openestate.git
cd openestate/deploy
./install.sh
```

The script is fully non-interactive — it doesn't prompt for anything — and
will:
1. Check for Docker/Docker Compose and stop with a clear error (not offer
   to install them) if either is missing.
2. Generate `deploy/.env` (if it doesn't already exist) with
   cryptographically random secrets — database passwords, JWT signing key,
   refresh-token secret, PAN encryption key, TOTP encryption key, plugin
   secret key. If `deploy/.env` already exists, the script leaves it alone
   and reuses it (delete it first if you want fresh secrets).
3. Build and start the stack (Postgres, Redis, API, web admin,
   customer/broker portal, nginx) via `docker compose up -d --build`.
4. Wait for the API to report healthy, then run database migrations and
   seed the default masters (Indian tax defaults, standard roles, sample
   charge types).
5. Print a **randomly generated initial admin password** to the terminal —
   this is shown exactly once, for the fixed seeded login
   `admin@demo-realty.com`. Copy it immediately; it is not stored in
   plaintext anywhere. See §8 for what to do if you lose it — there is no
   dedicated recovery script yet, so the honest answer today is "run a
   short manual command," not "run a tool built for this."
6. Print the URL to open in your browser.

Total time: 5–10 minutes depending on server speed and internet connection.

> **If this is your first time on the internet with this server:** don't
> skip putting a firewall in front of it. At minimum, `ufw allow 22,80,443/tcp`
> and `ufw enable` before you finish setup, or use your cloud provider's
> security-group equivalent.

---

## 4. First login and initial setup SOP

1. Open the URL printed at the end of installation (e.g.
   `https://crm.yourcompany.com` or `http://your-server-ip:8080`).
2. Log in with `admin@demo-realty.com` (the fixed seeded login — the
   installer doesn't ask you for a custom admin email) and the printed
   password. You can create additional admin accounts with a real email
   afterward via Settings → Users.
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
9. **Notifications currently log to the console, not real SMS/email** —
   there is no settings screen or `.env` variable to wire up a real SMTP
   or SMS (DLT-compliant template IDs for India) provider yet; the
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

---

## 6. Upgrading to a new version

**There is no dedicated upgrade script yet** — this is a manual, but
short, procedure using the same tools the installer itself uses:

```bash
cd openestate               # your cloned repo
git fetch --tags
git checkout v0.2.0          # the version you're upgrading to — read its
                              # release notes first, see below
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml exec -w /app/packages/db api \
  ../../node_modules/.bin/prisma migrate deploy
```

**Take a backup first (§7) — there is no automatic pre-upgrade backup**,
so this step is entirely on you. If the upgrade fails partway (a migration
errors, or the new containers don't become healthy), restore from that
backup rather than trying to hand-fix a partially migrated database.

**Before upgrading a production instance**, read the release notes for that
version. A major version bump may include breaking changes; the release
notes will say so explicitly. If in doubt, test the upgrade on a staging
copy first (restore your latest backup onto a second, non-public server).

---

## 7. Backups

**There is no automatic backup container and no `backup.sh`/`restore.sh`
script yet** — this is genuinely manual today, using plain `pg_dump` and a
volume tarball. Treat this section as the actual runbook, not a preview
of tooling that exists.

**Manual backup, anytime** (run from your cloned repo's `deploy/`
directory):
```bash
# Database dump
docker compose exec postgres pg_dump -U openestate -d openestate \
  > openestate-$(date +%Y%m%d-%H%M%S).sql

# Uploaded files (documents, photos) — the `uploads` named volume
docker run --rm -v deploy_uploads:/data -v "$PWD":/backup alpine \
  tar czf /backup/openestate-uploads-$(date +%Y%m%d-%H%M%S).tar.gz -C /data .
```
(The volume name may be prefixed differently depending on your Compose
project name — run `docker volume ls | grep uploads` to confirm it if the
command above doesn't find it.)

**Restore** (disaster recovery — test this before you need it for real):
```bash
# Database — destructive, overwrites the current database
cat openestate-YYYYMMDD-HHMMSS.sql | docker compose exec -T postgres \
  psql -U openestate -d openestate

# Uploaded files
docker run --rm -v deploy_uploads:/data -v "$PWD":/backup alpine \
  sh -c "rm -rf /data/* && tar xzf /backup/openestate-uploads-YYYYMMDD-HHMMSS.tar.gz -C /data"
```

**Practice this now, not during an outage:** spin up a second small VM,
copy a backup file to it, run a fresh `install.sh`, then restore against
it using the commands above, and confirm you can log in and see the
restored data. This is the single most important thing you can do before
trusting this system with real customer money — doubly so while backups
are a manual procedure rather than an automated, tested script.

---

## 8. Recovering a lost admin password

There's no dedicated reset script yet, but the same tools `install.sh`
itself uses to run migrations/seed (`@prisma/client` and `argon2`, both
already present in the running `api` container) are enough to do this in
one command, run from your cloned repo's `deploy/` directory:

```bash
docker compose exec api node -e "
const { PrismaClient } = require('@prisma/client');
const argon2 = require('argon2');
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
  await prisma.\$disconnect();
})();
"
```

Swap the `email` filter for a different admin account if you're recovering
one other than the seeded default. This prints a new random password and
forces a change on next login (same as the original install flow).
Requires server access — this is intentional (nobody, including us, can
reset your password remotely; your data is yours).

---

## 9. Windows / local testing notes

OpenEstate is **not intended for production on Windows**, but you can run
it locally to evaluate it via Docker Desktop:

- Install Docker Desktop for Windows with WSL2 backend enabled.
- If `docker` isn't found in Git Bash after installing Docker Desktop, the
  CLI may not be on your `PATH` even though Docker Desktop is running.
  The install location varies: try `C:\Program Files\Docker\Docker\resources\bin`
  (system-wide installs) or, for a per-user install,
  `%LOCALAPPDATA%\Programs\DockerDesktop\resources\bin`
  (i.e. `C:\Users\<you>\AppData\Local\Programs\DockerDesktop\resources\bin`).
  Add whichever one actually exists on your machine to PATH and restart
  your terminal, or invoke Docker via PowerShell instead.
- Everything else in this guide works the same; just don't expose a
  Windows dev machine to the internet as your production server.

---

## 10. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `install.sh` fails at "Docker not found" | Docker not installed or not in PATH | Install Docker Engine (Linux) or Docker Desktop (Windows dev only); ensure the current shell has been restarted |
| Port 8080 (or 80/443) already in use | Another service on that port | Edit `deploy/.env`'s `NGINX_PORT` before first `docker compose up`, or stop the conflicting service |
| Containers keep restarting | Usually a bad `.env` value (short encryption key, wrong DB URL) | Run `docker compose logs api` — Nest's own boot errors name the exact bad variable |
| "Nest application" never appears in logs | Postgres/Redis not yet healthy | Wait 30–60s on first boot; check `docker compose ps` for unhealthy containers |
| Out of memory / containers OOM-killed | Server under the 4GB minimum | Upgrade the VM |
| Can't log in after password reset | Browser has a stale session cookie | Clear cookies for the domain, or open an incognito window |
| SMS/Email not sending | No real provider is wired up — only a console-logging stub ships today | Check `docker compose logs api` for the logged message the notification would have sent; a real provider needs custom code, not a config change (see §4 step 9) |
| Upgrade fails mid-migration (§6) | A migration hit an error | There's no automatic rollback — restore from the backup you took before upgrading (§7), then open a GitHub issue with the error output |

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
cd openestate/deploy   # your cloned repo
docker compose down -v   # -v also removes the database volume — this deletes ALL data
```
Take a final backup first if you might ever want this data again.
