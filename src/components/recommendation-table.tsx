import {
  CalendarClock,
  Coins,
  Database,
  HardDrive,
  Network,
  Server,
  ShieldCheck,
  Sparkles,
  UserRound,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatCategory, formatCurrency, formatStatus } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { Recommendation, RecommendationCategory } from '@/shared/types'

interface RecommendationTableProps {
  recommendations: Recommendation[]
  onSelect: (recommendation: Recommendation) => void
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
  if (confidence >= 0.8) return 'text-success'
  if (confidence >= 0.55) return 'text-warning'
  return 'text-destructive'
}

export function RecommendationTable({
  recommendations,
  onSelect,
  compact = false,
}: RecommendationTableProps) {
  if (!recommendations.length) {
    return (
      <div className="flex min-h-64 flex-col items-center justify-center rounded-[0.625rem] border border-dashed bg-secondary p-8 text-center">
        <ShieldCheck className="mb-3 size-8 text-success" aria-hidden="true" />
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
          <TableHead>Confidence</TableHead>
          {!compact && <TableHead>Owner</TableHead>}
          <TableHead className="text-right">Monthly value</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {recommendations.map((recommendation) => {
          const Icon = categoryIcons[recommendation.category]
          return (
            <TableRow
              key={recommendation.id}
              className="cursor-pointer"
              tabIndex={0}
              onClick={() => onSelect(recommendation)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onSelect(recommendation)
                }
              }}
            >
              <TableCell className="py-4">
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-[0.625rem] bg-secondary text-foreground">
                    <Icon className="size-4" aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-foreground">
                        {recommendation.title}
                      </span>
                      {recommendation.exception && (
                        <Badge variant="outline" className="text-muted-foreground">
                          Excepted
                        </Badge>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                      <span>{formatCategory(recommendation.category)}</span>
                      <span aria-hidden="true">·</span>
                      <span className="max-w-[330px] truncate">{recommendation.resourceName}</span>
                      <span aria-hidden="true">·</span>
                      <span>{formatStatus(recommendation.status)}</span>
                    </div>
                  </div>
                </div>
              </TableCell>
              {!compact && (
                <TableCell className="max-w-48 truncate text-muted-foreground">
                  {recommendation.subscriptionName}
                </TableCell>
              )}
              <TableCell>
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      'size-2 rounded-full bg-current',
                      confidenceClass(recommendation.confidence),
                    )}
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
                  {formatCurrency(
                    recommendation.estimatedMonthlySavings,
                    recommendation.currency,
                  )}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {recommendation.effort} effort
                </div>
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
