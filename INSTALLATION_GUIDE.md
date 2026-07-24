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

SSH into your server as a user with sudo access, then:

```bash
curl -fsSL https://raw.githubusercontent.com/<your-org>/openestate/main/deploy/install.sh | bash
```

The script will:
1. Check for Docker/Docker Compose and offer to install them if missing.
2. Clone the repository into `/opt/openestate` (or a directory you choose).
3. Generate a `.env` file with cryptographically random secrets — database
   password, JWT signing key, refresh-token secret, PAN encryption key, TOTP
   encryption key, plugin secret key. **Every key is validated for correct
   length at generation time** so a misconfigured `.env` fails loudly here,
   not later during first use.
4. Prompt for: your company name, an admin email, and (optionally) a domain
   name if you have one ready.
5. Pull/build Docker images and start the stack (Postgres, Redis, API, web
   admin, customer/broker portal, nginx).
6. Run database migrations and seed the default masters (Indian tax
   defaults, standard roles, sample charge types).
7. Print a **randomly generated initial admin password** to the terminal —
   this is shown exactly once. Copy it immediately; it is not stored in
   plaintext anywhere and not recoverable if lost (you'd need to reset it
   via the database recovery procedure in §8).
8. Print the URL to open in your browser.

Total time: 5–10 minutes depending on server speed and internet connection.

> **If this is your first time on the internet with this server:** don't
> skip putting a firewall in front of it. At minimum, `ufw allow 22,80,443/tcp`
> and `ufw enable` before you finish setup, or use your cloud provider's
> security-group equivalent.

---

## 4. First login and initial setup SOP

1. Open the URL printed at the end of installation (e.g.
   `https://crm.yourcompany.com` or `http://your-server-ip:8080`).
2. Log in with the admin email you provided and the printed password.
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
9. **Configure notifications** (optional but recommended): Settings →
   Integrations — SMTP for email, an SMS provider (DLT-compliant template
   IDs required for India) for SMS. Without this, the system works fully
   but customers/brokers won't get automated notifications.
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

```bash
cd /opt/openestate   # or wherever you installed it
./deploy/upgrade.sh
```

This will:
1. Pull the new code/images for the target version.
2. Take an automatic backup first (see §7) — **never skip this**.
3. Run any new database migrations.
4. Restart services with a health-check gate — if the new version fails to
   become healthy, the script reports failure rather than leaving you with
   a half-upgraded, broken system.

**Before upgrading a production instance**, read the release notes for that
version. A major version bump may include breaking changes; the release
notes will say so explicitly. If in doubt, test the upgrade on a staging
copy first (restore your latest backup onto a second, non-public server).

---

## 7. Backups

**Automatic:** the installer offers to enable a nightly backup container
(Postgres dump + uploads folder tarball, stored locally in
`/opt/openestate/backups` by default, with a configurable retention count
and an optional S3-compatible push for offsite copies).

**Manual, anytime:**
```bash
./deploy/backup.sh
```

**Restore** (disaster recovery — test this before you need it for real):
```bash
./deploy/restore.sh /path/to/backup-file.tar.gz
```
This is destructive to the current database — it will prompt for
confirmation before overwriting.

**Practice this now, not during an outage:** spin up a second small VM,
copy a backup file to it, run a fresh `install.sh`, then `restore.sh`
against it, and confirm you can log in and see the restored data. This is
the single most important thing you can do before trusting this system
with real customer money.

---

## 8. Recovering a lost admin password

If the one-time-shown password is lost and no other admin account exists:

```bash
cd /opt/openestate
docker compose exec api node dist/scripts/reset-admin-password.js --email you@company.com
```
This will print a new random password to the terminal. Requires server
access — this is intentional (nobody, including us, can reset your password
remotely; your data is yours).

---

## 9. Windows / local testing notes

OpenEstate is **not intended for production on Windows**, but you can run
it locally to evaluate it via Docker Desktop:

- Install Docker Desktop for Windows with WSL2 backend enabled.
- If `docker` isn't found in Git Bash after installing Docker Desktop, the
  CLI may not be on your `PATH` even though Docker Desktop is running —
  add `C:\Program Files\Docker\Docker\resources\bin` to your user PATH and
  restart your terminal, or invoke Docker via PowerShell instead.
- Everything else in this guide works the same; just don't expose a
  Windows dev machine to the internet as your production server.

---

## 10. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `install.sh` fails at "Docker not found" | Docker not installed or not in PATH | Install Docker Engine (Linux) or Docker Desktop (Windows dev only); ensure the current shell has been restarted |
| Port 8080 (or 80/443) already in use | Another service on that port | Edit `.env`'s `HTTP_PORT` before first `docker compose up`, or stop the conflicting service |
| Containers keep restarting | Usually a bad `.env` value (short encryption key, wrong DB URL) | Run `docker compose logs api` — the startup validator names the exact bad variable |
| "Nest application" never appears in logs | Postgres/Redis not yet healthy | Wait 30–60s on first boot; check `docker compose ps` for unhealthy containers |
| Out of memory / containers OOM-killed | Server under the 4GB minimum | Upgrade the VM or reduce concurrent worker settings (see docs site: Performance Tuning) |
| Can't log in after password reset | Browser has a stale session cookie | Clear cookies for the domain, or open an incognito window |
| SMS/Email not sending | No provider configured | Settings → Integrations — this is optional and silently no-ops until configured |
| Upgrade script fails mid-migration | A migration hit an error | The script stops before restarting services; restore from the pre-upgrade backup it took automatically, then open a GitHub issue with the error output |

---

## 11. Getting help

- Documentation site: `https://docs.<your-domain-or-project-site>`
- GitHub Issues: bug reports and feature requests
- GitHub Discussions: usage questions, "how do I configure X"
- Security issues: **do not open a public issue** — see `SECURITY.md` for
  the private disclosure process.

---

## 12. Uninstalling

```bash
cd /opt/openestate
docker compose down -v   # -v also removes the database volume — this deletes ALL data
```
Take a final backup first if you might ever want this data again.
