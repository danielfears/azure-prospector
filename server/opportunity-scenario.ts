import {
  savingsOpportunityScopeKey,
  type SavingsOpportunityScopeInput,
} from '../src/shared/savings-activity.js'
import type {
  RecommendationClaim,
  SavingsActivity,
} from '../src/shared/types.js'

export interface OpportunityScenarioFinding {
  currency: string | null
  resourceId?: string
  fingerprint: string
  estimatedMonthlySavings: number | null
  currentMonthlyCost: number | null
  confidence: number
  activity: SavingsOpportunityScopeInput['activity']
  subscriptionId: string
  title: string
  resourceType: string
  evidence?: SavingsOpportunityScopeInput['evidence']
  claim: RecommendationClaim
}

export interface OpportunityScenarioSubscription {
  currency: string | null
  monthlyCost: number | null
}

const SUPPORTED_POTENTIAL_LEVELS = new Set([
  'azure_estimate',
  'calculated_scenario',
] as const)

function isSupportedPotential(
  recommendation: OpportunityScenarioFinding,
): recommendation is OpportunityScenarioFinding & {
  currency: string
  estimatedMonthlySavings: number
} {
  return (
    recommendation.currency !== null &&
    recommendation.currency.trim().length > 0 &&
    recommendation.estimatedMonthlySavings !== null &&
    recommendation.estimatedMonthlySavings > 0 &&
    SUPPORTED_POTENTIAL_LEVELS.has(
      recommendation.claim.level as
        | 'azure_estimate'
        | 'calculated_scenario',
    )
  )
}

function bestByScope<T extends OpportunityScenarioFinding>(
  recommendations: T[],
): T[] {
  const best = new Map<string, T>()
  for (const recommendation of recommendations) {
    const scopeKey =
      recommendation.claim.overlap.scopeKey ||
      savingsOpportunityScopeKey(recommendation)
    const current = best.get(scopeKey)
    if (
      !current ||
      (recommendation.estimatedMonthlySavings ?? 0) >
        (current.estimatedMonthlySavings ?? 0)
    ) {
      best.set(scopeKey, recommendation)
    }
  }
  return [...best.values()]
}

function total(recommendations: OpportunityScenarioFinding[]): number {
  return recommendations.reduce(
    (sum, recommendation) =>
      sum + (recommendation.estimatedMonthlySavings ?? 0),
    0,
  )
}

/**
 * Produces one conservative current-state scenario. Usage optimization is
 * evaluated before commitments; reservation and Savings Plan alternatives are
 * never added together for the same subscription and currency.
 */
export function selectSupportedOpportunityRecommendations<
  T extends OpportunityScenarioFinding,
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
    const usageOptimization = group.filter((recommendation) =>
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

    // Current commitment forecasts are based on pre-optimization usage and
    // must be refreshed after supported usage optimization is implemented.
    if (usageOptimization.length > 0) continue

    const reservations = bestByScope(
      group.filter(
        (recommendation) => recommendation.activity === 'reserved_instances',
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

export function calculateOpportunityReductionRatios(
  recommendations: OpportunityScenarioFinding[],
  subscriptions: OpportunityScenarioSubscription[],
): Map<string, number> {
  const selected = selectSupportedOpportunityRecommendations(recommendations)
  const savingsByCurrency = new Map<string, number>()
  for (const recommendation of selected) {
    if (
      recommendation.currency === null ||
      recommendation.estimatedMonthlySavings === null
    ) {
      continue
    }
    const weightedSavings =
      recommendation.estimatedMonthlySavings *
      recommendation.confidence
    const conservativeSavings =
      recommendation.currentMonthlyCost !== null &&
      recommendation.currentMonthlyCost > 0
        ? Math.min(weightedSavings, recommendation.currentMonthlyCost)
        : weightedSavings
    savingsByCurrency.set(
      recommendation.currency,
      (savingsByCurrency.get(recommendation.currency) ?? 0) +
        conservativeSavings,
    )
  }

  const costByCurrency = new Map<string, number>()
  for (const subscription of subscriptions) {
    if (
      subscription.currency === null ||
      subscription.monthlyCost === null
    ) {
      continue
    }
    costByCurrency.set(
      subscription.currency,
      (costByCurrency.get(subscription.currency) ?? 0) +
        subscription.monthlyCost,
    )
  }
  return new Map(
    [...costByCurrency.entries()].map(([currency, monthlyCost]) => [
      currency,
      monthlyCost > 0
        ? Math.min(
            0.8,
            (savingsByCurrency.get(currency) ?? 0) / monthlyCost,
          )
        : 0,
    ]),
  )
}
