import type { TokenCredential } from '@azure/identity'
import type {
  Metric,
  MetricUnit,
  MetricsQueryResult,
} from '@azure/monitor-query-metrics'
import { describe, expect, it } from 'vitest'
import type { VmTelemetryEvidence } from '../src/shared/types.js'
import {
  collectVmTelemetry,
  completedThirtyDayWindow,
  evaluateVmScheduleScenario,
  runWithConcurrency,
  summarizeAvailability,
  summarizeMetric,
  VM_SCHEDULE_MINIMUM_COVERAGE,
  VM_SCHEDULE_SCENARIO_RULE_VERSION,
} from './vm-telemetry.js'

const window = completedThirtyDayWindow(
  new Date('2026-09-04T12:30:00.000Z'),
)
const resourceId =
  '/subscriptions/sub-one/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm-one'

function metric(
  name: string,
  values: Array<number | null>,
  options: {
    unit?: MetricUnit
    total?: boolean
    dimensions?: Record<string, string>
  } = {},
): Metric {
  return {
    id: `${resourceId}/providers/microsoft.insights/metrics/${name}`,
    type: 'Microsoft.Insights/metrics',
    name,
    unit: options.unit ?? 'Count',
    timeseries: [
      {
        metadatavalues: Object.entries(options.dimensions ?? {}).map(
          ([dimensionName, value]) => ({
            name: dimensionName,
            value,
          }),
        ),
        data: values.map((value, index) => ({
          timeStamp: new Date(
            new Date(window.startAt).getTime() + index * 3_600_000,
          ),
          ...(value === null
            ? {}
            : options.total
              ? { total: value, count: 60 }
              : {
                  average: value,
                  minimum: value,
                  maximum: value,
                  count: 60,
                }),
        })),
      },
    ],
  }
}

function queryResult(
  resource: string,
  metrics: Metric[],
): MetricsQueryResult {
  return {
    resourceId: resource,
    resourceRegion: 'uksouth',
    namespace: 'Microsoft.Compute/virtualMachines',
    granularity: 'PT1H',
    timespan: {
      startTime: new Date(window.startAt),
      endTime: new Date(window.endAt),
    },
    metrics,
    getMetricByName(name: string) {
      return metrics.find((item) => item.name === name)
    },
  }
}

function telemetry(availabilityValues: Array<number | null>): VmTelemetryEvidence {
  const availabilityMetric = metric(
    'VmAvailabilityMetric',
    availabilityValues,
    { dimensions: { Context: 'Customer' } },
  )
  return {
    resourceId,
    collectedAt: window.endAt,
    window: {
      ...window,
      interval: 'PT1H',
    },
    availability: summarizeAvailability(
      availabilityMetric,
      window.expectedBuckets,
    ),
    metrics: [
      summarizeMetric(
        availabilityMetric,
        'VmAvailabilityMetric',
        window.expectedBuckets,
        ['Average', 'Minimum', 'Maximum', 'Count'],
      ),
    ],
    activityLog: { events: [] },
    retrievalErrors: [],
    guestMemoryStatus: 'not_collected',
  }
}

const credential: TokenCredential = {
  async getToken() {
    return {
      token: 'test-token',
      expiresOnTimestamp: Date.now() + 60_000,
    }
  },
}

describe('VM telemetry evidence', () => {
  it('uses an exact completed 30-day UTC window', () => {
    expect(window).toEqual({
      startAt: '2026-08-05T00:00:00.000Z',
      endAt: '2026-09-04T00:00:00.000Z',
      expectedBuckets: 720,
    })
  })

  it('summarizes full availability with samples and dimensions', () => {
    const evidence = telemetry(Array.from({ length: 720 }, () => 1))
    expect(evidence.availability).toMatchObject({
      populatedBuckets: 720,
      unknownBuckets: 0,
      missingDataPercentage: 0,
      observedAvailableHours: 720,
      knownAvailabilityPercentage: 100,
      nearContinuousAvailability: true,
      contextValues: ['Customer'],
    })
    expect(evidence.availability.caveat).toContain(
      'unknown, not definitively deallocated',
    )
    expect(evidence.metrics[0]).toMatchObject({
      sampleCount: 43_200,
      expectedBuckets: 720,
      populatedBuckets: 720,
      minimum: 1,
      average: 1,
      maximum: 1,
      percentile95: 1,
    })
  })

  it('keeps null buckets unknown and rejects insufficient coverage', () => {
    const partial = telemetry([
      ...Array.from({ length: 700 }, () => 1),
      ...Array.from({ length: 20 }, () => null),
    ])
    expect(partial.availability.unknownBuckets).toBe(20)
    expect(partial.availability.observedAvailableHours).toBe(700)
    expect(partial.availability.nearContinuousAvailability).toBe(true)

    const insufficient = telemetry([
      ...Array.from({ length: 600 }, () => 1),
      ...Array.from({ length: 120 }, () => null),
    ])
    const scenario = evaluateVmScheduleScenario({
      telemetry: insufficient,
      eligibleVariableMonthlyCost: 300,
      currency: 'GBP',
    })
    expect(
      insufficient.availability.populatedBuckets /
        insufficient.availability.expectedBuckets,
    ).toBeLessThan(VM_SCHEDULE_MINIMUM_COVERAGE)
    expect(scenario).toMatchObject({
      eligible: false,
      estimatedMonthlySavings: null,
    })
    expect(scenario.reason).toContain('coverage')
  })

  it('builds a transparent eight-hours-per-weekday scenario', () => {
    const scenario = evaluateVmScheduleScenario({
      telemetry: telemetry(Array.from({ length: 720 }, () => 1)),
      eligibleVariableMonthlyCost: 300,
      currency: 'GBP',
    })
    expect(scenario.eligible).toBe(true)
    expect(scenario.observedBillableHours).toBe(720)
    expect(scenario.targetOperatingHours).toBe(176)
    expect(scenario.avoidableObservedBillableHours).toBe(544)
    expect(scenario.estimatedMonthlySavings).toBeCloseTo(226.67, 2)
    expect(scenario.formula).toMatchObject({
      expression:
        'eligible_variable_vm_compute_cost * avoidable_observed_billable_hours / observed_billable_hours',
      ruleVersion: VM_SCHEDULE_SCENARIO_RULE_VERSION,
    })
    expect(scenario.formula?.exclusions.join(' ')).toMatch(
      /disks.*public IPs.*backup/i,
    )
    expect(scenario.formula?.exclusions.join(' ')).toMatch(
      /Reservation.*Savings Plan/i,
    )
  })

  it('uses resource-scoped availability when the batch endpoint omits it', async () => {
    const availability = metric(
      'VmAvailabilityMetric',
      Array.from({ length: 720 }, () => 1),
    )
    const cpu = metric(
      'Percentage CPU',
      Array.from({ length: 720 }, () => 5),
      { unit: 'Percent' },
    )
    const result = await collectVmTelemetry({
      credential,
      candidates: [
        {
          resourceId,
          subscriptionId: 'sub-one',
          location: 'uksouth',
        },
      ],
      collectedAt: window.endAt,
      window,
      maximumAttempts: 1,
      async availabilityMetricQuery() {
        return availability
      },
      metricsClientFactory: () => ({
        async queryResources(
          resources,
          metricNames,
          _metricNamespace,
          options,
        ) {
          if (metricNames.includes('VmAvailabilityMetric')) {
            expect(options?.filter).toBeUndefined()
          }
          if (metricNames.includes('Network In Total')) {
            throw new Error('Optional IO metrics unavailable')
          }
          return resources.map((resource) =>
            queryResult(resource, [cpu]),
          )
        },
      }),
      async activityLogQuery() {
        return {
          events: [
            {
              operation: 'Microsoft.Compute/virtualMachines/start/action',
              status: 'Succeeded',
              timestamp: '2026-08-10T08:00:00.000Z',
            },
          ],
        }
      },
    })
    const evidence = result.get(resourceId.toLowerCase())!
    expect(evidence.activityLog.events).toHaveLength(1)
    expect(evidence.availability.populatedBuckets).toBe(720)
    expect(evidence.retrievalErrors.join(' ')).toContain(
      'Optional IO metrics unavailable',
    )
    expect(
      evidence.metrics.find((item) => item.name === 'Percentage CPU'),
    ).toMatchObject({ average: 5, percentile95: 5 })
  })

  it('records failed metrics without converting missing data to downtime', async () => {
    const result = await collectVmTelemetry({
      credential,
      candidates: [
        {
          resourceId,
          subscriptionId: 'sub-one',
          location: 'uksouth',
        },
      ],
      collectedAt: window.endAt,
      window,
      maximumAttempts: 1,
      async availabilityMetricQuery() {
        throw new Error('Monitoring Reader required')
      },
      metricsClientFactory: () => ({
        async queryResources() {
          throw new Error('Regional metrics unavailable')
        },
      }),
      async activityLogQuery() {
        throw new Error('Activity Log unavailable')
      },
    })
    const evidence = result.get(resourceId.toLowerCase())!
    expect(evidence.availability).toMatchObject({
      populatedBuckets: 0,
      unknownBuckets: 720,
      observedAvailableHours: 0,
      nearContinuousAvailability: false,
    })
    expect(evidence.retrievalErrors.join(' ')).toContain(
      'Monitoring Reader required',
    )
    expect(evidence.activityLog.error).toBe('Activity Log unavailable')
  })

  it('bounds resource-scoped availability retries', async () => {
    let attempts = 0
    const availability = metric(
      'VmAvailabilityMetric',
      Array.from({ length: 720 }, () => 1),
    )
    const result = await collectVmTelemetry({
      credential,
      candidates: [
        {
          resourceId,
          subscriptionId: 'sub-one',
          location: 'uksouth',
        },
      ],
      collectedAt: window.endAt,
      window,
      maximumAttempts: 2,
      retryDelayMilliseconds: 0,
      async availabilityMetricQuery() {
        attempts += 1
        if (attempts === 1) throw new Error('Transient metrics failure')
        return availability
      },
      metricsClientFactory: () => ({
        async queryResources(resources) {
          return resources.map((resource) => queryResult(resource, []))
        },
      }),
      async activityLogQuery() {
        return { events: [] }
      },
    })

    expect(attempts).toBe(2)
    expect(
      result.get(resourceId.toLowerCase())?.availability.populatedBuckets,
    ).toBe(720)
  })

  it('bounds concurrent resource-scoped availability requests', async () => {
    let active = 0
    let maximumActive = 0
    let calls = 0
    const availability = metric(
      'VmAvailabilityMetric',
      Array.from({ length: 720 }, () => 1),
    )
    await collectVmTelemetry({
      credential,
      candidates: Array.from({ length: 6 }, (_, index) => ({
        resourceId: `${resourceId}-${index}`,
        subscriptionId: 'sub-one',
        location: 'uksouth',
      })),
      collectedAt: window.endAt,
      window,
      concurrency: 3,
      maximumAttempts: 1,
      async availabilityMetricQuery() {
        calls += 1
        active += 1
        maximumActive = Math.max(maximumActive, active)
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 5)
        })
        active -= 1
        return availability
      },
      metricsClientFactory: () => ({
        async queryResources(resources) {
          return resources.map((resource) => queryResult(resource, []))
        },
      }),
      async activityLogQuery() {
        return { events: [] }
      },
    })

    expect(calls).toBe(6)
    expect(maximumActive).toBeLessThanOrEqual(3)
  })

  it('bounds concurrent Azure telemetry operations', async () => {
    let active = 0
    let maximumActive = 0
    const operations = Array.from({ length: 12 }, () => async () => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5)
      })
      active -= 1
    })
    await runWithConcurrency(operations, 3)
    expect(maximumActive).toBe(3)
  })
})
