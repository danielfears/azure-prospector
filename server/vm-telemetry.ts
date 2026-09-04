import type { TokenCredential } from '@azure/identity'
import {
  MetricsClient,
  type Metric,
  type MetricsQueryResourcesOptions,
  type MetricsQueryResult,
} from '@azure/monitor-query-metrics'
import type {
  RecommendationFormula,
  VmActivityLogEvent,
  VmMetricSeriesSummary,
  VmMetricSummary,
  VmTelemetryEvidence,
} from '../src/shared/types.js'

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
const METRIC_NAMESPACE = 'Microsoft.Compute/virtualMachines'
const CPU_METRICS = ['Percentage CPU'] as const
const IO_METRICS = [
  'Network In Total',
  'Network Out Total',
  'Disk Read Bytes',
  'Disk Write Bytes',
] as const
export const AVAILABILITY_AGGREGATIONS = [
  'Average',
  'Minimum',
  'Maximum',
] as const
const CPU_AGGREGATIONS = ['Average'] as const
const IO_AGGREGATIONS = ['Total'] as const
const AVAILABILITY_CAVEAT =
  'A null or missing VmAvailabilityMetric bucket means unknown, not definitively deallocated. Azure can stop emitting the metric immediately after a control-plane stop.'

export const VM_SCHEDULE_SCENARIO_RULE_VERSION =
  'vm-schedule-8-hours-weekday-v1'
export const VM_SCHEDULE_MINIMUM_COVERAGE = 0.95
export const VM_SCHEDULE_MINIMUM_AVAILABILITY = 0.98

export interface CompletedTelemetryWindow {
  startAt: string
  endAt: string
  expectedBuckets: number
}

export interface VmTelemetryCandidate {
  resourceId: string
  subscriptionId: string
  location: string
}

export interface MetricsQueryClient {
  queryResources(
    resourceIds: string[],
    metricNames: string[],
    metricNamespace: string,
    options?: MetricsQueryResourcesOptions,
  ): Promise<MetricsQueryResult[]>
}

export type MetricsClientFactory = (
  endpoint: string,
  credential: TokenCredential,
) => MetricsQueryClient

export interface ActivityLogQueryResult {
  events: VmActivityLogEvent[]
  error?: string
}

export type ActivityLogQuery = (
  candidate: VmTelemetryCandidate,
  window: CompletedTelemetryWindow,
  abortSignal: AbortSignal,
) => Promise<ActivityLogQueryResult>

export type AvailabilityMetricQuery = (
  candidate: VmTelemetryCandidate,
  window: CompletedTelemetryWindow,
  abortSignal: AbortSignal,
) => Promise<Metric | undefined>

export interface VmTelemetryCollectionOptions {
  credential: TokenCredential
  candidates: VmTelemetryCandidate[]
  availabilityMetricQuery: AvailabilityMetricQuery
  activityLogQuery: ActivityLogQuery
  collectedAt: string
  window?: CompletedTelemetryWindow
  metricsClientFactory?: MetricsClientFactory
  concurrency?: number
  maximumAttempts?: number
  timeoutMilliseconds?: number
  retryDelayMilliseconds?: number
  batchSize?: number
}

export interface VmScheduleScenarioInput {
  telemetry: VmTelemetryEvidence
  eligibleVariableMonthlyCost: number | null
  currency: string | null
}

export interface VmScheduleScenarioResult {
  eligible: boolean
  reason: string
  estimatedMonthlySavings: number | null
  observedBillableHours: number
  targetOperatingHours: number
  avoidableObservedBillableHours: number
  formula?: RecommendationFormula
}

interface CandidateAccumulator {
  metrics: Metric[]
  metricErrors: string[]
  availabilityMetric?: Metric
  activityLogEvents: VmActivityLogEvent[]
  activityLogError?: string
}

export function completedThirtyDayWindow(
  now = new Date(),
): CompletedTelemetryWindow {
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  )
  const start = new Date(end.getTime() - 30 * DAY_MS)
  return {
    startAt: start.toISOString(),
    endAt: end.toISOString(),
    expectedBuckets: 30 * 24,
  }
}

function finite(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined
}

function percentile95(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? null
}

function average(values: number[]): number | null {
  if (!values.length) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function missingPercentage(
  populatedBuckets: number,
  expectedBuckets: number,
): number {
  if (expectedBuckets <= 0) return 100
  return Math.max(
    0,
    Math.min(100, (1 - populatedBuckets / expectedBuckets) * 100),
  )
}

function dimensions(
  values: Metric['timeseries'][number]['metadatavalues'],
): Record<string, string> {
  return Object.fromEntries(
    (values ?? [])
      .filter(
        (value): value is { name: string; value: string } =>
          typeof value.name === 'string' &&
          typeof value.value === 'string',
      )
      .map((value) => [value.name, value.value]),
  )
}

function pointValue(
  point: NonNullable<Metric['timeseries'][number]['data']>[number],
): number | undefined {
  return (
    finite(point.average) ??
    finite(point.total) ??
    finite(point.maximum) ??
    finite(point.minimum)
  )
}

function summarizeSeries(
  series: Metric['timeseries'][number],
  expectedBuckets: number,
): VmMetricSeriesSummary {
  const data = series.data ?? []
  const values = data.map(pointValue).filter((value): value is number =>
    Number.isFinite(value),
  )
  const minimumValues = data
    .map((point) => finite(point.minimum) ?? pointValue(point))
    .filter((value): value is number => value !== undefined)
  const maximumValues = data
    .map((point) => finite(point.maximum) ?? pointValue(point))
    .filter((value): value is number => value !== undefined)
  const totalValues = data
    .map((point) => finite(point.total))
    .filter((value): value is number => value !== undefined)
  const populatedBuckets = new Set(
    data
      .filter((point) => pointValue(point) !== undefined)
      .map((point) => point.timeStamp.toISOString()),
  ).size
  return {
    dimensions: dimensions(series.metadatavalues),
    sampleCount: data.reduce(
      (sum, point) =>
        sum +
        (finite(point.count) ??
          (pointValue(point) === undefined ? 0 : 1)),
      0,
    ),
    sampleCountBasis: data.some((point) => finite(point.count) !== undefined)
      ? 'azure_count'
      : 'populated_buckets',
    populatedBuckets,
    missingDataPercentage: missingPercentage(
      populatedBuckets,
      expectedBuckets,
    ),
    minimum: minimumValues.length ? Math.min(...minimumValues) : null,
    average: average(values),
    maximum: maximumValues.length ? Math.max(...maximumValues) : null,
    percentile95: percentile95(values),
    total: totalValues.length
      ? totalValues.reduce((sum, value) => sum + value, 0)
      : null,
  }
}

export function summarizeMetric(
  metric: Metric | undefined,
  name: string,
  expectedBuckets: number,
  requestedAggregations: readonly string[],
): VmMetricSummary {
  if (!metric) {
    return {
      name,
      unit: 'Unknown',
      requestedAggregations: [...requestedAggregations],
      expectedBuckets,
      populatedBuckets: 0,
      sampleCount: 0,
      sampleCountBasis: 'populated_buckets',
      missingDataPercentage: 100,
      minimum: null,
      average: null,
      maximum: null,
      percentile95: null,
      total: null,
      series: [],
      error: 'Metric was not returned by Azure Monitor.',
    }
  }
  const series = metric.timeseries.map((item) =>
    summarizeSeries(item, expectedBuckets),
  )
  const allData = metric.timeseries.flatMap((item) => item.data ?? [])
  const values = allData
    .map(pointValue)
    .filter((value): value is number => value !== undefined)
  const minimumValues = allData
    .map((point) => finite(point.minimum) ?? pointValue(point))
    .filter((value): value is number => value !== undefined)
  const maximumValues = allData
    .map((point) => finite(point.maximum) ?? pointValue(point))
    .filter((value): value is number => value !== undefined)
  const totalValues = allData
    .map((point) => finite(point.total))
    .filter((value): value is number => value !== undefined)
  const populatedBuckets = new Set(
    allData
      .filter((point) => pointValue(point) !== undefined)
      .map((point) => point.timeStamp.toISOString()),
  ).size
  return {
    name,
    unit: metric.unit,
    requestedAggregations: [...requestedAggregations],
    expectedBuckets,
    populatedBuckets,
    sampleCount: allData.reduce(
      (sum, point) =>
        sum +
        (finite(point.count) ??
          (pointValue(point) === undefined ? 0 : 1)),
      0,
    ),
    sampleCountBasis: allData.some(
      (point) => finite(point.count) !== undefined,
    )
      ? 'azure_count'
      : 'populated_buckets',
    missingDataPercentage: missingPercentage(
      populatedBuckets,
      expectedBuckets,
    ),
    minimum: minimumValues.length ? Math.min(...minimumValues) : null,
    average: average(values),
    maximum: maximumValues.length ? Math.max(...maximumValues) : null,
    percentile95: percentile95(values),
    total: totalValues.length
      ? totalValues.reduce((sum, value) => sum + value, 0)
      : null,
    series,
    ...(metric.errorCode || metric.errorMessage
      ? {
          error: [metric.errorCode, metric.errorMessage]
            .filter(Boolean)
            .join(': '),
        }
      : {}),
  }
}

function hourKey(timestamp: Date): string {
  return new Date(
    Date.UTC(
      timestamp.getUTCFullYear(),
      timestamp.getUTCMonth(),
      timestamp.getUTCDate(),
      timestamp.getUTCHours(),
    ),
  ).toISOString()
}

export function summarizeAvailability(
  metric: Metric | undefined,
  expectedBuckets: number,
): VmTelemetryEvidence['availability'] {
  const byHour = new Map<string, number[]>()
  const contextValues = new Set<string>()
  for (const series of metric?.timeseries ?? []) {
    for (const [key, value] of Object.entries(dimensions(series.metadatavalues))) {
      if (key.toLowerCase() === 'context') contextValues.add(value)
    }
    for (const point of series.data ?? []) {
      const value = finite(point.average)
      if (value === undefined) continue
      const key = hourKey(point.timeStamp)
      const existing = byHour.get(key) ?? []
      existing.push(Math.max(0, Math.min(1, value)))
      byHour.set(key, existing)
    }
  }
  const hourlyValues = [...byHour.values()].map((values) =>
    Math.min(...values),
  )
  const populatedBuckets = hourlyValues.length
  const unknownBuckets = Math.max(0, expectedBuckets - populatedBuckets)
  const observedAvailableHours = hourlyValues.reduce(
    (sum, value) => sum + value,
    0,
  )
  const coverage =
    expectedBuckets > 0 ? populatedBuckets / expectedBuckets : 0
  const availability =
    populatedBuckets > 0 ? observedAvailableHours / populatedBuckets : 0
  return {
    expectedBuckets,
    populatedBuckets,
    unknownBuckets,
    missingDataPercentage: missingPercentage(
      populatedBuckets,
      expectedBuckets,
    ),
    observedAvailableHours,
    knownAvailabilityPercentage:
      populatedBuckets > 0 ? availability * 100 : null,
    nearContinuousAvailability:
      coverage >= VM_SCHEDULE_MINIMUM_COVERAGE &&
      availability >= VM_SCHEDULE_MINIMUM_AVAILABILITY,
    contextValues: [...contextValues].sort(),
    caveat: AVAILABILITY_CAVEAT,
  }
}

function weekdayTargetHours(window: CompletedTelemetryWindow): number {
  const start = new Date(window.startAt)
  const end = new Date(window.endAt)
  let weekdays = 0
  for (
    let current = start.getTime();
    current < end.getTime();
    current += DAY_MS
  ) {
    const day = new Date(current).getUTCDay()
    if (day !== 0 && day !== 6) weekdays += 1
  }
  return weekdays * 8
}

export function evaluateVmScheduleScenario(
  input: VmScheduleScenarioInput,
): VmScheduleScenarioResult {
  const availability = input.telemetry.availability
  const targetOperatingHours = weekdayTargetHours({
    startAt: input.telemetry.window.startAt,
    endAt: input.telemetry.window.endAt,
    expectedBuckets: input.telemetry.window.expectedBuckets,
  })
  const observedBillableHours = availability.observedAvailableHours
  const avoidableObservedBillableHours = Math.max(
    0,
    observedBillableHours - targetOperatingHours,
  )
  const coverage =
    availability.expectedBuckets > 0
      ? availability.populatedBuckets / availability.expectedBuckets
      : 0
  if (
    input.eligibleVariableMonthlyCost === null ||
    input.eligibleVariableMonthlyCost <= 0 ||
    input.currency === null
  ) {
    return {
      eligible: false,
      reason: 'A native-currency VM compute cost baseline is required.',
      estimatedMonthlySavings: null,
      observedBillableHours,
      targetOperatingHours,
      avoidableObservedBillableHours,
    }
  }
  if (coverage < VM_SCHEDULE_MINIMUM_COVERAGE) {
    return {
      eligible: false,
      reason: `VmAvailabilityMetric coverage is ${(coverage * 100).toFixed(
        1,
      )}%; at least ${VM_SCHEDULE_MINIMUM_COVERAGE * 100}% is required.`,
      estimatedMonthlySavings: null,
      observedBillableHours,
      targetOperatingHours,
      avoidableObservedBillableHours,
    }
  }
  if (!availability.nearContinuousAvailability) {
    return {
      eligible: false,
      reason: `Known availability was ${(
        availability.knownAvailabilityPercentage ?? 0
      ).toFixed(1)}%; at least ${
        VM_SCHEDULE_MINIMUM_AVAILABILITY * 100
      }% is required.`,
      estimatedMonthlySavings: null,
      observedBillableHours,
      targetOperatingHours,
      avoidableObservedBillableHours,
    }
  }
  if (observedBillableHours <= targetOperatingHours) {
    return {
      eligible: false,
      reason:
        'Observed available hours do not exceed the eight-hours-per-weekday scenario.',
      estimatedMonthlySavings: null,
      observedBillableHours,
      targetOperatingHours,
      avoidableObservedBillableHours,
    }
  }

  const estimatedMonthlySavings =
    input.eligibleVariableMonthlyCost *
    (avoidableObservedBillableHours / observedBillableHours)
  return {
    eligible: true,
    reason:
      'The completed 30-day window has sufficient coverage and demonstrates near-continuous availability.',
    estimatedMonthlySavings,
    observedBillableHours,
    targetOperatingHours,
    avoidableObservedBillableHours,
    formula: {
      expression:
        'eligible_variable_vm_compute_cost * avoidable_observed_billable_hours / observed_billable_hours',
      inputs: [
        {
          name: 'eligible_variable_vm_compute_cost',
          value: input.eligibleVariableMonthlyCost,
          unit: input.currency,
          sourceEvidenceLabel: 'Median completed-month amortized cost',
        },
        {
          name: 'observed_billable_hours',
          value: observedBillableHours,
          unit: 'hours',
        },
        {
          name: 'avoidable_observed_billable_hours',
          value: avoidableObservedBillableHours,
          unit: 'hours',
        },
        {
          name: 'target_hours_per_weekday',
          value: 8,
          unit: 'hours',
        },
        {
          name: 'scenario_horizon',
          value: 30,
          unit: 'days',
        },
      ],
      assumptions: [
        'The counterfactual runs the VM for eight hours on each weekday and zero hours at weekends.',
        'Numeric VmAvailabilityMetric hourly averages approximate observed billable running hours.',
        'Required operating hours must be validated before any shutdown change.',
        'The PricingModel=OnDemand or Spot portion of resource-attributed median completed-month amortized VM cost is used as the eligible variable compute-cost proxy.',
      ],
      exclusions: [
        'Managed disks, public IPs, backup, monitoring and other fixed resource costs.',
        'Reservation, Savings Plan, Azure Hybrid Benefit and other commitment effects.',
        'Startup, shutdown and workload recovery overhead.',
        'Unknown VmAvailabilityMetric buckets and guest-memory behavior.',
      ],
      ruleVersion: VM_SCHEDULE_SCENARIO_RULE_VERSION,
    },
  }
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size))
  }
  return result
}

async function sleep(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

async function withRetriesAndTimeout<T>(
  operation: (abortSignal: AbortSignal) => Promise<T>,
  maximumAttempts: number,
  timeoutMilliseconds: number,
  retryDelayMilliseconds: number,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMilliseconds)
    try {
      return await operation(controller.signal)
    } catch (error) {
      lastError = error
      if (attempt + 1 < maximumAttempts) {
        await sleep(retryDelayMilliseconds * 2 ** attempt)
      }
    } finally {
      clearTimeout(timeout)
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('Azure telemetry request failed')
}

export async function runWithConcurrency(
  operations: Array<() => Promise<void>>,
  concurrency: number,
): Promise<void> {
  let index = 0
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), operations.length) },
    async () => {
      while (index < operations.length) {
        const operation = operations[index]
        index += 1
        if (operation) await operation()
      }
    },
  )
  await Promise.all(workers)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : 'Unknown error'
}

function defaultMetricsClientFactory(
  endpoint: string,
  credential: TokenCredential,
): MetricsQueryClient {
  return new MetricsClient(endpoint, credential, {
    retryOptions: {
      maxRetries: 1,
      retryDelayInMs: 500,
      maxRetryDelayInMs: 2_000,
    },
  })
}

function metricEndpoint(location: string): string {
  const region = location.toLowerCase().replaceAll(/[^a-z0-9]/g, '')
  return `https://${region}.metrics.monitor.azure.com`
}

function metricByName(metrics: Metric[], name: string): Metric | undefined {
  return metrics.find(
    (metric) => metric.name.toLowerCase() === name.toLowerCase(),
  )
}

export async function collectVmTelemetry(
  options: VmTelemetryCollectionOptions,
): Promise<Map<string, VmTelemetryEvidence>> {
  const candidates = [
    ...new Map(
      options.candidates.map((candidate) => [
        candidate.resourceId.toLowerCase(),
        candidate,
      ]),
    ).values(),
  ]
  if (!candidates.length) return new Map()
  const window = options.window ?? completedThirtyDayWindow()
  const concurrency = Math.floor(
    Math.max(1, Math.min(8, options.concurrency ?? 3)),
  )
  const maximumAttempts = Math.floor(
    Math.max(
      1,
      Math.min(3, options.maximumAttempts ?? 2),
    ),
  )
  const timeoutMilliseconds = Math.max(
    1_000,
    Math.min(120_000, options.timeoutMilliseconds ?? 20_000),
  )
  const retryDelayMilliseconds = Math.max(
    0,
    Math.min(10_000, options.retryDelayMilliseconds ?? 500),
  )
  const batchSize = Math.floor(
    Math.max(1, Math.min(50, options.batchSize ?? 20)),
  )
  const clientFactory =
    options.metricsClientFactory ?? defaultMetricsClientFactory
  const accumulators = new Map<string, CandidateAccumulator>(
    candidates.map((candidate) => [
      candidate.resourceId.toLowerCase(),
      {
        metrics: [],
        metricErrors: [],
        activityLogEvents: [],
      },
    ]),
  )
  const groups = new Map<string, VmTelemetryCandidate[]>()
  for (const candidate of candidates) {
    const key = `${candidate.subscriptionId.toLowerCase()}|${candidate.location.toLowerCase()}`
    const group = groups.get(key) ?? []
    group.push(candidate)
    groups.set(key, group)
  }

  const operations: Array<() => Promise<void>> = []
  for (const group of groups.values()) {
    for (const batch of chunks(group, batchSize)) {
      operations.push(async () => {
        const resourceIds = batch.map((candidate) => candidate.resourceId)
        const client = clientFactory(
          metricEndpoint(batch[0]!.location),
          options.credential,
        )
        for (const request of [
          {
            metricNames: [...CPU_METRICS],
            aggregations: [...CPU_AGGREGATIONS],
          },
          {
            metricNames: [...IO_METRICS],
            aggregations: [...IO_AGGREGATIONS],
          },
        ]) {
          try {
            const results = await withRetriesAndTimeout(
              (abortSignal) => {
                const queryOptions: MetricsQueryResourcesOptions & {
                  abortSignal: AbortSignal
                } = {
                  startTime: new Date(window.startAt),
                  endTime: new Date(window.endAt),
                  interval: 'PT1H',
                  aggregation: request.aggregations.join(','),
                  abortSignal,
                }
                return client.queryResources(
                  resourceIds,
                  request.metricNames,
                  METRIC_NAMESPACE,
                  queryOptions,
                )
              },
              maximumAttempts,
              timeoutMilliseconds,
              retryDelayMilliseconds,
            )
            for (const [resultIndex, result] of results.entries()) {
              const resourceId =
                result.resourceId ?? resourceIds[resultIndex]
              if (!resourceId) continue
              accumulators
                .get(resourceId.toLowerCase())
                ?.metrics.push(...result.metrics)
            }
          } catch (error) {
            const message = `${request.metricNames.join(', ')}: ${errorMessage(
              error,
            )}`
            for (const candidate of batch) {
              accumulators
                .get(candidate.resourceId.toLowerCase())
                ?.metricErrors.push(message)
            }
          }
        }
      })
    }
  }
  for (const candidate of candidates) {
    operations.push(async () => {
      const accumulator = accumulators.get(candidate.resourceId.toLowerCase())!
      try {
        accumulator.availabilityMetric = await withRetriesAndTimeout(
          (abortSignal) =>
            options.availabilityMetricQuery(
              candidate,
              window,
              abortSignal,
            ),
          maximumAttempts,
          timeoutMilliseconds,
          retryDelayMilliseconds,
        )
      } catch (error) {
        accumulator.metricErrors.push(
          `VmAvailabilityMetric: ${errorMessage(error)}`,
        )
      }
    })
    operations.push(async () => {
      const accumulator = accumulators.get(candidate.resourceId.toLowerCase())!
      try {
        const result = await withRetriesAndTimeout(
          (abortSignal) =>
            options.activityLogQuery(candidate, window, abortSignal),
          maximumAttempts,
          timeoutMilliseconds,
          retryDelayMilliseconds,
        )
        accumulator.activityLogEvents = result.events
        accumulator.activityLogError = result.error
      } catch (error) {
        accumulator.activityLogError = errorMessage(error)
      }
    })
  }
  await runWithConcurrency(operations, concurrency)

  return new Map(
    candidates.map((candidate) => {
      const accumulator = accumulators.get(candidate.resourceId.toLowerCase())!
      const metrics = [
        summarizeMetric(
          accumulator.availabilityMetric,
          'VmAvailabilityMetric',
          window.expectedBuckets,
          AVAILABILITY_AGGREGATIONS,
        ),
        ...CPU_METRICS.map((name) =>
          summarizeMetric(
            metricByName(accumulator.metrics, name),
            name,
            window.expectedBuckets,
            CPU_AGGREGATIONS,
          ),
        ),
        ...IO_METRICS.map((name) =>
          summarizeMetric(
            metricByName(accumulator.metrics, name),
            name,
            window.expectedBuckets,
            IO_AGGREGATIONS,
          ),
        ),
      ]
      const availabilityMetric = accumulator.availabilityMetric
      const retrievalErrors = [
        ...accumulator.metricErrors,
        ...metrics
          .filter((metric) => metric.error)
          .map((metric) => `${metric.name}: ${metric.error}`),
        ...(accumulator.activityLogError
          ? [`Activity Log: ${accumulator.activityLogError}`]
          : []),
      ]
      return [
        candidate.resourceId.toLowerCase(),
        {
          resourceId: candidate.resourceId,
          collectedAt: options.collectedAt,
          window: {
            startAt: window.startAt,
            endAt: window.endAt,
            interval: 'PT1H' as const,
            expectedBuckets: window.expectedBuckets,
          },
          availability: summarizeAvailability(
            availabilityMetric,
            window.expectedBuckets,
          ),
          metrics,
          activityLog: {
            events: accumulator.activityLogEvents,
            ...(accumulator.activityLogError
              ? { error: accumulator.activityLogError }
              : {}),
          },
          retrievalErrors,
          guestMemoryStatus: 'not_collected' as const,
        },
      ]
    }),
  )
}
