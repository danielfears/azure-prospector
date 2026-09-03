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
})
