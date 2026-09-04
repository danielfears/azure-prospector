import {
  CalendarClock,
  Coins,
  Database,
  HardDrive,
  Network,
  Server,
  ShieldCheck,
  ShieldAlert,
  Sparkles,
  UserRound,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import {
  evidenceFreshness,
  findingKind,
  findingReadiness,
} from '@/components/finding-readiness'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  formatCategory,
  formatCurrency,
  formatDate,
  formatStatus,
} from '@/lib/format'
import { cn } from '@/lib/utils'
import type { Recommendation, RecommendationCategory } from '@/shared/types'

interface RecommendationTableProps {
  recommendations: Recommendation[]
  onSelect: (recommendation: Recommendation) => void
  onSelectSubscription?: (subscriptionId: string) => void
  onSelectResource?: (recommendation: Recommendation) => void
  warnings?: string[]
  compact?: boolean
}

const categoryIcons: Record<RecommendationCategory, typeof Server> = {
  compute: Server,
  storage: HardDrive,
  network: Network,
  database: Database,
  commitment: Coins,
  scheduling: CalendarClock,
  governance: ShieldCheck,
  other: Sparkles,
}

function confidenceClass(confidence: number) {
  if (confidence >= 0.8) return 'text-primary'
  if (confidence >= 0.55) return 'text-foreground'
  return 'text-destructive'
}

export function RecommendationTable({
  recommendations,
  onSelect,
  onSelectSubscription,
  onSelectResource,
  warnings = [],
  compact = false,
}: RecommendationTableProps) {
  if (!recommendations.length) {
    return (
      <div className="flex min-h-64 flex-col items-center justify-center rounded-[0.625rem] border border-dashed bg-secondary p-8 text-center">
        <ShieldCheck className="mb-3 size-8 text-primary" aria-hidden="true" />
        <div className="font-semibold text-foreground">No findings match this view</div>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">
          Adjust the filters or run a fresh scan to update the recommendation inventory.
        </p>
      </div>
    )
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="min-w-[320px]">Finding</TableHead>
          {!compact && <TableHead>Subscription</TableHead>}
          <TableHead>Evidence score</TableHead>
          {!compact && <TableHead>Owner</TableHead>}
          <TableHead className="text-right">Monthly value</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {recommendations.map((recommendation) => {
          const Icon = categoryIcons[recommendation.category]
          const readiness = findingReadiness(recommendation, warnings)
          return (
            <TableRow key={recommendation.id}>
              <TableCell className="py-4">
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-[0.625rem] bg-secondary text-foreground">
                    <Icon className="size-4" aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        className="min-h-11 rounded-md text-left font-semibold text-foreground hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => onSelect(recommendation)}
                      >
                        {recommendation.title}
                      </button>
                      <Badge
                        variant={readiness === 'ready' ? 'outline' : 'secondary'}
                      >
                        {readiness === 'ready' ? (
                          'Ready to review'
                        ) : (
                          <>
                            <ShieldAlert aria-hidden="true" />
                            Needs validation
                          </>
                        )}
                      </Badge>
                      {recommendation.exception && (
                        <Badge variant="outline" className="text-muted-foreground">
                          Excepted
                        </Badge>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                      <span>{formatCategory(recommendation.category)}</span>
                      <span aria-hidden="true">·</span>
                      {onSelectResource ? (
                        <button
                          type="button"
                          className="max-w-[330px] truncate font-semibold text-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={() => onSelectResource(recommendation)}
                        >
                          {recommendation.resourceName}
                        </button>
                      ) : (
                        <span className="max-w-[330px] truncate">
                          {recommendation.resourceName}
                        </span>
                      )}
                      <span aria-hidden="true">·</span>
                      <span>{formatStatus(recommendation.status)}</span>
                      <span aria-hidden="true">·</span>
                      <span>{recommendation.risk} risk</span>
                      <span aria-hidden="true">·</span>
                      <span>{findingKind(recommendation)}</span>
                      <span aria-hidden="true">·</span>
                      <span>
                        refreshed{' '}
                        {formatDate(evidenceFreshness(recommendation), true)}
                      </span>
                    </div>
                  </div>
                </div>
              </TableCell>
              {!compact && (
                <TableCell className="max-w-48 truncate text-muted-foreground">
                  {onSelectSubscription ? (
                    <button
                      type="button"
                      className="min-h-11 max-w-full truncate rounded-md text-left font-semibold text-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() =>
                        onSelectSubscription(recommendation.subscriptionId)
                      }
                    >
                      {recommendation.subscriptionName}
                    </button>
                  ) : (
                    recommendation.subscriptionName
                  )}
                </TableCell>
              )}
              <TableCell>
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      'size-2 rounded-full bg-current',
                      confidenceClass(recommendation.confidence),
                    )}
                    aria-hidden="true"
                  />
                  <span className="font-semibold text-foreground">
                    {Math.round(recommendation.confidence * 100)}%
                  </span>
                </div>
              </TableCell>
              {!compact && (
                <TableCell>
                  <div className="flex items-center gap-2 text-sm">
                    <UserRound className="size-3.5 text-muted-foreground" aria-hidden="true" />
                    <span
                      className={cn(
                        'max-w-40 truncate',
                        recommendation.owner.source === 'unassigned'
                          ? 'text-destructive'
                          : 'text-foreground',
                      )}
                    >
                      {recommendation.owner.displayName}
                    </span>
                  </div>
                </TableCell>
              )}
              <TableCell className="text-right">
                <div className="font-bold text-foreground">
                  {recommendation.estimatedMonthlySavings !== null &&
                  recommendation.currency
                    ? formatCurrency(
                        recommendation.estimatedMonthlySavings,
                        recommendation.currency,
                      )
                    : recommendation.estimatedMonthlySavings !== null
                      ? 'Currency unavailable'
                      : 'Not quantified'}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {(recommendation.currentMonthlyCost ?? 0) > 0 &&
                  recommendation.currency
                    ? `${formatCurrency(
                        recommendation.currentMonthlyCost ?? 0,
                        recommendation.currency,
                      )} cost basis`
                    : (recommendation.currentMonthlyCost ?? 0) > 0
                      ? 'Currency unavailable · not comparable'
                      : 'No matched cost basis'}
                </div>
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
