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
  it('persists coverage evidence counts', () => {
    const store = new ProspectorStore(':memory:', { seed: false })
    try {
      const snapshot = createDemoSnapshot(
        new Date('2026-09-01T12:00:00.000Z'),
      )
      const coverageKey = snapshot.coverage[0]!.key
      snapshot.coverage[0] = {
        ...snapshot.coverage[0]!,
        coveredCount: 3,
        totalCount: 4,
      }
      const scan = store.startScan('demo', 'demo')
      store.upsertCollectedSnapshot(scan.id, snapshot)
      store.finishScan(scan.id)

      expect(
        store
          .getOverview()
          .coverage.find((item) => item.key === coverageKey),
      ).toMatchObject({
        coveredCount: 3,
        totalCount: 4,
      })
    } finally {
      store.close()
    }
  })

  it('does not present legacy trend values as measured savings', () => {
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
          observedAmortizedCost: 100,
          opportunityScenarioCost: 100,
          measuredSavings: null,
          actualCost: 100,
          optimizedCost: 100,
          realizedSavings: 0,
        },
      ])
      expect(overview.savings.measuredResultCount).toBe(0)
      expect(overview.savings.measuredResultCoverage).toBeNull()
      expect(overview.savings.measurementCoverage).toBe(0)
      expect(overview.savings.verifiedMeasurementCount).toBe(0)
      expect(overview.savings.byCurrency[0]).toMatchObject({
        realizedSavingsLast30Days: 0,
        realizedSavingsAllTime: 0,
        verifiedMeasurementCount: 0,
      })
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('backfills savings activities in active and saved assessment workspaces', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'prospector-activity-'))
    const databasePath = path.join(directory, 'legacy.db')
    const initialStore = new ProspectorStore(databasePath, { seed: false })
    const reservedSnapshot = liveSnapshot('tenant-a', 'reserved')
    Object.assign(reservedSnapshot.recommendations[0]!, {
      category: 'commitment',
      title: 'Purchase reserved instances for stable VM demand',
      description: 'Commit to predictable virtual machine usage.',
    })
    const reservedScan = initialStore.startScan(
      'live',
      'azure',
      'tenant-a',
      'Reserved assessment',
    )
    initialStore.completeScan(reservedScan.id, reservedSnapshot)

    const scheduleSnapshot = liveSnapshot('tenant-b', 'schedule')
    Object.assign(scheduleSnapshot.recommendations[0]!, {
      category: 'scheduling',
      title: 'Review VM shutdown schedule coverage',
      description: 'No matching auto-shutdown schedule was found.',
    })
    const scheduleScan = initialStore.startScan(
      'live',
      'azure',
      'tenant-b',
      'Schedule assessment',
    )
    initialStore.completeScan(scheduleScan.id, scheduleSnapshot)
    initialStore.close()

    const legacy = new DatabaseSync(databasePath)
    legacy.exec('ALTER TABLE recommendations DROP COLUMN activity')
    const assessmentRows = legacy
      .prepare('SELECT id, workspace_json FROM assessments')
      .all() as Array<{ id: string; workspace_json: string }>
    const updateWorkspace = legacy.prepare(
      'UPDATE assessments SET workspace_json = ? WHERE id = ?',
    )
    for (const assessment of assessmentRows) {
      const workspace = JSON.parse(assessment.workspace_json) as {
        recommendations?: Array<Record<string, unknown>>
      }
      for (const recommendation of workspace.recommendations ?? []) {
        delete recommendation.activity
      }
      updateWorkspace.run(JSON.stringify(workspace), assessment.id)
    }
    legacy.close()

    const migrated = new ProspectorStore(databasePath, { seed: false })
    try {
      expect(migrated.listRecommendations()[0]).toMatchObject({
        activity: 'shutdown_scheduling',
        estimatedMonthlySavings: null,
        claim: {
          level: 'investigation_lead',
          provenance: { activityClassification: 'legacy_migration' },
        },
      })
      migrated.activateAssessment(reservedScan.assessmentId!)
      expect(migrated.listRecommendations()[0]?.activity).toBe(
        'reserved_instances',
      )
    } finally {
      migrated.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('retries activity backfill when the migration marker is absent', () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), 'prospector-activity-retry-'),
    )
    const databasePath = path.join(directory, 'legacy.db')
    const initialStore = new ProspectorStore(databasePath, { seed: false })
    const snapshot = liveSnapshot('tenant-a', 'reserved')
    Object.assign(snapshot.recommendations[0]!, {
      category: 'commitment',
      title: 'Purchase reserved instances for stable VM demand',
      description: 'Commit to predictable virtual machine usage.',
      activity: 'reserved_instances',
    })
    const scan = initialStore.startScan(
      'live',
      'azure',
      'tenant-a',
      'Interrupted migration',
    )
    initialStore.completeScan(scan.id, snapshot)
    initialStore.close()

    const interrupted = new DatabaseSync(databasePath)
    interrupted.exec(`
      UPDATE recommendations SET activity = 'other';
      DELETE FROM metadata WHERE key = 'schema_savings_activity_v1';
    `)
    const assessment = interrupted
      .prepare('SELECT id, workspace_json FROM assessments LIMIT 1')
      .get() as { id: string; workspace_json: string }
    const workspace = JSON.parse(assessment.workspace_json) as {
      recommendations: Array<Record<string, unknown>>
    }
    for (const recommendation of workspace.recommendations) {
      recommendation.activity = 'other'
    }
    interrupted
      .prepare('UPDATE assessments SET workspace_json = ? WHERE id = ?')
      .run(JSON.stringify(workspace), assessment.id)
    interrupted.close()

    const migrated = new ProspectorStore(databasePath, { seed: false })
    try {
      expect(migrated.listRecommendations()[0]?.activity).toBe(
        'reserved_instances',
      )
      migrated.activateAssessment(scan.assessmentId!)
      expect(migrated.listRecommendations()[0]?.activity).toBe(
        'reserved_instances',
      )
    } finally {
      migrated.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('migrates legacy zero sentinels conservatively in active and saved workspaces', () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), 'prospector-financial-availability-'),
    )
    const databasePath = path.join(directory, 'legacy.db')
    const initialStore = new ProspectorStore(databasePath, { seed: false })
    const knownSnapshot = createDemoSnapshot(
      new Date('2026-09-01T12:00:00.000Z'),
    )
    const known = knownSnapshot.recommendations[0]!
    known.estimatedMonthlySavings = 0
    known.azureEstimatedMonthlySavings = 0
    known.currentMonthlyCost = 0
    known.currency = 'GBP'
    known.evidence = [
      {
        label: 'Estimated monthly savings',
        value: 0,
        unit: 'GBP',
        source: 'Azure Advisor',
      },
      {
        label: 'Median completed-month amortized cost',
        value: 0,
        unit: 'GBP',
        source: 'Cost Management',
      },
    ]
    knownSnapshot.recommendations = [known]
    knownSnapshot.subscriptions = [
      {
        ...knownSnapshot.subscriptions[0]!,
        monthlyCost: 0,
        currency: 'GBP',
      },
    ]
    const knownScan = initialStore.startScan(
      'demo',
      'demo',
      undefined,
      'Known zero',
    )
    initialStore.completeScan(knownScan.id, knownSnapshot)

    const ambiguousSnapshot = createDemoSnapshot(
      new Date('2026-09-02T12:00:00.000Z'),
    )
    const ambiguous = {
      ...ambiguousSnapshot.recommendations[0]!,
      id: 'legacy_ambiguous_zero',
      fingerprint: 'legacy_ambiguous_zero',
      estimatedMonthlySavings: 0,
      azureEstimatedMonthlySavings: 0,
      currentMonthlyCost: 0,
      currency: 'USD',
      evidence: [],
    }
    ambiguousSnapshot.recommendations = [ambiguous]
    ambiguousSnapshot.subscriptions = [
      {
        ...ambiguousSnapshot.subscriptions[0]!,
        monthlyCost: 0,
        currency: 'USD',
      },
    ]
    const ambiguousScan = initialStore.startScan(
      'demo',
      'demo',
      undefined,
      'Ambiguous zero',
    )
    initialStore.completeScan(ambiguousScan.id, ambiguousSnapshot)
    initialStore.close()

    const legacy = new DatabaseSync(databasePath)
    legacy.exec(`
      UPDATE recommendations
      SET claim_json = '{}',
        evidence_json = '[]',
        estimated_monthly_savings = 0,
        current_monthly_cost = 0,
        currency = 'USD',
        savings_amount_available = 1,
        current_cost_available = 1,
        currency_available = 0;
      UPDATE subscriptions
      SET monthly_cost = 0,
        currency = 'USD',
        monthly_cost_available = 1,
        currency_available = 0;
      DELETE FROM metadata
      WHERE key = 'schema_financial_availability_v2';
    `)
    const knownAssessment = legacy
      .prepare('SELECT workspace_json FROM assessments WHERE id = ?')
      .get(knownScan.assessmentId!) as { workspace_json: string }
    const workspace = JSON.parse(knownAssessment.workspace_json) as {
      recommendations: Array<Record<string, unknown>>
      subscriptions: Array<Record<string, unknown>>
    }
    const storedRecommendation = workspace.recommendations[0]!
    storedRecommendation.claim_json = '{}'
    storedRecommendation.estimated_monthly_savings = 0
    storedRecommendation.current_monthly_cost = 0
    storedRecommendation.currency = 'GBP'
    storedRecommendation.evidence_json = JSON.stringify(known.evidence)
    delete storedRecommendation.savings_amount_available
    delete storedRecommendation.current_cost_available
    delete storedRecommendation.currency_available
    for (const subscription of workspace.subscriptions) {
      subscription.monthly_cost = 0
      subscription.currency = 'GBP'
      delete subscription.monthly_cost_available
      delete subscription.currency_available
    }
    legacy
      .prepare('UPDATE assessments SET workspace_json = ? WHERE id = ?')
      .run(JSON.stringify(workspace), knownScan.assessmentId!)
    legacy.close()

    const migrated = new ProspectorStore(databasePath, { seed: false })
    try {
      expect(migrated.getRecommendation(ambiguous.id)).toMatchObject({
        estimatedMonthlySavings: null,
        currentMonthlyCost: null,
        currency: null,
      })
      expect(migrated.getOverview().subscriptions[0]).toMatchObject({
        monthlyCost: null,
        currency: null,
      })

      migrated.activateAssessment(knownScan.assessmentId!)
      expect(migrated.getRecommendation(known.id)).toMatchObject({
        estimatedMonthlySavings: 0,
        currentMonthlyCost: 0,
        currency: 'GBP',
      })
    } finally {
      migrated.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('associates the complete matching legacy scan history', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'prospector-history-'))
    const databasePath = path.join(directory, 'legacy.db')
    const initialStore = new ProspectorStore(databasePath, { seed: false })
    const snapshot = liveSnapshot('tenant-a', 'a')
    const first = initialStore.startScan(
      'live',
      'azure',
      'tenant-a',
      'Legacy assessment',
      undefined,
      ['subscription-a'],
    )
    initialStore.upsertCollectedSnapshot(first.id, snapshot)
    initialStore.finishScan(first.id)
    const second = initialStore.startScan(
      'live',
      'azure',
      'tenant-a',
      'Legacy assessment',
      first.assessmentId,
      ['subscription-a'],
    )
    initialStore.upsertCollectedSnapshot(second.id, snapshot)
    initialStore.finishScan(second.id)
    initialStore.close()

    const legacy = new DatabaseSync(databasePath)
    legacy.exec(`
      DELETE FROM assessments;
      UPDATE scans SET assessment_id = NULL;
      DELETE FROM metadata WHERE key = 'active_assessment_id';
    `)
    legacy.close()

    const migrated = new ProspectorStore(databasePath, { seed: false })
    try {
      const assessments = migrated.listAssessments()
      expect(assessments).toHaveLength(1)
      expect(migrated.getAssessmentScans(assessments[0]!.id)).toHaveLength(2)
    } finally {
      migrated.close()
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
      ).toBe(6689)
      expect(
        overview.savings.byCurrency[0]?.annualizedPotentialSavings,
      ).toBe(80_268)
      expect(overview.savings.measuredResultCount).toBe(0)
      expect(overview.savings.measuredResultCoverage).toBeNull()
      expect(overview.savings.measurementCoverage).toBe(0)
      expect(overview.categories.find((item) => item.category === 'storage')).toEqual({
        category: 'storage',
        recommendations: 2,
        estimatedMonthlySavings: [{ currency: 'USD', amount: 1246 }],
      })
      expect(overview.coverage).toHaveLength(4)
      expect(overview.recentScans).toHaveLength(1)
      expect(
        overview.savings.byCurrency[0]?.costTrend.every(
          (point) =>
            point.opportunityScenarioCost < point.observedAmortizedCost &&
            point.actualCost === point.observedAmortizedCost &&
            point.optimizedCost === point.opportunityScenarioCost &&
            point.realizedSavings === 0,
        ),
      ).toBe(true)
    } finally {
      store.close()
    }
  })

  it('keeps unquantified schedule leads out of every potential total', () => {
    const store = populatedStore()
    try {
      const schedule = store
        .listRecommendations({ includeExcepted: true })
        .find((recommendation) =>
          recommendation.activity === 'shutdown_scheduling',
        )
      expect(schedule).toMatchObject({
        estimatedMonthlySavings: null,
        claim: {
          level: 'investigation_lead',
          decisionStatus: 'needs_evidence',
          validationState: 'unvalidated',
        },
      })
      expect(
        store.getOverview().categories.find(
          (category) => category.category === 'scheduling',
        ),
      ).toEqual({
        category: 'scheduling',
        recommendations: 1,
        estimatedMonthlySavings: [],
      })
      expect(store.latestScan()?.estimatedMonthlySavingsByCurrency).toEqual([
        { currency: 'USD', amount: 6689 },
      ])
    } finally {
      store.close()
    }
  })

  it('persists VM telemetry evidence with the normalized finding', () => {
    const store = new ProspectorStore(':memory:', { seed: false })
    try {
      const snapshot = createDemoSnapshot(
        new Date('2026-09-04T12:00:00.000Z'),
      )
      snapshot.recommendations[0]!.vmTelemetry = {
        resourceId: snapshot.recommendations[0]!.resourceId!,
        collectedAt: '2026-09-04T12:00:00.000Z',
        window: {
          startAt: '2026-08-05T00:00:00.000Z',
          endAt: '2026-09-04T00:00:00.000Z',
          interval: 'PT1H',
          expectedBuckets: 720,
        },
        availability: {
          expectedBuckets: 720,
          populatedBuckets: 700,
          unknownBuckets: 20,
          missingDataPercentage: 20 / 7.2,
          observedAvailableHours: 699,
          knownAvailabilityPercentage: 99.86,
          nearContinuousAvailability: true,
          contextValues: ['Customer'],
          caveat: 'Null availability remains unknown.',
        },
        metrics: [],
        activityLog: { events: [] },
        retrievalErrors: [],
        guestMemoryStatus: 'not_collected',
      }
      const scan = store.startScan('demo', 'demo')
      store.completeScan(scan.id, snapshot)

      expect(
        store.getRecommendation(snapshot.recommendations[0]!.id)?.vmTelemetry,
      ).toEqual(snapshot.recommendations[0]!.vmTelemetry)
    } finally {
      store.close()
    }
  })

  it('preserves telemetry-backed scheduling scenarios when restoring workspaces', () => {
    const store = new ProspectorStore(':memory:', { seed: false })
    try {
      const firstSnapshot = createDemoSnapshot(
        new Date('2026-09-04T12:00:00.000Z'),
      )
      const schedule = firstSnapshot.recommendations.find(
        (recommendation) =>
          recommendation.activity === 'shutdown_scheduling',
      )!
      schedule.estimatedMonthlySavings = 200
      schedule.calculatedMonthlySavings = 200
      schedule.claim = {
        ...schedule.claim,
        level: 'calculated_scenario',
        decisionStatus: 'needs_validation',
        validationState: 'deterministic_calculation',
        ruleVersion: 'vm-schedule-8-hours-weekday-v1',
        evidenceWindow: {
          startAt: '2026-08-05T00:00:00.000Z',
          endAt: '2026-09-04T00:00:00.000Z',
          lookbackDays: 30,
          description: 'Completed 30-day Azure Monitor window.',
        },
        provenance: {
          ...schedule.claim.provenance,
          sourceApi:
            'Azure Resource Graph, Azure Monitor Metrics and Azure Activity Log',
        },
        formula: {
          expression:
            'eligible_variable_vm_compute_cost * avoidable_observed_billable_hours / observed_billable_hours',
          inputs: [],
          assumptions: ['Eight hours per weekday.'],
          exclusions: ['Commitment effects.'],
          ruleVersion: 'vm-schedule-8-hours-weekday-v1',
        },
      }
      schedule.vmTelemetry = {
        resourceId: schedule.resourceId!,
        collectedAt: '2026-09-04T12:00:00.000Z',
        window: {
          startAt: '2026-08-05T00:00:00.000Z',
          endAt: '2026-09-04T00:00:00.000Z',
          interval: 'PT1H',
          expectedBuckets: 720,
        },
        availability: {
          expectedBuckets: 720,
          populatedBuckets: 720,
          unknownBuckets: 0,
          missingDataPercentage: 0,
          observedAvailableHours: 720,
          knownAvailabilityPercentage: 100,
          nearContinuousAvailability: true,
          contextValues: ['Customer'],
          caveat: 'Null remains unknown.',
        },
        metrics: [],
        activityLog: { events: [] },
        retrievalErrors: [],
        guestMemoryStatus: 'not_collected',
      }
      const first = store.startScan(
        'demo',
        'demo',
        undefined,
        'First workspace',
      )
      store.completeScan(first.id, firstSnapshot)

      const second = store.startScan(
        'demo',
        'demo',
        undefined,
        'Second workspace',
      )
      store.completeScan(second.id, createDemoSnapshot())
      store.activateAssessment(first.assessmentId!)

      const restored = store.getRecommendation(schedule.id)!
      expect(restored).toMatchObject({
        estimatedMonthlySavings: 200,
        calculatedMonthlySavings: 200,
        claim: {
          level: 'calculated_scenario',
          ruleVersion: 'vm-schedule-8-hours-weekday-v1',
          formula: {
            expression:
              'eligible_variable_vm_compute_cost * avoidable_observed_billable_hours / observed_billable_hours',
          },
        },
        vmTelemetry: {
          availability: { populatedBuckets: 720 },
        },
      })
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
            observedAmortizedCost: 100,
            opportunityScenarioCost: 100,
            measuredSavings: null,
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
          potentialMonthlySavings: 6689,
        },
      ])
      expect(completed.estimatedMonthlySavings).toBe(0)
      expect(completed.estimatedMonthlySavingsByCurrency).toEqual([
        { currency: 'GBP', amount: 50 },
        { currency: 'USD', amount: 6689 },
      ])
    } finally {
      store.close()
    }
  })

  it('does not add alternative findings for the same resource together', () => {
    const store = new ProspectorStore(':memory:', { seed: false })
    try {
      const snapshot = createDemoSnapshot(
        new Date('2026-09-01T12:00:00.000Z'),
      )
      const original = snapshot.recommendations[0]!
      snapshot.recommendations.push({
        ...original,
        id: 'alternative_scenario',
        fingerprint: 'alternative_scenario_fingerprint',
        estimatedMonthlySavings:
          (original.estimatedMonthlySavings ?? 0) - 1,
      })
      const scan = store.startScan('demo', 'demo')
      const completed = store.completeScan(scan.id, snapshot)

      const overview = store.getOverview()
      expect(
        overview.savings.byCurrency[0]?.potentialMonthlySavings,
      ).toBe(6689)
      expect(
        overview.categories.find(
          (item) => item.category === original.category,
        )?.recommendations,
      ).toBeGreaterThan(1)
      expect(completed.estimatedMonthlySavingsByCurrency).toEqual([
        { currency: 'USD', amount: 6689 },
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
        firstA.assessmentId,
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
      const partialScan = store.startScan(
        'live',
        'azure',
        'tenant-a',
        undefined,
        fullScan.assessmentId,
      )
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
      const excludedScan = store.startScan(
        'live',
        'azure',
        'tenant-a',
        undefined,
        fullScan.assessmentId,
      )
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
      const second = store.startScan(
        'live',
        'azure',
        'tenant-a',
        undefined,
        first.assessmentId,
      )
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

  it('persists, switches, rescans, and deletes named assessments', () => {
    const store = new ProspectorStore(':memory:', { seed: false })
    try {
      const snapshotA = liveSnapshot('tenant-a', 'a')
      const scanA = store.startScan(
        'live',
        'azure',
        'tenant-a',
        'Assessment A',
        undefined,
        ['subscription-a'],
      )
      store.upsertCollectedSnapshot(scanA.id, snapshotA)
      store.finishScan(scanA.id)
      const recommendationA = store.listRecommendations()[0]!
      store.createAction(recommendationA.id, {
        actionType: 'manual',
        title: 'Preserved action',
        requestedBy: 'operator@example.invalid',
      })

      const snapshotB = liveSnapshot('tenant-b', 'b')
      const scanB = store.startScan(
        'live',
        'azure',
        'tenant-b',
        'Assessment B',
        undefined,
        ['subscription-b'],
      )
      store.upsertCollectedSnapshot(scanB.id, snapshotB)
      store.finishScan(scanB.id)

      expect(store.listAssessments().map((item) => item.name)).toEqual([
        'Assessment B',
        'Assessment A',
      ])
      expect(store.getOverview().estate.assessmentName).toBe('Assessment B')

      store.activateAssessment(scanA.assessmentId!)
      expect(store.getOverview().estate.assessmentName).toBe('Assessment A')
      expect(store.listRecommendations()[0]?.id).toBe(recommendationA.id)
      expect(store.listActions()).toHaveLength(1)

      const rescanA = store.startScan(
        'live',
        'azure',
        'tenant-a',
        'Assessment A',
        scanA.assessmentId,
        ['subscription-a'],
      )
      store.upsertCollectedSnapshot(rescanA.id, snapshotA)
      store.finishScan(rescanA.id)
      expect(
        store
          .recentScans(10)
          .filter((scan) => scan.assessmentId === scanA.assessmentId),
      ).toHaveLength(2)
      expect(store.listActions()).toHaveLength(1)

      expect(store.deleteAssessment(scanB.assessmentId!)).toBe(true)
      expect(store.listAssessments().map((item) => item.name)).toEqual([
        'Assessment A',
      ])
      expect(store.deleteAssessment(scanA.assessmentId!)).toBe(true)
      expect(store.listAssessments()).toHaveLength(0)
      expect(store.listRecommendations()).toHaveLength(0)
      expect(store.getOverview().estate.lastScanAt).toBeUndefined()
    } finally {
      store.close()
    }
  })

  it('keeps completed metadata after a failed rescan and blocks switching while running', () => {
    const store = new ProspectorStore(':memory:', { seed: false })
    try {
      const assessmentA = liveSnapshot('tenant-a', 'a')
      const first = store.startScan(
        'live',
        'azure',
        'tenant-a',
        'Original assessment',
        undefined,
        ['subscription-a'],
      )
      store.completeScan(first.id, assessmentA)

      const assessmentB = liveSnapshot('tenant-b', 'b')
      const second = store.startScan(
        'live',
        'azure',
        'tenant-b',
        'Other assessment',
        undefined,
        ['subscription-b'],
      )
      store.completeScan(second.id, assessmentB)

      const rescan = store.startScan(
        'live',
        'azure',
        'tenant-b',
        'Uncommitted rename',
        second.assessmentId,
        ['different-subscription'],
      )
      expect(() => store.activateAssessment(first.assessmentId!)).toThrow(
        'cannot be switched while a scan is running',
      )
      store.failScan(rescan.id, 'Expected test failure')

      expect(store.getAssessment(second.assessmentId!)).toMatchObject({
        name: 'Other assessment',
        status: 'completed',
        selectedSubscriptionIds: ['subscription-b'],
      })
      expect(store.getOverview().estate.assessmentName).toBe(
        'Other assessment',
      )
    } finally {
      store.close()
    }
  })
})
