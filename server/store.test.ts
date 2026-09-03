import { describe, expect, it } from 'vitest'
import { createDemoSnapshot } from './providers/demo.js'
import type { ProviderSnapshot } from './providers/types.js'
import { ProspectorStore } from './store.js'

function populatedStore(): ProspectorStore {
  const store = new ProspectorStore(':memory:', { seed: false })
  const snapshot = createDemoSnapshot(new Date('2026-09-01T12:00:00.000Z'))
  const scan = store.startScan('demo', 'demo')
  store.upsertCollectedSnapshot(scan.id, snapshot)
  store.finishScan(scan.id)
  return store
}

function liveSnapshot(tenantId: string, suffix: string): ProviderSnapshot {
  const base = createDemoSnapshot(new Date('2026-09-01T12:00:00.000Z'))
  const subscriptionId = `subscription-${suffix}`
  const recommendation = {
    ...base.recommendations[0]!,
    id: `rec_${suffix}`,
    fingerprint: `fingerprint_${suffix}`,
    sourceFamily: 'azure:advisor-cost',
    tenantId,
    subscriptionId,
    subscriptionName: `Subscription ${suffix}`,
    resourceId:
      `/subscriptions/${subscriptionId}/resourceGroups/rg-${suffix}` +
      `/providers/Microsoft.Compute/virtualMachines/vm-${suffix}`,
    resourceName: `vm-${suffix}`,
  }
  return {
    ...base,
    provider: 'azure',
    mode: 'live',
    tenantId,
    tenantName: `Tenant ${suffix}`,
    subscriptions: [
      {
        ...base.subscriptions[0]!,
        id: subscriptionId,
        name: `Subscription ${suffix}`,
        potentialMonthlySavings: recommendation.estimatedMonthlySavings,
        openRecommendations: 1,
      },
    ],
    recommendations: [recommendation],
    completeSourceFamilies: ['azure:advisor-cost'],
  }
}

describe('ProspectorStore', () => {
  it('rejects non-canonical recommendation confidence values', () => {
    const store = new ProspectorStore(':memory:', { seed: false })
    try {
      const snapshot = createDemoSnapshot()
      snapshot.recommendations[0]!.confidence = 80
      const scan = store.startScan('demo', 'demo')

      expect(() => store.upsertCollectedSnapshot(scan.id, snapshot)).toThrow(
        'confidence outside 0..1',
      )
      expect(
        store.listRecommendations({ includeExcepted: true }),
      ).toHaveLength(0)
    } finally {
      store.close()
    }
  })

  it('aggregates overview data from normalized snapshot tables', () => {
    const store = populatedStore()
    try {
      const overview = store.getOverview()

      expect(overview.estate.mode).toBe('demo')
      expect(overview.estate.subscriptions).toBe(3)
      expect(overview.estate.resources).toBe(1301)
      expect(overview.estate.monthlyCost).toBe(86_520)
      expect(overview.openRecommendations).toBe(10)
      expect(overview.highConfidenceRecommendations).toBe(7)
      expect(overview.unownedRecommendations).toBe(4)
      expect(overview.savings.potentialMonthlySavings).toBe(6887)
      expect(overview.savings.annualizedPotentialSavings).toBe(82_644)
      expect(overview.savings.verifiedMeasurementCount).toBe(6)
      expect(overview.savings.measurementCoverage).toBe(100)
      expect(overview.categories.find((item) => item.category === 'storage')).toEqual({
        category: 'storage',
        recommendations: 2,
        estimatedMonthlySavings: 1246,
      })
      expect(overview.coverage).toHaveLength(4)
      expect(overview.recentScans).toHaveLength(1)
    } finally {
      store.close()
    }
  })

  it('applies recommendation filters and active exception visibility', () => {
    const store = populatedStore()
    try {
      expect(store.listRecommendations({ search: 'managed disk' })).toHaveLength(1)
      expect(store.listRecommendations({ category: 'network' })).toHaveLength(1)
      expect(
        store.listRecommendations({
          subscriptionId: '00000000-0000-0000-0000-000000000101',
        }),
      ).toHaveLength(4)
      expect(store.listRecommendations({ owner: 'commerce' })).toHaveLength(1)
      expect(
        store.listRecommendations({ minimumConfidence: 0.9 }),
      ).toHaveLength(5)
      expect(
        store
          .listRecommendations({ includeExcepted: true })
          .every((item) => item.confidence >= 0 && item.confidence <= 1),
      ).toBe(true)
      expect(
        store.listRecommendations({ minimumConfidence: 1.01 }),
      ).toHaveLength(0)
      expect(store.listRecommendations({ status: 'open' })).toHaveLength(10)

      const baseline = store.getOverview()
      const recommendation = store.listRecommendations()[0]!
      const excepted = store.createException(
        recommendation.id,
        'Covered by a temporary business requirement',
        'reviewer@example.invalid',
        '2099-12-01T00:00:00.000Z',
      )

      expect(excepted?.exception?.reason).toContain('temporary')
      expect(
        store.listRecommendations().some((item) => item.id === recommendation.id),
      ).toBe(false)
      expect(
        store
          .listRecommendations({ includeExcepted: true })
          .find((item) => item.id === recommendation.id)?.exception,
      ).toBeDefined()

      const overview = store.getOverview()
      expect(overview.openRecommendations).toBe(
        baseline.openRecommendations - 1,
      )
      expect(overview.savings.potentialMonthlySavings).toBe(
        baseline.savings.potentialMonthlySavings -
          recommendation.estimatedMonthlySavings,
      )
      expect(
        overview.categories.find(
          (item) => item.category === recommendation.category,
        )?.recommendations,
      ).toBe(0)
      const subscription = overview.subscriptions.find(
        (item) => item.id === recommendation.subscriptionId,
      )
      const baselineSubscription = baseline.subscriptions.find(
        (item) => item.id === recommendation.subscriptionId,
      )
      expect(subscription?.openRecommendations).toBe(
        (baselineSubscription?.openRecommendations ?? 0) - 1,
      )
      expect(subscription?.potentialMonthlySavings).toBe(
        (baselineSubscription?.potentialMonthlySavings ?? 0) -
          recommendation.estimatedMonthlySavings,
      )
    } finally {
      store.close()
    }
  })

  it('moves recommendation status with remediation action workflow', () => {
    const store = populatedStore()
    try {
      const recommendation = store.listRecommendations()[0]!
      const action = store.createAction(recommendation.id, {
        actionType: 'manual',
        title: 'Validate and apply the recommendation',
        requestedBy: 'operator@example.invalid',
      })

      expect(action?.status).toBe('proposed')
      expect(store.getRecommendation(recommendation.id)?.status).toBe('accepted')

      expect(store.updateActionStatus(action!.id, 'approved')?.status).toBe(
        'approved',
      )
      expect(store.getRecommendation(recommendation.id)?.status).toBe(
        'in_progress',
      )

      expect(store.updateActionStatus(action!.id, 'completed')?.status).toBe(
        'completed',
      )
      const completed = store.getRecommendation(recommendation.id)
      expect(completed?.status).toBe('resolved')
      expect(completed?.resolvedAt).toBeDefined()

      expect(store.updateActionStatus(action!.id, 'failed')?.status).toBe(
        'failed',
      )
      const reopened = store.getRecommendation(recommendation.id)
      expect(reopened?.status).toBe('open')
      expect(reopened?.resolvedAt).toBeUndefined()
    } finally {
      store.close()
    }
  })

  it('aggregates recommendation status across multiple actions', () => {
    const store = populatedStore()
    try {
      const recommendation = store.listRecommendations()[0]!
      const completedAction = store.createAction(recommendation.id, {
        actionType: 'manual',
        title: 'Apply the infrastructure change',
        requestedBy: 'operator@example.invalid',
      })!
      const followUpAction = store.createAction(recommendation.id, {
        actionType: 'manual',
        title: 'Validate the post-change service',
        requestedBy: 'operator@example.invalid',
      })!

      store.updateActionStatus(completedAction.id, 'completed')
      expect(store.getRecommendation(recommendation.id)?.status).toBe('accepted')

      store.updateActionStatus(followUpAction.id, 'approved')
      expect(store.getRecommendation(recommendation.id)?.status).toBe(
        'in_progress',
      )

      store.updateActionStatus(followUpAction.id, 'completed')
      expect(store.getRecommendation(recommendation.id)?.status).toBe('resolved')

      store.updateActionStatus(followUpAction.id, 'failed')
      expect(store.getRecommendation(recommendation.id)?.status).toBe('resolved')
    } finally {
      store.close()
    }
  })

  it('compares exception expiry timestamps by instant, not text offset', () => {
    const store = populatedStore()
    try {
      const recommendation = store.listRecommendations()[0]!
      store.createException(
        recommendation.id,
        'This timestamp is historically expired',
        'reviewer@example.invalid',
        '2020-01-01T14:00:00+14:00',
      )

      expect(
        store
          .listRecommendations()
          .some((item) => item.id === recommendation.id),
      ).toBe(true)
      expect(store.getRecommendation(recommendation.id)?.exception).toBeUndefined()
    } finally {
      store.close()
    }
  })

  it('isolates remediation actions to the active provider', () => {
    const store = populatedStore()
    try {
      const recommendation = store.listRecommendations()[0]!
      store.createAction(recommendation.id, {
        actionType: 'manual',
        title: 'Demo-only action',
        requestedBy: 'operator@example.invalid',
      })
      expect(store.listActions()).toHaveLength(1)

      const liveSnapshot = createDemoSnapshot()
      liveSnapshot.provider = 'azure'
      liveSnapshot.mode = 'live'
      liveSnapshot.tenantId = 'tenant-live'
      liveSnapshot.tenantName = 'Connected Azure tenant'
      liveSnapshot.resources = 0
      liveSnapshot.monthlyCost = 0
      liveSnapshot.subscriptions = []
      liveSnapshot.recommendations = []
      liveSnapshot.coverage = []
      liveSnapshot.costTrend = []
      liveSnapshot.completeSourceFamilies = []
      const liveScan = store.startScan('live', 'azure', 'tenant-live')
      store.upsertCollectedSnapshot(liveScan.id, liveSnapshot)
      store.finishScan(liveScan.id)

      expect(store.listActions()).toHaveLength(0)
    } finally {
      store.close()
    }
  })

  it('isolates recommendations, actions, and scan history by active tenant', () => {
    const store = new ProspectorStore(':memory:', { seed: false })
    const tenantA = liveSnapshot('tenant-a', 'a')
    const tenantB = liveSnapshot('tenant-b', 'b')
    try {
      const firstA = store.startScan('live', 'azure', 'tenant-a')
      store.upsertCollectedSnapshot(firstA.id, tenantA)
      store.finishScan(firstA.id)
      const recommendationA = store.listRecommendations()[0]!
      const actionA = store.createAction(recommendationA.id, {
        actionType: 'manual',
        title: 'Tenant A action',
        requestedBy: 'operator@example.invalid',
      })!

      const scanB = store.startScan('live', 'azure', 'tenant-b')
      store.upsertCollectedSnapshot(scanB.id, tenantB)
      store.finishScan(scanB.id)

      expect(store.listRecommendations({ includeExcepted: true })).toHaveLength(1)
      expect(store.listRecommendations({ includeExcepted: true })[0]?.tenantId).toBe(
        'tenant-b',
      )
      expect(store.listActions()).toHaveLength(0)
      expect(store.getRecommendation(recommendationA.id)).toBeUndefined()
      expect(store.updateActionStatus(actionA.id, 'completed')).toBeUndefined()
      expect(
        store.getOverview().recentScans.every(
          (scan) => scan.tenantId === 'tenant-b',
        ),
      ).toBe(true)

      const secondA = store.startScan('live', 'azure', 'tenant-a')
      store.upsertCollectedSnapshot(secondA.id, tenantA)
      store.finishScan(secondA.id)

      expect(store.getRecommendation(recommendationA.id)?.status).toBe('accepted')
      expect(store.listActions()).toHaveLength(1)
      expect(
        store.getOverview().recentScans.every(
          (scan) => scan.tenantId === 'tenant-a',
        ),
      ).toBe(true)
    } finally {
      store.close()
    }
  })

  it('does not resolve findings from subscriptions excluded from a partial scan', () => {
    const store = new ProspectorStore(':memory:', { seed: false })
    const initial = liveSnapshot('tenant-a', 'a')
    const secondRecommendation = {
      ...initial.recommendations[0]!,
      id: 'rec_b',
      fingerprint: 'fingerprint_b',
      subscriptionId: 'subscription-b',
      subscriptionName: 'Subscription b',
      resourceId:
        '/subscriptions/subscription-b/resourceGroups/rg-b' +
        '/providers/Microsoft.Compute/virtualMachines/vm-b',
      resourceName: 'vm-b',
    }
    initial.subscriptions.push({
      ...initial.subscriptions[0]!,
      id: 'subscription-b',
      name: 'Subscription b',
    })
    initial.recommendations.push(secondRecommendation)

    try {
      const fullScan = store.startScan('live', 'azure', 'tenant-a')
      store.upsertCollectedSnapshot(fullScan.id, initial)
      store.finishScan(fullScan.id)

      const partial = liveSnapshot('tenant-a', 'a')
      partial.recommendations = []
      const partialScan = store.startScan('live', 'azure', 'tenant-a')
      store.upsertCollectedSnapshot(partialScan.id, partial)
      store.finishScan(partialScan.id)

      const visible = store.listRecommendations({ includeExcepted: true })
      expect(
        visible.find((item) => item.subscriptionId === 'subscription-a')?.status,
      ).toBe('resolved')
      expect(
        visible.find((item) => item.subscriptionId === 'subscription-b')?.status,
      ).toBe('open')
    } finally {
      store.close()
    }
  })
})
