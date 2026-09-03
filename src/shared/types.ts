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
}

export interface EvidencePoint {
  label: string
  value: string | number
  unit?: string
  source: string
  observedAt?: string
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
  estimatedMonthlySavings: number
  currentMonthlyCost: number
  currency: string
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
  monthlyCost: number
  potentialMonthlySavings: number
  openRecommendations: number
  ownerCoverage: number
  currency: string
}

export interface CoverageItem {
  key: string
  label: string
  description: string
  percentage: number
  status: 'complete' | 'partial' | 'missing'
  source: string
  action?: string
}

export interface CostTrendPoint {
  period: string
  actualCost: number
  optimizedCost: number
  realizedSavings: number
}

export interface MonetaryAmount {
  currency: string
  amount: number
}

export interface CurrencyFinancialSummary {
  currency: string
  monthlyCost: number
  potentialMonthlySavings: number
  annualizedPotentialSavings: number
  realizedSavingsLast30Days: number
  realizedSavingsAllTime: number
  verifiedMeasurementCount: number
  measurementCoverage: number
  costTrend: CostTrendPoint[]
}

export interface CategorySummary {
  category: RecommendationCategory
  recommendations: number
  estimatedMonthlySavings: MonetaryAmount[]
}

export interface SavingsSummary {
  byCurrency: CurrencyFinancialSummary[]
  verifiedMeasurementCount: number
  measurementCoverage: number
}

export interface EstateSummary {
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
  assessmentName?: string
  tenantId?: string
  subscriptionIds?: string[]
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
