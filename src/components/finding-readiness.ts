import type { EvidencePoint, Recommendation } from '@/shared/types'

export type FindingReadiness = 'ready' | 'validation'
export type EvidenceKind =
  | 'Azure estimate'
  | 'Observed fact'
  | 'Calculated scenario'
  | 'Investigation lead'
  | 'Measured result'

const claimLabels: Record<Recommendation['claim']['level'], EvidenceKind> = {
  observed_fact: 'Observed fact',
  azure_estimate: 'Azure estimate',
  calculated_scenario: 'Calculated scenario',
  investigation_lead: 'Investigation lead',
  measured_result: 'Measured result',
}

function normalized(value?: string | number) {
  return String(value ?? '').trim().toLocaleLowerCase()
}

export function evidenceKind(evidence: EvidencePoint): EvidenceKind {
  const label = normalized(evidence.label)
  const source = normalized(evidence.source)

  if (
    label.includes('realized') ||
    label.includes('realised') ||
    label.includes('measured')
  ) {
    return 'Measured result'
  }
  if (source.includes('advisor')) return 'Azure estimate'
  if (
    source.includes('heuristic') ||
    source.includes('resource name') ||
    label.includes('not found') ||
    label.includes('inferred')
  ) {
    return 'Investigation lead'
  }
  if (
    label.includes('scenario') ||
    label.includes('calculated') ||
    label.includes('estimated')
  ) {
    return 'Calculated scenario'
  }
  return 'Observed fact'
}

export function findingKind(recommendation: Recommendation): EvidenceKind {
  return (
    claimLabels[recommendation.claim?.level] ??
    (recommendation.source === 'advisor'
      ? 'Azure estimate'
      : recommendation.source === 'prospector'
        ? 'Investigation lead'
        : 'Observed fact')
  )
}

export function evidenceFreshness(recommendation: Recommendation): string {
  const observed = recommendation.evidence
    .map((evidence) => evidence.observedAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1)
  return (
    recommendation.claim?.provenance.nativeLastUpdatedAt ??
    recommendation.claim?.evidenceWindow?.endAt ??
    observed ??
    recommendation.claim?.provenance.collectedAt ??
    recommendation.lastSeenAt
  )
}

export function hasCurrencyMismatch(
  recommendation: Recommendation,
  warnings: string[] = [],
): boolean {
  const evidenceCurrencies = new Set(
    recommendation.evidence
      .map((evidence) => evidence.unit?.trim().toUpperCase())
      .filter((unit): unit is string => Boolean(unit && /^[A-Z]{3}$/.test(unit))),
  )
  if (
    [...evidenceCurrencies].some(
      (currency) =>
        Boolean(recommendation.currency) &&
        currency !== recommendation.currency?.toUpperCase(),
    )
  ) {
    return true
  }

  const subscription = normalized(recommendation.subscriptionName)
  const resource = normalized(recommendation.resourceName)
  if (
    [
      ...(recommendation.claim?.missingEvidence ?? []),
      ...(recommendation.claim?.formula?.exclusions ?? []),
    ].some((item) => normalized(item).includes('currency'))
  ) {
    return true
  }
  return warnings.some((warning) => {
    const text = normalized(warning)
    return (
      text.includes('currency') &&
      text.includes(subscription) &&
      text.includes(resource)
    )
  })
}

export function findingReadiness(
  recommendation: Recommendation,
  warnings: string[] = [],
): FindingReadiness {
  if (recommendation.claim?.decisionStatus) {
    return recommendation.claim.decisionStatus === 'decision_ready'
      ? 'ready'
      : 'validation'
  }
  const hasDatedEvidence = recommendation.evidence.some(
    (evidence) => evidence.observedAt,
  )
  return (recommendation.currentMonthlyCost ?? 0) > 0 &&
    recommendation.confidence >= 0.8 &&
    recommendation.source !== 'prospector' &&
    recommendation.evidence.length > 0 &&
    hasDatedEvidence &&
    !hasCurrencyMismatch(recommendation, warnings)
    ? 'ready'
    : 'validation'
}

export function missingEvidence(
  recommendation: Recommendation,
  warnings: string[] = [],
): string[] {
  const gaps = [...(recommendation.claim?.missingEvidence ?? [])]
  if (!recommendation.claim && (recommendation.currentMonthlyCost ?? 0) <= 0) {
    gaps.push('No comparable resource-level cost baseline is attached.')
  }
  if (
    !recommendation.claim &&
    !recommendation.evidence.some((evidence) => evidence.observedAt)
  ) {
    gaps.push('The attached evidence has no observation timestamp.')
  }
  if (recommendation.owner.source === 'unassigned') {
    gaps.push('No accountable resource owner is identified.')
  }
  if (recommendation.source === 'prospector') {
    gaps.push('Workload intent and utilisation require operator validation.')
  }
  if (hasCurrencyMismatch(recommendation, warnings)) {
    gaps.push('Advisor and Cost Management currencies are not comparable.')
  }
  return [...new Set(gaps)]
}
