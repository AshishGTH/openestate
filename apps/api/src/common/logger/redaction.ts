/**
 * pino redaction paths. Extended as new PII-bearing fields are introduced
 * (CLAUDE.md: PAN/phone must never reach logs unmasked).
 */
export const LOG_REDACTION_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.body.password',
  'req.body.newPassword',
  'req.body.currentPassword',
  'req.body.token',
  'req.body.refreshToken',
  'req.body.pan',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.secret',
  '*.pan',
];
