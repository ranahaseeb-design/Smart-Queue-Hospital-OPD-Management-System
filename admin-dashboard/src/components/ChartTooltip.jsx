// Shared Recharts tooltip: label in primary ink, one row per series with its colour key.
export default function ChartTooltip({ active, payload, label, labelFormatter, valueFormatter, extra }) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-label">{labelFormatter ? labelFormatter(label, row) : label}</div>
      {payload.map((p) => (
        <div key={p.dataKey} className="chart-tooltip-row">
          <span className="chart-key" style={{ background: p.color || p.fill || p.stroke }} aria-hidden="true" />
          <span>{p.name}</span>
          <strong>{valueFormatter ? valueFormatter(p.value, p.dataKey, row) : p.value}</strong>
        </div>
      ))}
      {extra && extra(row)}
    </div>
  );
}
