import { createHash } from 'node:crypto'
import type {
  ConfidenceBand,
  RecommendationCategory,
  RecommendationOwner,
} from '../../src/shared/types.js'
import type {
  ProspectorProvider,
  ProviderCollectRequest,
  ProviderSnapshot,
  SnapshotRecommendation,
} from './types.js'

interface DemoRecommendationInput {
  source: SnapshotRecommendation['source']
  category: RecommendationCategory
  title: string
  description: string
  suggestedAction: string
  subscriptionId: string
  subscriptionName: string
  resourceName: string
  resourceType: string
  resourceGroup: string
  location: string
  savings: number
  cost: number
  confidence: number
  effort: SnapshotRecommendation['effort']
  risk: SnapshotRecommendation['risk']
  owner?: RecommendationOwner
  evidence: SnapshotRecommendation['evidence']
  tags?: Record<string, string>
}

const DEMO_SUBSCRIPTIONS = [
  {
    id: '00000000-0000-0000-0000-000000000101',
    name: 'Production',
    state: 'Enabled',
    monthlyCost: 48_760,
    resourceCount: 684,
  },
  {
    id: '00000000-0000-0000-0000-000000000102',
    name: 'Engineering',
    state: 'Enabled',
    monthlyCost: 23_940,
    resourceCount: 421,
  },
  {
    id: '00000000-0000-0000-0000-000000000103',
    name: 'Shared Services',
    state: 'Enabled',
    monthlyCost: 13_820,
    resourceCount: 196,
  },
] as const

function stableId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24)
}

function confidenceBand(confidence: number): ConfidenceBand {
  if (confidence >= 0.8) return 'high'
  if (confidence >= 0.6) return 'medium'
  return 'low'
}

function recommendation(input: DemoRecommendationInput): SnapshotRecommendation {
  const resourceId =
    `/subscriptions/${input.subscriptionId}/resourceGroups/${input.resourceGroup}` +
    `/providers/${input.resourceType}/${input.resourceName}`
  const fingerprint = stableId(
    `demo|${input.source}|${resourceId}|${input.title}`.toLowerCase(),
  )

  return {
    id: `rec_${fingerprint}`,
    fingerprint,
    source: input.source,
    sourceFamily: `demo:${input.source}`,
    category: input.category,
    title: input.title,
    description: input.description,
    suggestedAction: input.suggestedAction,
    subscriptionId: input.subscriptionId,
    subscriptionName: input.subscriptionName,
    resourceId,
    resourceName: input.resourceName,
    resourceType: input.resourceType,
    resourceGroup: input.resourceGroup,
    location: input.location,
    estimatedMonthlySavings: input.savings,
    currentMonthlyCost: input.cost,
    currency: 'USD',
    confidence: input.confidence,
    confidenceBand: confidenceBand(input.confidence),
    effort: input.effort,
    risk: input.risk,
    status: 'open',
    owner: input.owner ?? {
      displayName: 'Unassigned',
      source: 'unassigned',
      confidence: 0,
    },
    evidence: input.evidence,
    tags: input.tags ?? {},
    firstSeenAt: '2026-01-15T09:00:00.000Z',
    lastSeenAt: new Date().toISOString(),
  }
}

function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

export function createDemoSnapshot(now = new Date()): ProviderSnapshot {
  const observedAt = now.toISOString()
  const recommendations = [
    recommendation({
      source: 'advisor',
      category: 'compute',
      title: 'Right-size an underutilized virtual machine',
      description:
        'Seven-day utilization is consistently below the selected VM size.',
      suggestedAction:
        'Validate peak demand, then resize during the next maintenance window.',
      subscriptionId: DEMO_SUBSCRIPTIONS[0].id,
      subscriptionName: DEMO_SUBSCRIPTIONS[0].name,
      resourceName: 'api-prod-03',
      resourceType: 'Microsoft.Compute/virtualMachines',
      resourceGroup: 'rg-commerce-prod',
      location: 'eastus2',
      savings: 742,
      cost: 1_486,
      confidence: 0.94,
      effort: 'low',
      risk: 'medium',
      owner: {
        displayName: 'Commerce Platform',
        email: 'commerce@example.invalid',
        source: 'tag',
        confidence: 0.95,
      },
      evidence: [
        {
          label: 'Average CPU',
          value: 6.8,
          unit: '%',
          source: 'Azure Advisor',
          observedAt,
        },
        {
          label: 'Monthly amortized cost',
          value: 1486,
          unit: 'USD',
          source: 'Cost Management',
          observedAt,
        },
      ],
      tags: { owner: 'commerce@example.invalid', environment: 'production' },
    }),
    recommendation({
      source: 'resource_graph',
      category: 'storage',
      title: 'Delete an unattached managed disk',
      description:
        'The managed disk is not attached to a virtual machine and continues to incur storage charges.',
      suggestedAction:
        'Confirm retention requirements, take a snapshot if required, then delete the disk.',
      subscriptionId: DEMO_SUBSCRIPTIONS[1].id,
      subscriptionName: DEMO_SUBSCRIPTIONS[1].name,
      resourceName: 'build-agent-osdisk-old',
      resourceType: 'Microsoft.Compute/disks',
      resourceGroup: 'rg-build-agents',
      location: 'westus2',
      savings: 286,
      cost: 286,
      confidence: 0.98,
      effort: 'low',
      risk: 'medium',
      evidence: [
        {
          label: 'Disk state',
          value: 'Unattached',
          source: 'Azure Resource Graph',
          observedAt,
        },
      ],
      tags: { applicationOwner: 'Developer Productivity' },
    }),
    recommendation({
      source: 'resource_graph',
      category: 'network',
      title: 'Remove an unattached public IP address',
      description:
        'The public IP has no IP configuration and appears to be unused.',
      suggestedAction:
        'Verify DNS and deployment references, then remove the unused public IP.',
      subscriptionId: DEMO_SUBSCRIPTIONS[2].id,
      subscriptionName: DEMO_SUBSCRIPTIONS[2].name,
      resourceName: 'pip-legacy-gateway',
      resourceType: 'Microsoft.Network/publicIPAddresses',
      resourceGroup: 'rg-network-shared',
      location: 'eastus',
      savings: 31,
      cost: 31,
      confidence: 0.9,
      effort: 'low',
      risk: 'medium',
      evidence: [
        {
          label: 'Attachment',
          value: 'None',
          source: 'Azure Resource Graph',
          observedAt,
        },
      ],
    }),
    recommendation({
      source: 'prospector',
      category: 'scheduling',
      title: 'Review VM auto-shutdown coverage',
      description:
        'A non-production VM has no matching DevTest Lab auto-shutdown schedule.',
      suggestedAction:
        'Confirm operating hours and configure an appropriate shutdown schedule.',
      subscriptionId: DEMO_SUBSCRIPTIONS[1].id,
      subscriptionName: DEMO_SUBSCRIPTIONS[1].name,
      resourceName: 'integration-test-07',
      resourceType: 'Microsoft.Compute/virtualMachines',
      resourceGroup: 'rg-integration-test',
      location: 'centralus',
      savings: 198,
      cost: 396,
      confidence: 0.48,
      effort: 'low',
      risk: 'low',
      owner: {
        displayName: 'Quality Engineering',
        source: 'tag',
        confidence: 0.8,
      },
      evidence: [
        {
          label: 'Auto-shutdown schedule',
          value: 'Not found',
          source: 'Azure Resource Graph',
          observedAt,
        },
      ],
      tags: { serviceOwner: 'Quality Engineering', environment: 'test' },
    }),
    recommendation({
      source: 'advisor',
      category: 'database',
      title: 'Scale down an over-provisioned database',
      description:
        'Database utilization remains below the provisioned service tier.',
      suggestedAction:
        'Review workload peaks and lower the service tier after validation.',
      subscriptionId: DEMO_SUBSCRIPTIONS[0].id,
      subscriptionName: DEMO_SUBSCRIPTIONS[0].name,
      resourceName: 'catalog-sql-prod',
      resourceType: 'Microsoft.Sql/servers/databases',
      resourceGroup: 'rg-catalog-prod',
      location: 'eastus2',
      savings: 1_120,
      cost: 3_420,
      confidence: 0.86,
      effort: 'medium',
      risk: 'medium',
      owner: {
        displayName: 'Catalog Service',
        source: 'tag',
        confidence: 0.9,
      },
      evidence: [
        {
          label: 'Potential monthly savings',
          value: 1120,
          unit: 'USD',
          source: 'Azure Advisor',
          observedAt,
        },
      ],
      tags: { technicalOwner: 'Catalog Service' },
    }),
    recommendation({
      source: 'advisor',
      category: 'commitment',
      title: 'Reduce an underutilized reservation commitment',
      description:
        'Recent utilization is materially below the reserved quantity for this compute family.',
      suggestedAction:
        'Review exchange, return, scope, and workload-growth options before changing the commitment.',
      subscriptionId: DEMO_SUBSCRIPTIONS[2].id,
      subscriptionName: DEMO_SUBSCRIPTIONS[2].name,
      resourceName: 'compute-reservation-westus2',
      resourceType: 'Microsoft.Capacity/reservationOrders',
      resourceGroup: 'billing-scope',
      location: 'westus2',
      savings: 1_850,
      cost: 6_200,
      confidence: 0.91,
      effort: 'medium',
      risk: 'high',
      owner: {
        displayName: 'Cloud Platform',
        source: 'mapping',
        confidence: 0.9,
      },
      evidence: [
        {
          label: 'Thirty-day utilization',
          value: 54,
          unit: '%',
          source: 'Cost Management commitments',
          observedAt,
        },
        {
          label: 'Unused monthly commitment',
          value: 1850,
          unit: 'USD',
          source: 'Cost Management',
          observedAt,
        },
      ],
    }),
    recommendation({
      source: 'prospector',
      category: 'storage',
      title: 'Review a large cold blob dataset',
      description:
        'A high-cost container has had no observed reads for 120 days. Retention intent is not known.',
      suggestedAction:
        'Validate retention and recovery requirements, then tier or delete eligible objects through lifecycle management.',
      subscriptionId: DEMO_SUBSCRIPTIONS[0].id,
      subscriptionName: DEMO_SUBSCRIPTIONS[0].name,
      resourceName: 'telemetry-archive',
      resourceType: 'Microsoft.Storage/storageAccounts/blobServices/containers',
      resourceGroup: 'rg-data-prod',
      location: 'eastus2',
      savings: 960,
      cost: 1_480,
      confidence: 0.68,
      effort: 'medium',
      risk: 'high',
      owner: {
        displayName: 'Data Platform',
        source: 'tag',
        confidence: 0.9,
      },
      evidence: [
        {
          label: 'Stored data',
          value: 84,
          unit: 'TB',
          source: 'Blob Inventory',
          observedAt,
        },
        {
          label: 'Last observed read',
          value: '120 days ago',
          source: 'Storage last-access telemetry',
          observedAt,
        },
      ],
      tags: { owner: 'Data Platform', dataClassification: 'internal' },
    }),
    recommendation({
      source: 'advisor',
      category: 'compute',
      title: 'Right-size an AKS system node pool',
      description:
        'The node pool has sustained spare capacity after accounting for requested CPU and memory.',
      suggestedAction:
        'Validate disruption budgets and autoscaler limits, then reduce node count or VM size.',
      subscriptionId: DEMO_SUBSCRIPTIONS[0].id,
      subscriptionName: DEMO_SUBSCRIPTIONS[0].name,
      resourceName: 'aks-commerce-system',
      resourceType: 'Microsoft.ContainerService/managedClusters/agentPools',
      resourceGroup: 'rg-commerce-prod',
      location: 'eastus2',
      savings: 930,
      cost: 2_910,
      confidence: 0.84,
      effort: 'medium',
      risk: 'medium',
      owner: {
        displayName: 'Platform Engineering',
        source: 'tag',
        confidence: 0.92,
      },
      evidence: [
        {
          label: 'Peak requested CPU',
          value: 41,
          unit: '%',
          source: 'Azure Advisor',
          observedAt,
        },
      ],
      tags: { owner: 'Platform Engineering', environment: 'production' },
    }),
    recommendation({
      source: 'cost_management',
      category: 'governance',
      title: 'Reduce excessive analytics retention',
      description:
        'A workspace retains high-volume diagnostic data longer than the configured operational requirement.',
      suggestedAction:
        'Confirm audit requirements, then lower interactive retention or move older data to a lower-cost tier.',
      subscriptionId: DEMO_SUBSCRIPTIONS[2].id,
      subscriptionName: DEMO_SUBSCRIPTIONS[2].name,
      resourceName: 'law-shared-platform',
      resourceType: 'Microsoft.OperationalInsights/workspaces',
      resourceGroup: 'rg-monitoring-shared',
      location: 'eastus',
      savings: 410,
      cost: 1_760,
      confidence: 0.74,
      effort: 'medium',
      risk: 'medium',
      evidence: [
        {
          label: 'Interactive retention',
          value: 365,
          unit: 'days',
          source: 'Azure Resource Graph',
          observedAt,
        },
      ],
    }),
    recommendation({
      source: 'resource_graph',
      category: 'compute',
      title: 'Remove an empty App Service plan',
      description:
        'The App Service plan has no deployed sites and continues to incur compute charges.',
      suggestedAction:
        'Confirm that no deployment pipeline targets the plan, then delete it.',
      subscriptionId: DEMO_SUBSCRIPTIONS[1].id,
      subscriptionName: DEMO_SUBSCRIPTIONS[1].name,
      resourceName: 'asp-retired-api',
      resourceType: 'Microsoft.Web/serverfarms',
      resourceGroup: 'rg-retired-services',
      location: 'westus2',
      savings: 360,
      cost: 360,
      confidence: 0.95,
      effort: 'low',
      risk: 'low',
      evidence: [
        {
          label: 'Attached sites',
          value: 0,
          source: 'Azure Resource Graph',
          observedAt,
        },
      ],
    }),
  ]

  const costTrend = Array.from({ length: 6 }, (_, index) => {
    const date = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (5 - index), 1),
    )
    const actualCost = 79_300 + index * 1_444
    const realizedSavings = 1_150 + index * 275
    return {
      period: monthKey(date),
      actualCost,
      optimizedCost: actualCost - realizedSavings,
      realizedSavings,
    }
  })

  const bySubscription = new Map<string, SnapshotRecommendation[]>()
  for (const item of recommendations) {
    const existing = bySubscription.get(item.subscriptionId) ?? []
    existing.push(item)
    bySubscription.set(item.subscriptionId, existing)
  }

  return {
    provider: 'demo',
    mode: 'demo',
    tenantName: 'Demo Azure Estate',
    collectedAt: observedAt,
    currency: 'USD',
    resources: DEMO_SUBSCRIPTIONS.reduce(
      (sum, subscription) => sum + subscription.resourceCount,
      0,
    ),
    monthlyCost: DEMO_SUBSCRIPTIONS.reduce(
      (sum, subscription) => sum + subscription.monthlyCost,
      0,
    ),
    subscriptions: DEMO_SUBSCRIPTIONS.map((subscription) => {
      const items = bySubscription.get(subscription.id) ?? []
      const owned = items.filter(
        (item) => item.owner.source !== 'unassigned',
      ).length
      return {
        ...subscription,
        potentialMonthlySavings: items.reduce(
          (sum, item) => sum + item.estimatedMonthlySavings,
          0,
        ),
        openRecommendations: items.length,
        ownerCoverage: items.length ? Math.round((owned / items.length) * 100) : 100,
        currency: 'USD',
      }
    }),
    recommendations,
    costTrend,
    coverage: [
      {
        key: 'subscriptions',
        label: 'Subscription discovery',
        description: 'All demo subscriptions were discovered.',
        percentage: 100,
        status: 'complete',
        source: 'Azure Resource Manager',
      },
      {
        key: 'advisor',
        label: 'Advisor recommendations',
        description: 'Cost-category Advisor data is represented.',
        percentage: 100,
        status: 'complete',
        source: 'Azure Resource Graph',
      },
      {
        key: 'cost-management',
        label: 'Cost visibility',
        description: 'Monthly amortized cost is available for all subscriptions.',
        percentage: 100,
        status: 'complete',
        source: 'Cost Management',
      },
      {
        key: 'ownership',
        label: 'Owner tags',
        description: 'Recommendation ownership inferred from common owner tags.',
        percentage: 80,
        status: 'partial',
        source: 'Resource tags',
        action: 'Add an owner tag to unowned resources.',
      },
    ],
    warnings: [],
    completeSourceFamilies: [
      'demo:advisor',
      'demo:cost_management',
      'demo:resource_graph',
      'demo:prospector',
    ],
  }
}

export class DemoProvider implements ProspectorProvider {
  readonly name = 'demo'
  readonly mode = 'demo' as const

  async collect(_request: ProviderCollectRequest): Promise<ProviderSnapshot> {
    return createDemoSnapshot()
  }
}
