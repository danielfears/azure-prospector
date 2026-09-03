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

export interface ProviderSnapshot {
  provider: string
  mode: ScanMode
  tenantId?: string
  tenantName: string
  collectedAt: string
  currency: string
  resources: number
  monthlyCost: number
  subscriptions: SnapshotSubscription[]
  recommendations: SnapshotRecommendation[]
  coverage: CoverageItem[]
  costTrend: CostTrendPoint[]
  warnings: string[]
  completeSourceFamilies: string[]
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
