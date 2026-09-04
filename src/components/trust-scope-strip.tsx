import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  CircleDashed,
  Coins,
  Layers3,
  LockKeyhole,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { formatDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import type {
  AssessmentSummary,
  CoverageItem,
  OverviewResponse,
} from '@/shared/types'

interface TrustScopeStripProps {
  overview: OverviewResponse
  assessment?: AssessmentSummary
  onCoverage: () => void
}

const coverageRank: Record<CoverageItem['status'], number> = {
  missing: 0,
  unavailable: 1,
  partial: 2,
  complete: 3,
}

function sourceWindow(overview: OverviewResponse): string {
  const periods = overview.savings.byCurrency
    .flatMap((summary) => summary.costTrend.map((point) => point.period))
    .filter((period) => /^\d{4}-\d{2}$/.test(period))
    .sort()
  if (!periods.length) return 'Cost window unavailable'

  const format = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
  const start = format.format(new Date(`${periods[0]}-01T00:00:00Z`))
  const end = format.format(
    new Date(`${periods.at(-1)}-01T00:00:00Z`),
  )
  return start === end ? start : `${start}–${end}`
}

function StatusIcon({ status }: { status: CoverageItem['status'] }) {
  const Icon =
    status === 'complete'
      ? CheckCircle2
      : status === 'partial'
        ? CircleDashed
        : status === 'unavailable'
          ? LockKeyhole
          : AlertTriangle
  return <Icon className="size-3.5" aria-hidden="true" />
}

export function TrustScopeStrip({
  overview,
  assessment,
  onCoverage,
}: TrustScopeStripProps) {
  const latestScan = overview.recentScans[0]
  const selected = assessment?.selectedSubscriptionIds?.length
  const scanned =
    latestScan?.subscriptionsDiscovered ?? overview.estate.subscriptions
  const warnings = latestScan?.warningCount ?? latestScan?.warnings?.length ?? 0
  const gaps = [...overview.coverage]
    .filter((item) => item.status !== 'complete')
    .sort(
      (left, right) =>
        coverageRank[left.status] - coverageRank[right.status] ||
        left.percentage - right.percentage,
    )
    .slice(0, 3)

  return (
    <section
      className="mb-6 border-y border-[var(--cp-border-strong)] bg-[var(--cp-trust-bg)] px-4 py-3 sm:rounded-xl sm:border"
      aria-label="Assessment scope and data trust"
    >
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 text-xs">
        <div className="min-w-48">
          <div className="font-bold text-foreground">
            {overview.estate.assessmentName ??
              assessment?.name ??
              overview.estate.tenantName}
          </div>
          <div className="mt-0.5 text-muted-foreground">
            {selected
              ? `${scanned}/${selected} subscriptions scanned`
              : `${scanned} ${
                  scanned === 1 ? 'subscription' : 'subscriptions'
                } scanned`}
            {' · '}
            {overview.estate.resources.toLocaleString()} resources inventoried
          </div>
        </div>

        <TrustFact icon={Layers3} label="Source window" value={sourceWindow(overview)} />
        <TrustFact
          icon={CalendarClock}
          label="Freshness"
          value={`Scan ${formatDate(overview.estate.lastScanAt, true)} · view ${formatDate(
            overview.generatedAt,
            true,
          )}`}
        />
        <TrustFact
          icon={Coins}
          label="Currency treatment"
          value={`${
            overview.estate.billingCurrencies.join(' + ') || 'Unavailable'
          } native · no FX conversion`}
        />

        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            'ml-auto',
            warnings > 0 && 'text-warning hover:text-warning',
          )}
          onClick={onCoverage}
        >
          <AlertTriangle aria-hidden="true" />
          {warnings
            ? `${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`
            : 'No scan warnings'}
        </Button>
      </div>

      {gaps.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
          <span className="mr-1 text-[11px] font-bold uppercase tracking-[0.08em] text-muted-foreground">
            Coverage gaps
          </span>
          {gaps.map((gap) => (
            <button
              key={gap.key}
              type="button"
              className={cn(
                'inline-flex min-h-9 items-center gap-1.5 rounded-full border bg-card px-3 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                gap.status === 'missing'
                  ? 'border-destructive text-destructive'
                  : gap.status === 'partial'
                    ? 'border-warning text-foreground'
                    : 'text-muted-foreground',
              )}
              title={gap.description}
              onClick={onCoverage}
            >
              <StatusIcon status={gap.status} />
              {gap.label}
              <span className="font-normal">
                {gap.status === 'unavailable'
                  ? 'unavailable'
                  : `${Math.round(gap.percentage)}% ${gap.status}`}
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  )
}

function TrustFact({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof CalendarClock
  label: string
  value: string
}) {
  return (
    <div className="flex min-w-44 items-start gap-2">
      <Icon className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden="true" />
      <div>
        <div className="font-semibold text-foreground">{label}</div>
        <div className="mt-0.5 text-muted-foreground">{value}</div>
      </div>
    </div>
  )
}
