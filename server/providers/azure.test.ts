import type { TokenCredential } from '@azure/identity'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AzureProvider,
  createCostQueryPlan,
} from './azure.js'
import { calculateOpportunityReductionRatios } from '../opportunity-scenario.js'

const originalFetch = globalThis.fetch
const originalSubscriptionIds = process.env.PROSPECTOR_SUBSCRIPTION_IDS
const originalCostInterval = process.env.AZURE_COST_REQUEST_INTERVAL_MS
const originalPageInterval = process.env.AZURE_COST_PAGE_INTERVAL_MS
const originalCostBudget = process.env.AZURE_COST_QPU_BUDGET_PER_SCAN
const originalCostHistory = process.env.AZURE_COST_HISTORY_MONTHS
const originalRetryAttempts = process.env.AZURE_HTTP_RETRY_ATTEMPTS

beforeEach(() => {
  process.env.AZURE_COST_REQUEST_INTERVAL_MS = '0'
  process.env.AZURE_COST_PAGE_INTERVAL_MS = '0'
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
  if (originalSubscriptionIds === undefined) {
    delete process.env.PROSPECTOR_SUBSCRIPTION_IDS
  } else {
    process.env.PROSPECTOR_SUBSCRIPTION_IDS = originalSubscriptionIds
  }
  if (originalCostInterval === undefined) {
    delete process.env.AZURE_COST_REQUEST_INTERVAL_MS
  } else {
    process.env.AZURE_COST_REQUEST_INTERVAL_MS = originalCostInterval
  }
  for (const [name, original] of [
    ['AZURE_COST_PAGE_INTERVAL_MS', originalPageInterval],
    ['AZURE_COST_QPU_BUDGET_PER_SCAN', originalCostBudget],
    ['AZURE_COST_HISTORY_MONTHS', originalCostHistory],
    ['AZURE_HTTP_RETRY_ATTEMPTS', originalRetryAttempts],
  ]) {
    if (original === undefined) {
      delete process.env[name]
    } else {
      process.env[name] = original
    }
  }
})

function jsonResponse(
  payload: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

describe('AzureProvider', () => {
  it('builds a confidence-weighted, per-resource opportunity scenario', () => {
    const ratios = calculateOpportunityReductionRatios(
      [
        {
          currency: 'GBP',
          resourceId: 'resource-one',
          fingerprint: 'finding-one',
          estimatedMonthlySavings: 200,
          currentMonthlyCost: 300,
          confidence: 0.8,
        },
        {
          currency: 'GBP',
          resourceId: 'resource-one',
          fingerprint: 'finding-two',
          estimatedMonthlySavings: 100,
          currentMonthlyCost: 300,
          confidence: 0.9,
        },
        {
          currency: 'USD',
          fingerprint: 'advisor-only',
          estimatedMonthlySavings: 500,
          currentMonthlyCost: 0,
          confidence: 0.8,
        },
      ],
      [
        { currency: 'GBP', monthlyCost: 1000 },
        { currency: 'USD', monthlyCost: 0 },
      ],
    )

    expect(ratios.get('GBP')).toBeCloseTo(0.16)
    expect(ratios.get('USD')).toBe(0)
  })

  it('adapts cost history to the tenant QPU budget', () => {
    expect(createCostQueryPlan(2)).toEqual({
      historyMonths: 6,
      subscriptionsToQuery: 2,
      estimatedQpu: 12,
      minimumIntervalMilliseconds: 6600,
    })
    expect(createCostQueryPlan(122)).toEqual({
      historyMonths: 3,
      subscriptionsToQuery: 122,
      estimatedQpu: 366,
      minimumIntervalMilliseconds: 3300,
    })
    expect(createCostQueryPlan(500)).toEqual({
      historyMonths: 1,
      subscriptionsToQuery: 480,
      estimatedQpu: 480,
      minimumIntervalMilliseconds: 3300,
    })
  })

  it("retains each subscription's native billing currency without conversion", async () => {
    delete process.env.PROSPECTOR_SUBSCRIPTION_IDS
    const graphQueries: string[] = []
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input)
      if (url.includes('/subscriptions?')) {
        return jsonResponse({
          value: [
            {
              subscriptionId: 'sub-usd',
              displayName: 'USD subscription',
              state: 'Enabled',
              tenantId: 'tenant-one',
            },
            {
              subscriptionId: 'sub-eur',
              displayName: 'EUR subscription',
              state: 'Enabled',
              tenantId: 'tenant-one',
            },
          ],
        })
      }
      if (url.includes('/subscriptions/sub-usd/providers/Microsoft.CostManagement/query')) {
        return jsonResponse({
          properties: {
            columns: [
              { name: 'PreTaxCost' },
              { name: 'ResourceId' },
              { name: 'BillingMonth' },
              { name: 'Currency' },
            ],
            rows: [
              [
                100,
                '/subscriptions/sub-usd/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm-usd',
                '202608',
                'USD',
              ],
            ],
          },
        })
      }
      if (url.includes('/subscriptions/sub-eur/providers/Microsoft.CostManagement/query')) {
        return jsonResponse({
          properties: {
            columns: [
              { name: 'PreTaxCost' },
              { name: 'ResourceId' },
              { name: 'BillingMonth' },
              { name: 'Currency' },
            ],
            rows: [
              [
                75,
                '/subscriptions/sub-eur/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm-eur',
                '202608',
                'GBP',
              ],
            ],
          },
        })
      }
      if (url.includes('/providers/Microsoft.ResourceGraph/resources')) {
        const body = JSON.parse(String(init?.body)) as { query: string }
        graphQueries.push(body.query)
        if (body.query.includes('advisorresources')) {
          return jsonResponse({
            data: [
              {
                id: '/subscriptions/sub-eur/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm-eur',
                name: 'vm-eur',
                type: 'Microsoft.Compute/virtualMachines',
                subscriptionId: 'sub-eur',
                resourceGroup: 'rg',
                location: 'westeurope',
                tags: {},
                advisorRecommendationId: 'advisor-eur',
                properties: {
                  category: 'Cost',
                  impactedField: 'Microsoft.Compute/virtualMachines',
                  resourceMetadata: {
                    resourceId:
                      '/subscriptions/sub-eur/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm-eur',
                  },
                  shortDescription: {
                    solution: 'Right-size the virtual machine',
                    problem: 'The virtual machine is underutilized.',
                  },
                  extendedProperties: {
                    savingsAmount: '50',
                    savingsCurrency: 'EUR',
                  },
                },
              },
            ],
          })
        }
        return jsonResponse({ data: [] })
      }
      throw new Error(`Unexpected Azure request: ${url}`)
    }) as typeof fetch

    const credential: TokenCredential = {
      async getToken() {
        return {
          token: 'test-token',
          expiresOnTimestamp: Date.now() + 60_000,
        }
      },
    }
    const provider = new AzureProvider(credential, 'tenant-one')

    const snapshot = await provider.collect({ tenantId: 'tenant-one' })

    expect(
      snapshot.subscriptions.map((subscription) => subscription.currency),
    ).toEqual(['USD', 'GBP'])
    expect(
      snapshot.currencyCostTrends.map((trend) => trend.currency),
    ).toEqual(['GBP', 'USD'])
    expect(snapshot.recommendations[0]?.currency).toBe('EUR')
    expect(
      snapshot.subscriptions.find((item) => item.id === 'sub-eur')
        ?.potentialMonthlySavings,
    ).toBe(0)
    expect(snapshot.warnings).toContain(
      'Native billing currencies are retained separately (USD, GBP); no currency conversion is applied.',
    )
    expect(snapshot.warnings).toContain(
      'Azure Advisor savings for EUR subscription/vm-eur use EUR, while Cost Management uses GBP; both source amounts are retained without combining them.',
    )
    expect(
      graphQueries.find((query) =>
        query.includes('microsoft.network/publicipaddresses'),
      ),
    ).toContain('isempty(properties.natGateway)')
  })

  it('does not invent USD for a successful zero-spend subscription', async () => {
    delete process.env.PROSPECTOR_SUBSCRIPTION_IDS
    let eurCostAttempts = 0
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input)
      if (url.includes('/subscriptions?')) {
        return jsonResponse({
          value: [
            {
              subscriptionId: 'sub-empty',
              displayName: 'Empty subscription',
              state: 'Enabled',
              tenantId: 'tenant-one',
            },
            {
              subscriptionId: 'sub-eur',
              displayName: 'EUR subscription',
              state: 'Enabled',
              tenantId: 'tenant-one',
            },
          ],
        })
      }
      if (url.includes('/subscriptions/sub-empty/providers/Microsoft.CostManagement/query')) {
        return jsonResponse({
          properties: {
            columns: [
              { name: 'PreTaxCost' },
              { name: 'ResourceId' },
              { name: 'BillingMonth' },
              { name: 'Currency' },
            ],
            rows: [],
          },
        })
      }
      if (url.includes('/subscriptions/sub-eur/providers/Microsoft.CostManagement/query')) {
        eurCostAttempts += 1
        if (eurCostAttempts === 1) {
          return jsonResponse(
            { error: { code: 'TooManyRequests' } },
            429,
            {
              'x-ms-ratelimit-microsoft.costmanagement-qpu-retry-after':
                '0',
            },
          )
        }
        return jsonResponse({
          properties: {
            columns: [
              { name: 'PreTaxCost' },
              { name: 'ResourceId' },
              { name: 'BillingMonth' },
              { name: 'Currency' },
            ],
            rows: [
              [
                100,
                '/subscriptions/sub-eur/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm-eur',
                '202608',
                'EUR',
              ],
            ],
          },
        })
      }
      if (url.includes('/providers/Microsoft.ResourceGraph/resources')) {
        return jsonResponse({ data: [] })
      }
      throw new Error(`Unexpected Azure request: ${url}`)
    }) as typeof fetch

    const credential: TokenCredential = {
      async getToken() {
        return {
          token: 'test-token',
          expiresOnTimestamp: Date.now() + 60_000,
        }
      },
    }
    const snapshot = await new AzureProvider(
      credential,
      'tenant-one',
    ).collect({ tenantId: 'tenant-one' })

    expect(snapshot.currencyCostTrends).toHaveLength(1)
    expect(snapshot.currencyCostTrends[0]?.currency).toBe('EUR')
    expect(eurCostAttempts).toBe(2)
    expect(
      snapshot.subscriptions.find((item) => item.id === 'sub-empty')?.currency,
    ).toBe('EUR')
  })

  it('stops paginated cost collection at the configured QPU budget', async () => {
    process.env.AZURE_COST_QPU_BUDGET_PER_SCAN = '6'
    process.env.AZURE_COST_HISTORY_MONTHS = '6'
    process.env.AZURE_HTTP_RETRY_ATTEMPTS = '0'
    let costCalls = 0
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input)
      if (url.includes('/subscriptions?')) {
        return jsonResponse({
          value: [
            {
              subscriptionId: 'sub-one',
              displayName: 'Subscription one',
              state: 'Enabled',
              tenantId: 'tenant-one',
            },
          ],
        })
      }
      if (
        url.includes('/Microsoft.CostManagement/query') ||
        url.endsWith('/cost-next')
      ) {
        costCalls += 1
        return jsonResponse({
          properties: {
            columns: [
              { name: 'PreTaxCost' },
              { name: 'ResourceId' },
              { name: 'BillingMonth' },
              { name: 'Currency' },
            ],
            rows: [],
            nextLink: `${'https://management.azure.com'}/cost-next`,
          },
        })
      }
      if (url.includes('/providers/Microsoft.ResourceGraph/resources')) {
        return jsonResponse({ data: [] })
      }
      throw new Error(`Unexpected Azure request: ${url}`)
    }) as typeof fetch
    const credential: TokenCredential = {
      async getToken() {
        return {
          token: 'test-token',
          expiresOnTimestamp: Date.now() + 60_000,
        }
      },
    }

    const snapshot = await new AzureProvider(
      credential,
      'tenant-one',
    ).collect({ tenantId: 'tenant-one' })

    expect(costCalls).toBe(1)
    expect(snapshot.warnings).toContain(
      'Cost Management data is unavailable for Subscription one (configured 6-QPU scan budget exhausted).',
    )
  })
})
