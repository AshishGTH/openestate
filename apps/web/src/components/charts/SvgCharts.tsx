/**
 * Hand-rolled inline SVG bar/donut charts — no charting library. Revisit
 * only if multi-series or trend lines are actually asked for (CLAUDE.md's
 * reporting-suite decisions). Both take the same simple `{label, value}[]`
 * shape every aggregate report in the catalogue already produces.
 */

interface Point {
  label: string;
  value: number;
}

const COLORS = ['#2563eb', '#059669', '#d97706', '#dc2626', '#7c3aed', '#0891b2', '#db2777', '#65a30d'];

export function BarChart({ data }: { data: Point[] }) {
  if (data.length === 0) {
    return <p className="text-sm text-slate-500">No data to chart.</p>;
  }
  const max = Math.max(...data.map((d) => d.value), 1);
  const rowHeight = 32;
  const height = data.length * rowHeight + 16;
  const labelWidth = 160;
  const chartWidth = 480;
  const width = labelWidth + chartWidth + 60;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full max-w-2xl" role="img" aria-label="Bar chart">
      {data.map((d, i) => {
        const barWidth = (d.value / max) * chartWidth;
        const y = i * rowHeight + 8;
        return (
          <g key={d.label}>
            <text x={labelWidth - 8} y={y + rowHeight / 2} textAnchor="end" dominantBaseline="middle" fontSize="12" fill="#334155">
              {d.label}
            </text>
            <rect x={labelWidth} y={y + 4} width={Math.max(barWidth, 1)} height={rowHeight - 12} fill={COLORS[i % COLORS.length]} rx={2} />
            <text x={labelWidth + barWidth + 6} y={y + rowHeight / 2} dominantBaseline="middle" fontSize="12" fill="#0f172a">
              {d.value}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function DonutChart({ data }: { data: Point[] }) {
  const total = data.reduce((sum, d) => sum + d.value, 0);
  if (data.length === 0 || total === 0) {
    return <p className="text-sm text-slate-500">No data to chart.</p>;
  }

  const size = 220;
  const radius = 90;
  const innerRadius = 55;
  const cx = size / 2;
  const cy = size / 2;

  let cumulative = 0;
  const slices = data.map((d, i) => {
    const startAngle = (cumulative / total) * 2 * Math.PI - Math.PI / 2;
    cumulative += d.value;
    const endAngle = (cumulative / total) * 2 * Math.PI - Math.PI / 2;
    const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;

    const x1 = cx + radius * Math.cos(startAngle);
    const y1 = cy + radius * Math.sin(startAngle);
    const x2 = cx + radius * Math.cos(endAngle);
    const y2 = cy + radius * Math.sin(endAngle);
    const ix1 = cx + innerRadius * Math.cos(endAngle);
    const iy1 = cy + innerRadius * Math.sin(endAngle);
    const ix2 = cx + innerRadius * Math.cos(startAngle);
    const iy2 = cy + innerRadius * Math.sin(startAngle);

    const path = [
      `M ${x1} ${y1}`,
      `A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2}`,
      `L ${ix1} ${iy1}`,
      `A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${ix2} ${iy2}`,
      'Z',
    ].join(' ');

    return { path, color: COLORS[i % COLORS.length], label: d.label, value: d.value };
  });

  return (
    <div className="flex flex-wrap items-center gap-6">
      <svg viewBox={`0 0 ${size} ${size}`} className="h-56 w-56 shrink-0" role="img" aria-label="Donut chart">
        {slices.map((s) => (
          <path key={s.label} d={s.path} fill={s.color} stroke="#fff" strokeWidth={1} />
        ))}
      </svg>
      <ul className="space-y-1 text-sm">
        {slices.map((s) => (
          <li key={s.label} className="flex items-center gap-2">
            <span className="h-3 w-3 rounded-sm" style={{ backgroundColor: s.color }} />
            <span className="text-slate-700">{s.label}</span>
            <span className="text-slate-400">
              {s.value} ({Math.round((s.value / total) * 1000) / 10}%)
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
