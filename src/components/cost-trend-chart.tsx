import type { CostTrendPoint } from '@/shared/types'

interface CostTrendChartProps {
  points: CostTrendPoint[]
  currency: string
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
  const values = points.flatMap((point) => [point.actualCost, point.optimizedCost])
  const max = Math.max(...values, 1)
  const actualPath = createPath(
    points.map((point) => point.actualCost),
    width,
    height,
    max,
  )
  const optimizedPath = createPath(
    points.map((point) => point.optimizedCost),
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
    ? Math.max(0, latestPoint.actualCost - latestPoint.optimizedCost)
    : 0

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">
            {currency} cost trajectory
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Historical spend with today's confidence-weighted,
            per-resource-deduplicated opportunity applied. Illustrative, not a
            forecast.
          </p>
        </div>
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-primary" />
            Actual
          </span>
          <span className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-success" />
            Opportunity scenario
          </span>
          {latestScenarioReduction > 0 && (
            <span className="font-semibold text-success">
              {format.format(latestScenarioReduction)}/month lower
            </span>
          )}
        </div>
      </div>

      <div className="relative overflow-hidden rounded-[0.625rem] border bg-secondary p-4">
        <svg
          role="img"
          aria-label="Monthly actual and optimized Azure costs"
          className="h-[220px] w-full overflow-visible"
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
        >
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
            stroke="var(--cp-accent)"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="4"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d={optimizedPath}
            fill="none"
            stroke="var(--cp-success)"
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
      </div>
    </div>
  )
}
