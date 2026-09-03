export interface OpportunityScenarioFinding {
  currency: string
  resourceId?: string
  fingerprint: string
  estimatedMonthlySavings: number
  currentMonthlyCost: number
  confidence: number
}

export interface OpportunityScenarioSubscription {
  currency: string
  monthlyCost: number
}

export function calculateOpportunityReductionRatios(
  recommendations: OpportunityScenarioFinding[],
  subscriptions: OpportunityScenarioSubscription[],
): Map<string, number> {
  const bestSavingsByResource = new Map<string, number>()
  for (const recommendation of recommendations) {
    if (recommendation.estimatedMonthlySavings <= 0) continue
    const weightedSavings =
      recommendation.estimatedMonthlySavings *
      recommendation.confidence
    const conservativeSavings =
      recommendation.currentMonthlyCost > 0
        ? Math.min(weightedSavings, recommendation.currentMonthlyCost)
        : weightedSavings
    const key = `${recommendation.currency}:${recommendation.resourceId ?? recommendation.fingerprint}`
    bestSavingsByResource.set(
      key,
      Math.max(bestSavingsByResource.get(key) ?? 0, conservativeSavings),
    )
  }

  const savingsByCurrency = new Map<string, number>()
  for (const [key, savings] of bestSavingsByResource) {
    const separator = key.indexOf(':')
    const currency = key.slice(0, separator)
    savingsByCurrency.set(
      currency,
      (savingsByCurrency.get(currency) ?? 0) + savings,
    )
  }
  const costByCurrency = new Map<string, number>()
  for (const subscription of subscriptions) {
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
