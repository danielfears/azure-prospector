import type { TokenCredential } from '@azure/identity'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AzureProvider,
  classifyAdvisorSavingsActivity,
  createCostQueryPlan,
} from './azure.js'
import { calculateOpportunityReductionRatios } from '../opportunity-scenario.js'
import {
  classifySavingsActivity,
  savingsOpportunityScopeKey,
} from '../../src/shared/savings-activity.js'
import type { RecommendationClaim } from '../../src/shared/types.js'

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

function scenarioClaim(
  scopeKey: string,
  level: RecommendationClaim['level'] = 'azure_estimate',
): RecommendationClaim {
  return {
    level,
    decisionStatus: 'needs_validation',
    validationState:
      level === 'azure_estimate'
        ? 'azure_authored'
        : 'deterministic_calculation',
    ruleVersion: 'test-v1',
    provenance: {
      provider: 'azure',
      sourceFamily: 'azure:advisor-cost',
      sourceApi: 'Azure Advisor via Azure Resource Graph',
      collectedAt: '2026-09-01T00:00:00.000Z',
      activityClassification: 'text_fallback',
      extendedProperties: {},
    },
    evidenceWindow: {
      endAt: '2026-09-01T00:00:00.000Z',
      description: 'Test evidence window.',
    },
    missingEvidence: [],
    overlap: {
      scopeKey,
      spendPoolKey: 'subscription|compute-usage',
      sequenceStage: 'usage_optimization',
      sequenceOrder: 10,
      mutuallyExclusiveActivities: ['reserved_instances', 'savings_plans'],
    },
  }
}

describe('AzureProvider', () => {
  it.each([
    {
      expected: 'reserved_instances',
      title: 'Purchase a reserved instance',
      description: 'A savings plan is an alternative for less stable usage.',
      category: 'commitment',
      resourceType: 'Microsoft.Compute/virtualMachines',
    },
    {
      expected: 'savings_plans',
      title: 'Purchase an Azure savings plan',
      description: 'This is more flexible than a VM reservation.',
      category: 'commitment',
      resourceType: 'Microsoft.Compute/virtualMachines',
    },
    {
      expected: 'shutdown_scheduling',
      title: 'Review VM schedule coverage',
      description: 'No matching auto-shutdown schedule was found.',
      category: 'compute',
      resourceType: 'Microsoft.Compute/virtualMachines',
    },
    {
      expected: 'orphan_cleanup',
      title: 'Delete an unattached managed disk',
      description: 'The disk is not attached to a virtual machine.',
      category: 'storage',
      resourceType: 'Microsoft.Compute/disks',
    },
    {
      expected: 'orphan_cleanup',
      title: 'Remove an unused public IP address',
      description: 'The public IP has no IP configuration.',
      category: 'network',
      resourceType: 'Microsoft.Network/publicIPAddresses',
    },
    {
      expected: 'orphan_cleanup',
      title: 'Remove an unattached network interface',
      description: 'The NIC has no virtual machine attachment.',
      category: 'network',
      resourceType: 'Microsoft.Network/networkInterfaces',
    },
    {
      expected: 'right_sizing',
      title: 'Right-size the underutilized virtual machine',
      description: 'Select a smaller SKU.',
      category: 'compute',
      resourceType: 'Microsoft.Compute/virtualMachines',
    },
    {
      expected: 'storage_optimization',
      title: 'Move cold blobs to a lower-cost tier',
      description: 'Use lifecycle management for the archive.',
      category: 'storage',
      resourceType: 'Microsoft.Storage/storageAccounts',
    },
    {
      expected: 'licensing_hybrid_benefit',
      title: 'Enable Azure Hybrid Benefit',
      description: 'Apply eligible Windows Server licences.',
      category: 'commitment',
      resourceType: 'Microsoft.Compute/virtualMachines',
    },
    {
      expected: 'database_optimization',
      title: 'Optimise the database service tier',
      description: 'Database utilization is consistently low.',
      category: 'database',
      resourceType: 'Microsoft.Sql/servers/databases',
    },
    {
      expected: 'network_optimization',
      title: 'Consolidate NAT gateways',
      description: 'Reduce network charges.',
      category: 'network',
      resourceType: 'Microsoft.Network/natGateways',
    },
    {
      expected: 'other',
      title: 'Review resource tags',
      description: 'Confirm ownership metadata.',
      category: 'governance',
      resourceType: 'Microsoft.Resources/resourceGroups',
    },
  ])('classifies $expected deterministically', ({ expected, ...input }) => {
    expect(classifySavingsActivity(input)).toBe(expected)
  })

  it('prefers known Advisor recommendation type IDs and documents fallback', () => {
    expect(
      classifyAdvisorSavingsActivity({
        recommendationTypeId: '84b1a508-fc21-49da-979e-96894f1665df',
        title: 'Localized title',
        description: 'Localized description',
        category: 'commitment',
        resourceType: 'Microsoft.Subscriptions/subscriptions',
      }),
    ).toEqual({
      activity: 'savings_plans',
      method: 'recommendation_type_id',
    })
    expect(
      classifyAdvisorSavingsActivity({
        recommendationTypeId: 'unknown-type',
        title: 'Right-size the underutilized VM',
        description: 'Select a smaller SKU.',
        category: 'compute',
        resourceType: 'Microsoft.Compute/virtualMachines',
      }),
    ).toEqual({ activity: 'right_sizing', method: 'text_fallback' })
  })

  it('builds a confidence-weighted, per-resource opportunity scenario', () => {
    const ratios = calculateOpportunityReductionRatios(
      [
        {
          currency: 'GBP',
          activity: 'right_sizing',
          subscriptionId: 'sub-one',
          title: 'Right-size VM',
          resourceType: 'Microsoft.Compute/virtualMachines',
          resourceId: 'resource-one',
          fingerprint: 'finding-one',
          estimatedMonthlySavings: 200,
          currentMonthlyCost: 300,
          confidence: 0.8,
          claim: scenarioClaim('resource-one'),
        },
        {
          currency: 'GBP',
          activity: 'right_sizing',
          subscriptionId: 'sub-one',
          title: 'Right-size VM',
          resourceType: 'Microsoft.Compute/virtualMachines',
          resourceId: 'resource-one',
          fingerprint: 'finding-two',
          estimatedMonthlySavings: 100,
          currentMonthlyCost: 300,
          confidence: 0.9,
          claim: scenarioClaim('resource-one'),
        },
        {
          currency: 'USD',
          activity: 'right_sizing',
          subscriptionId: 'sub-two',
          title: 'Right-size VM',
          resourceType: 'Microsoft.Compute/virtualMachines',
          fingerprint: 'advisor-only',
          estimatedMonthlySavings: 500,
          currentMonthlyCost: 0,
          confidence: 0.8,
          claim: scenarioClaim('advisor-only'),
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

  it('sequences usage optimization before mutually exclusive commitments', () => {
    const base = {
      currency: 'GBP',
      subscriptionId: 'sub-one',
      resourceType: 'Microsoft.Compute/virtualMachines',
      currentMonthlyCost: 1000,
      confidence: 1,
      evidence: [],
    }
    const rightSize = {
      ...base,
      activity: 'right_sizing' as const,
      resourceId: 'vm-one',
      fingerprint: 'right-size',
      title: 'Right-size VM',
      estimatedMonthlySavings: 200,
      claim: scenarioClaim('vm-one'),
    }
    const reservation = {
      ...base,
      activity: 'reserved_instances' as const,
      fingerprint: 'reservation',
      title: 'Reserve compute',
      estimatedMonthlySavings: 300,
      claim: scenarioClaim('reservation-scope'),
    }
    const savingsPlan = {
      ...base,
      activity: 'savings_plans' as const,
      fingerprint: 'savings-plan',
      title: 'Purchase savings plan',
      estimatedMonthlySavings: 400,
      claim: scenarioClaim('savings-plan-scope'),
    }

    expect(
      calculateOpportunityReductionRatios(
        [rightSize, reservation, savingsPlan],
        [{ currency: 'GBP', monthlyCost: 1000 }],
      ).get('GBP'),
    ).toBe(0.2)
    expect(
      calculateOpportunityReductionRatios(
        [reservation, savingsPlan],
        [{ currency: 'GBP', monthlyCost: 1000 }],
      ).get('GBP'),
    ).toBe(0.4)
  })

  it('uses one stable scope for alternative commitment scenarios', () => {
    const base = {
      activity: 'reserved_instances' as const,
      subscriptionId: 'sub-one',
      title: 'Consider App Service reserved instance',
      resourceType: 'Microsoft.Subscriptions/subscriptions',
      fingerprint: 'scenario-one',
      evidence: [
        { label: 'Recommended SKU', value: 'App_Service_I1_v2_linux' },
        { label: 'Recommendation region', value: 'uksouth' },
      ],
    }
    expect(
      savingsOpportunityScopeKey({
        ...base,
        resourceId: '/advisor/recommendations/scenario-one',
        title: `${base.title} (1 year, 7-day lookback)`,
      }),
    ).toBe(
      savingsOpportunityScopeKey({
        ...base,
        fingerprint: 'scenario-two',
        resourceId: '/advisor/recommendations/scenario-two',
        title: `${base.title} (3 years, 60-day lookback)`,
      }),
    )
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
                  recommendationStatus: 'New',
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
                    annualSavingsAmount: '600',
                    term: 'P3Y',
                    lookbackPeriod: '30',
                    qty: '2',
                    sku: 'Example_SKU',
                    region: 'westeurope',
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
    const provider = new AzureProvider(credential, 'tenant-one', {
      telemetryMaximumCandidates: 0,
    })

    const snapshot = await provider.collect({ tenantId: 'tenant-one' })

    expect(
      snapshot.subscriptions.map((subscription) => subscription.currency),
    ).toEqual(['USD', 'GBP'])
    expect(
      snapshot.currencyCostTrends.map((trend) => trend.currency),
    ).toEqual(['GBP', 'USD'])
    expect(snapshot.recommendations[0]?.currency).toBe('EUR')
    expect(snapshot.recommendations[0]?.activity).toBe('right_sizing')
    expect(snapshot.recommendations[0]?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'Estimated annual savings',
          value: 600,
        }),
        expect.objectContaining({
          label: 'Commitment term',
          value: '3 years',
        }),
        expect.objectContaining({
          label: 'Usage lookback',
          value: '30 days',
        }),
        expect.objectContaining({
          label: 'Recommended SKU',
          value: 'Example_SKU',
        }),
      ]),
    )
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
    globalThis.fetch = vi.fn(async (input, init) => {
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
        const query = (JSON.parse(String(init?.body)) as { query: string }).query
        if (query.includes('microsoft.advisor/recommendations')) {
          return jsonResponse({
            data: [
              {
                id: '/subscriptions/sub-empty/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm-empty',
                advisorRecommendationId: 'advisor-no-currency',
                name: 'vm-empty',
                type: 'Microsoft.Compute/virtualMachines',
                subscriptionId: 'sub-empty',
                resourceGroup: 'rg',
                tags: {},
                properties: {
                  category: 'Cost',
                  recommendationStatus: 'New',
                  impactedField: 'Microsoft.Compute/virtualMachines',
                  resourceMetadata: {
                    resourceId:
                      '/subscriptions/sub-empty/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm-empty',
                  },
                  shortDescription: {
                    solution: 'Right-size the virtual machine',
                    problem: 'The virtual machine is underutilized.',
                  },
                  extendedProperties: { savingsAmount: '25' },
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
    const snapshot = await new AzureProvider(
      credential,
      'tenant-one',
      { telemetryMaximumCandidates: 0 },
    ).collect({ tenantId: 'tenant-one' })

    expect(snapshot.currencyCostTrends).toHaveLength(1)
    expect(snapshot.currencyCostTrends[0]?.currency).toBe('EUR')
    expect(eurCostAttempts).toBe(2)
    expect(
      snapshot.subscriptions.find((item) => item.id === 'sub-empty')?.currency,
    ).toBeNull()
    expect(snapshot.recommendations[0]).toMatchObject({
      estimatedMonthlySavings: null,
      currency: null,
      claim: {
        level: 'investigation_lead',
        decisionStatus: 'needs_evidence',
      },
    })
  })

  it('filters Advisor lifecycle and treats invalid schedules as gaps', async () => {
    delete process.env.PROSPECTOR_SUBSCRIPTION_IDS
    const vmId = (name: string, group = 'rg-test') =>
      `/subscriptions/sub-one/resourceGroups/${group}/providers/Microsoft.Compute/virtualMachines/${name}`
    const advisor = (
      id: string,
      status: string | undefined,
      group = 'rg-test',
      recommendationTypeId = 'unknown-right-size-type',
      maxCpuP95: string | null = '4.2',
    ) => ({
      id: vmId('advisor-vm', group),
      advisorResourceId: `/subscriptions/sub-one/providers/Microsoft.Advisor/recommendations/${id}`,
      advisorRecommendationId: id,
      name: 'advisor-vm',
      type: 'Microsoft.Compute/virtualMachines',
      subscriptionId: 'sub-one',
      resourceGroup: group,
      location: 'uksouth',
      tags: {},
      properties: {
        category: 'Cost',
        ...(status ? { recommendationStatus: status } : {}),
        recommendationTypeId,
        lastUpdated: '2026-08-31T12:00:00.000Z',
        impact: 'High',
        risk: 'Medium',
        impactedField: 'Microsoft.Compute/virtualMachines',
        resourceMetadata: { resourceId: vmId('advisor-vm', group) },
        shortDescription: {
          solution: `Right-size ${id}`,
          problem: 'The virtual machine is underutilized.',
        },
        extendedProperties: {
          savingsAmount: '50',
          savingsCurrency: 'GBP',
          lookbackPeriod: '30',
          ...(maxCpuP95 === null ? {} : { MaxCpuP95: maxCpuP95 }),
        },
      },
    })
    const vm = (name: string) => ({
      id: vmId(name),
      name,
      type: 'Microsoft.Compute/virtualMachines',
      subscriptionId: 'sub-one',
      resourceGroup: 'rg-test',
      location: 'uksouth',
      tags: { environment: 'test' },
      properties: {},
    })
    const schedule = (
      name: string,
      target: string,
      status: string,
      taskType: string,
      includeTimeZone = true,
    ) => ({
      id: `/subscriptions/sub-one/resourceGroups/rg-test/providers/Microsoft.DevTestLab/schedules/${name}`,
      name,
      type: 'Microsoft.DevTestLab/schedules',
      subscriptionId: 'sub-one',
      resourceGroup: 'rg-test',
      location: 'uksouth',
      tags: {},
      properties: {
        targetResourceId: target,
        status,
        taskType,
        dailyRecurrence: { time: '1900' },
        ...(includeTimeZone ? { timeZoneId: 'UTC' } : {}),
      },
    })

    globalThis.fetch = vi.fn(async (input, init) => {
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
      if (url.includes('/Microsoft.CostManagement/query')) {
        const body = JSON.parse(String(init?.body)) as {
          dataset: { grouping: Array<{ name: string }> }
        }
        expect(body.dataset.grouping.map((group) => group.name)).toEqual([
          'ResourceId',
          'PricingModel',
        ])
        return jsonResponse({
          properties: {
            columns: [
              { name: 'PreTaxCost' },
              { name: 'ResourceId' },
              { name: 'BillingMonth' },
              { name: 'Currency' },
            ],
            rows: [
              [100, vmId('vm-uncovered'), '202608', 'GBP'],
              [100, vmId('vm-disabled'), '202608', 'GBP'],
              [100, vmId('vm-startup'), '202608', 'GBP'],
              [100, vmId('vm-covered'), '202608', 'GBP'],
              [100, vmId('vm-incomplete'), '202608', 'GBP'],
            ],
          },
        })
      }
      if (url.includes('/providers/Microsoft.ResourceGraph/resources')) {
        const query = (JSON.parse(String(init?.body)) as { query: string }).query
        if (query.includes('microsoft.advisor/configurations')) {
          return jsonResponse({
            data: [
              {
                id: '/subscriptions/sub-one/providers/Microsoft.Advisor/configurations/default',
                name: 'default',
                type: 'Microsoft.Advisor/configurations',
                subscriptionId: 'sub-one',
                properties: { exclude: false, lowCpuThreshold: '5' },
              },
              {
                id: '/subscriptions/sub-one/resourceGroups/rg-excluded/providers/Microsoft.Advisor/configurations/default',
                name: 'rg-excluded',
                type: 'Microsoft.Advisor/configurations',
                subscriptionId: 'sub-one',
                resourceGroup: 'rg-excluded',
                properties: { exclude: true },
              },
            ],
          })
        }
        if (query.includes('microsoft.advisor/recommendations')) {
          expect(query).toContain(
            "tostring(properties.recommendationStatus) in~ ('New', 'Active', 'InProgress')",
          )
          expect(query).not.toContain(
            'isempty(properties.recommendationStatus)',
          )
          return jsonResponse({
            data: [
              advisor('active', 'New'),
              advisor('legacy', undefined),
              advisor(
                'low-below',
                'New',
                'rg-test',
                'e10b1381-5f0a-47ff-8c7b-37bd13d7c974',
                '4',
              ),
              advisor(
                'low-above',
                'New',
                'rg-test',
                'e10b1381-5f0a-47ff-8c7b-37bd13d7c974',
                '6',
              ),
              advisor(
                'low-missing',
                'New',
                'rg-test',
                '94aea435-ef39-493f-a547-8408092c22a7',
                null,
              ),
              advisor('dismissed', 'Dismissed'),
              advisor('postponed', 'Postponed'),
              advisor('excluded', 'New', 'rg-excluded'),
            ],
          })
        }
        if (query.includes("type =~ 'microsoft.compute/virtualmachines'")) {
          return jsonResponse({
            data: [
              vm('vm-uncovered'),
              vm('vm-disabled'),
              vm('vm-startup'),
              vm('vm-covered'),
              vm('vm-incomplete'),
            ],
          })
        }
        if (query.includes("type =~ 'microsoft.devtestlab/schedules'")) {
          return jsonResponse({
            data: [
              schedule(
                'shutdown-disabled',
                vmId('vm-disabled'),
                'Disabled',
                'ComputeVmShutdownTask',
              ),
              schedule(
                'startup-enabled',
                vmId('vm-startup'),
                'Enabled',
                'ComputeVmStartupTask',
              ),
              schedule(
                'shutdown-enabled',
                vmId('vm-covered'),
                'Enabled',
                'ComputeVmShutdownTask',
              ),
              schedule(
                'shutdown-missing-timezone',
                vmId('vm-incomplete'),
                'Enabled',
                'ComputeVmShutdownTask',
                false,
              ),
            ],
          })
        }
        if (query.includes('summarize resourceCount')) {
          return jsonResponse({
            data: [{ subscriptionId: 'sub-one', resourceCount: 5 }],
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

    const snapshot = await new AzureProvider(
      credential,
      'tenant-one',
      { telemetryMaximumCandidates: 0 },
    ).collect({ tenantId: 'tenant-one' })
    const advisorFindings = snapshot.recommendations.filter(
      (recommendation) => recommendation.source === 'advisor',
    )
    expect(advisorFindings.map((finding) => finding.sourceRecommendationId))
      .toEqual(['active', 'low-below', 'low-missing'])
    expect(advisorFindings[0]?.claim).toMatchObject({
      level: 'azure_estimate',
      validationState: 'azure_authored',
      provenance: {
        nativeStatus: 'New',
        nativeImpact: 'High',
        nativeRisk: 'Medium',
        nativeLookbackDays: 30,
        activityClassification: 'text_fallback',
        extendedProperties: { MaxCpuP95: '4.2' },
      },
    })
    expect(advisorFindings[1]?.claim.provenance.advisorConfiguration)
      .toMatchObject({
        source: 'Azure Advisor configuration',
        scope: 'sub-one',
        lowCpuThreshold: 5,
      })
    expect(advisorFindings[2]?.claim.missingEvidence.join(' ')).toContain(
      'MaxCpuP95',
    )

    const scheduleFindings = snapshot.recommendations.filter(
      (recommendation) =>
        recommendation.activity === 'shutdown_scheduling',
    )
    expect(scheduleFindings.map((finding) => finding.resourceName).sort())
      .toEqual([
        'vm-disabled',
        'vm-incomplete',
        'vm-startup',
        'vm-uncovered',
      ])
    expect(
      scheduleFindings.every(
        (finding) =>
          finding.estimatedMonthlySavings === null &&
          finding.azureEstimatedMonthlySavings === null &&
          finding.calculatedMonthlySavings === null &&
          finding.measuredMonthlySavings === null &&
          finding.claim.level === 'investigation_lead' &&
          finding.claim.formula === undefined,
      ),
    ).toBe(true)
    expect(snapshot.subscriptions[0]?.potentialMonthlySavings).toBe(50)
  })

  it('enriches selected VM findings and reports observed telemetry coverage', async () => {
    delete process.env.PROSPECTOR_SUBSCRIPTION_IDS
    const vmId =
      '/subscriptions/sub-one/resourceGroups/rg-test/providers/Microsoft.Compute/virtualMachines/vm-test'
    const telemetryStart = new Date('2026-08-05T00:00:00.000Z')
    const hourlyPoints = Array.from({ length: 720 }, (_, index) => ({
      timeStamp: new Date(telemetryStart.getTime() + index * 3_600_000),
      average: 1,
      minimum: 1,
      maximum: 1,
      total: 100,
      count: 60,
    }))
    globalThis.fetch = vi.fn(async (input, init) => {
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
      if (url.includes('/Microsoft.CostManagement/query')) {
        return jsonResponse({
          properties: {
            columns: [
              { name: 'PreTaxCost' },
              { name: 'ResourceId' },
              { name: 'BillingMonth' },
              { name: 'Currency' },
              { name: 'PricingModel' },
            ],
            rows: [[300, vmId, '202608', 'GBP', 'OnDemand']],
          },
        })
      }
      if (url.includes('/providers/Microsoft.Insights/metrics?')) {
        const requestUrl = new URL(url)
        expect(requestUrl.searchParams.get('metricnames')).toBe(
          'VmAvailabilityMetric',
        )
        expect(requestUrl.searchParams.get('interval')).toBe('PT1H')
        expect(requestUrl.searchParams.get('aggregation')).toBe(
          'Average,Minimum,Maximum',
        )
        expect(requestUrl.searchParams.get('timespan')).toBe(
          '2026-08-05T00:00:00.000Z/2026-09-04T00:00:00.000Z',
        )
        expect(requestUrl.searchParams.has('$filter')).toBe(false)
        return jsonResponse({
          value: [
            {
              id: `${vmId}/providers/Microsoft.Insights/metrics/VmAvailabilityMetric`,
              type: 'Microsoft.Insights/metrics',
              name: {
                value: 'VmAvailabilityMetric',
                localizedValue: 'VM Availability Metric',
              },
              unit: 'Count',
              timeseries: [
                {
                  metadatavalues: [
                    {
                      name: {
                        value: 'Context',
                        localizedValue: 'Context',
                      },
                      value: 'Customer',
                    },
                  ],
                  data: hourlyPoints.map((point) => ({
                    timeStamp: point.timeStamp.toISOString(),
                    average: point.average,
                    minimum: point.minimum,
                    maximum: point.maximum,
                  })),
                },
              ],
            },
          ],
        })
      }
      if (url.includes('/eventtypes/management/values')) {
        return jsonResponse({
          value: [
            {
              eventTimestamp: '2026-08-10T08:00:00.000Z',
              operationName: {
                value: 'Microsoft.Compute/virtualMachines/start/action',
              },
              status: { value: 'Succeeded' },
              correlationId: 'correlation-one',
            },
          ],
        })
      }
      if (url.includes('/providers/Microsoft.ResourceGraph/resources')) {
        const query = (JSON.parse(String(init?.body)) as { query: string }).query
        if (query.includes('microsoft.advisor/configurations')) {
          return jsonResponse({ data: [] })
        }
        if (query.includes('microsoft.advisor/recommendations')) {
          return jsonResponse({
            data: [
              {
                id: vmId,
                advisorResourceId:
                  '/subscriptions/sub-one/providers/Microsoft.Advisor/recommendations/right-size',
                advisorRecommendationId: 'right-size',
                name: 'vm-test',
                type: 'Microsoft.Compute/virtualMachines',
                subscriptionId: 'sub-one',
                resourceGroup: 'rg-test',
                location: 'uksouth',
                tags: { environment: 'test' },
                properties: {
                  category: 'Cost',
                  recommendationStatus: 'New',
                  recommendationTypeId: 'unknown-right-size-type',
                  lastUpdated: '2026-09-01T00:00:00.000Z',
                  impactedField: 'Microsoft.Compute/virtualMachines',
                  resourceMetadata: { resourceId: vmId },
                  shortDescription: {
                    solution: 'Right-size the underutilized VM',
                    problem: 'The virtual machine is underutilized.',
                  },
                  extendedProperties: {
                    savingsAmount: '50',
                    savingsCurrency: 'GBP',
                    lookbackPeriod: '30',
                  },
                },
              },
            ],
          })
        }
        if (query.includes("type =~ 'microsoft.compute/virtualmachines'")) {
          return jsonResponse({
            data: [
              {
                id: vmId,
                name: 'vm-test',
                type: 'Microsoft.Compute/virtualMachines',
                subscriptionId: 'sub-one',
                resourceGroup: 'rg-test',
                location: 'uksouth',
                tags: { environment: 'test' },
                properties: {},
              },
            ],
          })
        }
        if (query.includes("type =~ 'microsoft.devtestlab/schedules'")) {
          return jsonResponse({ data: [] })
        }
        if (query.includes('summarize resourceCount')) {
          return jsonResponse({
            data: [{ subscriptionId: 'sub-one', resourceCount: 1 }],
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
    const snapshot = await new AzureProvider(
      credential,
      'tenant-one',
      {
        now: () => new Date('2026-09-04T12:30:00.000Z'),
        telemetryMaximumAttempts: 1,
        metricsClientFactory: () => ({
          async queryResources(resources, metricNames) {
            return resources.map((resourceId) => {
              const metrics = metricNames.map((name) => ({
                id: `${resourceId}/providers/microsoft.insights/metrics/${name}`,
                type: 'Microsoft.Insights/metrics',
                name,
                unit:
                  name === 'Percentage CPU'
                    ? ('Percent' as const)
                    : name === 'VmAvailabilityMetric'
                      ? ('Count' as const)
                      : ('Bytes' as const),
                timeseries: [
                  {
                    metadatavalues:
                      name === 'VmAvailabilityMetric'
                        ? [{ name: 'Context', value: 'Customer' }]
                        : [],
                    data:
                      name === 'Percentage CPU'
                        ? hourlyPoints.map((point) => ({
                            ...point,
                            average: 5,
                            minimum: 2,
                            maximum: 8,
                            total: undefined,
                          }))
                        : hourlyPoints,
                  },
                ],
              }))
              return {
                resourceId,
                resourceRegion: 'uksouth',
                namespace: 'Microsoft.Compute/virtualMachines',
                granularity: 'PT1H',
                timespan: {
                  startTime: telemetryStart,
                  endTime: new Date('2026-09-04T00:00:00.000Z'),
                },
                metrics,
                getMetricByName(name: string) {
                  return metrics.find((metric) => metric.name === name)
                },
              }
            })
          },
        }),
      },
    ).collect({ tenantId: 'tenant-one' })

    const rightSize = snapshot.recommendations.find(
      (recommendation) => recommendation.source === 'advisor',
    )!
    expect(rightSize).toMatchObject({
      activity: 'right_sizing',
      azureEstimatedMonthlySavings: 50,
      calculatedMonthlySavings: null,
      claim: {
        level: 'azure_estimate',
      },
      vmTelemetry: {
        guestMemoryStatus: 'not_collected',
        availability: {
          populatedBuckets: 720,
          nearContinuousAvailability: true,
          contextValues: ['Customer'],
        },
      },
    })
    expect(rightSize.claim.missingEvidence.join(' ')).toContain(
      'Guest memory telemetry',
    )
    expect(
      rightSize.evidence.find((item) => item.label === 'Hourly CPU p95')?.value,
    ).toBe(5)

    const schedule = snapshot.recommendations.find(
      (recommendation) =>
        recommendation.activity === 'shutdown_scheduling',
    )!
    expect(schedule.azureEstimatedMonthlySavings).toBeNull()
    expect(schedule.calculatedMonthlySavings).toBeCloseTo(226.67, 2)
    expect(schedule.claim).toMatchObject({
      level: 'calculated_scenario',
      decisionStatus: 'needs_validation',
      validationState: 'deterministic_calculation',
      ruleVersion: 'vm-schedule-8-hours-weekday-v1',
      formula: {
        expression:
          'eligible_variable_vm_compute_cost * avoidable_observed_billable_hours / observed_billable_hours',
      },
    })
    expect(schedule.vmTelemetry?.activityLog.events).toEqual([
      {
        operation: 'Microsoft.Compute/virtualMachines/start/action',
        status: 'Succeeded',
        timestamp: '2026-08-10T08:00:00.000Z',
        correlationId: 'correlation-one',
      },
    ])
    expect(
      snapshot.coverage.find(
        (coverage) => coverage.key === 'vm-platform-telemetry',
      ),
    ).toMatchObject({
      percentage: 100,
      status: 'complete',
    })
    expect(snapshot.subscriptions[0]?.potentialMonthlySavings).toBeCloseTo(
      226.67,
      2,
    )
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
