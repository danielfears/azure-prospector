import { createHash } from 'node:crypto'
import {
  AzureCliCredential,
  DefaultAzureCredential,
  InteractiveBrowserCredential,
  ManagedIdentityCredential,
  type TokenCredential,
} from '@azure/identity'
import type {
  Metric,
  MetricUnit,
} from '@azure/monitor-query-metrics'
import type {
  ConfidenceBand,
  EvidencePoint,
  RecommendationClaim,
  RecommendationCategory,
  RecommendationOwner,
  SavingsActivity,
  SerializableScalar,
  VmActivityLogEvent,
  VmTelemetryEvidence,
} from '../../src/shared/types.js'
import {
  classifySavingsActivity,
  savingsOpportunityScopeKey,
} from '../../src/shared/savings-activity.js'
import type {
  ProspectorProvider,
  ProviderCollectRequest,
  ProviderSnapshot,
  SnapshotRecommendation,
  SnapshotSubscription,
} from './types.js'
import { configuredSubscriptionIds } from '../azure-config.js'
import {
  calculateOpportunityReductionRatios,
  selectSupportedOpportunityRecommendations,
} from '../opportunity-scenario.js'
import {
  collectVmTelemetry,
  completedThirtyDayWindow,
  evaluateVmScheduleScenario,
  type ActivityLogQueryResult,
  type AvailabilityMetricQuery,
  type MetricsClientFactory,
  VM_SCHEDULE_MINIMUM_COVERAGE,
  type VmTelemetryCandidate,
} from '../vm-telemetry.js'

const ARM_ORIGIN = 'https://management.azure.com'
const ARM_SCOPE = 'https://management.azure.com/.default'
const RESOURCE_GRAPH_API_VERSION = '2022-10-01'
const COST_API_VERSION = '2023-11-01'
const ACTIVITY_LOG_API_VERSION = '2015-04-01'
const METRICS_API_VERSION = '2023-10-01'
const ADVISOR_RULE_VERSION = 'azure-advisor-v2'
const ORPHAN_RULE_VERSION = 'azure-resource-orphan-v2'
const SCHEDULE_RULE_VERSION = 'devtestlab-schedule-gap-v2'
const DEFAULT_OWNER_TAGS = [
  'owner',
  'serviceOwner',
  'applicationOwner',
  'technicalOwner',
]

interface ArmSubscription {
  subscriptionId: string
  displayName: string
  state: string
  tenantId?: string
}

interface ResourceGraphResponse {
  data?: unknown[]
  $skipToken?: string
  skipToken?: string
}

interface ResourceRecord {
  id: string
  name: string
  type: string
  subscriptionId: string
  resourceGroup?: string
  location?: string
  tags: Record<string, string>
  properties: Record<string, unknown>
}

interface CostQueryResult {
  subscriptionId: string
  currency?: string
  representativeByResource: Map<string, number>
  representativeVariableByResource: Map<string, number>
  monthlyTotals: Map<string, number>
  representativeTotal: number
}

class ArmRequestError extends Error {
  readonly status: number
  readonly code?: string
  readonly retryAfterSeconds?: number

  constructor(
    status: number,
    operation: string,
    code?: string,
    retryAfterMilliseconds?: number,
  ) {
    super(
      `${operation} failed with Azure HTTP status ${status}${code ? ` (${code})` : ''}`,
    )
    this.name = 'ArmRequestError'
    this.status = status
    this.code = code
    this.retryAfterSeconds =
      retryAfterMilliseconds === undefined
        ? undefined
        : Math.ceil(retryAfterMilliseconds / 1000)
  }
}

function createCredential(requestedTenantId?: string): TokenCredential {
  const mode = (process.env.PROSPECTOR_AUTH_MODE ?? 'default')
    .trim()
    .toLowerCase()
    .replaceAll('-', '_')
  const tenantId = requestedTenantId ?? process.env.AZURE_TENANT_ID
  const clientId = process.env.AZURE_CLIENT_ID

  switch (mode) {
    case 'default':
    case 'default_credential':
      return new DefaultAzureCredential({
        tenantId,
        managedIdentityClientId: clientId,
      })
    case 'cli':
    case 'azure_cli':
      return new AzureCliCredential({ tenantId })
    case 'managed_identity':
      return new ManagedIdentityCredential({ clientId })
    case 'interactive':
    case 'interactive_browser':
      if (!clientId) {
        throw new Error(
          'AZURE_CLIENT_ID is required when PROSPECTOR_AUTH_MODE is interactive_browser',
        )
      }
      return new InteractiveBrowserCredential({ clientId, tenantId })
    default:
      throw new Error(
        'PROSPECTOR_AUTH_MODE must be default, cli, managed_identity, or interactive_browser',
      )
  }
}

function ownerTagNames(): string[] {
  const configured = process.env.PROSPECTOR_OWNER_TAGS
  if (!configured?.trim()) return DEFAULT_OWNER_TAGS
  const values = configured
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  return values.length ? values : DEFAULT_OWNER_TAGS
}

function stableId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24)
}

function confidenceBand(value: number): ConfidenceBand {
  if (value >= 0.8) return 'high'
  if (value >= 0.6) return 'medium'
  return 'low'
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const normalized = value.replaceAll(',', '').replace(/[^\d.-]/g, '')
    const parsed = Number(normalized)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function median(values: number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const midpoint = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? sorted[midpoint]!
    : (sorted[midpoint - 1]! + sorted[midpoint]!) / 2
}

function monthlyPeriod(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const text = String(value)
  const compactMatch = /^(\d{4})(\d{2})/.exec(text)
  if (compactMatch) return `${compactMatch[1]}-${compactMatch[2]}`
  const isoMatch = /^(\d{4})-(\d{2})/.exec(text)
  return isoMatch ? `${isoMatch[1]}-${isoMatch[2]}` : undefined
}

function firstNumber(
  object: Record<string, unknown>,
  keys: string[],
): number | undefined {
  const lowered = new Map(
    Object.entries(object).map(([key, value]) => [key.toLowerCase(), value]),
  )
  for (const key of keys) {
    const value = finiteNumber(lowered.get(key.toLowerCase()))
    if (value !== undefined) return value
  }
  return undefined
}

function firstString(
  object: Record<string, unknown>,
  keys: string[],
): string | undefined {
  const lowered = new Map(
    Object.entries(object).map(([key, value]) => [key.toLowerCase(), value]),
  )
  for (const key of keys) {
    const value = lowered.get(key.toLowerCase())
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }
  return undefined
}

function normalizeTags(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .map(([key, tagValue]) => [key, tagValue]),
  )
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

const METRIC_UNITS = new Set<MetricUnit>([
  'Count',
  'Bytes',
  'Seconds',
  'CountPerSecond',
  'BytesPerSecond',
  'Percent',
  'MilliSeconds',
  'ByteSeconds',
  'Unspecified',
  'Cores',
  'MilliCores',
  'NanoCores',
  'BitsPerSecond',
])

function metricUnit(value: unknown): MetricUnit {
  return typeof value === 'string' && METRIC_UNITS.has(value as MetricUnit)
    ? (value as MetricUnit)
    : 'Unspecified'
}

function resourceScopedMetric(value: unknown): Metric | undefined {
  const row = asObject(value)
  const nameObject = asObject(row.name)
  const name =
    firstString(nameObject, ['value', 'localizedValue']) ??
    (typeof row.name === 'string' ? row.name : undefined)
  if (!name) return undefined
  const timeseries = Array.isArray(row.timeseries) ? row.timeseries : []
  return {
    id: typeof row.id === 'string' ? row.id : name,
    type: typeof row.type === 'string' ? row.type : 'Microsoft.Insights/metrics',
    name,
    unit: metricUnit(row.unit),
    ...(typeof row.errorCode === 'string'
      ? { errorCode: row.errorCode }
      : {}),
    ...(typeof row.errorMessage === 'string'
      ? { errorMessage: row.errorMessage }
      : {}),
    timeseries: timeseries.map((value) => {
      const series = asObject(value)
      const metadata = Array.isArray(series.metadatavalues)
        ? series.metadatavalues
        : []
      const data = Array.isArray(series.data) ? series.data : []
      return {
        metadatavalues: metadata.flatMap((value) => {
          const item = asObject(value)
          const metadataName = asObject(item.name)
          const dimensionName =
            firstString(metadataName, ['value', 'localizedValue']) ??
            (typeof item.name === 'string' ? item.name : undefined)
          return dimensionName && typeof item.value === 'string'
            ? [{ name: dimensionName, value: item.value }]
            : []
        }),
        data: data.flatMap((value) => {
          const point = asObject(value)
          const timestamp =
            typeof point.timeStamp === 'string'
              ? new Date(point.timeStamp)
              : undefined
          if (!timestamp || Number.isNaN(timestamp.getTime())) return []
          return [
            {
              timeStamp: timestamp,
              ...(finiteNumber(point.average) !== undefined
                ? { average: finiteNumber(point.average) }
                : {}),
              ...(finiteNumber(point.minimum) !== undefined
                ? { minimum: finiteNumber(point.minimum) }
                : {}),
              ...(finiteNumber(point.maximum) !== undefined
                ? { maximum: finiteNumber(point.maximum) }
                : {}),
              ...(finiteNumber(point.total) !== undefined
                ? { total: finiteNumber(point.total) }
                : {}),
              ...(finiteNumber(point.count) !== undefined
                ? { count: finiteNumber(point.count) }
                : {}),
            },
          ]
        }),
      }
    }),
  }
}

function resourceRecord(value: unknown): ResourceRecord | undefined {
  const row = asObject(value)
  const id = typeof row.id === 'string' ? row.id : ''
  const name = typeof row.name === 'string' ? row.name : ''
  const type = typeof row.type === 'string' ? row.type : ''
  const subscriptionId =
    typeof row.subscriptionId === 'string' ? row.subscriptionId : ''
  if (!id || !name || !type || !subscriptionId) return undefined
  return {
    id,
    name,
    type,
    subscriptionId,
    resourceGroup:
      typeof row.resourceGroup === 'string' ? row.resourceGroup : undefined,
    location: typeof row.location === 'string' ? row.location : undefined,
    tags: normalizeTags(row.tags),
    properties: asObject(row.properties),
  }
}

function inferOwner(tags: Record<string, string>): RecommendationOwner {
  const tagMap = new Map(
    Object.entries(tags).map(([key, value]) => [key.toLowerCase(), value.trim()]),
  )
  for (const configuredTag of ownerTagNames()) {
    const value = tagMap.get(configuredTag.toLowerCase())
    if (!value) continue
    const angleMatch = /^(.*?)\s*<([^<>@\s]+@[^<>@\s]+)>$/.exec(value)
    if (angleMatch) {
      return {
        displayName: angleMatch[1]?.trim() || angleMatch[2]!,
        email: angleMatch[2],
        source: 'tag',
        confidence: 0.95,
      }
    }
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
      return {
        displayName: value,
        email: value,
        source: 'tag',
        confidence: 0.95,
      }
    }
    return {
      displayName: value,
      source: 'tag',
      confidence: 0.85,
    }
  }
  return {
    displayName: 'Unassigned',
    source: 'unassigned',
    confidence: 0,
  }
}

function categoryForResource(type: string): RecommendationCategory {
  const normalized = type.toLowerCase()
  if (
    normalized.includes('sql') ||
    normalized.includes('database') ||
    normalized.includes('dbfor')
  ) {
    return 'database'
  }
  if (
    normalized.includes('network') ||
    normalized.includes('publicip') ||
    normalized.includes('networkinterface')
  ) {
    return 'network'
  }
  if (
    normalized.includes('storage') ||
    normalized.includes('/disks') ||
    normalized.includes('snapshot')
  ) {
    return 'storage'
  }
  if (
    normalized.includes('compute') ||
    normalized.includes('virtualmachine') ||
    normalized.includes('container')
  ) {
    return 'compute'
  }
  return 'other'
}

function categoryForAdvisor(
  resourceType: string,
  title: string,
  description: string,
): RecommendationCategory {
  if (
    /reservation|reserved instance|savings plan|hybrid benefit|commitment/i.test(
      `${title} ${description}`,
    )
  ) {
    return 'commitment'
  }
  return categoryForResource(resourceType)
}

function formatCommitmentTerm(value: string | undefined): string | undefined {
  const match = /^P(\d+)Y$/i.exec(value ?? '')
  if (!match) return value
  const years = Number(match[1])
  return `${years} ${years === 1 ? 'year' : 'years'}`
}

function resourceCost(
  resourceId: string,
  costs: Map<string, number>,
): number | null {
  return costs.get(resourceId.toLowerCase()) ?? null
}

const ADVISOR_ACTIVITY_BY_TYPE_ID = new Map<string, SavingsActivity>([
  ['84b1a508-fc21-49da-979e-96894f1665df', 'savings_plans'],
  ['8ee30d6b-2a1c-45f3-93f0-df6962034a33', 'reserved_instances'],
  ['885cd4f5-dfa0-4d68-bbfd-00f89fc2b69c', 'reserved_instances'],
  ['db621e98-4a20-4942-b174-c455dc71dbae', 'reserved_instances'],
  ['89515250-1243-43d1-b4e7-f9437cedffd8', 'reserved_instances'],
  ['680a5388-28aa-44e8-88af-32e3598dc869', 'reserved_instances'],
  ['0eb54047-acd9-4f26-8ffb-8cec713782d6', 'reserved_instances'],
  ['0169a2e1-c7bf-4c37-90b8-0714811c82d3', 'reserved_instances'],
  ['a205074f-8049-48b3-903f-556f5e530ae3', 'reserved_instances'],
  ['a8fd63ce-4600-43eb-af33-a6d5481f5930', 'reserved_instances'],
])
const ADVISOR_INACTIVE_VM_TYPE_IDS = new Set([
  'e10b1381-5f0a-47ff-8c7b-37bd13d7c974',
  '94aea435-ef39-493f-a547-8408092c22a7',
])

export function classifyAdvisorSavingsActivity(input: {
  recommendationTypeId?: string
  title: string
  description: string
  category: string
  resourceType: string
}): {
  activity: SavingsActivity
  method: 'recommendation_type_id' | 'text_fallback'
} {
  const mapped = input.recommendationTypeId
    ? ADVISOR_ACTIVITY_BY_TYPE_ID.get(input.recommendationTypeId.toLowerCase())
    : undefined
  return mapped
    ? { activity: mapped, method: 'recommendation_type_id' }
    : {
        activity: classifySavingsActivity(input),
        method: 'text_fallback',
      }
}

function scalarExtendedProperties(
  value: Record<string, unknown>,
): Record<string, SerializableScalar> {
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, SerializableScalar] =>
        entry[1] === null ||
        ['string', 'number', 'boolean'].includes(typeof entry[1]),
    ),
  )
}

function normalizedAdvisorStatus(
  properties: Record<string, unknown>,
): string | undefined {
  return firstString(properties, ['recommendationStatus', 'status'])
}

function isActiveAdvisorRecommendation(
  properties: Record<string, unknown>,
): boolean {
  const status = normalizedAdvisorStatus(properties)
  if (!status) return false
  const normalized = status.toLowerCase().replaceAll(/[\s_-]/g, '')
  return ['new', 'active', 'inprogress'].includes(normalized)
}

function overlapIdentity(input: {
  activity: SavingsActivity
  subscriptionId: string
  resourceType: string
  resourceId?: string
  fingerprint: string
  title: string
  evidence: EvidencePoint[]
}): RecommendationClaim['overlap'] {
  const scopeKey = savingsOpportunityScopeKey(input)
  const computeSpendPool =
    /compute|virtualmachines?|managedclusters|agentpools/i.test(
      input.resourceType,
    ) ||
    ['reserved_instances', 'savings_plans', 'right_sizing', 'shutdown_scheduling']
      .includes(input.activity)
  const stage =
    input.activity === 'reserved_instances'
      ? { sequenceStage: 'reservation' as const, sequenceOrder: 20 }
      : input.activity === 'savings_plans'
        ? { sequenceStage: 'savings_plan' as const, sequenceOrder: 30 }
        : ['right_sizing', 'shutdown_scheduling'].includes(input.activity)
          ? {
              sequenceStage: 'usage_optimization' as const,
              sequenceOrder: 10,
            }
          : { sequenceStage: 'independent' as const, sequenceOrder: 10 }
  const mutuallyExclusiveActivities: SavingsActivity[] =
    input.activity === 'reserved_instances'
      ? ['savings_plans']
      : input.activity === 'savings_plans'
        ? ['reserved_instances']
        : ['right_sizing', 'shutdown_scheduling'].includes(input.activity)
          ? ['reserved_instances', 'savings_plans']
          : []
  return {
    scopeKey,
    spendPoolKey: computeSpendPool
      ? `${input.subscriptionId.toLowerCase()}|compute-usage`
      : (input.resourceId ?? scopeKey).toLowerCase(),
    ...(input.activity === 'reserved_instances' ||
    input.activity === 'savings_plans'
      ? { alternativeGroup: scopeKey }
      : {}),
    ...stage,
    mutuallyExclusiveActivities,
  }
}

function nonProductionHeuristic(
  resource: ResourceRecord,
): string | undefined {
  const terms =
    '(?:dev|development|test|qa|uat|stage|staging|sandbox|demo|nonprod|non-production)'
  const valuePattern = new RegExp(`(?:^|[\\s_.-])${terms}(?:$|[\\s_.-])`, 'i')
  const tagKeys = new Set([
    'environment',
    'env',
    'stage',
    'deploymentenvironment',
    'workloadenvironment',
  ])
  for (const [key, value] of Object.entries(resource.tags)) {
    if (tagKeys.has(key.toLowerCase()) && valuePattern.test(value)) {
      return `environment tag ${key}=${value}`
    }
  }
  if (valuePattern.test(resource.name)) {
    return `resource name ${resource.name}`
  }
  return undefined
}

interface ShutdownScheduleInspection {
  targetResourceId?: string
  status?: string
  taskType?: string
  recurrence?: string
  timeZone?: string
  activeCoverage: boolean
}

function inspectShutdownSchedule(
  schedule: ResourceRecord,
): ShutdownScheduleInspection {
  const status = firstString(schedule.properties, ['status', 'provisioningState'])
  const enabled = !(
    status &&
    ['disabled', 'disable', 'deleted', 'failed', 'canceled', 'cancelled'].includes(
      status.toLowerCase(),
    )
  )
  const taskType = firstString(schedule.properties, [
    'taskType',
    'task',
    'scheduleType',
  ])
  const shutdownTask = taskType
    ? /shutdown|compute.*stop|stop.*compute/i.test(taskType)
    : /shutdown/i.test(schedule.name)
  const dailyRecurrence = asObject(schedule.properties.dailyRecurrence)
  const recurrence =
    firstString(dailyRecurrence, ['time']) ??
    firstString(schedule.properties, ['recurrence', 'scheduleTime'])
  const timeZone = firstString(schedule.properties, [
    'timeZoneId',
    'timeZone',
  ])
  const targetResourceId =
    typeof schedule.properties.targetResourceId === 'string'
      ? schedule.properties.targetResourceId
      : undefined
  return {
    targetResourceId,
    status,
    taskType,
    recurrence,
    timeZone,
    activeCoverage: Boolean(
      targetResourceId &&
        enabled &&
        shutdownTask &&
        recurrence &&
        timeZone,
    ),
  }
}

function telemetryEvidencePoints(
  telemetry: VmTelemetryEvidence,
): EvidencePoint[] {
  const metric = (name: string) =>
    telemetry.metrics.find((item) => item.name === name)
  const cpu = metric('Percentage CPU')
  const networkIn = metric('Network In Total')
  const networkOut = metric('Network Out Total')
  const diskRead = metric('Disk Read Bytes')
  const diskWrite = metric('Disk Write Bytes')
  return [
    {
      label: 'VmAvailabilityMetric coverage',
      value: 100 - telemetry.availability.missingDataPercentage,
      unit: '%',
      source: 'Azure Monitor Metrics',
      observedAt: telemetry.collectedAt,
    },
    {
      label: 'Observed available hours',
      value: telemetry.availability.observedAvailableHours,
      unit: 'hours',
      source: 'Azure Monitor VmAvailabilityMetric',
      observedAt: telemetry.collectedAt,
    },
    ...(telemetry.availability.knownAvailabilityPercentage !== null
      ? [
          {
            label: 'Known-bucket availability',
            value: telemetry.availability.knownAvailabilityPercentage,
            unit: '%',
            source: 'Azure Monitor VmAvailabilityMetric',
            observedAt: telemetry.collectedAt,
          },
        ]
      : []),
    ...(cpu?.average !== null && cpu?.average !== undefined
      ? [
          {
            label: 'Hourly average CPU',
            value: cpu.average,
            unit: '%',
            source: 'Azure Monitor Percentage CPU',
            observedAt: telemetry.collectedAt,
          },
        ]
      : []),
    ...(cpu?.percentile95 !== null && cpu?.percentile95 !== undefined
      ? [
          {
            label: 'Hourly CPU p95',
            value: cpu.percentile95,
            unit: '%',
            source: 'Azure Monitor Percentage CPU',
            observedAt: telemetry.collectedAt,
          },
        ]
      : []),
    ...[
      ['Network ingress', networkIn],
      ['Network egress', networkOut],
      ['Disk read', diskRead],
      ['Disk write', diskWrite],
    ].flatMap(([label, summary]) =>
      typeof label === 'string' &&
      typeof summary === 'object' &&
      summary !== null &&
      'total' in summary &&
      typeof summary.total === 'number'
        ? [
            {
              label: `${label} over telemetry window`,
              value: summary.total,
              unit: 'bytes',
              source: 'Azure Monitor Metrics',
              observedAt: telemetry.collectedAt,
            },
          ]
        : [],
    ),
    {
      label: 'Relevant Activity Log events',
      value: telemetry.activityLog.events.length,
      source: 'Azure Activity Log',
      observedAt: telemetry.collectedAt,
    },
  ]
}

function makeRecommendation(input: {
  source: SnapshotRecommendation['source']
  sourceFamily: string
  sourceRecommendationId?: string
  category: RecommendationCategory
  activity: SavingsActivity
  title: string
  description: string
  suggestedAction: string
  tenantId?: string
  subscription: ArmSubscription
  resource: ResourceRecord
  savings: number | null
  currentCost: number | null
  currency: string | null
  confidence: number
  effort: SnapshotRecommendation['effort']
  risk: SnapshotRecommendation['risk']
  evidence: EvidencePoint[]
  claim: Omit<RecommendationClaim, 'overlap'>
  observedAt: string
}): SnapshotRecommendation {
  const fingerprint = stableId(
    [
      'azure',
      input.source,
      input.sourceRecommendationId ?? input.resource.id,
      input.title,
    ]
      .join('|')
      .toLowerCase(),
  )
  const savings =
    input.savings === null ? null : Math.max(0, input.savings)
  const claim: RecommendationClaim = {
    ...input.claim,
    overlap: overlapIdentity({
      activity: input.activity,
      subscriptionId: input.subscription.subscriptionId,
      resourceType: input.resource.type,
      resourceId: input.resource.id,
      fingerprint,
      title: input.title,
      evidence: input.evidence,
    }),
  }
  return {
    id: `rec_${fingerprint}`,
    fingerprint,
    source: input.source,
    sourceFamily: input.sourceFamily,
    sourceRecommendationId: input.sourceRecommendationId,
    category: input.category,
    activity: input.activity,
    title: input.title,
    description: input.description,
    suggestedAction: input.suggestedAction,
    tenantId: input.tenantId,
    subscriptionId: input.subscription.subscriptionId,
    subscriptionName: input.subscription.displayName,
    resourceId: input.resource.id,
    resourceName: input.resource.name,
    resourceType: input.resource.type,
    resourceGroup: input.resource.resourceGroup,
    location: input.resource.location,
    estimatedMonthlySavings: savings,
    azureEstimatedMonthlySavings:
      claim.level === 'azure_estimate' ? savings : null,
    calculatedMonthlySavings:
      claim.level === 'calculated_scenario' ? savings : null,
    measuredMonthlySavings:
      claim.level === 'measured_result' ? savings : null,
    currentMonthlyCost:
      input.currentCost === null ? null : Math.max(0, input.currentCost),
    currency: input.currency,
    claim,
    confidence: input.confidence,
    confidenceBand: confidenceBand(input.confidence),
    effort: input.effort,
    risk: input.risk,
    status: 'open',
    owner: inferOwner(input.resource.tags),
    evidence: input.evidence,
    tags: input.resource.tags,
    firstSeenAt: input.observedAt,
    lastSeenAt: input.observedAt,
  }
}

function numericEnvironmentValue(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const configured = Number(process.env[name] ?? fallback)
  return Number.isFinite(configured)
    ? Math.max(minimum, Math.min(maximum, configured))
    : fallback
}

function retryAfterMilliseconds(response: Response): number | undefined {
  const delays: number[] = []
  for (const header of [
    'x-ms-ratelimit-microsoft.costmanagement-qpu-retry-after',
    'x-ms-ratelimit-microsoft.costmanagement-entity-retry-after',
    'x-ms-ratelimit-microsoft.costmanagement-clienttype-retry-after',
    'x-ms-ratelimit-microsoft.costmanagement-tenant-retry-after',
  ]) {
    const value = response.headers.get(header)
    if (value !== null) {
      const seconds = Number(value)
      if (Number.isFinite(seconds) && seconds >= 0) {
        delays.push(seconds * 1000)
      }
    }
  }

  const retryAfter = response.headers.get('retry-after')
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) {
      delays.push(seconds * 1000)
    } else {
      const retryAt = Date.parse(retryAfter)
      if (Number.isFinite(retryAt)) {
        delays.push(Math.max(0, retryAt - Date.now()))
      }
    }
  }
  return delays.length ? Math.max(...delays) : undefined
}

async function azureErrorCode(response: Response): Promise<string | undefined> {
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('application/json')) return undefined
  const payload = (await response.clone().json().catch(() => undefined)) as
    | { error?: { code?: unknown } }
    | undefined
  return typeof payload?.error?.code === 'string'
    ? payload.error.code.slice(0, 100)
    : undefined
}

function sleep(
  milliseconds: number,
  signal?: AbortSignal | null,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error('Azure request aborted'),
      )
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', handleAbort)
      resolve()
    }, milliseconds)
    const handleAbort = (): void => {
      clearTimeout(timer)
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new Error('Azure request aborted'),
      )
    }
    signal?.addEventListener('abort', handleAbort, { once: true })
  })
}

function isTransientStatus(status: number): boolean {
  return [408, 429, 500, 502, 503, 504].includes(status)
}

function retryDelay(error: ArmRequestError, attempt: number): number {
  if (error.retryAfterSeconds !== undefined) {
    return error.retryAfterSeconds * 1000
  }
  return (
    Math.min(10_000, 1000 * 2 ** attempt) +
    Math.floor(Math.random() * 250)
  )
}

export interface CostQueryPlan {
  historyMonths: number
  subscriptionsToQuery: number
  estimatedQpu: number
  minimumIntervalMilliseconds: number
}

class CostQueryBudgetExceededError extends Error {
  constructor(readonly budget: number) {
    super(`Cost Management query budget of ${budget} QPUs was exhausted`)
    this.name = 'CostQueryBudgetExceededError'
  }
}

class CostQueryBudget {
  private consumed = 0

  constructor(readonly limit: number) {}

  get remaining(): number {
    return this.limit - this.consumed
  }

  consume(units: number): void {
    if (units > this.remaining) {
      throw new CostQueryBudgetExceededError(this.limit)
    }
    this.consumed += units
  }
}

interface RequestBudget {
  qpuBudget: CostQueryBudget
  qpuCost: number
}

export function createCostQueryPlan(
  subscriptionCount: number,
  maximumHistoryMonths = 6,
  qpuBudget = 480,
): CostQueryPlan {
  const safeSubscriptionCount = Math.max(0, Math.floor(subscriptionCount))
  const safeMaximumMonths = Math.max(1, Math.floor(maximumHistoryMonths))
  const safeQpuBudget = Math.max(1, Math.floor(qpuBudget))
  if (safeSubscriptionCount === 0) {
    return {
      historyMonths: 1,
      subscriptionsToQuery: 0,
      estimatedQpu: 0,
      minimumIntervalMilliseconds: 1100,
    }
  }
  const historyMonths = Math.max(
    1,
    Math.min(
      safeMaximumMonths,
      Math.floor(safeQpuBudget / safeSubscriptionCount),
    ),
  )
  const subscriptionsToQuery = Math.min(
    safeSubscriptionCount,
    Math.floor(safeQpuBudget / historyMonths),
  )
  return {
    historyMonths,
    subscriptionsToQuery,
    estimatedQpu: subscriptionsToQuery * historyMonths,
    minimumIntervalMilliseconds: Math.max(3300, historyMonths * 1100),
  }
}

export interface AzureProviderOptions {
  availabilityMetricQuery?: AvailabilityMetricQuery
  metricsClientFactory?: MetricsClientFactory
  telemetryConcurrency?: number
  telemetryMaximumAttempts?: number
  telemetryTimeoutMilliseconds?: number
  telemetryRetryDelayMilliseconds?: number
  telemetryBatchSize?: number
  telemetryMaximumCandidates?: number
  now?: () => Date
}

export class AzureProvider implements ProspectorProvider {
  readonly name = 'azure'
  readonly mode = 'live' as const
  private readonly credential: TokenCredential
  private readonly requestedTenantId?: string
  private readonly options: AzureProviderOptions

  constructor(
    credential?: TokenCredential,
    requestedTenantId?: string,
    options: AzureProviderOptions = {},
  ) {
    this.requestedTenantId = requestedTenantId
    this.credential = credential ?? createCredential(requestedTenantId)
    this.options = options
  }

  private async requestOnce<T>(
    url: string,
    operation: string,
    init: RequestInit = {},
  ): Promise<T> {
    const parsedUrl = new URL(url, ARM_ORIGIN)
    if (parsedUrl.origin !== ARM_ORIGIN) {
      throw new Error('Azure API returned an unexpected pagination origin')
    }
    const token = await this.credential.getToken(ARM_SCOPE)
    if (!token) throw new Error('Azure authentication did not return an access token')
    const response = await fetch(parsedUrl, {
      ...init,
      headers: {
        Accept: 'application/json',
        ClientType: 'AzureProspector',
        Authorization: `Bearer ${token.token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    })
    if (!response.ok) {
      throw new ArmRequestError(
        response.status,
        operation,
        await azureErrorCode(response),
        retryAfterMilliseconds(response),
      )
    }
    return (await response.json()) as T
  }

  private async request<T>(
    url: string,
    operation: string,
    init: RequestInit = {},
    budget?: RequestBudget,
  ): Promise<T> {
    const retryAttempts = numericEnvironmentValue(
      'AZURE_HTTP_RETRY_ATTEMPTS',
      3,
      0,
      6,
    )
    const maximumRetryDelay = numericEnvironmentValue(
      'AZURE_MAX_RETRY_DELAY_MS',
      120_000,
      0,
      300_000,
    )
    for (let attempt = 0; ; attempt += 1) {
      init.signal?.throwIfAborted()
      try {
        budget?.qpuBudget.consume(budget.qpuCost)
        return await this.requestOnce<T>(url, operation, init)
      } catch (error) {
        if (
          !(error instanceof ArmRequestError) ||
          !isTransientStatus(error.status) ||
          attempt >= retryAttempts
        ) {
          throw error
        }
        const delay = retryDelay(error, attempt)
        if (delay > maximumRetryDelay) throw error
        await sleep(delay, init.signal)
      }
    }
  }

  private async discoverSubscriptions(
    requestedIds?: string[],
    requestedTenantId?: string,
  ): Promise<ArmSubscription[]> {
    const subscriptions: ArmSubscription[] = []
    let nextUrl: string | undefined =
      `${ARM_ORIGIN}/subscriptions?api-version=2022-12-01`
    while (nextUrl) {
      const response: {
        value?: Array<Record<string, unknown>>
        nextLink?: string
      } = await this.request(nextUrl, 'Subscription discovery')
      for (const row of response.value ?? []) {
        if (
          typeof row.subscriptionId !== 'string' ||
          typeof row.displayName !== 'string' ||
          typeof row.state !== 'string'
        ) {
          continue
        }
        if (row.state.toLowerCase() !== 'enabled') continue
        subscriptions.push({
          subscriptionId: row.subscriptionId,
          displayName: row.displayName,
          state: row.state,
          tenantId:
            typeof row.tenantId === 'string' ? row.tenantId : undefined,
        })
      }
      nextUrl = response.nextLink
    }

    const environmentAllowList = configuredSubscriptionIds()
    const requestAllowList = requestedIds?.length
      ? new Set(requestedIds.map((id) => id.toLowerCase()))
      : undefined
    return subscriptions.filter((subscription) => {
      const id = subscription.subscriptionId.toLowerCase()
      const belongsToRequestedTenant =
        !requestedTenantId ||
        subscription.tenantId?.toLowerCase() === requestedTenantId.toLowerCase()
      return (
        belongsToRequestedTenant &&
        (!environmentAllowList || environmentAllowList.has(id)) &&
        (!requestAllowList || requestAllowList.has(id))
      )
    })
  }

  private async queryResourceGraph(
    subscriptions: string[],
    query: string,
    operation: string,
  ): Promise<unknown[]> {
    const rows: unknown[] = []
    for (let offset = 0; offset < subscriptions.length; offset += 100) {
      const batch = subscriptions.slice(offset, offset + 100)
      let skipToken: string | undefined
      do {
        const response: ResourceGraphResponse = await this.request(
          `${ARM_ORIGIN}/providers/Microsoft.ResourceGraph/resources?api-version=${RESOURCE_GRAPH_API_VERSION}`,
          operation,
          {
            method: 'POST',
            body: JSON.stringify({
              subscriptions: batch,
              query,
              options: {
                $top: 1000,
                ...(skipToken ? { $skipToken: skipToken } : {}),
              },
            }),
          },
        )
        rows.push(...(response.data ?? []))
        skipToken = response.$skipToken ?? response.skipToken
      } while (skipToken)
    }
    return rows
  }

  private async queryCosts(
    subscription: ArmSubscription,
    historyMonths: number,
    qpuBudget: CostQueryBudget,
  ): Promise<CostQueryResult> {
    const now = new Date()
    const from = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth() - historyMonths,
        1,
      ),
    )
    const to = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - 1,
    )
    const requestBody = JSON.stringify({
      type: 'AmortizedCost',
      timeframe: 'Custom',
      timePeriod: {
        from: from.toISOString(),
        to: to.toISOString(),
      },
      dataset: {
        granularity: 'Monthly',
        aggregation: {
          totalCost: {
            name: 'PreTaxCost',
            function: 'Sum',
          },
        },
        grouping: [
          { type: 'Dimension', name: 'ResourceId' },
          { type: 'Dimension', name: 'PricingModel' },
        ],
      },
    })
    type CostResponse = {
      properties?: {
        columns?: Array<{ name?: string }>
        rows?: unknown[][]
        nextLink?: string
      }
    }
    const responses: CostResponse[] = []
    const pageInterval = numericEnvironmentValue(
      'AZURE_COST_PAGE_INTERVAL_MS',
      15_500,
      0,
      60_000,
    )
    let pageIndex = 0
    let nextUrl: string | undefined =
      `${ARM_ORIGIN}/subscriptions/${encodeURIComponent(subscription.subscriptionId)}` +
      `/providers/Microsoft.CostManagement/query?api-version=${COST_API_VERSION}`
    while (nextUrl) {
      if (pageIndex > 0 && pageInterval > 0) await sleep(pageInterval)
      const response: CostResponse = await this.request(
        nextUrl,
        'Cost Management query',
        {
          method: 'POST',
          body: requestBody,
        },
        { qpuBudget, qpuCost: historyMonths },
      )
      responses.push(response)
      nextUrl = response.properties?.nextLink
      pageIndex += 1
    }
    const columns = (responses[0]?.properties?.columns ?? []).map((column) =>
      (column.name ?? '').toLowerCase(),
    )
    const costIndex = columns.findIndex((name) =>
      ['pretaxcost', 'cost', 'totalcost'].includes(name),
    )
    const resourceIndex = columns.findIndex((name) => name === 'resourceid')
    const periodIndex = columns.findIndex((name) =>
      ['usagedate', 'billingmonth', 'month'].includes(name),
    )
    const currencyIndex = columns.findIndex((name) => name === 'currency')
    const pricingModelIndex = columns.findIndex(
      (name) => name === 'pricingmodel',
    )
    if (
      costIndex < 0 ||
      resourceIndex < 0 ||
      periodIndex < 0 ||
      currencyIndex < 0
    ) {
      throw new Error(
        'Cost Management response is missing PreTaxCost, ResourceId, monthly period, or Currency columns',
      )
    }
    const monthlyResourceCosts = new Map<string, Map<string, number>>()
    const monthlyVariableResourceCosts = new Map<
      string,
      Map<string, number>
    >()
    let currency: string | undefined

    for (const response of responses) {
      for (const row of response.properties?.rows ?? []) {
        const cost = finiteNumber(row[costIndex]) ?? 0
        const resourceId =
          typeof row[resourceIndex] === 'string'
            ? row[resourceIndex].toLowerCase()
            : ''
        const period = monthlyPeriod(row[periodIndex])
        if (!period) continue
        if (
          currencyIndex >= 0 &&
          typeof row[currencyIndex] === 'string' &&
          row[currencyIndex]
        ) {
          currency = row[currencyIndex]
        }
        const periodCosts = monthlyResourceCosts.get(period) ?? new Map()
        periodCosts.set(resourceId, (periodCosts.get(resourceId) ?? 0) + cost)
        monthlyResourceCosts.set(period, periodCosts)
        const pricingModel =
          pricingModelIndex >= 0 &&
          typeof row[pricingModelIndex] === 'string'
            ? row[pricingModelIndex].toLowerCase().replaceAll(/[\s_-]/g, '')
            : ''
        if (['ondemand', 'spot'].includes(pricingModel)) {
          const variableCosts =
            monthlyVariableResourceCosts.get(period) ?? new Map()
          variableCosts.set(
            resourceId,
            (variableCosts.get(resourceId) ?? 0) + cost,
          )
          monthlyVariableResourceCosts.set(period, variableCosts)
        }
      }
    }

    const periods = [...monthlyResourceCosts.keys()].sort()
    const currentPeriod =
      `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
    const completedPeriods = periods.filter((period) => period < currentPeriod)
    const trendPeriods = completedPeriods.length ? completedPeriods : periods
    const monthlyTotals = new Map(
      trendPeriods.map((period) => [
        period,
        [...(monthlyResourceCosts.get(period)?.values() ?? [])].reduce(
          (sum, cost) => sum + cost,
          0,
        ),
      ]),
    )
    const resourceIds = new Set(
      trendPeriods.flatMap((period) => [
        ...(monthlyResourceCosts.get(period)?.keys() ?? []),
      ]),
    )
    const representativeByResource = new Map(
      [...resourceIds].map((resourceId) => [
        resourceId,
        median(
          trendPeriods.map(
            (period) =>
              monthlyResourceCosts.get(period)?.get(resourceId) ?? 0,
          ),
        ),
      ]),
    )
    const representativeVariableByResource = new Map(
      [...resourceIds]
        .map(
          (resourceId): [string, number] => [
            resourceId,
            median(
              trendPeriods.map(
                (period) =>
                  monthlyVariableResourceCosts
                    .get(period)
                    ?.get(resourceId) ?? 0,
              ),
            ),
          ],
        )
        .filter(([, cost]) => cost > 0),
    )
    if (
      !currency &&
      [...monthlyTotals.values()].some((monthlyCost) => monthlyCost !== 0)
    ) {
      throw new Error(
        'Cost Management returned monetary values without a billing currency',
      )
    }
    return {
      subscriptionId: subscription.subscriptionId,
      currency,
      representativeByResource,
      representativeVariableByResource,
      monthlyTotals,
      representativeTotal: median([...monthlyTotals.values()]),
    }
  }

  private async queryVmAvailabilityMetric(
    candidate: VmTelemetryCandidate,
    window: ReturnType<typeof completedThirtyDayWindow>,
    abortSignal: AbortSignal,
  ): Promise<Metric | undefined> {
    const parameters = new URLSearchParams({
      'api-version': METRICS_API_VERSION,
      metricnames: 'VmAvailabilityMetric',
      metricnamespace: 'Microsoft.Compute/virtualMachines',
      timespan: `${window.startAt}/${window.endAt}`,
      interval: 'PT1H',
      aggregation: 'Average,Minimum,Maximum',
    })
    const response: { value?: unknown[] } = await this.request(
      `${ARM_ORIGIN}${candidate.resourceId}/providers/Microsoft.Insights/metrics?${parameters}`,
      'VM availability metric query',
      { signal: abortSignal },
    )
    return (response.value ?? [])
      .map(resourceScopedMetric)
      .find(
        (metric): metric is Metric =>
          metric?.name.toLowerCase() === 'vmavailabilitymetric',
      )
  }

  private async queryVmActivityLog(
    candidate: VmTelemetryCandidate,
    window: ReturnType<typeof completedThirtyDayWindow>,
    abortSignal: AbortSignal,
  ): Promise<ActivityLogQueryResult> {
    const inclusiveEnd = new Date(
      new Date(window.endAt).getTime() - 1,
    ).toISOString()
    const filter = [
      `eventTimestamp ge '${window.startAt}'`,
      `eventTimestamp le '${inclusiveEnd}'`,
      `resourceUri eq '${candidate.resourceId.replaceAll("'", "''")}'`,
    ].join(' and ')
    const parameters = new URLSearchParams({
      'api-version': ACTIVITY_LOG_API_VERSION,
      $filter: filter,
    })
    let nextUrl: string | undefined =
      `${ARM_ORIGIN}/subscriptions/${encodeURIComponent(
        candidate.subscriptionId,
      )}/providers/microsoft.insights/eventtypes/management/values?${parameters}`
    const events: VmActivityLogEvent[] = []
    for (let page = 0; nextUrl && page < 10; page += 1) {
      const response: {
        value?: Array<Record<string, unknown>>
        nextLink?: string
      } = await this.request(nextUrl, 'VM Activity Log query', {
        signal: abortSignal,
      })
      for (const row of response.value ?? []) {
        const operationObject = asObject(row.operationName)
        const statusObject = asObject(row.status)
        const operation =
          firstString(operationObject, ['value', 'localizedValue']) ??
          (typeof row.operationName === 'string'
            ? row.operationName
            : undefined)
        const timestamp =
          typeof row.eventTimestamp === 'string'
            ? row.eventTimestamp
            : undefined
        if (
          !operation ||
          !timestamp ||
          !/microsoft\.compute\/virtualmachines\/(?:start|restart|poweroff|deallocate)\/action/i.test(
            operation,
          )
        ) {
          continue
        }
        events.push({
          operation,
          status:
            firstString(statusObject, ['value', 'localizedValue']) ??
            (typeof row.status === 'string' ? row.status : 'Unknown'),
          timestamp,
          ...(typeof row.correlationId === 'string'
            ? { correlationId: row.correlationId }
            : {}),
        })
      }
      nextUrl = response.nextLink
    }
    return {
      events: events.sort((left, right) =>
        left.timestamp.localeCompare(right.timestamp),
      ),
      ...(nextUrl
        ? {
            error:
              'Activity Log pagination exceeded the 10-page per-resource safety bound.',
          }
        : {}),
    }
  }

  async collect(request: ProviderCollectRequest): Promise<ProviderSnapshot> {
    const collectionNow = this.options.now?.() ?? new Date()
    const collectedAt = collectionNow.toISOString()
    const warnings: string[] = []
    const completeSourceFamilies: string[] = []
    const requestedTenantId =
      request.tenantId ?? this.requestedTenantId ?? process.env.AZURE_TENANT_ID
    const subscriptions = await this.discoverSubscriptions(
      request.subscriptionIds,
      requestedTenantId,
    )
    if (subscriptions.length === 0) {
      throw new Error(
        'No enabled Azure subscriptions were visible after applying the subscription allow-list',
      )
    }
    const subscriptionIds = subscriptions.map(
      (subscription) => subscription.subscriptionId,
    )
    const subscriptionById = new Map(
      subscriptions.map((subscription) => [
        subscription.subscriptionId.toLowerCase(),
        subscription,
      ]),
    )

    const maximumCostHistoryMonths = Math.floor(
      numericEnvironmentValue(
        'AZURE_COST_HISTORY_MONTHS',
        6,
        1,
        12,
      ),
    )
    const costQpuBudget = Math.floor(
      numericEnvironmentValue(
        'AZURE_COST_QPU_BUDGET_PER_SCAN',
        480,
        1,
        600,
      ),
    )
    const costQueryPlan = createCostQueryPlan(
      subscriptions.length,
      maximumCostHistoryMonths,
      costQpuBudget,
    )
    const costRequestInterval = numericEnvironmentValue(
      'AZURE_COST_REQUEST_INTERVAL_MS',
      costQueryPlan.minimumIntervalMilliseconds,
      0,
      30_000,
    )
    const costSubscriptions = subscriptions.slice(
      0,
      costQueryPlan.subscriptionsToQuery,
    )
    const qpuBudget = new CostQueryBudget(costQpuBudget)
    if (costSubscriptions.length < subscriptions.length) {
      warnings.push(
        `Cost Management collection was limited to ${costSubscriptions.length} of ${subscriptions.length} subscriptions to stay within the configured ${costQpuBudget}-QPU scan budget.`,
      )
    }
    const costAttempts: Array<{
      result?: CostQueryResult
      subscription: ArmSubscription
    }> = []
    for (const [index, subscription] of costSubscriptions.entries()) {
      if (qpuBudget.remaining < costQueryPlan.historyMonths) {
        warnings.push(
          `Cost Management collection stopped after using the configured ${costQpuBudget}-QPU scan budget; remaining subscriptions retain inventory and Advisor coverage without cost history.`,
        )
        break
      }
      if (index > 0 && costRequestInterval > 0) {
        await sleep(costRequestInterval)
      }
      try {
        costAttempts.push({
          result: await this.queryCosts(
            subscription,
            costQueryPlan.historyMonths,
            qpuBudget,
          ),
          subscription,
        })
      } catch (error) {
        const reason =
          error instanceof CostQueryBudgetExceededError
            ? `configured ${error.budget}-QPU scan budget exhausted`
            : error instanceof ArmRequestError
            ? `HTTP ${error.status}${error.code ? ` ${error.code}` : ''}${
                error.retryAfterSeconds
                  ? `; retry after ${error.retryAfterSeconds}s`
                  : ''
              }`
            : 'authentication or connectivity error'
        warnings.push(
          `Cost Management data is unavailable for ${subscription.displayName} (${reason}).`,
        )
        costAttempts.push({ subscription })
        if (error instanceof CostQueryBudgetExceededError) break
      }
    }
    const costResults = costAttempts
      .map((attempt) => attempt.result)
      .filter((result): result is CostQueryResult => result !== undefined)
    const billingCurrencies = [
      ...new Set(
        costResults
          .map((result) => result.currency?.trim().toUpperCase())
          .filter((value): value is string => Boolean(value)),
      ),
    ]
    if (billingCurrencies.length > 1) {
      warnings.push(
        `Native billing currencies are retained separately (${billingCurrencies.join(
          ', ',
        )}); no currency conversion is applied.`,
      )
    }
    const costBySubscription = new Map(
      costResults.map((result) => [
        result.subscriptionId.toLowerCase(),
        result,
      ]),
    )
    const currencyBySubscription = new Map(
      costResults
        .filter(
          (
            result,
          ): result is CostQueryResult & { currency: string } =>
            Boolean(result.currency),
        )
        .map((result) => [
          result.subscriptionId.toLowerCase(),
          result.currency.trim().toUpperCase(),
        ]),
    )
    const allResourceCosts = new Map<string, number>()
    const allVariableResourceCosts = new Map<string, number>()
    for (const result of costResults) {
      for (const [resourceId, cost] of result.representativeByResource) {
        allResourceCosts.set(resourceId, cost)
      }
      for (const [resourceId, cost] of result.representativeVariableByResource) {
        allVariableResourceCosts.set(resourceId, cost)
      }
    }
    const graphResults = new Map<string, unknown[]>()
    const graphQueries = [
      {
        key: 'advisor',
        operation: 'Advisor Resource Graph query',
        query: `
          advisorresources
          | where type =~ 'microsoft.advisor/recommendations'
          | where tostring(properties.category) =~ 'Cost'
          | where tostring(properties.recommendationStatus) in~ ('New', 'Active', 'InProgress')
          | extend advisorResourceId=id,
              impactedResourceId=tostring(properties.resourceMetadata.resourceId),
              advisorRecommendationId=name
          | join kind=leftouter (
              Resources
              | project impactedResourceId=id, impactedName=name,
                  impactedType=type, impactedResourceGroup=resourceGroup,
                  impactedLocation=location, impactedTags=tags
            ) on impactedResourceId
          | project
              id=iff(isempty(impactedResourceId), advisorResourceId, impactedResourceId),
              name=iff(
                isempty(impactedName),
                iff(
                  isempty(tostring(properties.impactedValue)),
                  advisorRecommendationId,
                  tostring(properties.impactedValue)
                ),
                impactedName
              ),
              type=iff(
                isempty(impactedType),
                iff(
                  isempty(tostring(properties.impactedField)),
                  'Microsoft.Advisor/recommendations',
                  tostring(properties.impactedField)
                ),
                impactedType
              ),
              subscriptionId, resourceGroup=impactedResourceGroup,
              location=impactedLocation, tags=impactedTags, properties,
              advisorRecommendationId, advisorResourceId
        `,
      },
      {
        key: 'advisorConfigurations',
        operation: 'Advisor configuration query',
        query: `
          advisorresources
          | where type =~ 'microsoft.advisor/configurations'
          | project id, name, type, subscriptionId, resourceGroup,
              location, tags, properties
        `,
      },
      {
        key: 'disks',
        operation: 'Managed disk orphan query',
        query: `
          Resources
          | where type =~ 'microsoft.compute/disks'
          | where isempty(managedBy)
          | where tostring(properties.diskState) =~ 'Unattached'
          | project id, name, type, subscriptionId, resourceGroup,
              location, tags, properties
        `,
      },
      {
        key: 'publicIps',
        operation: 'Public IP orphan query',
        query: `
          Resources
          | where type =~ 'microsoft.network/publicipaddresses'
          | where isempty(properties.ipConfiguration)
          | where isempty(properties.natGateway)
          | project id, name, type, subscriptionId, resourceGroup,
              location, tags, properties
        `,
      },
      {
        key: 'nics',
        operation: 'Network interface orphan query',
        query: `
          Resources
          | where type =~ 'microsoft.network/networkinterfaces'
          | where isempty(properties.virtualMachine)
          | where isempty(properties.privateEndpoint)
          | project id, name, type, subscriptionId, resourceGroup,
              location, tags, properties
        `,
      },
      {
        key: 'vms',
        operation: 'Virtual machine schedule coverage query',
        query: `
          Resources
          | where type =~ 'microsoft.compute/virtualmachines'
          | project id, name, type, subscriptionId, resourceGroup,
              location, tags, properties
        `,
      },
      {
        key: 'schedules',
        operation: 'Auto-shutdown schedule query',
        query: `
          Resources
          | where type =~ 'microsoft.devtestlab/schedules'
          | project id, name, type, subscriptionId, resourceGroup,
              location, tags, properties
        `,
      },
      {
        key: 'resourceCounts',
        operation: 'Resource inventory query',
        query: `
          Resources
          | summarize resourceCount=count() by subscriptionId
        `,
      },
    ] as const

    for (const graphQuery of graphQueries) {
      try {
        graphResults.set(
          graphQuery.key,
          await this.queryResourceGraph(
            subscriptionIds,
            graphQuery.query,
            graphQuery.operation,
          ),
        )
      } catch (error) {
        const reason =
          error instanceof ArmRequestError
            ? `HTTP ${error.status}`
            : 'authentication or connectivity error'
        warnings.push(`${graphQuery.operation} is unavailable (${reason}).`)
      }
    }

    const recommendations: SnapshotRecommendation[] = []
    let vmTelemetryCandidateCount = 0
    let vmTelemetrySelectedCount = 0
    let vmTelemetryRetrievedCount = 0
    let vmTelemetrySufficientCount = 0
    const tenantId =
      requestedTenantId ??
      subscriptions.find((subscription) => subscription.tenantId)?.tenantId

    const excludedAdvisorSubscriptions = new Set<string>()
    const excludedAdvisorResourceGroups = new Set<string>()
    const advisorLowCpuConfigurations = new Map<
      string,
      {
        lowCpuThreshold: number
        resourceId?: string
      }
    >()
    for (const value of graphResults.get('advisorConfigurations') ?? []) {
      const configuration = asObject(value)
      const properties = asObject(configuration.properties)
      const excluded =
        properties.exclude === true ||
        (typeof properties.exclude === 'string' &&
          properties.exclude.toLowerCase() === 'true')
      const subscriptionId =
        typeof configuration.subscriptionId === 'string'
          ? configuration.subscriptionId.toLowerCase()
          : ''
      const resourceGroup =
        typeof configuration.resourceGroup === 'string'
          ? configuration.resourceGroup.toLowerCase()
          : ''
      if (!subscriptionId) continue
      const lowCpuThreshold = firstNumber(properties, ['lowCpuThreshold'])
      if (!resourceGroup && lowCpuThreshold !== undefined) {
        advisorLowCpuConfigurations.set(subscriptionId, {
          lowCpuThreshold,
          ...(typeof configuration.id === 'string'
            ? { resourceId: configuration.id }
            : {}),
        })
      }
      if (excluded) {
        if (resourceGroup) {
          excludedAdvisorResourceGroups.add(
            `${subscriptionId}|${resourceGroup}`,
          )
        } else {
          excludedAdvisorSubscriptions.add(subscriptionId)
        }
      }
    }

    const advisorRows = graphResults.get('advisor')
    if (advisorRows) {
      completeSourceFamilies.push('azure:advisor-cost')
      for (const value of advisorRows) {
        const advisorRow = asObject(value)
        const resource = resourceRecord(value)
        if (!resource) continue
        const subscription = subscriptionById.get(
          resource.subscriptionId.toLowerCase(),
        )
        if (!subscription) continue
        const properties = resource.properties
        const nativeStatus = normalizedAdvisorStatus(properties)
        if (!isActiveAdvisorRecommendation(properties)) continue
        if (properties.tracked === true) continue
        const exclusionKey =
          `${resource.subscriptionId.toLowerCase()}|${(
            resource.resourceGroup ?? ''
          ).toLowerCase()}`
        if (
          excludedAdvisorSubscriptions.has(
            resource.subscriptionId.toLowerCase(),
          ) ||
          excludedAdvisorResourceGroups.has(exclusionKey)
        ) {
          continue
        }
        const resourceMetadata = asObject(properties.resourceMetadata)
        const impactedResourceId =
          typeof resourceMetadata.resourceId === 'string'
            ? resourceMetadata.resourceId
            : typeof properties.resourceId === 'string'
              ? properties.resourceId
              : resource.id
        const impactedResource: ResourceRecord = {
          ...resource,
          id: impactedResourceId,
          name:
            impactedResourceId.split('/').filter(Boolean).at(-1) ??
            resource.name,
          type:
            typeof properties.impactedField === 'string'
              ? properties.impactedField
              : resource.type,
        }
        const shortDescription = asObject(properties.shortDescription)
        const extended = asObject(properties.extendedProperties)
        const recommendationTypeId = firstString(properties, [
          'recommendationTypeId',
        ])
        const normalizedRecommendationTypeId =
          recommendationTypeId?.toLowerCase()
        const inactiveVmConfiguration =
          normalizedRecommendationTypeId &&
          ADVISOR_INACTIVE_VM_TYPE_IDS.has(normalizedRecommendationTypeId)
            ? advisorLowCpuConfigurations.get(
                resource.subscriptionId.toLowerCase(),
              )
            : undefined
        const maxCpuP95 = firstNumber(extended, ['MaxCpuP95'])
        if (
          normalizedRecommendationTypeId &&
          ADVISOR_INACTIVE_VM_TYPE_IDS.has(
            normalizedRecommendationTypeId,
          )
        ) {
          const passesLowCpuConfiguration =
            inactiveVmConfiguration && maxCpuP95 !== undefined
              ? maxCpuP95 < inactiveVmConfiguration.lowCpuThreshold
              : maxCpuP95 === undefined || maxCpuP95 < 100
          if (!passesLowCpuConfiguration) continue
        }
        const annualSavings = firstNumber(extended, [
          'annualSavingsAmount',
          'annualSavings',
        ])
        const rawMonthlySavings =
          firstNumber(extended, [
            'monthlySavingsAmount',
            'savingsAmount',
            'estimatedMonthlySavings',
          ])
        const monthlySavings =
          rawMonthlySavings ??
          (annualSavings !== undefined ? annualSavings / 12 : null)
        const currentCost = resourceCost(impactedResourceId, allResourceCosts)
        const costCurrency = costBySubscription
          .get(resource.subscriptionId.toLowerCase())
          ?.currency?.trim()
          .toUpperCase()
        const advisorCurrency = firstString(extended, [
          'savingsCurrency',
          'annualSavingsCurrency',
          'currency',
        ])?.toUpperCase()
        const currenciesConflict = Boolean(
          costCurrency &&
            advisorCurrency &&
            costCurrency !== advisorCurrency,
        )
        if (currenciesConflict) {
          warnings.push(
            `Azure Advisor savings for ${subscription.displayName}/${resource.name} use ${advisorCurrency}, while Cost Management uses ${costCurrency}; both source amounts are retained without combining them.`,
          )
        }
        const comparableCurrentCost = currenciesConflict ? null : currentCost
        const term = formatCommitmentTerm(
          firstString(extended, ['term']),
        )
        const lookbackPeriod = firstString(extended, [
          'lookbackPeriod',
        ])
        const recommendedQuantity = firstString(extended, [
          'qty',
          'displayQty',
        ])
        const recommendedSku = firstString(extended, [
          'sku',
          'displaySKU',
        ])
        const recommendationRegion = firstString(extended, ['region'])
        const recommendationCurrency =
          advisorCurrency ?? costCurrency ?? null
        if (monthlySavings !== null && monthlySavings > 0 && !recommendationCurrency) {
          warnings.push(
            `Azure Advisor savings for ${subscription.displayName}/${resource.name} have no source currency and were retained as non-monetary evidence.`,
          )
        }
        const hasMonetaryEstimate =
          monthlySavings !== null &&
          monthlySavings > 0 &&
          recommendationCurrency !== null
        const confidence =
          hasMonetaryEstimate &&
          comparableCurrentCost !== null &&
          comparableCurrentCost > 0
            ? 0.9
            : hasMonetaryEstimate
              ? 0.78
              : 0.62
        const baseTitle =
          typeof shortDescription.solution === 'string'
            ? shortDescription.solution
            : 'Review Azure Advisor cost recommendation'
        const problem =
          typeof shortDescription.problem === 'string'
            ? shortDescription.problem
            : 'Azure Advisor identified a cost optimization opportunity.'
        const scenario = [
          term,
          lookbackPeriod
            ? `${lookbackPeriod}-day lookback`
            : undefined,
        ].filter(Boolean)
        const title = scenario.length
          ? `${baseTitle} (${scenario.join(', ')})`
          : baseTitle
        const classification = classifyAdvisorSavingsActivity({
          recommendationTypeId,
          title,
          description: problem,
          category: categoryForAdvisor(
            impactedResource.type,
            title,
            problem,
          ),
          resourceType: impactedResource.type,
        })
        const nativeLastUpdatedAt = firstString(properties, [
          'lastUpdated',
          'lastUpdatedAt',
        ])
        const nativeImpact = firstString(properties, ['impact'])
        const nativeRisk =
          firstString(properties, ['risk']) ??
          firstString(extended, ['risk'])
        const lookbackDays = finiteNumber(lookbackPeriod)
        const missingEvidence = [
          ...(comparableCurrentCost === null
            ? ['Independent resource-level cost baseline']
            : []),
          ...(!recommendationCurrency ? ['Savings currency'] : []),
          ...(!nativeStatus ? ['Authoritative Advisor lifecycle status'] : []),
          ...(!nativeLastUpdatedAt ? ['Advisor last-updated timestamp'] : []),
          ...(!lookbackDays ? ['Advisor usage lookback window'] : []),
          ...(normalizedRecommendationTypeId &&
          ADVISOR_INACTIVE_VM_TYPE_IDS.has(normalizedRecommendationTypeId) &&
          maxCpuP95 === undefined
            ? ['Advisor MaxCpuP95 used by the inactive-VM configuration rule']
            : []),
          ...(!graphResults.has('advisorConfigurations')
            ? ['Advisor exclusion configuration']
            : []),
        ]
        recommendations.push(
          makeRecommendation({
            source: 'advisor',
            sourceFamily: 'azure:advisor-cost',
            sourceRecommendationId:
              typeof advisorRow.advisorRecommendationId === 'string'
                ? advisorRow.advisorRecommendationId
                : resource.name,
            category: categoryForAdvisor(
              impactedResource.type,
              title,
              problem,
            ),
            activity: classification.activity,
            title,
            description: problem,
            suggestedAction: title,
            tenantId,
            subscription,
            resource: impactedResource,
            savings: hasMonetaryEstimate ? monthlySavings : null,
            currentCost: comparableCurrentCost,
            currency: recommendationCurrency,
            confidence,
            effort: 'medium',
            risk: 'medium',
            evidence: [
              {
                label: 'Advisor impact',
                value:
                  typeof properties.impact === 'string'
                    ? properties.impact
                    : 'Cost',
                source: 'Azure Advisor',
                observedAt: collectedAt,
              },
              ...(monthlySavings !== null && monthlySavings > 0
                ? [
                    {
                      label: 'Estimated monthly savings',
                      value: monthlySavings,
                      ...(recommendationCurrency
                        ? { unit: recommendationCurrency }
                        : {}),
                      source: 'Azure Advisor',
                      observedAt: collectedAt,
                    },
                  ]
                : []),
              ...(annualSavings !== undefined
                ? [
                    {
                      label: 'Estimated annual savings',
                      value: annualSavings,
                      ...(recommendationCurrency
                        ? { unit: recommendationCurrency }
                        : {}),
                      source: 'Azure Advisor',
                      observedAt: collectedAt,
                    },
                  ]
                : []),
              ...(comparableCurrentCost !== null && costCurrency
                ? [
                    {
                      label: 'Median completed-month amortized cost',
                      value: comparableCurrentCost,
                      unit: costCurrency,
                      source: 'Cost Management',
                      observedAt: collectedAt,
                    },
                  ]
                : []),
              ...(term
                ? [
                    {
                      label: 'Commitment term',
                      value: term,
                      source: 'Azure Advisor',
                      observedAt: collectedAt,
                    },
                  ]
                : []),
              ...(lookbackPeriod
                ? [
                    {
                      label: 'Usage lookback',
                      value: `${lookbackPeriod} days`,
                      source: 'Azure Advisor',
                      observedAt: collectedAt,
                    },
                  ]
                : []),
              ...(recommendedQuantity
                ? [
                    {
                      label: 'Recommended quantity',
                      value: recommendedQuantity,
                      source: 'Azure Advisor',
                      observedAt: collectedAt,
                    },
                  ]
                : []),
              ...(recommendedSku
                ? [
                    {
                      label: 'Recommended SKU',
                      value: recommendedSku,
                      source: 'Azure Advisor',
                      observedAt: collectedAt,
                    },
                  ]
                : []),
              ...(recommendationRegion
                ? [
                    {
                      label: 'Recommendation region',
                      value: recommendationRegion,
                      source: 'Azure Advisor',
                      observedAt: collectedAt,
                    },
                  ]
                : []),
            ],
            claim: {
              level: hasMonetaryEstimate
                ? 'azure_estimate'
                : 'investigation_lead',
              decisionStatus: hasMonetaryEstimate
                ? 'needs_validation'
                : 'needs_evidence',
              validationState: hasMonetaryEstimate
                ? 'azure_authored'
                : 'unvalidated',
              ruleVersion: ADVISOR_RULE_VERSION,
              provenance: {
                provider: this.name,
                sourceFamily: 'azure:advisor-cost',
                sourceApi: 'Azure Advisor via Azure Resource Graph',
                sourceApiVersion: RESOURCE_GRAPH_API_VERSION,
                collectedAt,
                nativeRecommendationId:
                  typeof advisorRow.advisorRecommendationId === 'string'
                    ? advisorRow.advisorRecommendationId
                    : resource.name,
                nativeRecommendationResourceId:
                  typeof advisorRow.advisorResourceId === 'string'
                    ? advisorRow.advisorResourceId
                    : undefined,
                nativeRecommendationTypeId: recommendationTypeId,
                nativeStatus,
                nativeLastUpdatedAt,
                nativeImpact,
                nativeRisk,
                nativeLookbackDays: lookbackDays,
                activityClassification: classification.method,
                extendedProperties: scalarExtendedProperties(extended),
                ...(inactiveVmConfiguration
                  ? {
                      advisorConfiguration: {
                        source: 'Azure Advisor configuration' as const,
                        scope: resource.subscriptionId,
                        resourceId: inactiveVmConfiguration.resourceId,
                        lowCpuThreshold:
                          inactiveVmConfiguration.lowCpuThreshold,
                      },
                    }
                  : {}),
              },
              evidenceWindow: lookbackDays
                ? {
                    lookbackDays,
                    description: `Azure Advisor usage lookback of ${lookbackDays} days`,
                  }
                : {
                    endAt: collectedAt,
                    description:
                      'Point-in-time Advisor recommendation; source lookback was not supplied.',
                  },
              ...(hasMonetaryEstimate
                ? {
                    formula: {
                      expression:
                        rawMonthlySavings !== undefined
                          ? 'azure_advisor_monthly_savings'
                          : 'annual_savings / 12',
                      inputs: [
                        rawMonthlySavings !== undefined
                          ? {
                              name: 'azure_advisor_monthly_savings',
                              value: rawMonthlySavings,
                              unit: recommendationCurrency,
                              sourceEvidenceLabel:
                                'Estimated monthly savings',
                            }
                          : {
                              name: 'annual_savings',
                              value: annualSavings ?? 0,
                              unit: recommendationCurrency,
                              sourceEvidenceLabel:
                                'Estimated annual savings',
                            },
                      ],
                      assumptions: [
                        rawMonthlySavings !== undefined
                          ? 'The amount and monthly period are authored by Azure Advisor.'
                          : 'Azure annual estimate is distributed evenly across twelve months.',
                      ],
                      exclusions: [
                        'No independent validation of the Azure-authored forecast.',
                      ],
                      ruleVersion: ADVISOR_RULE_VERSION,
                    },
                  }
                : {}),
              missingEvidence,
            },
            observedAt: collectedAt,
          }),
        )
      }
    }

    const orphanInputs = [
      {
        key: 'disks',
        title: 'Delete an unattached managed disk',
        description:
          'The managed disk is unattached and may continue to incur storage charges.',
        action:
          'Confirm retention requirements, snapshot if necessary, then delete the disk.',
      },
      {
        key: 'publicIps',
        title: 'Remove an unattached public IP address',
        description:
          'The public IP has no IP configuration and appears to be unused.',
        action:
          'Verify DNS and deployment references, then remove the public IP.',
      },
      {
        key: 'nics',
        title: 'Remove an unattached network interface',
        description:
          'The network interface has no virtual machine or private endpoint attachment.',
        action:
          'Verify deployment references, then remove the unused network interface.',
      },
    ] as const
    if (orphanInputs.every((input) => graphResults.has(input.key))) {
      completeSourceFamilies.push('azure:resource-orphans')
    }
    for (const input of orphanInputs) {
      for (const value of graphResults.get(input.key) ?? []) {
        const resource = resourceRecord(value)
        if (!resource) continue
        const subscription = subscriptionById.get(
          resource.subscriptionId.toLowerCase(),
        )
        if (!subscription) continue
        const currency =
          currencyBySubscription.get(
            resource.subscriptionId.toLowerCase(),
          ) ?? null
        const currentCost = resourceCost(resource.id, allResourceCosts)
        const quantified =
          currentCost !== null && currentCost > 0 && currency !== null
        recommendations.push(
          makeRecommendation({
            source: 'resource_graph',
            sourceFamily: 'azure:resource-orphans',
            category: categoryForResource(resource.type),
            activity: 'orphan_cleanup',
            title: input.title,
            description: input.description,
            suggestedAction: input.action,
            tenantId,
            subscription,
            resource,
            savings: quantified ? currentCost : null,
            currentCost,
            currency,
            confidence: quantified ? 0.96 : 0.82,
            effort: 'low',
            risk: 'medium',
            evidence: [
              {
                label: 'Attachment',
                value: 'None',
                source: 'Azure Resource Graph',
                observedAt: collectedAt,
              },
              ...(quantified
                ? [
                    {
                      label: 'Median completed-month amortized cost',
                      value: currentCost,
                      unit: currency,
                      source: 'Cost Management',
                      observedAt: collectedAt,
                    },
                  ]
                : []),
            ],
            claim: {
              level: quantified ? 'calculated_scenario' : 'observed_fact',
              decisionStatus: 'needs_validation',
              validationState: quantified
                ? 'deterministic_calculation'
                : 'independently_validated',
              ruleVersion: ORPHAN_RULE_VERSION,
              provenance: {
                provider: this.name,
                sourceFamily: 'azure:resource-orphans',
                sourceApi: 'Azure Resource Graph',
                sourceApiVersion: RESOURCE_GRAPH_API_VERSION,
                collectedAt,
                activityClassification: 'deterministic_rule',
                extendedProperties: {},
              },
              evidenceWindow: {
                endAt: collectedAt,
                description:
                  'Point-in-time resource relationship with a completed-month median cost baseline.',
              },
              ...(quantified
                ? {
                    formula: {
                      expression: 'avoidable_monthly_cost = median_resource_cost',
                      inputs: [
                        {
                          name: 'median_resource_cost',
                          value: currentCost,
                          unit: currency,
                          sourceEvidenceLabel:
                            'Median completed-month amortized cost',
                        },
                      ],
                      assumptions: [
                        'Deleting the resource removes all resource-attributed variable cost.',
                        'The current unattached relationship persists after validation.',
                      ],
                      exclusions: [
                        'Reservation or commitment reallocation effects.',
                        'Retention, recovery, deployment and external dependency requirements.',
                      ],
                      ruleVersion: ORPHAN_RULE_VERSION,
                    },
                  }
                : {}),
              missingEvidence: [
                'Resource age and duration in the unattached state',
                'External deployment, DNS and recovery dependencies',
                ...(quantified
                  ? []
                  : ['Native-currency resource-level cost baseline']),
              ],
            },
            observedAt: collectedAt,
          }),
        )
      }
    }

    const vmRows = graphResults.get('vms')
    const scheduleRows = graphResults.get('schedules')
    if (vmRows && scheduleRows) {
      completeSourceFamilies.push('azure:auto-shutdown-coverage')
      const scheduledTargets = new Set<string>()
      const scheduleInspections = new Map<
        string,
        ShutdownScheduleInspection[]
      >()
      for (const value of scheduleRows) {
        const schedule = resourceRecord(value)
        if (!schedule) continue
        const inspection = inspectShutdownSchedule(schedule)
        if (!inspection.targetResourceId) continue
        const target = inspection.targetResourceId.toLowerCase()
        const inspections = scheduleInspections.get(target) ?? []
        inspections.push(inspection)
        scheduleInspections.set(target, inspections)
        if (inspection.activeCoverage) scheduledTargets.add(target)
      }
      for (const value of vmRows) {
        const resource = resourceRecord(value)
        if (!resource || scheduledTargets.has(resource.id.toLowerCase())) {
          continue
        }
        const heuristic = nonProductionHeuristic(resource)
        if (!heuristic) continue
        const subscription = subscriptionById.get(
          resource.subscriptionId.toLowerCase(),
        )
        if (!subscription) continue
        const currency =
          currencyBySubscription.get(
            resource.subscriptionId.toLowerCase(),
          ) ?? null
        const currentCost = resourceCost(resource.id, allResourceCosts)
        const eligibleVariableCost = resourceCost(
          resource.id,
          allVariableResourceCosts,
        )
        const inspectedSchedules =
          scheduleInspections.get(resource.id.toLowerCase()) ?? []
        recommendations.push(
          makeRecommendation({
            source: 'prospector',
            sourceFamily: 'azure:auto-shutdown-coverage',
            category: 'scheduling',
            activity: 'shutdown_scheduling',
            title: 'Review VM auto-shutdown coverage',
            description:
              'No matching DevTest Lab auto-shutdown schedule was found. Workload operating hours are unknown, so this is a low-confidence lead.',
            suggestedAction:
              'Confirm required operating hours and configure auto-shutdown when appropriate.',
            tenantId,
            subscription,
            resource,
            savings: null,
            currentCost,
            currency,
            confidence: 0.45,
            effort: 'low',
            risk: 'low',
            evidence: [
              {
                label: 'Auto-shutdown schedule',
                value: 'Not found',
                source: 'Azure Resource Graph',
                observedAt: collectedAt,
              },
              {
                label: 'Non-production heuristic',
                value: heuristic,
                source: 'Resource name or generic environment tag',
                observedAt: collectedAt,
              },
              ...(inspectedSchedules.length
                ? [
                    {
                      label: 'Matching schedule records inspected',
                      value: JSON.stringify(
                        inspectedSchedules.map((inspection) => ({
                          status: inspection.status ?? 'unknown',
                          taskType: inspection.taskType ?? 'unknown',
                          recurrence: inspection.recurrence ?? 'missing',
                          timeZone: inspection.timeZone ?? 'missing',
                          activeCoverage: inspection.activeCoverage,
                        })),
                      ),
                      source: 'Azure Resource Graph',
                      observedAt: collectedAt,
                    },
                  ]
                : []),
              ...(currentCost !== null && currency !== null
                ? [
                    {
                      label: 'Median completed-month amortized cost',
                      value: currentCost,
                      unit: currency,
                      source: 'Cost Management',
                      observedAt: collectedAt,
                    },
                  ]
                : []),
              ...(eligibleVariableCost !== null && currency !== null
                ? [
                    {
                      label: 'Eligible variable VM compute cost',
                      value: eligibleVariableCost,
                      unit: currency,
                      source:
                        'Cost Management PricingModel=OnDemand or Spot',
                      observedAt: collectedAt,
                    },
                  ]
                : []),
            ],
            claim: {
              level: 'investigation_lead',
              decisionStatus: 'needs_evidence',
              validationState: 'unvalidated',
              ruleVersion: SCHEDULE_RULE_VERSION,
              provenance: {
                provider: this.name,
                sourceFamily: 'azure:auto-shutdown-coverage',
                sourceApi: 'Azure Resource Graph',
                sourceApiVersion: RESOURCE_GRAPH_API_VERSION,
                collectedAt,
                activityClassification: 'deterministic_rule',
                extendedProperties: {},
              },
              evidenceWindow: {
                endAt: collectedAt,
                description:
                  'Point-in-time DevTest Lab schedule inventory; no runtime history was collected.',
              },
              missingEvidence: [
                'Historical VM running and deallocated state',
                'Required operating hours and time zone',
                'CPU, memory, disk and network utilization over a representative window',
                'Azure Automation, Logic Apps, Functions and external scheduler coverage',
                'Variable compute cost separated from fixed disks, IPs and commitments',
              ],
            },
            observedAt: collectedAt,
          }),
        )
      }
    }

    const vmCandidateRecommendations = recommendations
      .filter(
        (recommendation) =>
          recommendation.resourceId &&
          recommendation.location &&
          recommendation.resourceType.toLowerCase() ===
            'microsoft.compute/virtualmachines' &&
          ['right_sizing', 'shutdown_scheduling'].includes(
            recommendation.activity,
          ),
      )
      .sort((left, right) =>
        left.activity === right.activity
          ? left.resourceId!.localeCompare(right.resourceId!)
          : left.activity === 'shutdown_scheduling'
            ? -1
            : 1,
      )
    const uniqueVmCandidates = new Map<string, VmTelemetryCandidate>()
    for (const recommendation of vmCandidateRecommendations) {
      const resourceId = recommendation.resourceId!
      if (uniqueVmCandidates.has(resourceId.toLowerCase())) continue
      uniqueVmCandidates.set(resourceId.toLowerCase(), {
        resourceId,
        subscriptionId: recommendation.subscriptionId,
        location: recommendation.location!,
      })
    }
    vmTelemetryCandidateCount = uniqueVmCandidates.size
    const maximumTelemetryCandidates = Math.floor(
      this.options.telemetryMaximumCandidates ??
        numericEnvironmentValue(
          'AZURE_VM_TELEMETRY_MAX_CANDIDATES',
          50,
          1,
          200,
        ),
    )
    const selectedVmCandidates = [...uniqueVmCandidates.values()].slice(
      0,
      maximumTelemetryCandidates,
    )
    vmTelemetrySelectedCount = selectedVmCandidates.length
    if (vmTelemetrySelectedCount < vmTelemetryCandidateCount) {
      warnings.push(
        `Azure Monitor VM telemetry was limited to ${vmTelemetrySelectedCount} of ${vmTelemetryCandidateCount} evidence-relevant candidates.`,
      )
    }
    if (selectedVmCandidates.length) {
      const telemetryWindow = completedThirtyDayWindow(collectionNow)
      const vmTelemetry = await collectVmTelemetry({
        credential: this.credential,
        candidates: selectedVmCandidates,
        availabilityMetricQuery:
          this.options.availabilityMetricQuery ??
          ((candidate, window, abortSignal) =>
            this.queryVmAvailabilityMetric(
              candidate,
              window,
              abortSignal,
            )),
        activityLogQuery: (candidate, window, abortSignal) =>
          this.queryVmActivityLog(candidate, window, abortSignal),
        collectedAt,
        window: telemetryWindow,
        metricsClientFactory: this.options.metricsClientFactory,
        concurrency:
          this.options.telemetryConcurrency ??
          numericEnvironmentValue(
            'AZURE_VM_TELEMETRY_CONCURRENCY',
            3,
            1,
            8,
          ),
        maximumAttempts:
          this.options.telemetryMaximumAttempts ??
          numericEnvironmentValue(
            'AZURE_VM_TELEMETRY_MAX_ATTEMPTS',
            2,
            1,
            3,
          ),
        timeoutMilliseconds:
          this.options.telemetryTimeoutMilliseconds ??
          numericEnvironmentValue(
            'AZURE_VM_TELEMETRY_TIMEOUT_MS',
            20_000,
            1_000,
            120_000,
          ),
        retryDelayMilliseconds:
          this.options.telemetryRetryDelayMilliseconds ??
          numericEnvironmentValue(
            'AZURE_VM_TELEMETRY_RETRY_DELAY_MS',
            500,
            0,
            10_000,
          ),
        batchSize:
          this.options.telemetryBatchSize ??
          numericEnvironmentValue(
            'AZURE_VM_TELEMETRY_BATCH_SIZE',
            20,
            1,
            50,
          ),
      })
      vmTelemetryRetrievedCount = [...vmTelemetry.values()].filter(
        (telemetry) => telemetry.availability.populatedBuckets > 0,
      ).length
      vmTelemetrySufficientCount = [...vmTelemetry.values()].filter(
        (telemetry) =>
          telemetry.availability.populatedBuckets /
            telemetry.availability.expectedBuckets >=
          VM_SCHEDULE_MINIMUM_COVERAGE,
      ).length
      if (vmTelemetryRetrievedCount < vmTelemetrySelectedCount) {
        warnings.push(
          `Azure Monitor availability data was unavailable for ${
            vmTelemetrySelectedCount - vmTelemetryRetrievedCount
          } of ${vmTelemetrySelectedCount} selected VM candidates; per-resource retrieval errors were retained.`,
        )
      }

      for (const recommendation of vmCandidateRecommendations) {
        if (!recommendation.resourceId) continue
        const telemetry = vmTelemetry.get(
          recommendation.resourceId.toLowerCase(),
        )
        if (!telemetry) continue
        recommendation.vmTelemetry = telemetry
        recommendation.evidence.push(...telemetryEvidencePoints(telemetry))
        const guestMemoryGap =
          'Guest memory telemetry is not collected; Azure Monitor Agent and Log Analytics are optional.'
        if (recommendation.activity === 'right_sizing') {
          recommendation.claim = {
            ...recommendation.claim,
            missingEvidence: [
              ...new Set([
                ...recommendation.claim.missingEvidence,
                guestMemoryGap,
                ...(telemetry.availability.populatedBuckets === 0
                  ? ['Azure Monitor platform telemetry for this VM']
                  : []),
              ]),
            ],
          }
          continue
        }

        const scenario = evaluateVmScheduleScenario({
          telemetry,
          eligibleVariableMonthlyCost: resourceCost(
            recommendation.resourceId,
            allVariableResourceCosts,
          ),
          currency: recommendation.currency,
        })
        recommendation.evidence.push({
          label: 'Eight-hours-per-weekday scenario eligibility',
          value: scenario.reason,
          source: 'Prospector deterministic rule',
          observedAt: collectedAt,
        })
        recommendation.claim = {
          ...recommendation.claim,
          evidenceWindow: {
            startAt: telemetry.window.startAt,
            endAt: telemetry.window.endAt,
            lookbackDays: 30,
            description:
              'Completed 30-day Azure Monitor platform-metrics window at hourly granularity.',
          },
          provenance: {
            ...recommendation.claim.provenance,
            sourceApi:
              'Azure Resource Graph, Azure Monitor Metrics and Azure Activity Log',
            extendedProperties: {
              ...recommendation.claim.provenance.extendedProperties,
              telemetryInterval: telemetry.window.interval,
              telemetryExpectedBuckets: telemetry.window.expectedBuckets,
            },
          },
          missingEvidence: [
            ...new Set([
              ...recommendation.claim.missingEvidence.filter(
                (item) =>
                  item !== 'Historical VM running and deallocated state' &&
                  item !==
                    'CPU, memory, disk and network utilization over a representative window' &&
                  (!scenario.eligible ||
                    item !==
                      'Variable compute cost separated from fixed disks, IPs and commitments'),
              ),
              guestMemoryGap,
              'Seasonal representativeness beyond the completed 30-day window',
              ...(scenario.eligible
                ? []
                : ['Sufficient near-continuous VmAvailabilityMetric evidence']),
            ]),
          ],
        }
        if (
          !scenario.eligible ||
          scenario.estimatedMonthlySavings === null ||
          !scenario.formula
        ) {
          continue
        }
        recommendation.estimatedMonthlySavings =
          scenario.estimatedMonthlySavings
        recommendation.azureEstimatedMonthlySavings = null
        recommendation.calculatedMonthlySavings =
          scenario.estimatedMonthlySavings
        recommendation.measuredMonthlySavings = null
        recommendation.confidence = 0.72
        recommendation.confidenceBand = confidenceBand(
          recommendation.confidence,
        )
        recommendation.description =
          'No active DevTest Lab shutdown schedule was found. A completed 30-day platform-metrics window showed near-continuous availability; the monetary value is an eight-hours-per-weekday calculated scenario that requires workload validation.'
        recommendation.claim = {
          ...recommendation.claim,
          level: 'calculated_scenario',
          decisionStatus: 'needs_validation',
          validationState: 'deterministic_calculation',
          ruleVersion: scenario.formula.ruleVersion,
          formula: scenario.formula,
        }
        recommendation.evidence.push({
          label: 'Eight-hours-per-weekday calculated scenario',
          value: scenario.estimatedMonthlySavings,
          unit: recommendation.currency!,
          source: 'Prospector deterministic formula',
          observedAt: collectedAt,
        })
      }
    }

    const resourceCounts = new Map<string, number>()
    for (const value of graphResults.get('resourceCounts') ?? []) {
      const row = asObject(value)
      if (typeof row.subscriptionId === 'string') {
        resourceCounts.set(
          row.subscriptionId.toLowerCase(),
          finiteNumber(row.resourceCount) ?? 0,
        )
      }
    }
    const recommendationsBySubscription = new Map<
      string,
      SnapshotRecommendation[]
    >()
    for (const item of recommendations) {
      const key = item.subscriptionId.toLowerCase()
      const existing = recommendationsBySubscription.get(key) ?? []
      existing.push(item)
      recommendationsBySubscription.set(key, existing)
    }
    const supportedRecommendations =
      selectSupportedOpportunityRecommendations(recommendations)
    const supportedBySubscription = new Map<
      string,
      SnapshotRecommendation[]
    >()
    for (const item of supportedRecommendations) {
      const key = item.subscriptionId.toLowerCase()
      const existing = supportedBySubscription.get(key) ?? []
      existing.push(item)
      supportedBySubscription.set(key, existing)
    }
    const snapshotSubscriptions: SnapshotSubscription[] = subscriptions.map(
      (subscription) => {
        const key = subscription.subscriptionId.toLowerCase()
        const items = recommendationsBySubscription.get(key) ?? []
        const supportedItems = supportedBySubscription.get(key) ?? []
        const owned = items.filter(
          (item) => item.owner.source !== 'unassigned',
        ).length
        const currency =
          currencyBySubscription.get(key) ?? null
        return {
          id: subscription.subscriptionId,
          name: subscription.displayName,
          tenantId: subscription.tenantId,
          state: subscription.state,
          monthlyCost:
            costBySubscription.get(key)?.representativeTotal ?? null,
          potentialMonthlySavings: supportedItems
            .filter(
              (item) =>
                currency !== null &&
                item.currency === currency &&
                item.estimatedMonthlySavings !== null,
            )
            .reduce(
              (sum, item) => sum + (item.estimatedMonthlySavings ?? 0),
              0,
            ),
          openRecommendations: items.length,
          ownerCoverage: items.length ? (owned / items.length) * 100 : 100,
          currency,
          costBasis: 'median_completed_month_amortized_pretax_cost',
          resourceCount: resourceCounts.get(key) ?? 0,
        }
      },
    )

    const monthlyTotalsByCurrency = new Map<
      string,
      Map<string, number>
    >()
    for (const result of costResults) {
      const currency = result.currency?.trim().toUpperCase()
      if (!currency) continue
      const monthlyTotals =
        monthlyTotalsByCurrency.get(currency) ?? new Map<string, number>()
      for (const [period, total] of result.monthlyTotals) {
        monthlyTotals.set(period, (monthlyTotals.get(period) ?? 0) + total)
      }
      monthlyTotalsByCurrency.set(currency, monthlyTotals)
    }
    const opportunityRatios = calculateOpportunityReductionRatios(
      recommendations,
      snapshotSubscriptions,
    )
    const currencyCostTrends = [...monthlyTotalsByCurrency.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([currency, monthlyTotals]) => ({
        currency,
        points: [...monthlyTotals.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([period, observedAmortizedCost]) => ({
            period,
            observedAmortizedCost,
            opportunityScenarioCost:
              observedAmortizedCost *
              (1 - (opportunityRatios.get(currency) ?? 0)),
            measuredSavings: null,
            actualCost: observedAmortizedCost,
            optimizedCost:
              observedAmortizedCost *
              (1 - (opportunityRatios.get(currency) ?? 0)),
            realizedSavings: 0,
          })),
      }))

    const graphSuccesses = graphQueries.filter((query) =>
      graphResults.has(query.key),
    ).length
    const costPercentage = (costResults.length / subscriptions.length) * 100
    const graphPercentage = (graphSuccesses / graphQueries.length) * 100
    const advisorPercentage = graphResults.has('advisor') ? 100 : 0
    const storageInventoryPercentage = graphResults.has('disks') ? 50 : 0
    const owned = recommendations.filter(
      (item) => item.owner.source !== 'unassigned',
    ).length
    const ownershipPercentage = recommendations.length
      ? (owned / recommendations.length) * 100
      : 100
    const vmTelemetryPercentage = vmTelemetrySelectedCount
      ? (vmTelemetrySufficientCount / vmTelemetrySelectedCount) * 100
      : 0
    const coverageStatus = (
      percentage: number,
    ): 'complete' | 'partial' | 'missing' =>
      percentage >= 99.5
        ? 'complete'
        : percentage > 0
          ? 'partial'
          : 'missing'

    return {
      provider: this.name,
      mode: this.mode,
      tenantId,
      tenantName: 'Connected Azure tenant',
      collectedAt,
      resources: [...resourceCounts.values()].reduce(
        (sum, count) => sum + count,
        0,
      ),
      subscriptions: snapshotSubscriptions,
      recommendations,
      currencyCostTrends,
      coverage: [
        {
          key: 'subscriptions',
          label: 'Subscription discovery',
          description: `${subscriptions.length} enabled subscriptions are included.`,
          percentage: 100,
          status: 'complete',
          source: 'Azure Resource Manager',
        },
        {
          key: 'resource-graph',
          label: 'Resource Graph visibility',
          description: `${graphSuccesses} of ${graphQueries.length} read-only inventory queries succeeded.`,
          percentage: graphPercentage,
          status: coverageStatus(graphPercentage),
          source: 'Azure Resource Graph',
          action:
            graphPercentage < 100
              ? 'Grant read access to Resource Graph for the missing scope.'
              : undefined,
        },
        {
          key: 'advisor',
          label: 'Advisor cost recommendations',
          description: graphResults.has('advisor')
            ? 'Cost-category Azure Advisor recommendations were queried through Resource Graph.'
            : 'Azure Advisor recommendation data was not available.',
          percentage: advisorPercentage,
          status: coverageStatus(advisorPercentage),
          source: 'Azure Advisor via Resource Graph',
          action:
            advisorPercentage < 100
              ? 'Grant read access to Advisor recommendations through Resource Graph.'
              : undefined,
        },
        {
          key: 'vm-platform-telemetry',
          label: 'Selected VM platform telemetry',
          description: vmTelemetrySelectedCount
            ? `${vmTelemetrySufficientCount} of ${vmTelemetrySelectedCount} selected evidence-relevant VM candidates returned at least ${
                VM_SCHEDULE_MINIMUM_COVERAGE * 100
              }% of the completed 30-day hourly availability window; ${vmTelemetryRetrievedCount} returned some availability data. ${vmTelemetryCandidateCount} candidates were identified. Guest memory was not collected.`
            : 'No evidence-relevant VM candidates were selected. Platform metrics are queried only for VM schedule or right-sizing findings; guest memory remains optional and was not collected.',
          percentage: vmTelemetryPercentage,
          coveredCount: vmTelemetrySufficientCount,
          totalCount: vmTelemetrySelectedCount,
          status:
            vmTelemetrySelectedCount === 0
              ? 'unavailable'
              : coverageStatus(vmTelemetryPercentage),
          source: 'Azure Monitor Metrics and Activity Log',
          action:
            vmTelemetrySelectedCount > 0 &&
            vmTelemetryPercentage < 100
              ? 'Grant Monitoring Reader access or inspect per-finding retrieval errors. Azure Monitor Agent is not required for platform metrics.'
              : undefined,
        },
        {
          key: 'storage-last-access',
          label: 'Storage last-access and inventory',
          description: graphResults.has('disks')
            ? 'Managed disk inventory was queried, but blob/file last-access telemetry was not.'
            : 'Storage inventory and last-access telemetry were not available.',
          percentage: storageInventoryPercentage,
          status: coverageStatus(storageInventoryPercentage),
          source: 'Azure Resource Graph and Storage telemetry',
          action:
            'Enable and connect storage inventory or last-access telemetry for deeper validation.',
        },
        {
          key: 'commitment-detail',
          label: 'Commitment detail',
          description:
            'Requires billing-account or benefit-specific access that is outside this subscription-scoped assessment.',
          percentage: 0,
          status: 'unavailable',
          source: 'Cost Management commitments',
        },
        {
          key: 'cost-management',
          label: 'Cost visibility',
          description: `${costResults.length} of ${subscriptions.length} subscriptions returned up to ${costQueryPlan.historyMonths} completed months of amortized cost.`,
          percentage: costPercentage,
          status: coverageStatus(costPercentage),
          source: 'Cost Management',
          action:
            costPercentage < 100
              ? 'Grant Cost Management Reader access for subscriptions with gaps.'
              : undefined,
        },
        {
          key: 'ownership',
          label: 'Owner tags',
          description:
            'Ownership is inferred from configured generic resource tags.',
          percentage: ownershipPercentage,
          status: coverageStatus(ownershipPercentage),
          source: 'Resource tags',
          action:
            ownershipPercentage < 100
              ? 'Add an owner tag to resources without an inferred owner.'
              : undefined,
        },
      ],
      warnings,
      completeSourceFamilies,
      completeSourceFamiliesBySubscription: Object.fromEntries(
        subscriptions.map((subscription) => [
          subscription.subscriptionId,
          completeSourceFamilies,
        ]),
      ),
    }
  }
}
