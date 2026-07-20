export const PERMISSIONS = {
  // ── Admin ──────────────────────────────────────────
  ADMIN_COMPANY_READ: 'admin.company.read',
  ADMIN_COMPANY_UPDATE: 'admin.company.update',
  ADMIN_USER_READ: 'admin.user.read',
  ADMIN_USER_CREATE: 'admin.user.create',
  ADMIN_USER_UPDATE: 'admin.user.update',
  ADMIN_USER_DEACTIVATE: 'admin.user.deactivate',
  ADMIN_ROLE_READ: 'admin.role.read',
  ADMIN_ROLE_CREATE: 'admin.role.create',
  ADMIN_ROLE_UPDATE: 'admin.role.update',
  ADMIN_ROLE_DELETE: 'admin.role.delete',
  ADMIN_MASTER_READ: 'admin.master.read',
  ADMIN_MASTER_CREATE: 'admin.master.create',
  ADMIN_MASTER_UPDATE: 'admin.master.update',
  ADMIN_MASTER_DELETE: 'admin.master.delete',
  ADMIN_CUSTOM_FIELD_READ: 'admin.custom-field.read',
  ADMIN_CUSTOM_FIELD_CREATE: 'admin.custom-field.create',
  ADMIN_CUSTOM_FIELD_UPDATE: 'admin.custom-field.update',
  ADMIN_CUSTOM_FIELD_DELETE: 'admin.custom-field.delete',
  ADMIN_CONFIG_READ: 'admin.config.read',
  ADMIN_CONFIG_UPDATE: 'admin.config.update',
  ADMIN_AUDIT_READ: 'admin.audit.read',

  // ── Presales ───────────────────────────────────────
  PRESALES_INQUIRY_READ: 'presales.inquiry.read',
  PRESALES_INQUIRY_CREATE: 'presales.inquiry.create',
  PRESALES_INQUIRY_UPDATE: 'presales.inquiry.update',
  PRESALES_INQUIRY_DELETE: 'presales.inquiry.delete',
  PRESALES_INQUIRY_ASSIGN: 'presales.inquiry.assign',
  PRESALES_FOLLOW_UP_READ: 'presales.follow-up.read',
  PRESALES_FOLLOW_UP_CREATE: 'presales.follow-up.create',
  PRESALES_FOLLOW_UP_UPDATE: 'presales.follow-up.update',
  PRESALES_SITE_VISIT_READ: 'presales.site-visit.read',
  PRESALES_SITE_VISIT_CREATE: 'presales.site-visit.create',
  PRESALES_SITE_VISIT_UPDATE: 'presales.site-visit.update',
  PRESALES_REPORT_VIEW: 'presales.report.view',

  // ── Postsales ──────────────────────────────────────
  POSTSALES_BOOKING_READ: 'postsales.booking.read',
  POSTSALES_BOOKING_CREATE: 'postsales.booking.create',
  POSTSALES_BOOKING_UPDATE: 'postsales.booking.update',
  POSTSALES_BOOKING_CANCEL: 'postsales.booking.cancel',
  POSTSALES_UNIT_READ: 'postsales.unit.read',
  POSTSALES_UNIT_UPDATE: 'postsales.unit.update',
  POSTSALES_DEMAND_READ: 'postsales.demand.read',
  POSTSALES_DEMAND_GENERATE: 'postsales.demand.generate',
  POSTSALES_RECEIPT_READ: 'postsales.receipt.read',
  POSTSALES_RECEIPT_CREATE: 'postsales.receipt.create',
  POSTSALES_RECEIPT_CANCEL: 'postsales.receipt.cancel',
  POSTSALES_TRANSFER_READ: 'postsales.transfer.read',
  POSTSALES_TRANSFER_CREATE: 'postsales.transfer.create',
  POSTSALES_TRANSFER_APPROVE: 'postsales.transfer.approve',
  POSTSALES_DOCUMENT_READ: 'postsales.document.read',
  POSTSALES_DOCUMENT_UPLOAD: 'postsales.document.upload',
  POSTSALES_DOCUMENT_DELETE: 'postsales.document.delete',
  POSTSALES_LETTER_READ: 'postsales.letter.read',
  POSTSALES_LETTER_GENERATE: 'postsales.letter.generate',

  // ── Accounts ───────────────────────────────────────
  ACCOUNTS_RECEIPT_VERIFY: 'accounts.receipt.verify',
  ACCOUNTS_PAYMENT_READ: 'accounts.payment.read',
  ACCOUNTS_PAYMENT_CREATE: 'accounts.payment.create',
  ACCOUNTS_COMMISSION_READ: 'accounts.commission.read',
  ACCOUNTS_COMMISSION_APPROVE: 'accounts.commission.approve',

  // ── Reports ────────────────────────────────────────
  REPORTS_SALES_VIEW: 'reports.sales.view',
  REPORTS_COLLECTION_VIEW: 'reports.collection.view',
  REPORTS_OUTSTANDING_VIEW: 'reports.outstanding.view',
  REPORTS_BROKER_VIEW: 'reports.broker.view',
  REPORTS_GST_VIEW: 'reports.gst.view',
  REPORTS_CUSTOM_CREATE: 'reports.custom.create',

  // ── Portal ─────────────────────────────────────────
  PORTAL_BOOKING_READ: 'portal.booking.read',
  PORTAL_RECEIPT_READ: 'portal.receipt.read',
  PORTAL_DOCUMENT_READ: 'portal.document.read',
  PORTAL_DOCUMENT_UPLOAD: 'portal.document.upload',
  PORTAL_PAYMENT_SCHEDULE_READ: 'portal.payment-schedule.read',
  PORTAL_PROFILE_UPDATE: 'portal.profile.update',
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS = Object.values(PERMISSIONS);

export const PERMISSION_MODULES = [
  'admin',
  'presales',
  'postsales',
  'accounts',
  'reports',
  'portal',
] as const;

export type PermissionModule = (typeof PERMISSION_MODULES)[number];
