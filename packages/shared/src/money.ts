const PAISE_PER_RUPEE = 100n;

export function rupeesToPaise(rupees: number): bigint {
  return BigInt(Math.round(rupees * 100));
}

export function paiseToRupees(paise: bigint): number {
  return Number(paise) / 100;
}

export function formatInr(paise: bigint): string {
  const negative = paise < 0n;
  const abs = negative ? -paise : paise;
  const rupees = abs / PAISE_PER_RUPEE;
  const remainder = abs % PAISE_PER_RUPEE;

  const rupeePart = formatWithLakhCrore(rupees);
  const paisePart = remainder.toString().padStart(2, '0');

  return `${negative ? '-' : ''}₹${rupeePart}.${paisePart}`;
}

function formatWithLakhCrore(n: bigint): string {
  const s = n.toString();
  if (s.length <= 3) return s;

  const last3 = s.slice(-3);
  let rest = s.slice(0, -3);
  const groups: string[] = [last3];

  while (rest.length > 2) {
    groups.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest.length > 0) {
    groups.unshift(rest);
  }

  return groups.join(',');
}

export function addPaise(a: bigint, b: bigint): bigint {
  return a + b;
}

export function subtractPaise(a: bigint, b: bigint): bigint {
  return a - b;
}

export function multiplyPaise(paise: bigint, factor: number): bigint {
  return BigInt(Math.round(Number(paise) * factor));
}
