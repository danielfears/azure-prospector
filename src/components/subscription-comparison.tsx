import { ArrowRight, ShieldAlert } from 'lucide-react'

import {
  findingReadiness,
} from '@/components/finding-readiness'
import {
  azureEstimatedOpportunityAmountsByCurrency,
} from '@/components/opportunity-aggregation'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatCurrency } from '@/lib/format'
import type {
  Recommendation,
  SubscriptionSummary,
} from '@/shared/types'

interface SubscriptionComparisonProps {
  subscriptions: SubscriptionSummary[]
  recommendations: Recommendation[]
  warnings: string[]
  onSelect: (subscriptionId: string) => void
}

export function SubscriptionComparison({
  subscriptions,
  recommendations,
  warnings,
  onSelect,
}: SubscriptionComparisonProps) {
  const totalsByCurrency = new Map<string, number>()
  for (const subscription of subscriptions) {
    if (!subscription.currency || subscription.monthlyCost === null) continue
    totalsByCurrency.set(
      subscription.currency,
      (totalsByCurrency.get(subscription.currency) ?? 0) +
        subscription.monthlyCost,
    )
  }

  const rows = [...subscriptions]
    .map((subscription) => {
      const findings = recommendations.filter(
        (recommendation) =>
          recommendation.subscriptionId === subscription.id &&
          ['open', 'accepted', 'in_progress'].includes(recommendation.status) &&
          !recommendation.exception,
      )
      const opportunity =
        azureEstimatedOpportunityAmountsByCurrency(findings).find(
          (amount) => amount.currency === subscription.currency,
        )?.amount ??
        null
      return {
        subscription,
        opportunity,
        actionReady: findings.filter(
          (recommendation) =>
            findingReadiness(recommendation, warnings) === 'ready',
        ).length,
        needsValidation: findings.filter(
          (recommendation) =>
            findingReadiness(recommendation, warnings) === 'validation',
        ).length,
      }
    })
    .sort(
      (left, right) =>
        (left.subscription.currency ?? '').localeCompare(
          right.subscription.currency ?? '',
        ) ||
        (right.subscription.monthlyCost ?? 0) -
          (left.subscription.monthlyCost ?? 0),
    )

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="min-w-64">Subscription</TableHead>
          <TableHead className="text-right">Typical monthly cost</TableHead>
          <TableHead className="text-right">Portfolio share</TableHead>
          <TableHead className="text-right">
            Azure estimated opportunity
          </TableHead>
          <TableHead>Decision state</TableHead>
          <TableHead className="text-right">Owner coverage</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map(
          ({ subscription, opportunity, actionReady, needsValidation }) => {
            const currencyTotal =
              totalsByCurrency.get(subscription.currency ?? '') ?? 0
            const portfolioShare = currencyTotal
              ? ((subscription.monthlyCost ?? 0) / currencyTotal) * 100
              : 0
            const savingsRate =
              opportunity !== null && (subscription.monthlyCost ?? 0) > 0
              ? (opportunity / (subscription.monthlyCost ?? 1)) * 100
              : 0
            return (
              <TableRow key={subscription.id}>
                <TableCell>
                  <button
                    type="button"
                    className="group flex min-h-11 w-full items-center justify-between gap-3 rounded-md text-left font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => onSelect(subscription.id)}
                  >
                    <span className="min-w-0">
                      <span className="block truncate">{subscription.name}</span>
                      <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                        {subscription.openRecommendations} open findings ·{' '}
                        {subscription.currency ?? 'currency unavailable'}
                      </span>
                    </span>
                    <ArrowRight
                      className="size-4 shrink-0 text-primary transition-transform group-hover:translate-x-0.5"
                      aria-hidden="true"
                    />
                  </button>
                </TableCell>
                <TableCell className="text-right font-semibold">
                  {subscription.monthlyCost !== null && subscription.currency
                    ? formatCurrency(
                        subscription.monthlyCost,
                        subscription.currency,
                        true,
                      )
                    : 'Not available'}
                </TableCell>
                <TableCell className="text-right">
                  {portfolioShare.toFixed(1)}%
                </TableCell>
                <TableCell className="text-right">
                  <div className="font-bold text-primary">
                    {subscription.currency && opportunity !== null
                      ? formatCurrency(opportunity, subscription.currency, true)
                      : 'Not available'}
                  </div>
                  {opportunity !== null && (
                    <div className="text-[11px] text-muted-foreground">
                      {savingsRate.toFixed(1)}% of cost · approval required
                    </div>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1.5">
                    <Badge variant="outline">{actionReady} ready</Badge>
                    {needsValidation > 0 && (
                      <Badge variant="secondary">
                        <ShieldAlert aria-hidden="true" />
                        {needsValidation} validate
                      </Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  <span className="font-semibold">
                    {Math.round(subscription.ownerCoverage)}%
                  </span>
                </TableCell>
              </TableRow>
            )
          },
        )}
      </TableBody>
    </Table>
  )
}
