import {
  ArrowRight,
  CalendarClock,
  Coins,
  Database,
  HardDrive,
  Network,
  Server,
  ShieldCheck,
  Sparkles,
  Wrench,
  type LucideIcon,
} from 'lucide-react'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  formatActivity,
  formatCurrencyAmounts,
} from '@/lib/format'
import { savingsOpportunityScopeKey } from '@/shared/savings-activity'
import type {
  MonetaryAmount,
  Recommendation,
  SavingsActivity,
} from '@/shared/types'

interface SavingsActivityPanelProps {
  recommendations: Recommendation[]
  onSelect: (activity: SavingsActivity) => void
}

interface ActivitySummary {
  activity: SavingsActivity
  resourceScopes: number
  scenarios: number
  potential: MonetaryAmount[]
}

const activityPresentations: Record<
  SavingsActivity,
  { description: string; icon: LucideIcon }
> = {
  reserved_instances: {
    description: 'Cover stable usage with reservations or reserved capacity.',
    icon: Coins,
  },
  savings_plans: {
    description: 'Apply flexible compute commitment discounts.',
    icon: Coins,
  },
  right_sizing: {
    description: 'Resize underutilised VM and AKS compute capacity.',
    icon: Server,
  },
  shutdown_scheduling: {
    description:
      'Review VMs without a detected DevTest Lab auto-shutdown schedule.',
    icon: CalendarClock,
  },
  orphan_cleanup: {
    description: 'Review unused disks, public IPs, NICs, and other resources.',
    icon: Wrench,
  },
  storage_optimization: {
    description: 'Optimise storage tiers, lifecycle, retention, and snapshots.',
    icon: HardDrive,
  },
  licensing_hybrid_benefit: {
    description: 'Apply Hybrid Benefit, BYOL, or licence mobility.',
    icon: ShieldCheck,
  },
  database_optimization: {
    description: 'Optimise database and SQL service tiers.',
    icon: Database,
  },
  network_optimization: {
    description: 'Reduce bandwidth, egress, gateway, and network costs.',
    icon: Network,
  },
  other: {
    description: 'Review general governance and unmatched savings.',
    icon: Sparkles,
  },
}

function summariseActivities(
  recommendations: Recommendation[],
): ActivitySummary[] {
  const active = recommendations.filter(
    (recommendation) =>
      ['open', 'accepted', 'in_progress'].includes(recommendation.status) &&
      !recommendation.exception,
  )
  const activities = new Map<SavingsActivity, Recommendation[]>()

  for (const recommendation of active) {
    const items = activities.get(recommendation.activity) ?? []
    items.push(recommendation)
    activities.set(recommendation.activity, items)
  }

  return [...activities.entries()]
    .map(([activity, findings]) => {
      const bestByResourceAndCurrency = new Map<string, number>()
      for (const finding of findings) {
        const resourceKey = savingsOpportunityScopeKey(finding)
        const key = `${finding.currency}\u0000${resourceKey}`
        bestByResourceAndCurrency.set(
          key,
          Math.max(
            bestByResourceAndCurrency.get(key) ?? 0,
            finding.estimatedMonthlySavings,
          ),
        )
      }

      const totals = new Map<string, number>()
      for (const [key, amount] of bestByResourceAndCurrency) {
        const currency = key.slice(0, key.indexOf('\u0000'))
        totals.set(currency, (totals.get(currency) ?? 0) + amount)
      }

      return {
        activity,
        resourceScopes: new Set(
          findings.map(
            (finding) => savingsOpportunityScopeKey(finding),
          ),
        ).size,
        scenarios: findings.length,
        potential: [...totals].map(([currency, amount]) => ({
          currency,
          amount,
        })),
      }
    })
    .sort(
      (left, right) =>
        right.resourceScopes - left.resourceScopes ||
        formatActivity(left.activity).localeCompare(
          formatActivity(right.activity),
        ),
    )
}

export function SavingsActivityPanel({
  recommendations,
  onSelect,
}: SavingsActivityPanelProps) {
  const activities = summariseActivities(recommendations)

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between gap-3 text-base">
          Savings activities
          <Sparkles className="size-4 text-primary" aria-hidden="true" />
        </CardTitle>
        <p className="text-sm leading-5 text-muted-foreground">
          Grouped by the action needed. Values use each resource once.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {activities.map((summary) => {
          const presentation = activityPresentations[summary.activity]
          const Icon = presentation.icon
          const label = formatActivity(summary.activity)
          const potential = formatCurrencyAmounts(summary.potential, true)

          return (
            <button
              key={summary.activity}
              type="button"
              className="group flex w-full items-start gap-3 rounded-[0.625rem] border bg-secondary p-3 text-left transition-colors hover:border-[var(--cp-border-strong)] hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`View ${summary.resourceScopes} ${label} opportunity scopes with ${potential} potential monthly savings`}
              onClick={() => onSelect(summary.activity)}
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-[0.625rem] border bg-card text-primary">
                <Icon className="size-4" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-start justify-between gap-3">
                  <span className="font-semibold text-foreground">{label}</span>
                  <span className="shrink-0 text-right text-sm font-bold text-foreground">
                    {potential}
                    <span className="block text-[10px] font-normal text-muted-foreground">
                      monthly
                    </span>
                  </span>
                </span>
                <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                  {presentation.description}
                </span>
                <span className="mt-1 flex items-center gap-1 text-xs font-semibold text-foreground">
                  {summary.resourceScopes}{' '}
                  {summary.resourceScopes === 1
                    ? 'opportunity scope'
                    : 'opportunity scopes'}
                  {summary.scenarios > summary.resourceScopes
                    ? ` · ${summary.scenarios} scenarios`
                    : ''}
                  <ArrowRight
                    className="size-3 transition-transform group-hover:translate-x-0.5"
                    aria-hidden="true"
                  />
                </span>
              </span>
            </button>
          )
        })}
        {!activities.length && (
          <div className="rounded-[0.625rem] border border-dashed bg-secondary p-4 text-sm text-muted-foreground">
            No active savings activities were found in this workspace.
          </div>
        )}
      </CardContent>
    </Card>
  )
}
