import { describe, expect, it } from 'vitest'

import {
  opportunityAmountsByCurrency,
  roundRobinByNativeCurrency,
  selectAzureEstimatedOpportunities,
  selectCalculatedScheduleScenarios,
  selectCanonicalOpportunityRecommendations,
} from '@/components/opportunity-aggregation'
import type {
  Recommendation,
  RecommendationClaimLevel,
  SavingsActivity,
} from '@/shared/types'

function recommendation(
  id: string,
  activity: SavingsActivity,
  savings: number,
  options: {
    currency?: string | null
    subscriptionId?: string
    scopeKey?: string
    level?: RecommendationClaimLevel
  } = {},
): Recommendation {
  const currency =
    options.currency === undefined ? 'GBP' : options.currency
  const subscriptionId = options.subscriptionId ?? 'subscription-1'
  const level = options.level ?? 'azure_estimate'
  return {
    id,
    fingerprint: id,
    source: level === 'azure_estimate' ? 'advisor' : 'resource_graph',
    category: 'compute',
    activity,
    title: id,
    description: id,
    suggestedAction: id,
    subscriptionId,
    subscriptionName: subscriptionId,
    resourceName: id,
    resourceType: 'microsoft.compute/virtualmachines',
    estimatedMonthlySavings: savings,
    azureEstimatedMonthlySavings:
      level === 'azure_estimate' ? savings : null,
    calculatedMonthlySavings:
      level === 'calculated_scenario' ? savings : null,
    measuredMonthlySavings: level === 'measured_result' ? savings : null,
    currentMonthlyCost: savings * 2,
    currency,
    claim: {
      level,
      decisionStatus: 'needs_validation',
      validationState:
        level === 'azure_estimate'
          ? 'azure_authored'
          : 'deterministic_calculation',
      ruleVersion: 'test-v1',
      provenance: {
        provider: 'test',
        sourceFamily: 'test',
        sourceApi: 'test',
        collectedAt: '2026-09-04T10:00:00.000Z',
        activityClassification: 'deterministic_rule',
        extendedProperties: {},
      },
      evidenceWindow: {
        description: 'Test window',
      },
      missingEvidence: [],
      overlap: {
        scopeKey: options.scopeKey ?? id,
        spendPoolKey: `${subscriptionId}|compute-usage`,
        sequenceStage:
          activity === 'reserved_instances'
            ? 'reservation'
            : activity === 'savings_plans'
              ? 'savings_plan'
              : activity === 'right_sizing' ||
                  activity === 'shutdown_scheduling'
                ? 'usage_optimization'
                : 'independent',
        sequenceOrder:
          activity === 'reserved_instances'
            ? 20
            : activity === 'savings_plans'
              ? 30
              : 10,
        mutuallyExclusiveActivities:
          activity === 'reserved_instances'
            ? ['savings_plans']
            : activity === 'savings_plans'
              ? ['reserved_instances']
              : [],
      },
    },
    confidence: 0.9,
    confidenceBand: 'high',
    effort: 'medium',
    risk: 'medium',
    status: 'open',
    owner: {
      displayName: 'Owner',
      source: 'manual',
      confidence: 1,
    },
    evidence: [],
    tags: {},
    firstSeenAt: '2026-09-04T10:00:00.000Z',
    lastSeenAt: '2026-09-04T10:00:00.000Z',
  }
}

describe('canonical frontend opportunity aggregation', () => {
  it('applies usage optimisation before commitment alternatives', () => {
    const selected = selectCanonicalOpportunityRecommendations([
      recommendation('right-size', 'right_sizing', 100),
      recommendation('reservation', 'reserved_instances', 500),
      recommendation('savings-plan', 'savings_plans', 600),
      recommendation('storage', 'storage_optimization', 50),
    ])

    expect(selected.map((item) => item.id)).toEqual(['right-size', 'storage'])
  })

  it('chooses the larger mutually exclusive commitment category', () => {
    const selected = selectCanonicalOpportunityRecommendations([
      recommendation('reservation-a', 'reserved_instances', 200),
      recommendation('reservation-b', 'reserved_instances', 100),
      recommendation('reservation-duplicate', 'reserved_instances', 250, {
        scopeKey: 'reservation-a',
      }),
      recommendation('savings-plan', 'savings_plans', 275),
    ])

    expect(selected.map((item) => item.id)).toEqual([
      'reservation-duplicate',
      'reservation-b',
    ])
  })

  it('keeps native currencies separate', () => {
    const amounts = opportunityAmountsByCurrency([
      recommendation('gbp', 'storage_optimization', 100),
      recommendation('usd', 'storage_optimization', 200, {
        currency: 'USD',
        subscriptionId: 'subscription-2',
      }),
      recommendation('unknown', 'storage_optimization', 999, {
        currency: null,
        subscriptionId: 'subscription-3',
      }),
    ])

    expect(amounts).toEqual([
      { currency: 'GBP', amount: 100 },
      { currency: 'USD', amount: 200 },
    ])
  })

  it('keeps calculated schedule scenarios out of Azure estimates', () => {
    const azure = recommendation('azure', 'right_sizing', 100)
    const schedule = recommendation('schedule', 'shutdown_scheduling', 50, {
      level: 'calculated_scenario',
    })

    expect(selectAzureEstimatedOpportunities([azure, schedule])).toEqual([
      azure,
    ])
    expect(selectCalculatedScheduleScenarios([azure, schedule])).toEqual([
      schedule,
    ])
  })

  it('sequences a calculated usage scenario before Azure commitments', () => {
    const reservation = recommendation(
      'reservation',
      'reserved_instances',
      500,
    )
    const schedule = recommendation('schedule', 'shutdown_scheduling', 50, {
      level: 'calculated_scenario',
    })

    expect(
      selectAzureEstimatedOpportunities([reservation, schedule]),
    ).toEqual([])
    expect(
      selectCalculatedScheduleScenarios([reservation, schedule]),
    ).toEqual([schedule])
  })

  it('round-robins currencies while preserving within-currency rank', () => {
    const gbpHigh = recommendation('gbp-high', 'other', 10_000)
    const gbpLow = recommendation('gbp-low', 'other', 10)
    const usdHigh = recommendation('usd-high', 'other', 20, {
      currency: 'USD',
    })
    const usdLow = recommendation('usd-low', 'other', 15, {
      currency: 'USD',
    })

    const ranked = roundRobinByNativeCurrency(
      [gbpLow, usdLow, gbpHigh, usdHigh],
      (left, right) =>
        (right.estimatedMonthlySavings ?? 0) -
        (left.estimatedMonthlySavings ?? 0),
    )

    expect(ranked.map((item) => item.id)).toEqual([
      'gbp-high',
      'usd-high',
      'gbp-low',
      'usd-low',
    ])
  })
})
