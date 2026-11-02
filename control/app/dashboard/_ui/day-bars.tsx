import { fmtDate } from '../../../lib/time'

// One series per chart (never two scales on one axis). Bars: 2px gap, 4px rounded tops on the baseline,
// recessive grid, direct labels on the peak and the latest day only, native hover titles, and a table view.
export const DayBars = ({
  title,
  unit,
  points,
  color,
}: {
  title: string
  unit: string
  points: { day: string; value: number }[]
  color: string
}) => {
  const W = 340
  const H = 120
  const top = 18
  const base = H - 18
  const n = Math.max(points.length, 1)
  const slot = W / n
  const barW = Math.max(3, Math.min(28, slot - 2))
  const max = Math.max(1, ...points.map((p) => p.value))
  const peak = points.reduce((best, p, i) => (p.value > (points[best]?.value ?? -1) ? i : best), 0)
  const last = points.length - 1
  const total = points.reduce((s, p) => s + p.value, 0)
  const label = (d: string): string => fmtDate(`${d}T12:00:00+05:30`)

  return (
    <figure className="rounded-2xl bg-raised p-4">
      <figcaption className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-xs text-dim tabular-nums">
          {total} {unit} in all
        </span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-3 w-full" role="img" aria-label={`${title}: ${points.map((p) => `${label(p.day)} ${p.value}`).join(', ')}`}>
        <line x1={0} x2={W} y1={base} y2={base} stroke="var(--color-line)" strokeWidth={1} />
        <line x1={0} x2={W} y1={top} y2={top} stroke="var(--color-line)" strokeWidth={1} strokeDasharray="2 4" />
        {points.map((p, i) => {
          const h = p.value === 0 ? 0 : Math.max(3, ((base - top) * p.value) / max)
          const x = i * slot + (slot - barW) / 2
          const r = Math.min(4, barW / 2, h)
          const y = base - h
          const d = h === 0 ? '' : `M${x},${base} V${y + r} Q${x},${y} ${x + r},${y} H${x + barW - r} Q${x + barW},${y} ${x + barW},${y + r} V${base} Z`
          return (
            <g key={p.day}>
              <rect x={i * slot} y={top} width={slot} height={base - top} fill="transparent">
                <title>{`${label(p.day)}: ${p.value} ${unit}`}</title>
              </rect>
              {d ? <path d={d} fill={color} pointerEvents="none" /> : null}
              {(i === peak || i === last) && p.value > 0 ? (
                <text x={x + barW / 2} y={y - 4} textAnchor="middle" fontSize={10} fill="var(--color-ink)" className="tabular-nums">
                  {p.value}
                </text>
              ) : null}
            </g>
          )
        })}
        <text x={0} y={H - 4} fontSize={10} fill="var(--color-faint)">
          {points[0] ? label(points[0].day) : ''}
        </text>
        <text x={W} y={H - 4} fontSize={10} fill="var(--color-faint)" textAnchor="end">
          {points[last] ? `${label(points[last].day)} (today)` : ''}
        </text>
      </svg>
      <details className="mt-2 text-xs text-dim">
        <summary className="cursor-pointer list-none text-faint">Show as table</summary>
        <table className="mt-2 w-full tabular-nums">
          <tbody>
            {points.map((p) => (
              <tr key={p.day} className="border-t border-line">
                <td className="py-1">{label(p.day)}</td>
                <td className="py-1 text-right">{p.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  )
}
