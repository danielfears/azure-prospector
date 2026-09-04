import type {
  CostTrendPoint,
  CoverageItem,
  Recommendation,
  ScanMode,
  SubscriptionSummary,
} from '../../src/shared/types.js'

export interface SnapshotRecommendation
  extends Omit<Recommendation, 'exception'> {
  sourceFamily: string
}

export interface SnapshotSubscription extends SubscriptionSummary {
  resourceCount: number
}

export interface CurrencyCostTrend {
  currency: string
  points: CostTrendPoint[]
}

export interface ProviderSnapshot {
  provider: string
  mode: ScanMode
  tenantId?: string
  tenantName: string
  collectedAt: string
  resources: number
  subscriptions: SnapshotSubscription[]
  recommendations: SnapshotRecommendation[]
  coverage: CoverageItem[]
  currencyCostTrends: CurrencyCostTrend[]
  warnings: string[]
  completeSourceFamilies: string[]
  completeSourceFamiliesBySubscription: Record<string, string[]>
}

export interface ProviderCollectRequest {
  tenantId?: string
  subscriptionIds?: string[]
}

export interface ProspectorProvider {
  readonly name: string
  readonly mode: ScanMode
  collect(request: ProviderCollectRequest): Promise<ProviderSnapshot>
}
