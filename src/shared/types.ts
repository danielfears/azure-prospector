export const recommendationCategories = [
  'compute',
  'storage',
  'network',
  'database',
  'commitment',
  'scheduling',
  'governance',
  'other',
] as const

export type RecommendationCategory = (typeof recommendationCategories)[number]

export const savingsActivities = [
  'reserved_instances',
  'savings_plans',
  'right_sizing',
  'shutdown_scheduling',
  'orphan_cleanup',
  'storage_optimization',
  'licensing_hybrid_benefit',
  'database_optimization',
  'network_optimization',
  'other',
] as const

export type SavingsActivity = (typeof savingsActivities)[number]

export const recommendationStatuses = [
  'open',
  'accepted',
  'in_progress',
  'resolved',
  'dismissed',
] as const

export type RecommendationStatus = (typeof recommendationStatuses)[number]
export type ConfidenceBand = 'high' | 'medium' | 'low'
export type Effort = 'low' | 'medium' | 'high'
export type Risk = 'low' | 'medium' | 'high'
export type RecommendationClaimLevel =
  | 'observed_fact'
  | 'azure_estimate'
  | 'calculated_scenario'
  | 'investigation_lead'
  | 'measured_result'
export type DecisionReadinessStatus =
  | 'needs_evidence'
  | 'needs_validation'
  | 'decision_ready'
  | 'measurement_pending'
  | 'measured'
export type ClaimValidationState =
  | 'unvalidated'
  | 'azure_authored'
  | 'deterministic_calculation'
  | 'independently_validated'
  | 'measured'
export type ActivityClassificationMethod =
  | 'recommendation_type_id'
  | 'text_fallback'
  | 'deterministic_rule'
  | 'legacy_migration'
export type ScanMode = 'demo' | 'live'
export type ScanStatus = 'running' | 'completed' | 'failed'
export type ActionStatus = 'proposed' | 'approved' | 'running' | 'completed' | 'failed'
export type AuthenticationSource =
  | 'none'
  | 'azure_cli'
  | 'browser'
  | 'managed_identity'
  | 'default_credential'

export interface AuthStatusResponse {
  authenticated: boolean
  source: AuthenticationSource
  browserLoginAvailable: boolean
  message: string
}

export interface AzureSubscriptionOption {
  id: string
  name: string
  tenantId: string
  tenantName: string
  state: string
  isDefault: boolean
  authenticationStatus: 'ready' | 'refresh_required'
}

export interface EvidencePoint {
  label: string
  value: string | number
  unit?: string
  source: string
  observedAt?: string
}

export type SerializableScalar = string | number | boolean | null

export interface RecommendationProvenance {
  provider: string
  sourceFamily: string
  sourceApi: string
  sourceApiVersion?: string
  collectedAt: string
  nativeRecommendationId?: string
  nativeRecommendationResourceId?: string
  nativeRecommendationTypeId?: string
  nativeStatus?: string
  nativeLastUpdatedAt?: string
  nativeImpact?: string
  nativeRisk?: string
  nativeLookbackDays?: number
  activityClassification: ActivityClassificationMethod
  extendedProperties: Record<string, SerializableScalar>
  advisorConfiguration?: {
    source: 'Azure Advisor configuration'
    scope: string
    resourceId?: string
    lowCpuThreshold?: number
  }
}

export interface RecommendationEvidenceWindow {
  startAt?: string
  endAt?: string
  lookbackDays?: number
  description: string
}

export interface RecommendationFormulaInput {
  name: string
  value: SerializableScalar
  unit?: string
  sourceEvidenceLabel?: string
}

export interface RecommendationFormula {
  expression: string
  inputs: RecommendationFormulaInput[]
  assumptions: string[]
  exclusions: string[]
  ruleVersion: string
}

export type SavingsSequenceStage =
  | 'usage_optimization'
  | 'independent'
  | 'reservation'
  | 'savings_plan'
  | 'measurement'

export interface RecommendationOverlapIdentity {
  scopeKey: string
  spendPoolKey: string
  alternativeGroup?: string
  sequenceStage: SavingsSequenceStage
  sequenceOrder: number
  mutuallyExclusiveActivities: SavingsActivity[]
}

export interface RecommendationClaim {
  level: RecommendationClaimLevel
  decisionStatus: DecisionReadinessStatus
  validationState: ClaimValidationState
  ruleVersion: string
  provenance: RecommendationProvenance
  evidenceWindow: RecommendationEvidenceWindow
  formula?: RecommendationFormula
  missingEvidence: string[]
  overlap: RecommendationOverlapIdentity
}

export interface VmMetricSeriesSummary {
  dimensions: Record<string, string>
  sampleCount: number
  sampleCountBasis: 'azure_count' | 'populated_buckets'
  populatedBuckets: number
  missingDataPercentage: number
  minimum: number | null
  average: number | null
  maximum: number | null
  percentile95: number | null
  total: number | null
}

export interface VmMetricSummary {
  name: string
  unit: string
  requestedAggregations: string[]
  expectedBuckets: number
  populatedBuckets: number
  sampleCount: number
  sampleCountBasis: 'azure_count' | 'populated_buckets'
  missingDataPercentage: number
  minimum: number | null
  average: number | null
  maximum: number | null
  percentile95: number | null
  total: number | null
  series: VmMetricSeriesSummary[]
  error?: string
}

export interface VmAvailabilitySummary {
  expectedBuckets: number
  populatedBuckets: number
  unknownBuckets: number
  missingDataPercentage: number
  observedAvailableHours: number
  knownAvailabilityPercentage: number | null
  nearContinuousAvailability: boolean
  contextValues: string[]
  caveat: string
}

export interface VmActivityLogEvent {
  operation: string
  status: string
  timestamp: string
  correlationId?: string
}

export interface VmActivityLogSummary {
  events: VmActivityLogEvent[]
  error?: string
}

export interface VmTelemetryEvidence {
  resourceId: string
  collectedAt: string
  window: {
    startAt: string
    endAt: string
    interval: 'PT1H'
    expectedBuckets: number
  }
  availability: VmAvailabilitySummary
  metrics: VmMetricSummary[]
  activityLog: VmActivityLogSummary
  retrievalErrors: string[]
  guestMemoryStatus: 'not_collected'
}

export interface RecommendationOwner {
  displayName: string
  email?: string
  source: 'tag' | 'mapping' | 'manual' | 'unassigned'
  /** Normalized score from 0 to 1. */
  confidence: number
}

export interface Recommendation {
  id: string
  fingerprint: string
  source: 'advisor' | 'resource_graph' | 'monitor' | 'cost_management' | 'prospector'
  sourceRecommendationId?: string
  category: RecommendationCategory
  activity: SavingsActivity
  title: string
  description: string
  suggestedAction: string
  tenantId?: string
  subscriptionId: string
  subscriptionName: string
  resourceId?: string
  resourceName: string
  resourceType: string
  resourceGroup?: string
  location?: string
  estimatedMonthlySavings: number | null
  azureEstimatedMonthlySavings: number | null
  calculatedMonthlySavings: number | null
  measuredMonthlySavings: number | null
  currentMonthlyCost: number | null
  currency: string | null
  claim: RecommendationClaim
  vmTelemetry?: VmTelemetryEvidence
  /** Normalized score from 0 to 1. */
  confidence: number
  confidenceBand: ConfidenceBand
  effort: Effort
  risk: Risk
  status: RecommendationStatus
  owner: RecommendationOwner
  evidence: EvidencePoint[]
  tags: Record<string, string>
  firstSeenAt: string
  lastSeenAt: string
  resolvedAt?: string
  exception?: ExceptionRecord
}

export interface ExceptionRecord {
  id: string
  recommendationId: string
  reason: string
  createdBy: string
  createdAt: string
  expiresAt?: string
}

export interface RemediationAction {
  id: string
  recommendationId: string
  actionType: 'manual' | 'runbook' | 'arm' | 'external'
  title: string
  notes?: string
  status: ActionStatus
  requestedBy: string
  createdAt: string
  updatedAt: string
  completedAt?: string
}

export interface ScanRecord {
  id: string
  assessmentId?: string
  mode: ScanMode
  status: ScanStatus
  assessmentName?: string
  tenantId?: string
  startedAt: string
  completedAt?: string
  subscriptionsDiscovered: number
  recommendationsFound: number
  estimatedMonthlySavings: number
  estimatedMonthlySavingsByCurrency: MonetaryAmount[]
  warningCount: number
  warnings: string[]
  error?: string
}

export interface SubscriptionSummary {
  id: string
  name: string
  tenantId?: string
  state: string
  monthlyCost: number | null
  potentialMonthlySavings: number
  openRecommendations: number
  ownerCoverage: number
  currency: string | null
  costBasis: 'median_completed_month_amortized_pretax_cost'
}

export interface CoverageItem {
  key: string
  label: string
  description: string
  percentage: number
  status: 'complete' | 'partial' | 'missing' | 'unavailable'
  source: string
  coveredCount?: number
  totalCount?: number
  action?: string
}

export interface CostTrendPoint {
  period: string
  observedAmortizedCost: number
  opportunityScenarioCost: number
  measuredSavings: number | null
  /** @deprecated Use observedAmortizedCost. */
  actualCost: number
  /** @deprecated Use opportunityScenarioCost. */
  optimizedCost: number
  /** @deprecated Use measuredSavings; zero does not imply measurement. */
  realizedSavings: number
}

export interface MonetaryAmount {
  currency: string
  amount: number
}

export interface CurrencyFinancialSummary {
  currency: string
  monthlyCost: number
  costBasis: 'median_completed_month_amortized_pretax_cost'
  potentialMonthlySavings: number
  annualizedPotentialSavings: number
  annualizationMethod: 'monthly_estimate_x_12'
  measuredSavingsLast30Days: number | null
  measuredSavingsAllTime: number | null
  measuredResultCount: number
  measuredResultCoverage: number | null
  /** @deprecated Use measuredResultCoverage. Kept numeric for API compatibility. */
  measurementCoverage: number
  /** @deprecated Use measuredSavingsLast30Days. */
  realizedSavingsLast30Days: number
  /** @deprecated Use measuredSavingsAllTime. */
  realizedSavingsAllTime: number
  /** @deprecated Use measuredResultCount. */
  verifiedMeasurementCount: number
  costTrend: CostTrendPoint[]
}

export interface CategorySummary {
  category: RecommendationCategory
  recommendations: number
  estimatedMonthlySavings: MonetaryAmount[]
}

export interface SavingsSummary {
  byCurrency: CurrencyFinancialSummary[]
  measuredResultCount: number
  measuredResultCoverage: number | null
  /** @deprecated Use measuredResultCoverage. Kept numeric for API compatibility. */
  measurementCoverage: number
  /** @deprecated Use measuredResultCount. */
  verifiedMeasurementCount: number
}

export interface EstateSummary {
  assessmentId?: string
  assessmentName?: string
  tenantName: string
  mode: ScanMode
  subscriptions: number
  resources: number
  billingCurrencies: string[]
  lastScanAt?: string
}

export interface OverviewResponse {
  generatedAt: string
  estate: EstateSummary
  savings: SavingsSummary
  openRecommendations: number
  highConfidenceRecommendations: number
  unownedRecommendations: number
  expiringExceptions: number
  categories: CategorySummary[]
  subscriptions: SubscriptionSummary[]
  coverage: CoverageItem[]
  recentScans: ScanRecord[]
}

export interface RecommendationQuery {
  search?: string
  category?: RecommendationCategory
  status?: RecommendationStatus
  subscriptionId?: string
  owner?: string
  minimumConfidence?: number
  includeExcepted?: boolean
}

export interface CreateExceptionRequest {
  reason: string
  createdBy: string
  expiresAt?: string
}

export interface CreateActionRequest {
  title: string
  notes?: string
  actionType: RemediationAction['actionType']
  requestedBy: string
}

export interface StartScanRequest {
  mode: ScanMode
  assessmentId?: string
  assessmentName?: string
  tenantId?: string
  subscriptionIds?: string[]
}

export interface AssessmentSummary {
  id: string
  name: string
  mode: ScanMode
  status: ScanStatus
  selectedSubscriptionIds: string[]
  subscriptionsDiscovered: number
  recommendationsFound: number
  warningCount: number
  createdAt: string
  updatedAt: string
  lastScanAt?: string
}

export interface HealthResponse {
  status: 'ok'
  name: 'Azure Prospector'
  version: string
  mode: ScanMode
  database: string
  now: string
}

export interface ApiError {
  error: string
  details?: string
}
