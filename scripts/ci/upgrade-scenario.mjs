#!/usr/bin/env node
/**
 * v0.8.4 Part O: data and sessions for the "upgrade from the previous release"
 * CI job. Everything goes through the real HTTP API (nginx on BASE), the way a
 * browser would. State is kept in a JSON file between steps.
 *
 *   node scripts/ci/upgrade-scenario.mjs seed      # on the previous release
 *   node scripts/ci/upgrade-scenario.mjs receipt   # one more receipt (any version)
 *   node scripts/ci/upgrade-scenario.mjs sessions  # saved sessions still refresh
 *
 * Env: BASE (default http://localhost), STATE (default /tmp/upgrade-state.json),
 * ADMIN_EMAIL, ADMIN_PASSWORD (the seeded one-time password; seed only).
 * Passwords are generated here and kept only in the state file.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://localhost';
const STATE = process.env.STATE ?? '/tmp/upgrade-state.json';
const API = `${BASE}/api/v1`;

const fail = (msg) => {
  console.error(`::error::${msg}`);
  process.exit(1);
};

/** Cookie jar per session: name -> value, from Set-Cookie headers. */
function absorb(jar, res) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    if (value) jar[name] = value;
    else delete jar[name];
  }
}
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

async function call(session, method, path, body) {
  const headers = { Cookie: cookieHeader(session.jar) };
  if (session.token) headers.Authorization = `Bearer ${session.token}`;
  const csrf = session.jar.openestate_csrf ?? session.jar.openestate_portal_csrf;
  if (csrf) headers['X-CSRF-Token'] = csrf;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  absorb(session.jar, res);
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

async function must(session, method, path, body, expect = [200, 201]) {
  const r = await call(session, method, path, body);
  if (!expect.includes(r.status)) fail(`${method} ${path} -> ${r.status}: ${JSON.stringify(r.body).slice(0, 500)}`);
  return r.body;
}

const list = (b) => (Array.isArray(b) ? b : (b?.data ?? []));
const pw = () => `Up-${randomBytes(12).toString('hex')}`;
const today = () => new Date().toISOString().slice(0, 10);

async function staffLogin(email, password) {
  const s = { jar: {} };
  const b = await must(s, 'POST', '/auth/login', { email, password }, [200]);
  if (!b?.accessToken) fail(`staff login returned no access token: ${JSON.stringify(b)}`);
  s.token = b.accessToken;
  return s;
}

async function seed() {
  const email = process.env.ADMIN_EMAIL ?? 'admin@demo-realty.com';
  let s = await staffLogin(email, process.env.ADMIN_PASSWORD ?? fail('ADMIN_PASSWORD is required'));
  const adminPassword = pw();
  // The seeded admin must change the one-time password first; that signs out
  // every session, so sign in again with the new one.
  const fcp = await call(s, 'POST', '/auth/force-change-password', { newPassword: adminPassword });
  if (![200, 201, 204].includes(fcp.status)) fail(`force-change-password -> ${fcp.status}: ${JSON.stringify(fcp.body)}`);
  s = await staffLogin(email, adminPassword);

  await must(s, 'PATCH', '/company/config', { gstStateCode: '09', companyGstin: '09ABCDE1234F1Z5' });
  const gst = list(await must(s, 'GET', '/masters/gst-rates')).find((g) => Number(g.rate) > 0);
  if (!gst) fail('no GST rate in the seeded masters');
  const unitType = list(await must(s, 'GET', '/masters/unit-types'))[0];

  const tag = Date.now().toString(36);
  const project = await must(s, 'POST', '/projects', { name: `Upgrade ${tag}`, code: `UP${tag}`.toUpperCase() });
  const tower = await must(s, 'POST', `/projects/${project.id}/towers`, { name: 'Tower A', code: 'TA', totalFloors: 1 });
  await must(s, 'POST', `/projects/${project.id}/units/bulk-generate`, {
    towerId: tower.id,
    floorStart: 1,
    floorEnd: 1,
    unitsPerFloor: 2,
    unitPrefix: 'U',
    ...(unitType ? { unitTypeId: unitType.id } : {}),
    carpetAreaSqft: 1000,
    baseRatePaise: '500000',
  });
  const units = list(await must(s, 'GET', `/projects/${project.id}/units?limit=50`));
  if (units.length < 1) fail('bulk-generate made no units');

  const phone = `9${String(Date.now()).slice(-9)}`;
  const applicantRes = await must(s, 'POST', '/applicants', { name: 'Upgrade Buyer', primaryPhone: phone, alternatePhones: [] });
  const applicant = applicantRes.applicant ?? applicantRes;

  const booking = await must(s, 'POST', '/bookings', {
    unitId: units[0].id,
    primaryApplicantId: applicant.id,
    coApplicantIds: [],
    bookingDate: today(),
    placeOfSupplyStateCode: '09',
    costLines: [{ kind: 'BASE', label: 'Base Sale Price', baseAmountPaise: '5000000000', gstRateId: gst.id }],
  });
  const agreed = BigInt(booking.agreedPricePaise);
  const first = agreed / 4n;
  await must(s, 'POST', `/bookings/${booking.id}/plan/custom`, {
    name: 'Upgrade plan',
    installments: [
      { label: 'Booking amount', dueDate: today(), amountPaise: String(first) },
      { label: 'Balance', dueDate: today(), amountPaise: String(agreed - first) },
    ],
  });
  const installments = await installmentsOf(s, booking.id);
  const [i1, i2] = installments;

  await must(s, 'POST', '/receipts', {
    bookingId: booking.id,
    receiptDate: today(),
    mode: 'CASH',
    grossAmountPaise: '10000000',
    allocations: [{ installmentId: i1.id, amountPaise: '10000000' }],
  });
  await must(s, 'POST', '/receipts', {
    bookingId: booking.id,
    receiptDate: today(),
    mode: 'NEFT',
    utr: `UTR${tag}`,
    grossAmountPaise: '20000000',
    allocations: [{ installmentId: i1.id, amountPaise: '20000000' }],
  });

  // Portal account for the buyer, then a portal session.
  const invite = await must(s, 'POST', '/admin/portal-invites', { applicantId: applicant.id, channel: 'SMS' });
  const portalPassword = pw();
  const anon = { jar: {} };
  await must(anon, 'POST', `/portal/auth/invite/${invite.inviteId ?? invite.id}/consume`, { token: invite.token, password: portalPassword }, [200, 201]);
  const p = { jar: {} };
  const pl = await must(p, 'POST', '/portal/auth/login', { identifier: phone, password: portalPassword }, [200]);
  if (!pl?.accessToken) fail(`portal login returned no access token: ${JSON.stringify(pl)}`);

  // A fresh staff session that is kept, unused, across the upgrade.
  const kept = await staffLogin(email, adminPassword);
  writeFileSync(
    STATE,
    JSON.stringify(
      {
        adminEmail: email,
        adminPassword,
        bookingId: booking.id,
        installmentId: (i2 ?? i1).id,
        staffJar: kept.jar,
        portalJar: p.jar,
      },
      null,
      2,
    ),
  );
  console.log(`Seeded booking ${booking.id} (2 receipts), a portal account, and one staff and one portal session.`);
}

async function installmentsOf(s, bookingId) {
  const h = await must(s, 'GET', `/bookings/${bookingId}/plan-history`);
  const plans = Array.isArray(h) ? h : (h.plans ?? h.data ?? [h]);
  const current = plans.find((x) => x.isActive !== false) ?? plans[0];
  const inst = current?.installments ?? h.installments ?? [];
  if (inst.length < 1) fail(`no installments found for booking ${bookingId}: ${JSON.stringify(h).slice(0, 300)}`);
  return [...inst].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
}

async function receipt() {
  const st = JSON.parse(readFileSync(STATE, 'utf8'));
  const s = await staffLogin(st.adminEmail, st.adminPassword);
  await must(s, 'POST', '/receipts', {
    bookingId: st.bookingId,
    receiptDate: today(),
    mode: 'CASH',
    grossAmountPaise: '500000',
    allocations: [{ installmentId: st.installmentId, amountPaise: '500000' }],
  });
  console.log('Recorded one more receipt (Rs 5,000).');
}

async function sessions() {
  const st = JSON.parse(readFileSync(STATE, 'utf8'));
  const staff = { jar: st.staffJar };
  const r1 = await call(staff, 'POST', '/auth/refresh', {});
  if (r1.status !== 200 || !r1.body?.accessToken) fail(`the saved staff session did not refresh: ${r1.status} ${JSON.stringify(r1.body)}`);
  staff.token = r1.body.accessToken;
  await must(staff, 'GET', `/bookings/${st.bookingId}`, undefined, [200]);
  const portal = { jar: st.portalJar };
  const r2 = await call(portal, 'POST', '/portal/auth/refresh', {});
  if (r2.status !== 200 || !r2.body?.accessToken) fail(`the saved portal session did not refresh: ${r2.status} ${JSON.stringify(r2.body)}`);
  portal.token = r2.body.accessToken;
  await must(portal, 'GET', '/portal/profile', undefined, [200]);
  // Keep the rotated cookies for a later check.
  writeFileSync(STATE, JSON.stringify({ ...st, staffJar: staff.jar, portalJar: portal.jar }, null, 2));
  console.log('Both saved sessions refreshed once and read data.');
}

const cmd = process.argv[2];
const run = { seed, receipt, sessions }[cmd];
if (!run) fail(`unknown command '${cmd}' (seed | receipt | sessions)`);
await run();
