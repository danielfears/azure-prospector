import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  AzureCliCredential,
  DefaultAzureCredential,
  InteractiveBrowserCredential,
  ManagedIdentityCredential,
  type TokenCredential,
} from '@azure/identity'
import type {
  AuthenticationSource,
  AuthStatusResponse,
  AzureSubscriptionOption,
} from '../src/shared/types.js'
import { configuredSubscriptionIds } from './azure-config.js'

export const AZURE_MANAGEMENT_SCOPE =
  'https://management.azure.com/.default'

const TOKEN_REFRESH_WINDOW_MS = 2 * 60 * 1000
const execFileAsync = promisify(execFile)

type CredentialOptions = Parameters<TokenCredential['getToken']>[1]
type CredentialToken = Awaited<ReturnType<TokenCredential['getToken']>>
type AvailableToken = NonNullable<CredentialToken>
type AuthenticationMode =
  | 'auto'
  | 'azure_cli'
  | 'browser'
  | 'managed_identity'
  | 'default_credential'
type AzureCliCommand = (arguments_: string[]) => Promise<string>

export interface InteractiveTokenCredential extends TokenCredential {
  authenticate(
    scopes: string | string[],
    options?: CredentialOptions,
  ): Promise<unknown | undefined>
}

export interface AzureAuthenticationServiceOptions {
  mode?: string
  tenantId?: string
  browserClientId?: string
  managedIdentityClientId?: string
  cliCredential?: TokenCredential
  browserCredential?: InteractiveTokenCredential
  hostedCredential?: TokenCredential
  azureCliCommand?: AzureCliCommand
}

export class AzureAuthenticationRequiredError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AzureAuthenticationRequiredError'
  }
}

function configuredMode(value?: string): AuthenticationMode {
  const mode = (value ?? 'auto').trim().toLowerCase().replaceAll('-', '_')
  switch (mode) {
    case 'auto':
    case 'default':
      return 'auto'
    case 'cli':
    case 'azure_cli':
      return 'azure_cli'
    case 'browser':
    case 'interactive':
    case 'interactive_browser':
      return 'browser'
    case 'managed_identity':
      return 'managed_identity'
    case 'default_credential':
    case 'workload_identity':
      return 'default_credential'
    default:
      throw new Error(
        'PROSPECTOR_AUTH_MODE must be auto, azure-cli, browser, managed-identity, or default-credential',
      )
  }
}

function scopeKey(scopes: string | string[]): string {
  return (Array.isArray(scopes) ? scopes : [scopes]).sort().join(' ')
}

function isCredentialUnavailable(error: unknown): boolean {
  return (
    error instanceof AzureAuthenticationRequiredError ||
    (error instanceof Error &&
      [
        'AuthenticationError',
        'AuthenticationRequiredError',
        'CredentialUnavailableError',
      ].includes(error.name))
  )
}

function subscriptionOption(value: unknown): AzureSubscriptionOption | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const row = value as Record<string, unknown>
  const rawId =
    typeof row.subscriptionId === 'string'
      ? row.subscriptionId
      : typeof row.id === 'string'
        ? row.id
        : undefined
  const id =
    rawId?.match(/^\/subscriptions\/([^/]+)\/?$/i)?.[1] ??
    rawId
  const name =
    typeof row.name === 'string'
      ? row.name
      : typeof row.displayName === 'string'
        ? row.displayName
        : undefined
  if (
    !id ||
    !name ||
    typeof row.tenantId !== 'string' ||
    typeof row.state !== 'string' ||
    row.state.toLowerCase() !== 'enabled'
  ) {
    return undefined
  }
  return {
    id,
    name,
    tenantId: row.tenantId,
    tenantName:
      typeof row.tenantDisplayName === 'string' && row.tenantDisplayName
        ? row.tenantDisplayName
        : row.tenantId,
    state: row.state,
    isDefault: row.isDefault === true,
    authenticationStatus: 'ready',
  }
}

export class AzureAuthenticationService implements TokenCredential {
  private readonly mode: AuthenticationMode
  private readonly tenantId?: string
  private readonly cliCredential: TokenCredential
  private readonly browserCredential: InteractiveTokenCredential
  private readonly hostedCredential?: TokenCredential
  private readonly azureCliCommand: AzureCliCommand
  private cachedToken?: {
    source: AuthenticationSource
    scopes: string
    value: AvailableToken
  }
  private activeSource: AuthenticationSource = 'none'

  constructor(options: AzureAuthenticationServiceOptions = {}) {
    this.mode = configuredMode(
      options.mode ?? process.env.PROSPECTOR_AUTH_MODE,
    )
    this.tenantId = options.tenantId ?? process.env.AZURE_TENANT_ID
    this.cliCredential =
      options.cliCredential ??
      new AzureCliCredential({ tenantId: this.tenantId })
    this.azureCliCommand =
      options.azureCliCommand ??
      (async (arguments_) => {
        const { stdout } = await execFileAsync('az', arguments_, {
          timeout: 30_000,
          maxBuffer: 10 * 1024 * 1024,
          windowsHide: true,
        })
        return stdout
      })
    const browserClientId =
      options.browserClientId ??
      process.env.PROSPECTOR_BROWSER_CLIENT_ID?.trim() ??
      undefined
    this.browserCredential =
      options.browserCredential ??
      new InteractiveBrowserCredential({
        tenantId: this.tenantId,
        clientId: browserClientId,
        redirectUri:
          process.env.PROSPECTOR_REDIRECT_URI?.trim() || undefined,
        additionallyAllowedTenants: ['*'],
        disableAutomaticAuthentication: true,
      })

    if (this.mode === 'managed_identity') {
      this.hostedCredential =
        options.hostedCredential ??
        new ManagedIdentityCredential({
          clientId:
            options.managedIdentityClientId ?? process.env.AZURE_CLIENT_ID,
        })
    } else if (this.mode === 'default_credential') {
      this.hostedCredential =
        options.hostedCredential ??
        new DefaultAzureCredential({
          tenantId: this.tenantId,
          managedIdentityClientId:
            options.managedIdentityClientId ?? process.env.AZURE_CLIENT_ID,
        })
    }
  }

  private supportsBrowserLogin(): boolean {
    return this.mode === 'auto' || this.mode === 'browser'
  }

  private async tokenFrom(
    source: AuthenticationSource,
    credential: TokenCredential,
    scopes: string | string[],
    options?: CredentialOptions,
  ): Promise<AvailableToken> {
    const key = scopeKey(scopes)
    if (
      this.cachedToken?.source === source &&
      this.cachedToken.scopes === key &&
      this.cachedToken.value.expiresOnTimestamp >
        Date.now() + TOKEN_REFRESH_WINDOW_MS
    ) {
      this.activeSource = source
      return this.cachedToken.value
    }

    const token = await credential.getToken(scopes, options)
    if (!token) {
      throw new AzureAuthenticationRequiredError(
        'Azure authentication did not return an access token.',
      )
    }
    this.cachedToken = { source, scopes: key, value: token }
    this.activeSource = source
    return token
  }

  private async resolveToken(
    scopes: string | string[],
    options?: CredentialOptions,
  ): Promise<AvailableToken> {
    if (this.mode === 'managed_identity' || this.mode === 'default_credential') {
      if (!this.hostedCredential) {
        throw new Error('Hosted Azure authentication is not configured.')
      }
      return this.tokenFrom(
        this.mode,
        this.hostedCredential,
        scopes,
        options,
      )
    }

    if (this.mode === 'auto' || this.mode === 'azure_cli') {
      try {
        return await this.tokenFrom(
          'azure_cli',
          this.cliCredential,
          scopes,
          options,
        )
      } catch (error) {
        if (!isCredentialUnavailable(error)) throw error
        if (this.cachedToken?.source === 'azure_cli') {
          this.cachedToken = undefined
        }
        this.activeSource = 'none'
        if (this.mode === 'azure_cli') {
          throw new AzureAuthenticationRequiredError(
            'Azure CLI is not signed in. Run az login --use-device-code --allow-no-subscriptions, then retry.',
          )
        }
      }
    }

    try {
      return await this.tokenFrom(
        'browser',
        this.browserCredential,
        scopes,
        options,
      )
    } catch (error) {
      if (!isCredentialUnavailable(error)) throw error
      if (this.cachedToken?.source === 'browser') {
        this.cachedToken = undefined
      }
      this.activeSource = 'none'
      throw new AzureAuthenticationRequiredError(
        'Azure CLI is not signed in. Use Connect Azure for secure browser sign-in.',
      )
    }
  }

  async getToken(
    scopes: string | string[],
    options?: CredentialOptions,
  ): Promise<CredentialToken> {
    return this.resolveToken(scopes, options)
  }

  async getStatus(): Promise<AuthStatusResponse> {
    try {
      await this.resolveToken(AZURE_MANAGEMENT_SCOPE)
    } catch (error) {
      if (!(error instanceof AzureAuthenticationRequiredError)) throw error
      return {
        authenticated: false,
        source: 'none',
        browserLoginAvailable: this.supportsBrowserLogin(),
        message: error.message,
      }
    }

    const sourceLabels: Record<Exclude<AuthenticationSource, 'none'>, string> =
      {
        azure_cli: 'Connected using your current Azure CLI session.',
        browser: 'Connected using Azure Identity browser sign-in.',
        managed_identity: 'Connected using managed identity.',
        default_credential: 'Connected using the configured Azure credential.',
      }
    return {
      authenticated: true,
      source: this.activeSource,
      browserLoginAvailable: this.supportsBrowserLogin(),
      message:
        this.activeSource === 'none'
          ? 'Azure sign-in is required.'
          : sourceLabels[this.activeSource],
    }
  }

  async ensureAuthenticated(): Promise<void> {
    await this.resolveToken(AZURE_MANAGEMENT_SCOPE)
  }

  async signInWithBrowser(): Promise<AuthStatusResponse> {
    if (!this.supportsBrowserLogin()) {
      throw new AzureAuthenticationRequiredError(
        'Browser sign-in is disabled for this installation.',
      )
    }
    const record = await this.browserCredential.authenticate(
      AZURE_MANAGEMENT_SCOPE,
    )
    if (!record) {
      throw new AzureAuthenticationRequiredError(
        'Azure Identity browser sign-in did not return an account.',
      )
    }
    this.cachedToken = undefined
    this.activeSource = 'none'
    return this.getStatus()
  }

  credentialForSubscription(
    subscriptionId: string,
    tenantId: string,
  ): TokenCredential {
    if (
      this.tenantId &&
      tenantId.toLowerCase() !== this.tenantId.toLowerCase()
    ) {
      throw new AzureAuthenticationRequiredError(
        'The selected subscription is outside the configured Azure tenant.',
      )
    }
    if (this.activeSource === 'azure_cli') {
      return new AzureCliCredential({
        subscription: subscriptionId,
      })
    }
    return this
  }

  private async cliSubscriptions(): Promise<AzureSubscriptionOption[]> {
    const stdout = await this.azureCliCommand(
      ['account', 'list', '--all', '--output', 'json', '--only-show-errors'],
    )
    const parsed = JSON.parse(stdout) as unknown
    if (!Array.isArray(parsed)) {
      throw new Error('Azure CLI returned an invalid subscription list.')
    }
    return parsed
      .map(subscriptionOption)
      .filter(
        (subscription): subscription is AzureSubscriptionOption =>
          subscription !== undefined,
      )
  }

  private async checkCliSubscriptionSessions(
    subscriptions: AzureSubscriptionOption[],
  ): Promise<AzureSubscriptionOption[]> {
    const statuses = new Map(
      await Promise.all(
        subscriptions.map(async (subscription) => {
          try {
            await this.azureCliCommand([
              'account',
              'get-access-token',
              '--subscription',
              subscription.id,
              '--resource',
              'https://management.azure.com',
              '--output',
              'none',
              '--only-show-errors',
            ])
            return [subscription.id, 'ready'] as const
          } catch {
            return [subscription.id, 'refresh_required'] as const
          }
        }),
      ),
    )
    return subscriptions.map((subscription) => ({
      ...subscription,
      authenticationStatus:
        statuses.get(subscription.id) ?? 'refresh_required',
    }))
  }

  private async armSubscriptions(): Promise<AzureSubscriptionOption[]> {
    const subscriptions: AzureSubscriptionOption[] = []
    let nextUrl: string | undefined =
      'https://management.azure.com/subscriptions?api-version=2022-12-01'
    while (nextUrl) {
      const parsedUrl = new URL(nextUrl)
      if (parsedUrl.origin !== 'https://management.azure.com') {
        throw new Error(
          'Azure returned an unexpected subscription pagination URL.',
        )
      }
      const token = await this.resolveToken(AZURE_MANAGEMENT_SCOPE)
      const headers = new Headers({ Accept: 'application/json' })
      headers.set('Authorization', ['Bearer', token.token].join(' '))
      const response = await fetch(parsedUrl, { headers })
      if (!response.ok) {
        throw new Error(
          `Azure subscription discovery failed with HTTP ${response.status}.`,
        )
      }
      const payload = (await response.json()) as {
        value?: unknown[]
        nextLink?: string
      }
      for (const value of payload.value ?? []) {
        const option = subscriptionOption(value)
        if (option) subscriptions.push(option)
      }
      nextUrl = payload.nextLink
    }
    return subscriptions
  }

  async listSubscriptions(): Promise<AzureSubscriptionOption[]> {
    await this.ensureAuthenticated()
    const allowList = configuredSubscriptionIds()
    const discoveredSubscriptions =
      this.activeSource === 'azure_cli'
        ? await this.cliSubscriptions()
        : await this.armSubscriptions()
    const subscriptions =
      this.activeSource === 'azure_cli'
        ? await this.checkCliSubscriptionSessions(discoveredSubscriptions)
        : discoveredSubscriptions
    return subscriptions
      .filter(
        (subscription) =>
          (!this.tenantId ||
            subscription.tenantId.toLowerCase() ===
              this.tenantId.toLowerCase()) &&
          (!allowList || allowList.has(subscription.id.toLowerCase())),
      )
      .filter(
        (subscription, index, values) =>
          values.findIndex((item) => item.id === subscription.id) === index,
      )
      .sort(
        (left, right) =>
          left.tenantName.localeCompare(right.tenantName) ||
          left.name.localeCompare(right.name),
      )
  }
}
