import type { TokenCredential } from '@azure/identity'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AzureProvider } from './azure.js'

const originalFetch = globalThis.fetch
const originalSubscriptionIds = process.env.PROSPECTOR_SUBSCRIPTION_IDS

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
  if (originalSubscriptionIds === undefined) {
    delete process.env.PROSPECTOR_SUBSCRIPTION_IDS
  } else {
    process.env.PROSPECTOR_SUBSCRIPTION_IDS = originalSubscriptionIds
  }
})

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('AzureProvider', () => {
  it('rejects Advisor savings in a different or otherwise hidden billing currency', async () => {
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
        return jsonResponse({ error: { code: 'Forbidden' } }, 403)
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

    await expect(
      provider.collect({ tenantId: 'tenant-one' }),
    ).rejects.toThrow('cannot aggregate multiple billing currencies')
    expect(
      graphQueries.find((query) =>
        query.includes('microsoft.network/publicipaddresses'),
      ),
    ).toContain('isempty(properties.natGateway)')
  })

  it('does not invent USD for a successful zero-spend subscription', async () => {
    delete process.env.PROSPECTOR_SUBSCRIPTION_IDS
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

    expect(snapshot.currency).toBe('EUR')
    expect(snapshot.monthlyCost).toBe(100)
    expect(
      snapshot.subscriptions.find((item) => item.id === 'sub-empty')?.currency,
    ).toBe('EUR')
  })
})
