import type { TokenCredential } from '@azure/identity'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AzureAuthenticationRequiredError,
  AzureAuthenticationService,
  type InteractiveTokenCredential,
} from './auth-service.js'

const accessToken = {
  token: 'test-token',
  expiresOnTimestamp: Date.now() + 60 * 60 * 1000,
}
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

function unavailableCredential(): TokenCredential {
  return {
    async getToken() {
      const error = new Error('Credential is unavailable.')
      error.name = 'CredentialUnavailableError'
      throw error
    },
  }
}

class StubBrokerCredential implements InteractiveTokenCredential {
  authenticated: boolean
  readonly authenticate = vi.fn(async () => {
    this.authenticated = true
    return { tenantId: 'tenant-one' }
  })
  readonly getToken = vi.fn(async () => {
    if (this.authenticated) return accessToken
    const error = new Error('Interaction is required.')
    error.name = 'AuthenticationRequiredError'
    throw error
  })

  constructor(authenticated = false) {
    this.authenticated = authenticated
  }
}

describe('AzureAuthenticationService', () => {
  it('uses a valid Azure CLI session before browser sign-in', async () => {
    const cliGetToken = vi.fn(async () => accessToken)
    const broker = new StubBrokerCredential(true)
    const service = new AzureAuthenticationService({
      mode: 'auto',
      cliCredential: { getToken: cliGetToken },
      browserCredential: broker,
    })

    await expect(service.getStatus()).resolves.toMatchObject({
      authenticated: true,
      source: 'azure_cli',
    })
    expect(cliGetToken).toHaveBeenCalledOnce()
    expect(broker.getToken).not.toHaveBeenCalled()
  })

  it('silently reuses a browser account when Azure CLI is unavailable', async () => {
    const broker = new StubBrokerCredential(true)
    const service = new AzureAuthenticationService({
      mode: 'auto',
      cliCredential: unavailableCredential(),
      browserCredential: broker,
    })

    await expect(service.getStatus()).resolves.toMatchObject({
      authenticated: true,
      source: 'browser',
      browserLoginAvailable: true,
    })
    expect(broker.getToken).toHaveBeenCalledOnce()
    expect(broker.authenticate).not.toHaveBeenCalled()
  })

  it('uses browser sign-in only after an explicit request', async () => {
    const broker = new StubBrokerCredential()
    const service = new AzureAuthenticationService({
      mode: 'auto',
      cliCredential: unavailableCredential(),
      browserCredential: broker,
    })

    await expect(service.getStatus()).resolves.toMatchObject({
      authenticated: false,
      source: 'none',
      browserLoginAvailable: true,
    })
    await expect(service.signInWithBrowser()).resolves.toMatchObject({
      authenticated: true,
      source: 'browser',
    })
    expect(broker.authenticate).toHaveBeenCalledOnce()
  })

  it('does not use browser fallback in Azure CLI-only mode', async () => {
    const broker = new StubBrokerCredential(true)
    const service = new AzureAuthenticationService({
      mode: 'azure-cli',
      cliCredential: unavailableCredential(),
      browserCredential: broker,
    })

    await expect(
      service.getToken('https://management.azure.com/.default'),
    ).rejects.toBeInstanceOf(AzureAuthenticationRequiredError)
    expect(broker.getToken).not.toHaveBeenCalled()
  })

  it('normalizes and filters ARM subscription identifiers', async () => {
    process.env.PROSPECTOR_SUBSCRIPTION_IDS = 'sub-one'
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          value: [
            {
              id: '/subscriptions/wrong-resource-path',
              subscriptionId: 'sub-one',
              displayName: 'Allowed subscription',
              tenantId: 'tenant-one',
              state: 'Enabled',
            },
            {
              id: '/subscriptions/sub-two',
              displayName: 'Excluded subscription',
              tenantId: 'tenant-one',
              state: 'Enabled',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    ) as typeof fetch
    const service = new AzureAuthenticationService({
      mode: 'browser',
      browserCredential: new StubBrokerCredential(true),
    })

    await expect(service.listSubscriptions()).resolves.toMatchObject([
      {
        id: 'sub-one',
        name: 'Allowed subscription',
      },
    ])
  })

  it('enforces an explicitly configured tenant boundary', () => {
    const service = new AzureAuthenticationService({
      mode: 'azure-cli',
      tenantId: 'tenant-one',
      cliCredential: {
        async getToken() {
          return accessToken
        },
      },
      browserCredential: new StubBrokerCredential(true),
    })

    expect(() => service.credentialForTenant('tenant-two')).toThrow(
      'outside the configured Azure tenant',
    )
  })

  it('flags cached CLI tenants whose management token needs refreshing', async () => {
    const azureCliCommand = vi.fn(async (arguments_: string[]) => {
      if (arguments_[0] === 'account' && arguments_[1] === 'list') {
        return JSON.stringify([
          {
            id: 'sub-one',
            name: 'Ready subscription',
            tenantId: 'tenant-one',
            tenantDisplayName: 'Ready tenant',
            state: 'Enabled',
            isDefault: true,
          },
          {
            id: 'sub-two',
            name: 'Stale subscription',
            tenantId: 'tenant-two',
            tenantDisplayName: 'Stale tenant',
            state: 'Enabled',
            isDefault: false,
          },
        ])
      }
      const tenantIndex = arguments_.indexOf('--tenant')
      if (arguments_[tenantIndex + 1] === 'tenant-one') return ''
      throw new Error('Refresh token expired')
    })
    const service = new AzureAuthenticationService({
      mode: 'azure-cli',
      cliCredential: {
        async getToken() {
          return accessToken
        },
      },
      browserCredential: new StubBrokerCredential(true),
      azureCliCommand,
    })

    await expect(service.listSubscriptions()).resolves.toMatchObject([
      {
        id: 'sub-one',
        authenticationStatus: 'ready',
      },
      {
        id: 'sub-two',
        authenticationStatus: 'refresh_required',
      },
    ])
  })
})
