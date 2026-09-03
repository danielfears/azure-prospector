import type {
  OverviewResponse,
  Recommendation,
  RemediationAction,
  ScanRecord,
} from '../src/shared/types.js'

export const ASSESSMENT_REPORT_SCHEMA =
  'azure-prospector/assessment-report@1' as const

export const FINDINGS_CSV_COLUMNS = [
  'id',
  'fingerprint',
  'source',
  'sourceRecommendationId',
  'category',
  'title',
  'description',
  'suggestedAction',
  'tenantId',
  'subscriptionId',
  'subscriptionName',
  'resourceId',
  'resourceName',
  'resourceType',
  'resourceGroup',
  'location',
  'estimatedMonthlySavings',
  'currentMonthlyCost',
  'currency',
  'confidence',
  'confidenceBand',
  'effort',
  'risk',
  'status',
  'ownerDisplayName',
  'ownerEmail',
  'ownerSource',
  'ownerConfidence',
  'evidence',
  'tags',
  'firstSeenAt',
  'lastSeenAt',
  'resolvedAt',
  'exceptionId',
  'exceptionReason',
  'exceptionCreatedBy',
  'exceptionCreatedAt',
  'exceptionExpiresAt',
] as const

export interface AssessmentReportIdentity {
  id?: string
  name: string
}

export interface AssessmentReportData<
  TOverview extends OverviewResponse = OverviewResponse,
  TFinding extends Recommendation = Recommendation,
  TAction extends RemediationAction = RemediationAction,
  TScan extends ScanRecord = ScanRecord,
> {
  assessment: AssessmentReportIdentity
  overview: TOverview
  recommendations: readonly TFinding[]
  actions: readonly TAction[]
  scans: readonly TScan[]
}

export type Redacted<T> = T extends Date
  ? string
  : T extends string | number | boolean | null
    ? T
    : T extends readonly (infer TValue)[]
      ? Redacted<TValue>[]
      : T extends object
        ? { [TKey in keyof T]?: Redacted<T[TKey]> }
        : never

export interface AssessmentReport<
  TOverview extends OverviewResponse = OverviewResponse,
  TFinding extends Recommendation = Recommendation,
  TAction extends RemediationAction = RemediationAction,
  TScan extends ScanRecord = ScanRecord,
> {
  schema: typeof ASSESSMENT_REPORT_SCHEMA
  exportedAt: string
  assessment: Redacted<AssessmentReportIdentity>
  overview: Redacted<TOverview>
  findings: Redacted<TFinding>[]
  remediationActions: Redacted<TAction>[]
  scans: Redacted<TScan>[]
}

export interface ReportExportOptions {
  exportedAt?: Date | string
}

export type ReportExportFormat = 'json' | 'csv'

const SENSITIVE_KEY_SUFFIXES = [
  'token',
  'password',
  'passwd',
  'pwd',
  'passphrase',
  'secret',
  'credential',
  'credentials',
  'apikey',
  'accesskey',
  'sharedaccesskey',
  'accountkey',
  'primarykey',
  'secondarykey',
  'connectionstring',
  'connectionstrings',
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'sharedaccesssignature',
  'privatekey',
] as const

const WINDOWS_RESERVED_NAMES =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i

function isSensitiveKey(key: string): boolean {
  const canonicalKey = key.replaceAll(/[^a-z0-9]/gi, '').toLowerCase()
  return SENSITIVE_KEY_SUFFIXES.some((suffix) =>
    canonicalKey.endsWith(suffix),
  )
}

function redactSensitiveText(value: string): string {
  return value
    .replaceAll(
      /\bEndpoint=sb:\/\/[^;\s]+;SharedAccessKeyName=[^;\s]+;SharedAccessKey=[^;\s]+/gi,
      '[REDACTED]',
    )
    .replaceAll(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      '[REDACTED]',
    )
    .replaceAll(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED]')
    .replaceAll(
      /((?:(?:"|')?(?:access[\s_-]?token|refresh[\s_-]?token|id[\s_-]?token|password|passwd|pwd|passphrase|client[\s_-]?secret|api[\s_-]?key|access[\s_-]?key|account[\s_-]?key|primary[\s_-]?key|secondary[\s_-]?key|shared[\s_-]?access[\s_-]?key|connection[\s_-]?string|shared[\s_-]?access[\s_-]?signature)(?:"|')?)\s*[:=]\s*)(?:\{[^}]*\}|"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1[REDACTED]',
    )
    .replaceAll(/([?&](?:sig|signature)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replaceAll(
      /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
      '[REDACTED]',
    )
    .replaceAll(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      '[REDACTED]',
    )
}

function redactTags(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => !isSensitiveKey(key))
      .map((key) => [key, '[REDACTED]']),
  )
}

function redactValue(
  value: unknown,
  ancestors: WeakSet<object>,
): unknown {
  if (typeof value === 'string') {
    return redactSensitiveText(value)
  }

  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value
  }

  if (value instanceof Date) {
    return toIsoTimestamp(value)
  }

  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new TypeError('Report data must not contain circular references')
    }
    ancestors.add(value)
    const result = value.map((item) => redactValue(item, ancestors))
    ancestors.delete(value)
    return result
  }

  if (typeof value === 'object') {
    if (ancestors.has(value)) {
      throw new TypeError('Report data must not contain circular references')
    }
    ancestors.add(value)
    const result = Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !isSensitiveKey(key))
        .map(([key, item]) => [
          key,
          key.toLowerCase() === 'tags'
            ? redactTags(item)
            : redactValue(item, ancestors),
        ]),
    )
    ancestors.delete(value)
    return result
  }

  return undefined
}

function sanitiseForExport<T>(value: T): Redacted<T> {
  return redactValue(value, new WeakSet<object>()) as Redacted<T>
}

function toIsoTimestamp(value: Date | string | undefined): string {
  const date = value === undefined ? new Date() : new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new TypeError('Report export timestamp must be a valid date')
  }
  return date.toISOString()
}

export function createAssessmentReport<
  TOverview extends OverviewResponse,
  TFinding extends Recommendation,
  TAction extends RemediationAction,
  TScan extends ScanRecord,
>(
  data: AssessmentReportData<TOverview, TFinding, TAction, TScan>,
  options: ReportExportOptions = {},
): AssessmentReport<TOverview, TFinding, TAction, TScan> {
  return {
    schema: ASSESSMENT_REPORT_SCHEMA,
    exportedAt: toIsoTimestamp(options.exportedAt),
    assessment: sanitiseForExport(data.assessment),
    overview: sanitiseForExport(data.overview),
    findings: sanitiseForExport(data.recommendations),
    remediationActions: sanitiseForExport(data.actions),
    scans: sanitiseForExport(data.scans),
  }
}

export function serializeAssessmentReport(
  report: AssessmentReport,
  indentation = 2,
): string {
  if (!Number.isInteger(indentation) || indentation < 0 || indentation > 10) {
    throw new RangeError('JSON indentation must be an integer from 0 to 10')
  }
  return `${JSON.stringify(report, null, indentation)}\n`
}

function spreadsheetSafeText(value: unknown): string {
  const text =
    value !== null && typeof value === 'object'
      ? JSON.stringify(value)
      : String(value ?? '')
  const normalizedLineEndings = text.replaceAll(/\r\n|\r|\n/g, '\r\n')
  return /^[=+\-@\t\r\n]/.test(normalizedLineEndings)
    ? `'${normalizedLineEndings}`
    : normalizedLineEndings
}

function csvCell(value: unknown): string {
  return `"${spreadsheetSafeText(value).replaceAll('"', '""')}"`
}

function findingCsvRow(finding: Redacted<Recommendation>): unknown[] {
  return [
    finding.id,
    finding.fingerprint,
    finding.source,
    finding.sourceRecommendationId,
    finding.category,
    finding.title,
    finding.description,
    finding.suggestedAction,
    finding.tenantId,
    finding.subscriptionId,
    finding.subscriptionName,
    finding.resourceId,
    finding.resourceName,
    finding.resourceType,
    finding.resourceGroup,
    finding.location,
    finding.estimatedMonthlySavings,
    finding.currentMonthlyCost,
    finding.currency,
    finding.confidence,
    finding.confidenceBand,
    finding.effort,
    finding.risk,
    finding.status,
    finding.owner?.displayName,
    finding.owner?.email,
    finding.owner?.source,
    finding.owner?.confidence,
    finding.evidence,
    finding.tags,
    finding.firstSeenAt,
    finding.lastSeenAt,
    finding.resolvedAt,
    finding.exception?.id,
    finding.exception?.reason,
    finding.exception?.createdBy,
    finding.exception?.createdAt,
    finding.exception?.expiresAt,
  ]
}

export function createFindingsCsv(
  findings: readonly Recommendation[],
): string {
  const rows = [
    FINDINGS_CSV_COLUMNS,
    ...sanitiseForExport(findings).map(findingCsvRow),
  ]
  return `${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`
}

function filenameSlug(assessmentName: string): string {
  const withoutControlCharacters = Array.from(
    assessmentName.normalize('NFKD'),
    (character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 31 || codePoint === 127 ? '-' : character
    },
  ).join('')

  let slug = withoutControlCharacters
    .replaceAll(/\p{Diacritic}/gu, '')
    .replaceAll(/[<>:"/\\|?*]+/g, '-')
    .replaceAll(/[^a-zA-Z0-9._-]+/g, '-')
    .replaceAll(/[-_.]{2,}/g, '-')
    .replaceAll(/^[-_.]+|[-_.]+$/g, '')
    .toLowerCase()
    .slice(0, 80)
    .replaceAll(/[-_.]+$/g, '')

  if (!slug) {
    slug = 'assessment'
  }
  if (WINDOWS_RESERVED_NAMES.test(slug)) {
    slug = `assessment-${slug}`
  }
  return slug
}

export function createAssessmentReportFilename(
  assessmentName: string,
  format: ReportExportFormat,
  exportedAt?: Date | string,
): string {
  if (format !== 'json' && format !== 'csv') {
    throw new TypeError('Report export format must be json or csv')
  }
  const timestamp = toIsoTimestamp(exportedAt)
    .replaceAll(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
  return `${filenameSlug(assessmentName)}-assessment-${timestamp}.${format}`
}
