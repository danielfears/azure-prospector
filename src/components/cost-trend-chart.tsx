import type { CostTrendPoint } from '@/shared/types'

interface CostTrendChartProps {
  points: CostTrendPoint[]
  currency: string
}

type CompatibleCostTrendPoint = CostTrendPoint & {
  actualCost?: number
  optimizedCost?: number
}

function observedCost(point: CostTrendPoint): number {
  const compatible = point as CompatibleCostTrendPoint
  return compatible.observedAmortizedCost ?? compatible.actualCost ?? 0
}

function opportunityCost(point: CostTrendPoint): number {
  const compatible = point as CompatibleCostTrendPoint
  return compatible.opportunityScenarioCost ?? compatible.optimizedCost ?? 0
}

function createPath(values: number[], width: number, height: number, max: number) {
  if (!values.length || max <= 0) return ''
  const xStep = values.length > 1 ? width / (values.length - 1) : 0
  return values
    .map((value, index) => {
      const x = index * xStep
      const y = height - (value / max) * height
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`
    })
    .join(' ')
}

export function CostTrendChart({ points, currency }: CostTrendChartProps) {
  const width = 720
  const height = 220
  const values = points.flatMap((point) => [
    observedCost(point),
    opportunityCost(point),
  ])
  const max = Math.max(...values, 1)
  const actualPath = createPath(
    points.map(observedCost),
    width,
    height,
    max,
  )
  const optimizedPath = createPath(
    points.map(opportunityCost),
    width,
    height,
    max,
  )
  const format = new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    notation: 'compact',
    maximumFractionDigits: 1,
  })
  const latestPoint = points.at(-1)
  const latestScenarioReduction = latestPoint
    ? Math.max(
        0,
        observedCost(latestPoint) - opportunityCost(latestPoint),
      )
    : 0
  const periodRange = points.length
    ? `${points[0]?.period} to ${points.at(-1)?.period}`
    : 'no available periods'
  const accessibleSummary = latestPoint
    ? `${currency} monthly cost from ${periodRange}. Latest actual ${format.format(
        observedCost(latestPoint),
      )}; calculated opportunity scenario ${format.format(
        opportunityCost(latestPoint),
      )}. The scenario is illustrative and is not a forecast or measured result.`
    : `${currency} cost trajectory has no available periods.`

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">
            {currency} cost trajectory
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Completed-period spend with today&apos;s confidence-weighted,
            per-scope-deduplicated opportunity applied. Calculated scenario,
            not a forecast or measured result.
          </p>
        </div>
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-[var(--cp-chart-actual)]" />
            Actual
          </span>
          <span className="flex items-center gap-2">
            <span className="h-0 w-4 border-t-2 border-dashed border-primary" />
            Calculated opportunity
          </span>
          {latestScenarioReduction > 0 && (
            <span className="font-semibold text-primary">
              {format.format(latestScenarioReduction)}/month lower
            </span>
          )}
        </div>
      </div>

      <div className="relative overflow-hidden rounded-[0.625rem] border bg-secondary p-4">
        <svg
          role="img"
          aria-label={accessibleSummary}
          className="h-[220px] w-full overflow-visible"
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
        >
          <desc>{accessibleSummary}</desc>
          {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
            const y = height - ratio * height
            return (
              <g key={ratio}>
                <line
                  x1="0"
                  x2={width}
                  y1={y}
                  y2={y}
                  stroke="var(--cp-border)"
                  strokeWidth="1"
                />
                <text
                  x="4"
                  y={Math.max(12, y - 6)}
                  fill="var(--cp-text-muted)"
                  fontSize="11"
                >
                  {format.format(max * ratio)}
                </text>
              </g>
            )
          })}
          <path
            d={actualPath}
            fill="none"
            stroke="var(--cp-chart-actual)"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="4"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d={optimizedPath}
            fill="none"
            stroke="var(--cp-accent)"
            strokeDasharray="8 7"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="3"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <div
          className="mt-3 grid gap-2 text-center text-[11px] text-muted-foreground"
          style={{ gridTemplateColumns: `repeat(${Math.max(points.length, 1)}, minmax(0, 1fr))` }}
        >
          {points.map((point) => (
            <span key={point.period}>{point.period}</span>
          ))}
        </div>
        <details className="mt-3 text-xs text-muted-foreground">
          <summary className="min-h-11 cursor-pointer py-3 font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            View chart values
          </summary>
          <div className="overflow-x-auto">
            <table className="w-full min-w-96 text-left">
              <thead>
                <tr className="border-b">
                  <th className="py-2 pr-4">Period</th>
                  <th className="py-2 pr-4">Actual</th>
                  <th className="py-2">Calculated opportunity</th>
                </tr>
              </thead>
              <tbody>
                {points.map((point) => (
                  <tr key={point.period} className="border-b">
                    <td className="py-2 pr-4">{point.period}</td>
                    <td className="py-2 pr-4">
                      {format.format(observedCost(point))}
                    </td>
                    <td className="py-2">
                      {format.format(opportunityCost(point))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </div>
    </div>
  )
}
