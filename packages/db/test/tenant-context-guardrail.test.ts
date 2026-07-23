/**
 * Structural guardrail for runWithTenant() (Phase 6 commit 4), added
 * after a real fail-open IDOR in NocService.approve()/reject(): a bare
 * self-wrapped runWithTenant({ companyId }) silently shadowed an active
 * portalBrokerId, and the resulting empty portal GUCs hit the RLS
 * policy's staff-passthrough branch — a portal session briefly got
 * staff-level DB visibility. This test is pure AsyncLocalStorage logic —
 * no Postgres needed, runs unconditionally (not gated behind
 * DATABASE_URL_TEST) — same "fast, DB-independent" tier discipline as
 * postsales-pdf.test.ts (Phase 4 decisions).
 */
import { describe, it, expect } from 'vitest';
import { runWithTenant, runScoped } from '../src/index';

describe('runWithTenant: portal-scope-shadowing guardrail', () => {
  it('throws when an ambient portal scope for the SAME company would be dropped by a companyId-only re-wrap', () => {
    const companyId = '11111111-1111-1111-1111-111111111111';
    const brokerId = '22222222-2222-2222-2222-222222222222';

    expect(() =>
      runWithTenant({ companyId, portalBrokerId: brokerId }, () => {
        // The exact shape of NocService's original bug: a bare re-wrap
        // with only companyId, dropping portalBrokerId.
        runWithTenant({ companyId }, () => undefined);
      }),
    ).toThrow(/refusing to widen an active portal scope/);
  });

  it('throws when an ambient portal scope would be SWITCHED to a different portal principal, not just dropped', () => {
    const companyId = '11111111-1111-1111-1111-111111111111';
    const brokerA = '22222222-2222-2222-2222-222222222222';
    const brokerB = '33333333-3333-3333-3333-333333333333';

    expect(() =>
      runWithTenant({ companyId, portalBrokerId: brokerA }, () => {
        runWithTenant({ companyId, portalBrokerId: brokerB }, () => undefined);
      }),
    ).toThrow(/refusing to widen an active portal scope/);
  });

  it('throws for a customer (portalApplicantId) session the same way as a broker session', () => {
    const companyId = '11111111-1111-1111-1111-111111111111';
    const applicantId = '44444444-4444-4444-4444-444444444444';

    expect(() =>
      runWithTenant({ companyId, portalApplicantId: applicantId }, () => {
        runWithTenant({ companyId }, () => undefined);
      }),
    ).toThrow(/refusing to widen an active portal scope/);
  });

  it('allows a same-company re-wrap that preserves the exact ambient portal scope', () => {
    const companyId = '11111111-1111-1111-1111-111111111111';
    const brokerId = '22222222-2222-2222-2222-222222222222';
    let ran = false;

    runWithTenant({ companyId, portalBrokerId: brokerId }, () => {
      runWithTenant({ companyId, portalBrokerId: brokerId }, () => {
        ran = true;
      });
    });

    expect(ran).toBe(true);
  });

  it('allows a same-company re-wrap when the ambient store has NO portal scope (staff self-wrap — unchanged, still harmless)', () => {
    const companyId = '11111111-1111-1111-1111-111111111111';
    let ran = false;

    runWithTenant({ companyId }, () => {
      runWithTenant({ companyId }, () => {
        ran = true;
      });
    });

    expect(ran).toBe(true);
  });

  it('allows a re-wrap when there is no ambient store at all', () => {
    const companyId = '11111111-1111-1111-1111-111111111111';
    let ran = false;

    runWithTenant({ companyId, portalBrokerId: 'x' }, () => {
      ran = true;
    });

    expect(ran).toBe(true);
  });

  it('allows re-wrapping to a DIFFERENT company even while an active portal scope is present — cross-company system jobs stay unaffected', () => {
    const companyA = '11111111-1111-1111-1111-111111111111';
    const companyB = '55555555-5555-5555-5555-555555555555';
    const brokerId = '22222222-2222-2222-2222-222222222222';
    let ran = false;

    runWithTenant({ companyId: companyA, portalBrokerId: brokerId }, () => {
      runWithTenant({ companyId: companyB }, () => {
        ran = true;
      });
    });

    expect(ran).toBe(true);
  });

  describe('runScoped()', () => {
    it('reuses the ambient store (does not re-wrap) when already active for the same company', () => {
      const companyId = '11111111-1111-1111-1111-111111111111';
      const brokerId = '22222222-2222-2222-2222-222222222222';
      let ran = false;

      runWithTenant({ companyId, portalBrokerId: brokerId }, () => {
        // Would throw if this fell through to a bare runWithTenant({ companyId })
        // re-wrap instead of reusing the ambient store.
        runScoped(companyId, () => {
          ran = true;
        });
      });

      expect(ran).toBe(true);
    });

    it('falls back to runWithTenant({ companyId }) when there is no ambient context at all', () => {
      const companyId = '11111111-1111-1111-1111-111111111111';
      let ran = false;

      runScoped(companyId, () => {
        ran = true;
      });

      expect(ran).toBe(true);
    });

    it('falls back to a fresh runWithTenant({ companyId }) for a DIFFERENT company than the ambient one', () => {
      const companyA = '11111111-1111-1111-1111-111111111111';
      const companyB = '55555555-5555-5555-5555-555555555555';
      let ran = false;

      runWithTenant({ companyId: companyA }, () => {
        runScoped(companyB, () => {
          ran = true;
        });
      });

      expect(ran).toBe(true);
    });
  });
});
