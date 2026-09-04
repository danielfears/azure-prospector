import type { TokenCredential } from '@azure/identity'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AzureSubscriptionOption } from '../../src/shared/types.js'
import { SelectedAzureProvider } from './selected-azure.js'

const originalFetch = globalThis.fetch
const originalCostInterval = process.env.AZURE_COST_REQUEST_INTERVAL_MS

function subscription(
  id: string,
  tenantId: string,
): AzureSubscriptionOption {
  return {
    id,
    name: `Subscription ${id}`,
    tenantId,
    tenantName: `Tenant ${tenantId}`,
    state: 'Enabled',
    isDefault: false,
    authenticationStatus: 'ready',
  }
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  process.env.AZURE_COST_REQUEST_INTERVAL_MS = '0'
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
  if (originalCostInterval === undefined) {
    delete process.env.AZURE_COST_REQUEST_INTERVAL_MS
  } else {
    process.env.AZURE_COST_REQUEST_INTERVAL_MS = originalCostInterval
  }
})

describe('SelectedAzureProvider', () => {
  it('requires an explicit subscription selection', async () => {
    const provider = new SelectedAzureProvider({
      async listSubscriptions() {
        return [subscription('sub-one', 'tenant-one')]
      },
      credentialForSubscription() {
        throw new Error('Credential should not be requested')
      },
    })

    await expect(provider.collect({})).rejects.toThrow(
      'Select at least one Azure subscription',
    )
  })

  it('completes accessible tenants and reports unavailable selected tenants', async () => {
    const subscriptions = [
      subscription('sub-one', 'tenant-one'),
      subscription('sub-two', 'tenant-two'),
    ]
    const validCredential: TokenCredential = {
      async getToken() {
        return {
          token: 'tenant-one-token',
          expiresOnTimestamp: Date.now() + 60_000,
        }
      },
    }
    const unavailableCredential: TokenCredential = {
      async getToken() {
        const error = new Error('Tenant sign-in is required')
        error.name = 'CredentialUnavailableError'
        throw error
      },
    }
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input)
      if (url.includes('/subscriptions?')) {
        return jsonResponse({
          value: [
            {
              subscriptionId: 'sub-one',
              displayName: 'Subscription sub-one',
              state: 'Enabled',
              tenantId: 'tenant-one',
            },
          ],
        })
      }
      if (url.includes('/Microsoft.CostManagement/query')) {
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
      if (url.includes('/Microsoft.ResourceGraph/resources')) {
        expect(init?.method).toBe('POST')
        return jsonResponse({ data: [] })
      }
      throw new Error(`Unexpected Azure request: ${url}`)
    }) as typeof fetch

    const provider = new SelectedAzureProvider({
      async listSubscriptions() {
        return subscriptions
      },
      credentialForSubscription(_subscriptionId, tenantId) {
        return tenantId === 'tenant-one'
          ? validCredential
          : unavailableCredential
      },
    })
    const snapshot = await provider.collect({
      subscriptionIds: ['sub-one', 'sub-two'],
    })

    expect(snapshot.subscriptions.map((item) => item.id)).toEqual([
      'sub-one',
    ])
    expect(
      snapshot.coverage.find((item) => item.key === 'assessment-scope'),
    ).toMatchObject({
      percentage: 50,
      status: 'partial',
    })
    expect(snapshot.warnings).toContain(
      'Subscription sub-two in Tenant tenant-two could not be scanned: Tenant sign-in is required',
    )
  })

  it('binds VM telemetry clients to each subscription credential', async () => {
    const subscriptions = [
      subscription('sub-one', 'tenant-one'),
      subscription('sub-two', 'tenant-two'),
    ]
    const credentials = new Map<string, TokenCredential>(
      subscriptions.map((item) => [
        item.tenantId,
        {
          async getToken() {
            return {
              token: `${item.tenantId}-token`,
              expiresOnTimestamp: Date.now() + 60_000,
            }
          },
        },
      ]),
    )
    const credentialByToken = new Map(
      subscriptions.map((item) => [
        `${item.tenantId}-token`,
        credentials.get(item.tenantId)!,
      ]),
    )
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input)
      const authorization = new Headers(init?.headers).get('Authorization') ?? ''
      const token = authorization.replace(/^Bearer\s+/i, '')
      const tenant = token.replace(/-token$/, '')
      const subscriptionId = tenant === 'tenant-one' ? 'sub-one' : 'sub-two'
      if (url.includes('/subscriptions?')) {
        return jsonResponse({
          value: [
            {
              subscriptionId,
              displayName: `Subscription ${subscriptionId}`,
              state: 'Enabled',
              tenantId: tenant,
            },
          ],
        })
      }
      if (url.includes('/Microsoft.CostManagement/query')) {
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
      if (url.includes('/providers/Microsoft.Insights/metrics?')) {
        if (tenant !== 'tenant-one') return jsonResponse({ value: [] })
        const start = new Date('2026-08-05T00:00:00.000Z')
        return jsonResponse({
          value: [
            {
              id: `${url}/VmAvailabilityMetric`,
              type: 'Microsoft.Insights/metrics',
              name: { value: 'VmAvailabilityMetric' },
              unit: 'Count',
              timeseries: [
                {
                  data: Array.from({ length: 720 }, (_, index) => ({
                    timeStamp: new Date(
                      start.getTime() + index * 3_600_000,
                    ).toISOString(),
                    average: 1,
                  })),
                },
              ],
            },
          ],
        })
      }
      if (url.includes('/eventtypes/management/values')) {
        return jsonResponse({ value: [] })
      }
      if (url.includes('/Microsoft.ResourceGraph/resources')) {
        const query = (JSON.parse(String(init?.body)) as { query: string }).query
        if (query.includes("type =~ 'microsoft.compute/virtualmachines'")) {
          return jsonResponse({
            data: [
              {
                id: `/subscriptions/${subscriptionId}/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm-test`,
                name: 'vm-test',
                type: 'Microsoft.Compute/virtualMachines',
                subscriptionId,
                resourceGroup: 'rg',
                location: 'uksouth',
                tags: { environment: 'test' },
                properties: {},
              },
            ],
          })
        }
        if (query.includes('summarize resourceCount')) {
          return jsonResponse({
            data: [{ subscriptionId, resourceCount: 1 }],
          })
        }
        return jsonResponse({ data: [] })
      }
      throw new Error(`Unexpected Azure request: ${url}`)
    }) as typeof fetch

    const boundCredentials: TokenCredential[] = []
    const provider = new SelectedAzureProvider(
      {
        async listSubscriptions() {
          return subscriptions
        },
        credentialForSubscription(_subscriptionId, tenantId) {
          return credentials.get(tenantId)!
        },
      },
      {
        telemetryMaximumAttempts: 1,
        metricsClientFactory(_endpoint, credential) {
          boundCredentials.push(credential)
          return {
            async queryResources(resources) {
              return resources.map((resourceId) => ({
                resourceId,
                resourceRegion: 'uksouth',
                namespace: 'Microsoft.Compute/virtualMachines',
                granularity: 'PT1H',
                timespan: {
                  startTime: new Date('2026-08-05T00:00:00.000Z'),
                  endTime: new Date('2026-09-04T00:00:00.000Z'),
                },
                metrics: [],
                getMetricByName() {
                  return undefined
                },
              }))
            },
          }
        },
      },
    )
    const snapshot = await provider.collect({
      subscriptionIds: ['sub-one', 'sub-two'],
    })

    expect(snapshot.subscriptions).toHaveLength(2)
    expect(new Set(boundCredentials)).toEqual(
      new Set([...credentialByToken.values()]),
    )
    expect(
      snapshot.coverage.find(
        (coverage) => coverage.key === 'vm-platform-telemetry',
      ),
    ).toMatchObject({
      percentage: 50,
      status: 'partial',
      coveredCount: 1,
      totalCount: 2,
    })
    expect(
      snapshot.coverage.find(
        (coverage) => coverage.key === 'vm-platform-telemetry',
      )?.description,
    ).toContain('2 selected subscriptions in 2 tenants')
  })
})
