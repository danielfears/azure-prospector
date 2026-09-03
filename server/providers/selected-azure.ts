import {
  AzureAuthenticationRequiredError,
} from '../auth-service.js'
import type { TokenCredential } from '@azure/identity'
import type {
  AzureSubscriptionOption,
  CoverageItem,
} from '../../src/shared/types.js'
import { AzureProvider } from './azure.js'
import type {
  CurrencyCostTrend,
  ProspectorProvider,
  ProviderCollectRequest,
  ProviderSnapshot,
} from './types.js'

interface SelectedAzureAuthentication {
  listSubscriptions(): Promise<AzureSubscriptionOption[]>
  credentialForSubscription(
    subscriptionId: string,
    tenantId: string,
  ): TokenCredential
}

function groupByTenant(
  subscriptions: AzureSubscriptionOption[],
): Map<string, AzureSubscriptionOption[]> {
  const groups = new Map<string, AzureSubscriptionOption[]>()
  for (const subscription of subscriptions) {
    const group = groups.get(subscription.tenantId) ?? []
    group.push(subscription)
    groups.set(subscription.tenantId, group)
  }
  return groups
}

function mergeCostTrends(
  snapshots: ProviderSnapshot[],
): CurrencyCostTrend[] {
  const totals = new Map<
    string,
    Map<
      string,
      {
        actualCost: number
        optimizedCost: number
        realizedSavings: number
      }
    >
  >()
  for (const snapshot of snapshots) {
    for (const trend of snapshot.currencyCostTrends) {
      const periods = totals.get(trend.currency) ?? new Map()
      for (const point of trend.points) {
        const current = periods.get(point.period) ?? {
          actualCost: 0,
          optimizedCost: 0,
          realizedSavings: 0,
        }
        current.actualCost += point.actualCost
        current.optimizedCost += point.optimizedCost
        current.realizedSavings += point.realizedSavings
        periods.set(point.period, current)
      }
      totals.set(trend.currency, periods)
    }
  }
  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, periods]) => ({
      currency,
      points: [...periods.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([period, values]) => ({ period, ...values })),
    }))
}

function mergeCoverage(snapshots: ProviderSnapshot[]): CoverageItem[] {
  const keys = new Set(
    snapshots.flatMap((snapshot) =>
      snapshot.coverage.map((item) => item.key),
    ),
  )
  const totalSubscriptions = snapshots.reduce(
    (sum, snapshot) => sum + snapshot.subscriptions.length,
    0,
  )
  const coverage: CoverageItem[] = []
  for (const key of [...keys].sort()) {
    const items = snapshots.flatMap((snapshot) => {
      const item = snapshot.coverage.find((candidate) => candidate.key === key)
      return item
        ? [{ item, weight: snapshot.subscriptions.length }]
        : []
    })
    const first = items[0]?.item
    if (!first) continue
    const percentage = totalSubscriptions
      ? items.reduce(
          (sum, { item, weight }) => sum + item.percentage * weight,
          0,
        ) / totalSubscriptions
      : 0
    const action = items.find(({ item }) => item.action)?.item.action
    coverage.push({
      key,
      label: first.label,
      description:
        snapshots.length === 1
          ? first.description
          : `${Math.round(percentage)}% coverage across ${totalSubscriptions} selected subscriptions in ${snapshots.length} tenants.`,
      percentage,
      status:
        percentage >= 99.5
          ? 'complete'
          : percentage > 0
            ? 'partial'
            : 'missing',
      source: first.source,
      ...(action ? { action } : {}),
    })
  }
  return coverage
}

export class SelectedAzureProvider implements ProspectorProvider {
  readonly name = 'azure'
  readonly mode = 'live' as const

  constructor(
    private readonly authentication: SelectedAzureAuthentication,
  ) {}

  async collect(request: ProviderCollectRequest): Promise<ProviderSnapshot> {
    const available = await this.authentication.listSubscriptions()
    if (!available.length) {
      throw new Error(
        'No enabled Azure subscriptions are available to the signed-in account.',
      )
    }

    if (!request.subscriptionIds?.length) {
      throw new Error('Select at least one Azure subscription to scan.')
    }
    const selectedIds = new Set(
      request.subscriptionIds.map((id) => id.toLowerCase()),
    )
    const selected = available.filter((subscription) =>
      selectedIds.has(subscription.id.toLowerCase()),
    )
    if (selected.length !== selectedIds.size) {
      throw new Error(
        `${selectedIds.size - selected.length} selected subscriptions are no longer visible to the signed-in account.`,
      )
    }

    const snapshots: ProviderSnapshot[] = []
    const tenantWarnings: string[] = []
    const tenantGroups = groupByTenant(selected)
    for (const subscription of selected) {
      try {
        const credential =
          this.authentication.credentialForSubscription(
            subscription.id,
            subscription.tenantId,
          )
        const snapshot = await new AzureProvider(
          credential,
          subscription.tenantId,
        ).collect({
          tenantId: subscription.tenantId,
          subscriptionIds: [subscription.id],
        })
        snapshots.push(snapshot)
      } catch (error) {
        const reason =
          error instanceof Error ? error.message : 'Unknown Azure error'
        tenantWarnings.push(
          `${subscription.name} in ${subscription.tenantName} could not be scanned: ${reason}`,
        )
      }
    }
    if (!snapshots.length) {
      throw new AzureAuthenticationRequiredError(
        'None of the selected subscriptions could be scanned. Refresh Azure CLI authentication for their tenants and try again.',
      )
    }

    const successfulSubscriptionIds = new Set(
      snapshots.flatMap((snapshot) =>
        snapshot.subscriptions.map((subscription) => subscription.id),
      ),
    )
    const successfulTenantNames = [
      ...new Set(
        selected
          .filter((subscription) =>
            successfulSubscriptionIds.has(subscription.id),
          )
          .map((subscription) => subscription.tenantName),
      ),
    ]
    const completeSourceFamilies =
      snapshots[0]?.completeSourceFamilies.filter((family) =>
        snapshots.every((snapshot) =>
          snapshot.completeSourceFamilies.includes(family),
        ),
      ) ?? []

    const coverage = mergeCoverage(snapshots)
    const scopePercentage =
      (successfulSubscriptionIds.size / selected.length) * 100
    coverage.push({
      key: 'assessment-scope',
      label: 'Selected assessment scope',
      description: `${successfulSubscriptionIds.size} of ${selected.length} selected subscriptions were scanned successfully.`,
      percentage: scopePercentage,
      status:
        scopePercentage >= 99.5
          ? 'complete'
          : scopePercentage > 0
            ? 'partial'
            : 'missing',
      source: 'Azure authentication',
      ...(scopePercentage < 100
        ? {
            action:
              'Refresh Azure CLI authentication for the unavailable tenant, then rerun this assessment.',
          }
        : {}),
    })

    return {
      provider: this.name,
      mode: this.mode,
      ...(tenantGroups.size === 1
        ? { tenantId: selected[0]!.tenantId }
        : {}),
      tenantName:
        successfulTenantNames.length === 1
          ? successfulTenantNames[0]!
          : `${successfulTenantNames.length} connected Azure tenants`,
      collectedAt: new Date().toISOString(),
      resources: snapshots.reduce(
        (sum, snapshot) => sum + snapshot.resources,
        0,
      ),
      subscriptions: snapshots.flatMap(
        (snapshot) => snapshot.subscriptions,
      ),
      recommendations: snapshots.flatMap(
        (snapshot) => snapshot.recommendations,
      ),
      coverage,
      currencyCostTrends: mergeCostTrends(snapshots),
      warnings: [
        ...snapshots.flatMap((snapshot) => snapshot.warnings),
        ...tenantWarnings,
      ],
      completeSourceFamilies,
      completeSourceFamiliesBySubscription: Object.assign(
        {},
        ...snapshots.map(
          (snapshot) => snapshot.completeSourceFamiliesBySubscription,
        ),
      ),
    }
  }
}
