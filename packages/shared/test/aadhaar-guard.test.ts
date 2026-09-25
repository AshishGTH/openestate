import { describe, it, expect } from 'vitest';
import {
  VERHOEFF_TABLES,
  verhoeffCheckDigit,
  isValidVerhoeff,
  findAadhaarLikeNumbers,
  isAadhaarLikeValue,
  redactAadhaarLike,
  maskAadhaarLike,
  AADHAAR_REDACTION,
  containsAadhaarKeyword,
  aadhaarKeywordError,
} from '../src/aadhaar-guard';

// No 12-digit literal appears in this file. Valid values are built from
// seeded random digits plus a computed check digit; an invalid value is a
// valid one with its check digit changed (Verhoeff catches every
// single-digit change, so it is always invalid).
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randomBody(r: () => number): string {
  let s = String(2 + Math.floor(r() * 8));
  for (let i = 0; i < 10; i++) s += String(Math.floor(r() * 10));
  return s;
}
function validNumber(r: () => number): string {
  const body = randomBody(r);
  return body + verhoeffCheckDigit(body);
}
function withWrongCheckDigit(valid: string): string {
  return valid.slice(0, 11) + String((Number(valid[11]) + 1) % 10);
}
const grouped = (n: string, sep: string) => `${n.slice(0, 4)}${sep}${n.slice(4, 8)}${sep}${n.slice(8)}`;

describe('Verhoeff tables, derived independently of the literal tables', () => {
  it('d is the dihedral group D5 (rotations x→x+i, reflections x→(i−5)−x, d[a][b] = a∘b)', () => {
    const act = (i: number, x: number) => (i < 5 ? (x + i) % 5 : (((i - 5 - x) % 5) + 5) % 5);
    const sig = (f: (x: number) => number) => [0, 1, 2, 3, 4].map(f).join();
    const index = new Map<string, number>();
    for (let i = 0; i < 10; i++) index.set(sig((x) => act(i, x)), i);
    for (let a = 0; a < 10; a++)
      for (let b = 0; b < 10; b++) {
        expect(VERHOEFF_TABLES.D[a][b]).toBe(index.get(sig((x) => act(a, act(b, x)))));
      }
  });

  it('p[i] is the cycle (0 1 5 8 9 4 2 7)(3 6) applied i times', () => {
    const cycle = new Map<number, number>();
    const cyc = [0, 1, 5, 8, 9, 4, 2, 7];
    cyc.forEach((v, i) => cycle.set(v, cyc[(i + 1) % cyc.length]));
    cycle.set(3, 6);
    cycle.set(6, 3);
    for (let i = 0; i < 8; i++)
      for (let j = 0; j < 10; j++) {
        let x = j;
        for (let k = 0; k < i; k++) x = cycle.get(x)!;
        expect(VERHOEFF_TABLES.P[i][j]).toBe(x);
      }
  });

  it('inv is the group inverse', () => {
    for (let j = 0; j < 10; j++) expect(VERHOEFF_TABLES.D[j][VERHOEFF_TABLES.INV[j]]).toBe(0);
  });

  it("matches Wikipedia's worked example: 236 → check digit 3", () => {
    expect(verhoeffCheckDigit('236')).toBe(3);
    expect(isValidVerhoeff('2363')).toBe(true);
    expect(isValidVerhoeff('2364')).toBe(false);
  });

  it('catches every single-digit change of a computed valid number', () => {
    const r = rng(7);
    for (let n = 0; n < 200; n++) {
      const v = validNumber(r);
      expect(isValidVerhoeff(v)).toBe(true);
      for (let pos = 0; pos < 12; pos++)
        for (let delta = 1; delta < 10; delta++) {
          const changed = v.slice(0, pos) + String((Number(v[pos]) + delta) % 10) + v.slice(pos + 1);
          expect(isValidVerhoeff(changed)).toBe(false);
        }
    }
  });
});

describe('findAadhaarLikeNumbers', () => {
  const r = rng(42);
  const v = validNumber(r);

  it('finds a valid number written plain, spaced, hyphenated, or mixed', () => {
    for (const text of [v, grouped(v, ' '), grouped(v, '-'), `${v.slice(0, 4)} ${v.slice(4, 8)}-${v.slice(8)}`]) {
      expect(findAadhaarLikeNumbers(`ref ${text} end`)).toHaveLength(1);
    }
  });

  it('ignores a wrong check digit, a first digit of 0 or 1, a longer digit run, dots, and a spaced +91 mobile', () => {
    expect(findAadhaarLikeNumbers(withWrongCheckDigit(v))).toHaveLength(0);
    for (const first of ['0', '1']) {
      const body = first + v.slice(1, 11);
      expect(findAadhaarLikeNumbers(body + verhoeffCheckDigit(body))).toHaveLength(0);
    }
    expect(findAadhaarLikeNumbers(`7${v}`)).toHaveLength(0);
    expect(findAadhaarLikeNumbers(`${v}7`)).toHaveLength(0);
    expect(findAadhaarLikeNumbers(grouped(v, '.'))).toHaveLength(0);
    expect(findAadhaarLikeNumbers('+91 98765 43210')).toHaveLength(0);
  });

  it('flags a 16-digit number in 4-4-4-4 groups when its first twelve digits are valid (documented behaviour)', () => {
    expect(findAadhaarLikeNumbers(`${grouped(v, ' ')} 5678`).length).toBeGreaterThanOrEqual(1);
  });

  it('about 1 in 10 random 12-digit numbers starting 2–9 pass — the figure the docs quote', () => {
    const r2 = rng(2026);
    const N = 20000;
    let pass = 0;
    for (let i = 0; i < N; i++) {
      const body = randomBody(r2);
      if (findAadhaarLikeNumbers(body + String(Math.floor(r2() * 10))).length > 0) pass++;
    }
    expect(pass / N).toBeGreaterThan(0.09);
    expect(pass / N).toBeLessThan(0.11);
  });
});

describe('isAadhaarLikeValue', () => {
  const v = validNumber(rng(3));
  it('checks strings and integer numbers, nothing else', () => {
    expect(isAadhaarLikeValue(v)).toBe(true);
    expect(isAadhaarLikeValue(Number(v))).toBe(true);
    expect(isAadhaarLikeValue(Number(withWrongCheckDigit(v)))).toBe(false);
    expect(isAadhaarLikeValue(true)).toBe(false);
    expect(isAadhaarLikeValue([v])).toBe(false);
    expect(isAadhaarLikeValue(null)).toBe(false);
  });
});

describe('redact and mask', () => {
  const r = rng(11);
  const v = validNumber(r);
  const w = validNumber(r);

  it('redact removes every digit of every match and leaves other text alone', () => {
    const out = redactAadhaarLike(`call +91 98765 43210, id ${grouped(v, '-')} and ${w}.`);
    expect(out).toBe(`call +91 98765 43210, id ${AADHAAR_REDACTION} and ${AADHAAR_REDACTION}.`);
    expect(findAadhaarLikeNumbers(out)).toHaveLength(0);
  });

  it('mask keeps only the last four digits', () => {
    const out = maskAadhaarLike(`id ${v}`);
    expect(out).toBe(`id XXXX XXXX ${v.slice(8)}`);
    expect(out).not.toContain(v.slice(0, 8));
  });

  it('a 16-digit run with two valid windows is replaced once, not mangled', () => {
    const out = redactAadhaarLike(`${grouped(v, ' ')} 5678`);
    expect(out).toBe(`${AADHAAR_REDACTION} 5678`);
  });

  it('text with no match comes back identical', () => {
    const text = `no match ${withWrongCheckDigit(v)}`;
    expect(redactAadhaarLike(text)).toBe(text);
    expect(maskAadhaarLike(text)).toBe(text);
  });
});

describe('containsAadhaarKeyword', () => {
  it.each([
    ['aadhaar_number', 'aadhaar'],
    ['Aadhaar-Number', 'aadhaar'],
    ['AADHAAR NO', 'aadhaar'],
    ['aadhar_card', 'aadhar'],
    ['A a d h a r', 'aadhar'],
    ['आधार संख्या', 'आधार'],
    ['ａａｄｈａａｒ', 'aadhaar'], // fullwidth Latin, folded by NFKC
    ['\u0905\u093E\u0927\u093E\u0930', '\u0906\u0927\u093E\u0930'], // अ + ा typed for आ
    ['\u0906\u0927\u093C\u093E\u0930', '\u0906\u0927\u093E\u0930'], // with a nukta
    ['\u0906\u200D\u0927\u093E\u0930', '\u0906\u0927\u093E\u0930'], // with a zero-width joiner
    ['Adhaar No', 'adhaar'],
    ['adhar_number', 'adhar'],
    ['Adhar-Card', 'adhar'],
  ])('blocks %j (matched %s)', (text, word) => {
    expect(containsAadhaarKeyword(text)).toBe(word);
  });

  it.each([
    'uid',
    'guide',
    'External UID',
    'Partner UID',
    'liquid',
    'bank_account_number',
    // Short spellings are whole-word only; each of these matched as a substring.
    'Via Dharavi',
    'Adhartal locality',
    'Road hardware',
    'Lead Hardness',
    'Radharani Nagar',
  ])('accepts %j', (text) => {
    expect(containsAadhaarKeyword(text)).toBeNull();
  });

  it('आधार मूल्य ("base price") is a known false positive, and the error suggests rewording', () => {
    expect(containsAadhaarKeyword('आधार मूल्य')).toBe('आधार');
    const msg = aadhaarKeywordError('आधार');
    expect(msg).toContain('"आधार"');
    expect(msg).toContain('मूल');
    expect(aadhaarKeywordError('aadhaar')).toContain('"aadhaar"');
  });
});
