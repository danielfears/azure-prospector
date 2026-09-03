import { createHash } from 'node:crypto'
import {
  AzureCliCredential,
  DefaultAzureCredential,
  InteractiveBrowserCredential,
  ManagedIdentityCredential,
  type TokenCredential,
} from '@azure/identity'
import type {
  ConfidenceBand,
  EvidencePoint,
  RecommendationCategory,
  RecommendationOwner,
} from '../../src/shared/types.js'
import type {
  ProspectorProvider,
  ProviderCollectRequest,
  ProviderSnapshot,
  SnapshotRecommendation,
  SnapshotSubscription,
} from './types.js'
import { configuredSubscriptionIds } from '../azure-config.js'
import { calculateOpportunityReductionRatios } from '../opportunity-scenario.js'

const ARM_ORIGIN = 'https://management.azure.com'
const ARM_SCOPE = 'https://management.azure.com/.default'
const RESOURCE_GRAPH_API_VERSION = '2022-10-01'
const COST_API_VERSION = '2023-11-01'
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
): number {
  return costs.get(resourceId.toLowerCase()) ?? 0
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

function makeRecommendation(input: {
  source: SnapshotRecommendation['source']
  sourceFamily: string
  sourceRecommendationId?: string
  category: RecommendationCategory
  title: string
  description: string
  suggestedAction: string
  tenantId?: string
  subscription: ArmSubscription
  resource: ResourceRecord
  savings: number
  currentCost: number
  currency: string
  confidence: number
  effort: SnapshotRecommendation['effort']
  risk: SnapshotRecommendation['risk']
  evidence: EvidencePoint[]
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
  return {
    id: `rec_${fingerprint}`,
    fingerprint,
    source: input.source,
    sourceFamily: input.sourceFamily,
    sourceRecommendationId: input.sourceRecommendationId,
    category: input.category,
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
    estimatedMonthlySavings: Math.max(0, input.savings),
    currentMonthlyCost: Math.max(0, input.currentCost),
    currency: input.currency,
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

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
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

export class AzureProvider implements ProspectorProvider {
  readonly name = 'azure'
  readonly mode = 'live' as const
  private readonly credential: TokenCredential
  private readonly requestedTenantId?: string

  constructor(credential?: TokenCredential, requestedTenantId?: string) {
    this.requestedTenantId = requestedTenantId
    this.credential = credential ?? createCredential(requestedTenantId)
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
        await sleep(delay)
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
        grouping: [{ type: 'Dimension', name: 'ResourceId' }],
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
      monthlyTotals,
      representativeTotal: median([...monthlyTotals.values()]),
    }
  }

  async collect(request: ProviderCollectRequest): Promise<ProviderSnapshot> {
    const collectedAt = new Date().toISOString()
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
    const fallbackCurrency = billingCurrencies[0] ?? 'USD'
    const allResourceCosts = new Map<string, number>()
    for (const result of costResults) {
      for (const [resourceId, cost] of result.representativeByResource) {
        allResourceCosts.set(resourceId, cost)
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
              advisorRecommendationId
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
    const tenantId =
      requestedTenantId ??
      subscriptions.find((subscription) => subscription.tenantId)?.tenantId

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
        const annualSavings = firstNumber(extended, [
          'annualSavingsAmount',
          'annualSavings',
        ])
        const monthlySavings =
          firstNumber(extended, [
            'monthlySavingsAmount',
            'savingsAmount',
            'estimatedMonthlySavings',
          ]) ?? (annualSavings !== undefined ? annualSavings / 12 : 0)
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
        const recommendationCurrency =
          advisorCurrency ?? costCurrency ?? fallbackCurrency
        if (
          advisorCurrency &&
          !currencyBySubscription.has(resource.subscriptionId.toLowerCase())
        ) {
          currencyBySubscription.set(
            resource.subscriptionId.toLowerCase(),
            advisorCurrency,
          )
        }
        const comparableCurrentCost = currenciesConflict ? 0 : currentCost
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
        const confidence =
          monthlySavings > 0 && comparableCurrentCost > 0
            ? 0.9
            : monthlySavings > 0
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
            title,
            description: problem,
            suggestedAction: title,
            tenantId,
            subscription,
            resource: impactedResource,
            savings: monthlySavings,
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
              ...(monthlySavings > 0
                ? [
                    {
                      label: 'Estimated monthly savings',
                      value: monthlySavings,
                      unit: recommendationCurrency,
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
                      unit: recommendationCurrency,
                      source: 'Azure Advisor',
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
          ) ?? fallbackCurrency
        const currentCost = resourceCost(resource.id, allResourceCosts)
        recommendations.push(
          makeRecommendation({
            source: 'resource_graph',
            sourceFamily: 'azure:resource-orphans',
            category: categoryForResource(resource.type),
            title: input.title,
            description: input.description,
            suggestedAction: input.action,
            tenantId,
            subscription,
            resource,
            savings: currentCost,
            currentCost,
            currency,
            confidence: currentCost > 0 ? 0.96 : 0.82,
            effort: 'low',
            risk: 'medium',
            evidence: [
              {
                label: 'Attachment',
                value: 'None',
                source: 'Azure Resource Graph',
                observedAt: collectedAt,
              },
              ...(currentCost > 0
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
      for (const value of scheduleRows) {
        const schedule = resourceRecord(value)
        if (!schedule) continue
        const target =
          typeof schedule.properties.targetResourceId === 'string'
            ? schedule.properties.targetResourceId
            : undefined
        if (target) scheduledTargets.add(target.toLowerCase())
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
          ) ?? fallbackCurrency
        const currentCost = resourceCost(resource.id, allResourceCosts)
        recommendations.push(
          makeRecommendation({
            source: 'prospector',
            sourceFamily: 'azure:auto-shutdown-coverage',
            category: 'scheduling',
            title: 'Review VM auto-shutdown coverage',
            description:
              'No matching DevTest Lab auto-shutdown schedule was found. Workload operating hours are unknown, so this is a low-confidence lead.',
            suggestedAction:
              'Confirm required operating hours and configure auto-shutdown when appropriate.',
            tenantId,
            subscription,
            resource,
            savings: currentCost * 0.5,
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
            ],
            observedAt: collectedAt,
          }),
        )
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
    const snapshotSubscriptions: SnapshotSubscription[] = subscriptions.map(
      (subscription) => {
        const key = subscription.subscriptionId.toLowerCase()
        const items = recommendationsBySubscription.get(key) ?? []
        const owned = items.filter(
          (item) => item.owner.source !== 'unassigned',
        ).length
        const currency =
          currencyBySubscription.get(key) ?? fallbackCurrency
        return {
          id: subscription.subscriptionId,
          name: subscription.displayName,
          tenantId: subscription.tenantId,
          state: subscription.state,
          monthlyCost:
            costBySubscription.get(key)?.representativeTotal ?? 0,
          potentialMonthlySavings: items
            .filter((item) => item.currency === currency)
            .reduce(
              (sum, item) => sum + item.estimatedMonthlySavings,
              0,
            ),
          openRecommendations: items.length,
          ownerCoverage: items.length ? (owned / items.length) * 100 : 100,
          currency,
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
          .map(([period, actualCost]) => ({
            period,
            actualCost,
            optimizedCost:
              actualCost *
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
          key: 'vm-guest-telemetry',
          label: 'VM and guest telemetry',
          description:
            'Guest metrics and workload telemetry are not queried; VM schedule findings use inventory heuristics only.',
          percentage: 0,
          status: 'missing',
          source: 'Azure Monitor',
          action:
            'Connect Azure Monitor telemetry to validate utilization-based findings.',
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
