import { describe, expect, it } from 'vitest'
import type {
  OverviewResponse,
  Recommendation,
  RemediationAction,
  ScanRecord,
} from '../src/shared/types.js'
import {
  ASSESSMENT_REPORT_SCHEMA,
  createAssessmentReport,
  createAssessmentReportFilename,
  createFindingsCsv,
  FINDINGS_CSV_COLUMNS,
  serializeAssessmentReport,
} from './report-export.js'

const exportedAt = '2026-09-03T12:50:21.811Z'

function recommendation(
  overrides: Partial<Recommendation> = {},
): Recommendation {
  return {
    id: 'rec-1',
    fingerprint: 'fingerprint-1',
    source: 'advisor',
    sourceRecommendationId: 'advisor-1',
    category: 'compute',
    activity: 'right_sizing',
    title: 'Resize the VM',
    description: 'The VM is underused.',
    suggestedAction: 'Select a smaller SKU.',
    tenantId: 'tenant-1',
    subscriptionId: 'subscription-1',
    subscriptionName: 'Production',
    resourceId:
      '/subscriptions/subscription-1/resourceGroups/rg-app/providers/Microsoft.Compute/virtualMachines/vm-app',
    resourceName: 'vm-app',
    resourceType: 'Microsoft.Compute/virtualMachines',
    resourceGroup: 'rg-app',
    location: 'uksouth',
    estimatedMonthlySavings: 123.45,
    currentMonthlyCost: 456.78,
    currency: 'GBP',
    confidence: 0.91,
    confidenceBand: 'high',
    effort: 'low',
    risk: 'low',
    status: 'open',
    owner: {
      displayName: 'Platform Team',
      email: 'platform@example.test',
      source: 'tag',
      confidence: 0.8,
    },
    evidence: [
      {
        label: 'Average CPU',
        value: 7.25,
        unit: '%',
        source: 'Azure Monitor',
        observedAt: '2026-09-02T12:00:00.000Z',
      },
    ],
    tags: { environment: 'production' },
    firstSeenAt: '2026-09-01T12:00:00.000Z',
    lastSeenAt: '2026-09-03T12:00:00.000Z',
    exception: {
      id: 'exception-1',
      recommendationId: 'rec-1',
      reason: 'Change freeze',
      createdBy: 'operator@example.test',
      createdAt: '2026-09-02T12:00:00.000Z',
      expiresAt: '2026-10-01T12:00:00.000Z',
    },
    ...overrides,
  }
}

const scan: ScanRecord = {
  id: 'scan-1',
  assessmentId: 'assessment-1',
  mode: 'live',
  status: 'completed',
  assessmentName: 'Production estate',
  tenantId: 'tenant-1',
  startedAt: '2026-09-03T11:55:00.000Z',
  completedAt: '2026-09-03T12:00:00.000Z',
  subscriptionsDiscovered: 2,
  recommendationsFound: 1,
  estimatedMonthlySavings: 123.45,
  estimatedMonthlySavingsByCurrency: [
    { currency: 'GBP', amount: 123.45 },
    { currency: 'EUR', amount: 80 },
  ],
  warningCount: 0,
  warnings: [],
}

const overview: OverviewResponse = {
  generatedAt: '2026-09-03T12:00:00.000Z',
  estate: {
    assessmentId: 'assessment-1',
    assessmentName: 'Production estate',
    tenantName: 'Example tenant',
    mode: 'live',
    subscriptions: 2,
    resources: 50,
    billingCurrencies: ['GBP', 'EUR'],
    lastScanAt: '2026-09-03T12:00:00.000Z',
  },
  savings: {
    byCurrency: [
      {
        currency: 'GBP',
        monthlyCost: 456.78,
        potentialMonthlySavings: 123.45,
        annualizedPotentialSavings: 1481.4,
        realizedSavingsLast30Days: 20,
        realizedSavingsAllTime: 75,
        verifiedMeasurementCount: 1,
        measurementCoverage: 1,
        costTrend: [],
      },
      {
        currency: 'EUR',
        monthlyCost: 320,
        potentialMonthlySavings: 80,
        annualizedPotentialSavings: 960,
        realizedSavingsLast30Days: 0,
        realizedSavingsAllTime: 0,
        verifiedMeasurementCount: 0,
        measurementCoverage: 0,
        costTrend: [],
      },
    ],
    verifiedMeasurementCount: 1,
    measurementCoverage: 0.5,
  },
  openRecommendations: 1,
  highConfidenceRecommendations: 1,
  unownedRecommendations: 0,
  expiringExceptions: 1,
  categories: [
    {
      category: 'compute',
      recommendations: 1,
      estimatedMonthlySavings: [
        { currency: 'GBP', amount: 123.45 },
        { currency: 'EUR', amount: 80 },
      ],
    },
  ],
  subscriptions: [
    {
      id: 'subscription-1',
      name: 'Production',
      tenantId: 'tenant-1',
      state: 'Enabled',
      monthlyCost: 456.78,
      potentialMonthlySavings: 123.45,
      openRecommendations: 1,
      ownerCoverage: 1,
      currency: 'GBP',
    },
  ],
  coverage: [],
  recentScans: [scan],
}

const action: RemediationAction = {
  id: 'action-1',
  recommendationId: 'rec-1',
  actionType: 'manual',
  title: 'Resize during maintenance',
  notes: 'Config: {"password":"TEST_JSON_PASSWORD_VALUE"}',
  status: 'approved',
  requestedBy: 'operator@example.test',
  createdAt: '2026-09-03T12:00:00.000Z',
  updatedAt: '2026-09-03T12:10:00.000Z',
}

describe('assessment report export', () => {
  it('creates a complete archival report without combining currencies', () => {
    const report = createAssessmentReport(
      {
        assessment: { id: 'assessment-1', name: 'Production estate' },
        overview,
        recommendations: [recommendation()],
        actions: [action],
        scans: [scan],
      },
      { exportedAt },
    )

    expect(report.schema).toBe(ASSESSMENT_REPORT_SCHEMA)
    expect(report.exportedAt).toBe(exportedAt)
    expect(report.findings).toHaveLength(1)
    expect(report.findings[0]?.activity).toBe('right_sizing')
    expect(report.remediationActions).toHaveLength(1)
    expect(report.remediationActions[0]).toMatchObject({
      id: action.id,
      status: action.status,
    })
    expect(report.remediationActions[0]?.notes).toContain('[REDACTED]')
    expect(report.scans).toEqual([scan])
    expect(report.overview.savings?.byCurrency?.map((item) => item.currency))
      .toEqual(['GBP', 'EUR'])

    const json = serializeAssessmentReport(report)
    expect(json.endsWith('\n')).toBe(true)
    expect(JSON.parse(json)).toEqual(report)
  })

  it('removes credential fields and redacts credentials embedded in text', () => {
    const finding = recommendation({
      tags: {
        environment: 'production',
        apiToken: '<TEST_SECRET>',
        SharedAccessKey: 'TEST_AZURE_ACCESS_KEY_VALUE',
        primaryKey: 'TEST_PRIMARY_KEY_VALUE',
        secondaryKey: 'TEST_SECONDARY_KEY_VALUE',
        connectionString:
          'Endpoint=sb://example.servicebus.windows.net/;SharedAccessKeyName=owner;SharedAccessKey=TEST_SERVICE_BUS_KEY_VALUE',
      },
      suggestedAction:
        'Endpoint=sb://embedded.servicebus.windows.net/;SharedAccessKeyName=owner;SharedAccessKey=TEST_EMBEDDED_KEY_VALUE Server=database.example;Uid=admin;Pwd={TEST_ODBC_BRACED;PASSWORD_VALUE}',
      description: 'Use Bearer TEST_TOKEN_VALUE only for this request.',
    })
    const input = {
      assessment: { id: 'assessment-1', name: 'Production estate' },
      overview: {
        ...overview,
        recentScans: [
          {
            ...scan,
            warnings: ['password=<TEST_SECRET>'],
            warningCount: 1,
          },
        ],
      },
      recommendations: [finding],
      actions: [action],
      scans: [scan],
    }

    const report = createAssessmentReport(input, { exportedAt })
    const exported = serializeAssessmentReport(report)

    expect(exported).not.toContain('<TEST_SECRET>')
    expect(exported).not.toContain('TEST_TOKEN_VALUE')
    expect(exported).not.toContain('apiToken')
    expect(exported).not.toContain('TEST_AZURE_ACCESS_KEY_VALUE')
    expect(exported).not.toContain('TEST_SERVICE_BUS_KEY_VALUE')
    expect(exported).not.toContain('TEST_EMBEDDED_KEY_VALUE')
    expect(exported).not.toContain('TEST_ODBC_BRACED')
    expect(exported).not.toContain('PASSWORD_VALUE')
    expect(exported).not.toContain('TEST_PRIMARY_KEY_VALUE')
    expect(exported).not.toContain('TEST_SECONDARY_KEY_VALUE')
    expect(exported).not.toContain('primaryKey')
    expect(exported).not.toContain('secondaryKey')
    expect(exported).not.toContain('SharedAccessKey')
    expect(exported).not.toContain('connectionString')
    expect(exported).not.toContain('TEST_JSON_PASSWORD_VALUE')
    expect(exported).toContain('[REDACTED]')
    expect(finding.tags.apiToken).toBe('<TEST_SECRET>')
  })

  it('writes complete RFC 4180 rows and protects spreadsheet cells', () => {
    const csv = createFindingsCsv([
      recommendation({
        title: 'Quarterly, "archive"\nreview',
        description: '=HYPERLINK("https://example.test")',
        suggestedAction: '\t=1+1',
        resourceGroup:
          '{"password":"TEST_CSV_JSON_PASSWORD_VALUE"}',
        tags: {
          environment: 'production',
          accessToken: '<TEST_SECRET>',
          databaseConfig:
            'Server=database.example;Uid=admin;Pwd={TEST_CSV_ODBC;PASSWORD_VALUE}',
        },
      }),
    ])

    expect(csv.startsWith(FINDINGS_CSV_COLUMNS.map(quoted).join(','))).toBe(true)
    expect(csv).toContain('"compute","right_sizing"')
    expect(csv).toContain('"Quarterly, ""archive""\r\nreview"')
    expect(csv).toContain(
      '"\'=HYPERLINK(""https://example.test"")"',
    )
    expect(csv).toContain('"\'\t=1+1"')
    expect(csv).toContain('"123.45","456.78","GBP"')
    expect(csv).toContain('""environment"":""[REDACTED]""')
    expect(csv).not.toContain('<TEST_SECRET>')
    expect(csv).not.toContain('accessToken')
    expect(csv).not.toContain('TEST_CSV_ODBC')
    expect(csv).not.toContain('PASSWORD_VALUE')
    expect(csv).not.toContain('TEST_CSV_JSON_PASSWORD_VALUE')
    expect(csv.endsWith('\r\n')).toBe(true)
    expect(csv.replaceAll('\r\n', '').includes('\r')).toBe(false)
  })

  it('creates portable, timestamped filenames', () => {
    expect(
      createAssessmentReportFilename(
        'Finance: UK / Q3 * review',
        'json',
        exportedAt,
      ),
    ).toBe('finance-uk-q3-review-assessment-20260903T125021Z.json')
    expect(createAssessmentReportFilename('CON', 'csv', exportedAt)).toBe(
      'assessment-con-assessment-20260903T125021Z.csv',
    )
    expect(createAssessmentReportFilename('報告', 'json', exportedAt)).toBe(
      'assessment-assessment-20260903T125021Z.json',
    )
  })

  it('rejects invalid timestamps and circular report extensions', () => {
    expect(() =>
      createAssessmentReportFilename('Estate', 'json', 'not-a-date'),
    ).toThrow('valid date')

    const extendedOverview = { ...overview, extension: {} as Record<string, unknown> }
    extendedOverview.extension.self = extendedOverview.extension
    expect(() =>
      createAssessmentReport(
        {
          assessment: { name: 'Estate' },
          overview: extendedOverview,
          recommendations: [recommendation()],
          actions: [action],
          scans: [scan],
        },
        { exportedAt },
      ),
    ).toThrow('circular references')
  })
})

function quoted(value: string): string {
  return `"${value}"`
}
