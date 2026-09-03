import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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
    completeSourceFamiliesBySubscription: {
      [subscriptionId]: ['azure:advisor-cost'],
    },
  }
}

describe('ProspectorStore', () => {
  it('migrates legacy cost trends without losing realized savings', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'prospector-store-'))
    const databasePath = path.join(directory, 'legacy.db')
    const legacy = new DatabaseSync(databasePath)
    legacy.exec(`
      CREATE TABLE cost_trend (
        provider TEXT NOT NULL,
        period TEXT NOT NULL,
        actual_cost REAL NOT NULL,
        optimized_cost REAL NOT NULL,
        realized_savings REAL NOT NULL,
        currency TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        PRIMARY KEY (provider, period)
      );
      INSERT INTO cost_trend VALUES (
        'demo', '2026-08', 100, 90, 10, 'USD',
        '2026-09-01T00:00:00.000Z'
      );
    `)
    legacy.close()

    const store = new ProspectorStore(databasePath, { seed: false })
    try {
      const overview = store.getOverview()
      expect(overview.estate.billingCurrencies).toEqual(['USD'])
      expect(overview.savings.byCurrency[0]?.costTrend).toEqual([
        {
          period: '2026-08',
          actualCost: 100,
          optimizedCost: 90,
          realizedSavings: 10,
        },
      ])
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

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
      expect(overview.estate.billingCurrencies).toEqual(['USD'])
      expect(overview.openRecommendations).toBe(10)
      expect(overview.highConfidenceRecommendations).toBe(7)
      expect(overview.unownedRecommendations).toBe(4)
      expect(overview.savings.byCurrency[0]?.monthlyCost).toBe(86_520)
      expect(
        overview.savings.byCurrency[0]?.potentialMonthlySavings,
      ).toBe(6887)
      expect(
        overview.savings.byCurrency[0]?.annualizedPotentialSavings,
      ).toBe(82_644)
      expect(overview.savings.verifiedMeasurementCount).toBe(6)
      expect(overview.savings.measurementCoverage).toBe(100)
      expect(overview.categories.find((item) => item.category === 'storage')).toEqual({
        category: 'storage',
        recommendations: 2,
        estimatedMonthlySavings: [{ currency: 'USD', amount: 1246 }],
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
      expect(overview.savings.byCurrency[0]?.potentialMonthlySavings).toBe(
        (baseline.savings.byCurrency[0]?.potentialMonthlySavings ?? 0) -
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

  it('keeps overview totals separated by their native currencies', () => {
    const store = new ProspectorStore(':memory:', { seed: false })
    try {
      const snapshot = createDemoSnapshot(
        new Date('2026-09-01T12:00:00.000Z'),
      )
      const recommendation = {
        ...snapshot.recommendations[0]!,
        id: 'rec_gbp',
        fingerprint: 'fingerprint_gbp',
        subscriptionId: 'subscription-gbp',
        subscriptionName: 'GBP subscription',
        resourceId:
          '/subscriptions/subscription-gbp/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm-gbp',
        resourceName: 'vm-gbp',
        estimatedMonthlySavings: 50,
        currentMonthlyCost: 100,
        currency: 'GBP',
      }
      snapshot.subscriptions.push({
        ...snapshot.subscriptions[0]!,
        id: 'subscription-gbp',
        name: 'GBP subscription',
        monthlyCost: 100,
        potentialMonthlySavings: 50,
        openRecommendations: 1,
        currency: 'GBP',
      })
      snapshot.recommendations.push(recommendation)
      snapshot.currencyCostTrends.push({
        currency: 'GBP',
        points: [
          {
            period: '2026-08',
            actualCost: 100,
            optimizedCost: 100,
            realizedSavings: 0,
          },
        ],
      })
      const scan = store.startScan('demo', 'demo')
      store.upsertCollectedSnapshot(scan.id, snapshot)
      const completed = store.finishScan(scan.id)

      const overview = store.getOverview()
      expect(overview.estate.billingCurrencies).toEqual(['GBP', 'USD'])
      expect(
        overview.savings.byCurrency.map((summary) => ({
          currency: summary.currency,
          monthlyCost: summary.monthlyCost,
          potentialMonthlySavings: summary.potentialMonthlySavings,
        })),
      ).toEqual([
        {
          currency: 'GBP',
          monthlyCost: 100,
          potentialMonthlySavings: 50,
        },
        {
          currency: 'USD',
          monthlyCost: 86_520,
          potentialMonthlySavings: 6887,
        },
      ])
      expect(completed.estimatedMonthlySavings).toBe(0)
      expect(completed.estimatedMonthlySavingsByCurrency).toEqual([
        { currency: 'GBP', amount: 50 },
        { currency: 'USD', amount: 6887 },
      ])
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
      liveSnapshot.subscriptions = []
      liveSnapshot.recommendations = []
      liveSnapshot.coverage = []
      liveSnapshot.currencyCostTrends = []
      liveSnapshot.completeSourceFamilies = []
      liveSnapshot.completeSourceFamiliesBySubscription = {}
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
      const firstA = store.startScan(
        'live',
        'azure',
        'tenant-a',
        'Tenant A assessment',
      )
      store.upsertCollectedSnapshot(firstA.id, tenantA)
      store.finishScan(firstA.id)
      const recommendationA = store.listRecommendations()[0]!
      const actionA = store.createAction(recommendationA.id, {
        actionType: 'manual',
        title: 'Tenant A action',
        requestedBy: 'operator@example.invalid',
      })!

      const scanB = store.startScan(
        'live',
        'azure',
        'tenant-b',
        'Tenant B assessment',
      )
      store.upsertCollectedSnapshot(scanB.id, tenantB)
      store.finishScan(scanB.id)

      expect(store.listRecommendations({ includeExcepted: true })).toHaveLength(1)
      expect(store.listRecommendations({ includeExcepted: true })[0]?.tenantId).toBe(
        'tenant-b',
      )
      expect(store.listActions()).toHaveLength(0)
      expect(store.getOverview().estate.assessmentName).toBe(
        'Tenant B assessment',
      )
      expect(store.getRecommendation(recommendationA.id)).toBeUndefined()
      expect(store.updateActionStatus(actionA.id, 'completed')).toBeUndefined()
      expect(
        store.getOverview().recentScans.every(
          (scan) => scan.tenantId === 'tenant-b',
        ),
      ).toBe(true)

      const secondA = store.startScan(
        'live',
        'azure',
        'tenant-a',
        'Tenant A assessment',
      )
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

  it('limits the active assessment without resolving excluded subscriptions', () => {
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
      ).toBeUndefined()

      const excludedScope = liveSnapshot('tenant-a', 'a')
      excludedScope.subscriptions = [initial.subscriptions[1]!]
      excludedScope.recommendations = []
      excludedScope.completeSourceFamilies = []
      excludedScope.completeSourceFamiliesBySubscription = {}
      const excludedScan = store.startScan('live', 'azure', 'tenant-a')
      store.upsertCollectedSnapshot(excludedScan.id, excludedScope)
      store.finishScan(excludedScan.id)
      expect(
        store.listRecommendations({ includeExcepted: true })[0]?.status,
      ).toBe('open')
    } finally {
      store.close()
    }
  })

  it('resolves stale findings only where source coverage is complete', () => {
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
    initial.completeSourceFamiliesBySubscription['subscription-b'] = [
      'azure:advisor-cost',
    ]

    try {
      const first = store.startScan('live', 'azure', 'tenant-a')
      store.upsertCollectedSnapshot(first.id, initial)
      store.finishScan(first.id)

      const partial = {
        ...initial,
        recommendations: [],
        completeSourceFamilies: [],
        completeSourceFamiliesBySubscription: {
          'subscription-a': ['azure:advisor-cost'],
          'subscription-b': [],
        },
      }
      const second = store.startScan('live', 'azure', 'tenant-a')
      store.upsertCollectedSnapshot(second.id, partial)
      store.finishScan(second.id)

      const recommendations = store.listRecommendations({
        includeExcepted: true,
      })
      expect(
        recommendations.find(
          (item) => item.subscriptionId === 'subscription-a',
        )?.status,
      ).toBe('resolved')
      expect(
        recommendations.find(
          (item) => item.subscriptionId === 'subscription-b',
        )?.status,
      ).toBe('open')
    } finally {
      store.close()
    }
  })
})
