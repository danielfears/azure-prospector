import { savingsOpportunityScopeKey } from '@/shared/savings-activity'
import type {
  MonetaryAmount,
  Recommendation,
  RecommendationClaimLevel,
  SavingsActivity,
} from '@/shared/types'

const supportedLevels = new Set<RecommendationClaimLevel>([
  'azure_estimate',
  'calculated_scenario',
])

function claimLevel(
  recommendation: Recommendation,
): RecommendationClaimLevel {
  const claim = recommendation.claim as Recommendation['claim'] | undefined
  if (claim?.level) return claim.level
  if (recommendation.source === 'advisor') return 'azure_estimate'
  if (recommendation.source === 'prospector') return 'investigation_lead'
  return 'calculated_scenario'
}

function isSupportedPotential(
  recommendation: Recommendation,
): recommendation is Recommendation & {
  currency: string
  estimatedMonthlySavings: number
} {
  return Boolean(
    recommendation.currency?.trim() &&
      recommendation.estimatedMonthlySavings !== null &&
      recommendation.estimatedMonthlySavings > 0 &&
      supportedLevels.has(claimLevel(recommendation)),
  )
}

function scopeKey(recommendation: Recommendation): string {
  const claim = recommendation.claim as Recommendation['claim'] | undefined
  return (
    claim?.overlap.scopeKey ||
    savingsOpportunityScopeKey(recommendation)
  )
}

function bestByScope<T extends Recommendation>(recommendations: T[]): T[] {
  const best = new Map<string, T>()
  for (const recommendation of recommendations) {
    const key = scopeKey(recommendation)
    const current = best.get(key)
    if (
      !current ||
      (recommendation.estimatedMonthlySavings ?? 0) >
        (current.estimatedMonthlySavings ?? 0)
    ) {
      best.set(key, recommendation)
    }
  }
  return [...best.values()]
}

function total(recommendations: Recommendation[]): number {
  return recommendations.reduce(
    (sum, recommendation) =>
      sum + (recommendation.estimatedMonthlySavings ?? 0),
    0,
  )
}

/**
 * Browser-safe mirror of the canonical opportunity sequence: apply usage
 * optimisation first, then choose either Reservations or Savings Plans.
 */
export function selectCanonicalOpportunityRecommendations<
  T extends Recommendation,
>(recommendations: T[]): T[] {
  const eligible = recommendations.filter(isSupportedPotential) as Array<
    T & { currency: string; estimatedMonthlySavings: number }
  >
  const groups = new Map<string, typeof eligible>()
  for (const recommendation of eligible) {
    const key = `${recommendation.subscriptionId}\u0000${recommendation.currency}`
    const group = groups.get(key) ?? []
    group.push(recommendation)
    groups.set(key, group)
  }

  const selected: T[] = []
  for (const group of groups.values()) {
    const usageOptimisation = group.filter((recommendation) =>
      (['shutdown_scheduling', 'right_sizing'] as SavingsActivity[]).includes(
        recommendation.activity,
      ),
    )
    const nonCommitment = bestByScope(
      group.filter(
        (recommendation) =>
          recommendation.activity !== 'reserved_instances' &&
          recommendation.activity !== 'savings_plans',
      ),
    )
    selected.push(...nonCommitment)

    if (usageOptimisation.length > 0) continue

    const reservations = bestByScope(
      group.filter(
        (recommendation) =>
          recommendation.activity === 'reserved_instances',
      ),
    )
    const savingsPlans = bestByScope(
      group.filter(
        (recommendation) => recommendation.activity === 'savings_plans',
      ),
    )
    selected.push(
      ...(total(reservations) >= total(savingsPlans)
        ? reservations
        : savingsPlans),
    )
  }
  return selected
}

export function selectAzureEstimatedOpportunities(
  recommendations: Recommendation[],
): Recommendation[] {
  return selectCanonicalOpportunityRecommendations(recommendations).filter(
    (recommendation) => claimLevel(recommendation) === 'azure_estimate',
  )
}

export function selectCalculatedScheduleScenarios(
  recommendations: Recommendation[],
): Recommendation[] {
  return selectCanonicalOpportunityRecommendations(recommendations).filter(
    (recommendation) =>
      claimLevel(recommendation) === 'calculated_scenario' &&
      recommendation.activity === 'shutdown_scheduling',
  )
}

export function opportunityAmountsByCurrency(
  recommendations: Recommendation[],
): MonetaryAmount[] {
  return amountsByCurrency(
    selectCanonicalOpportunityRecommendations(recommendations),
    (recommendation) => recommendation.estimatedMonthlySavings,
  )
}

export function azureEstimatedOpportunityAmountsByCurrency(
  recommendations: Recommendation[],
): MonetaryAmount[] {
  return amountsByCurrency(
    selectAzureEstimatedOpportunities(recommendations),
    (recommendation) =>
      recommendation.azureEstimatedMonthlySavings ??
      recommendation.estimatedMonthlySavings,
  )
}

export function calculatedScheduleAmountsByCurrency(
  recommendations: Recommendation[],
): MonetaryAmount[] {
  return amountsByCurrency(
    selectCalculatedScheduleScenarios(recommendations),
    (recommendation) =>
      recommendation.calculatedMonthlySavings ??
      recommendation.estimatedMonthlySavings,
  )
}

function amountsByCurrency(
  recommendations: Recommendation[],
  value: (recommendation: Recommendation) => number | null,
): MonetaryAmount[] {
  const totals = new Map<string, number>()
  for (const recommendation of recommendations) {
    const amount = value(recommendation)
    if (!recommendation.currency || amount === null) continue
    totals.set(
      recommendation.currency,
      (totals.get(recommendation.currency) ?? 0) + amount,
    )
  }
  return [...totals]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, amount]) => ({ currency, amount }))
}

export function roundRobinByNativeCurrency<T extends Recommendation>(
  recommendations: T[],
  compareWithinCurrency: (left: T, right: T) => number,
  limit = Number.POSITIVE_INFINITY,
): T[] {
  const groups = new Map<string, Array<{ item: T; index: number }>>()
  recommendations.forEach((recommendation, index) => {
    const key = recommendation.currency?.trim() || '\uffff'
    const group = groups.get(key) ?? []
    group.push({ item: recommendation, index })
    groups.set(key, group)
  })
  const orderedGroups = [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, group]) =>
      group.sort(
        (left, right) =>
          compareWithinCurrency(left.item, right.item) ||
          left.index - right.index,
      ),
    )

  const ranked: T[] = []
  for (let index = 0; ranked.length < limit; index += 1) {
    let added = false
    for (const group of orderedGroups) {
      const candidate = group[index]
      if (!candidate) continue
      ranked.push(candidate.item)
      added = true
      if (ranked.length === limit) break
    }
    if (!added) break
  }
  return ranked
}
