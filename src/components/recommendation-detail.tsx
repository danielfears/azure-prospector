import { useState } from 'react'
import {
  BadgeCheck,
  Ban,
  CircleDollarSign,
  ExternalLink,
  ShieldAlert,
  UserRound,
  Wrench,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  evidenceFreshness,
  evidenceKind,
  findingKind,
  findingReadiness,
  hasCurrencyMismatch,
  missingEvidence,
} from '@/components/finding-readiness'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { formatCurrency, formatDate, formatStatus } from '@/lib/format'
import type { CreateActionRequest, CreateExceptionRequest, Recommendation } from '@/shared/types'

interface RecommendationDetailProps {
  recommendation?: Recommendation
  open: boolean
  busy: boolean
  onOpenChange: (open: boolean) => void
  onCreateException: (
    recommendationId: string,
    request: CreateExceptionRequest,
  ) => Promise<void>
  onClearException: (recommendationId: string) => Promise<void>
  onCreateAction: (
    recommendationId: string,
    request: CreateActionRequest,
  ) => Promise<void>
  warnings?: string[]
  onOpenResource?: (recommendation: Recommendation) => void
}

function confidenceExplanation(recommendation: Recommendation): string {
  if (recommendation.source === 'advisor') {
    return (recommendation.currentMonthlyCost ?? 0) > 0
      ? 'Azure Advisor supplied a quantified recommendation and Prospector matched the impacted resource to recent amortized cost evidence.'
      : 'Azure Advisor supplied a quantified recommendation, but Prospector could not independently match this scope to a resource-level cost baseline. Treat the value as an option to validate, not bankable savings.'
  }
  if (recommendation.source === 'resource_graph') {
    return (recommendation.currentMonthlyCost ?? 0) > 0
      ? 'Azure Resource Graph confirmed the configuration relationship and Cost Management confirmed continuing spend.'
      : 'Azure Resource Graph confirmed the configuration relationship, but recent cost evidence was not available.'
  }
  if (recommendation.source === 'prospector') {
    return 'Prospector inferred this lead from resource metadata. Workload intent, external automation, and utilization telemetry are not fully observable.'
  }
  return 'The score reflects the completeness and independence of the evidence attached to this finding.'
}

export function RecommendationDetail({
  recommendation,
  open,
  busy,
  onOpenChange,
  onCreateException,
  onClearException,
  onCreateAction,
  warnings = [],
  onOpenResource,
}: RecommendationDetailProps) {
  const [mode, setMode] = useState<'details' | 'exception' | 'action'>('details')
  const [reason, setReason] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [actionTitle, setActionTitle] = useState(
    recommendation?.suggestedAction ?? '',
  )
  const [actionNotes, setActionNotes] = useState('')

  if (!recommendation) return null
  const recommendationId = recommendation.id
  const claim = recommendation.claim as Recommendation['claim'] | undefined
  const kind = findingKind(recommendation)
  const claimedMonthlyValue =
    kind === 'Azure estimate'
      ? recommendation.azureEstimatedMonthlySavings ??
        recommendation.estimatedMonthlySavings
      : kind === 'Calculated scenario'
        ? recommendation.calculatedMonthlySavings ??
          recommendation.estimatedMonthlySavings
        : kind === 'Measured result'
          ? recommendation.measuredMonthlySavings ??
            recommendation.estimatedMonthlySavings
          : recommendation.estimatedMonthlySavings
  const readiness = findingReadiness(recommendation, warnings)
  const evidenceGaps = missingEvidence(recommendation, warnings)
  const evidenceWindow = claim?.evidenceWindow
  const usageWindow = recommendation.evidence.find((evidence) =>
    evidence.label.toLocaleLowerCase().includes('lookback'),
  )
  const mismatch = hasCurrencyMismatch(recommendation, warnings)
  const costBasis =
    (recommendation.currentMonthlyCost ?? 0) > 0
      ? recommendation.currency
        ? `Matched recent resource-level cost evidence in ${recommendation.currency}`
        : 'Currency unavailable; the cost baseline is not comparable'
      : 'No comparable resource-level cost baseline'
  const formulaInputs = claim?.formula?.inputs
    .map(
      (input) =>
        `${input.name}=${String(input.value)}${input.unit ? ` ${input.unit}` : ''}`,
    )
    .join(' · ')
  const formulaDescription = claim?.formula
    ? `${claim.formula.expression}${
        formulaInputs ? ` · ${formulaInputs}` : ''
      } · rule ${claim.formula.ruleVersion}`
    : recommendation.source === 'advisor'
      ? 'Azure Advisor source estimate; Prospector does not recompute the native amount.'
      : 'No calculation formula is supplied for this claim.'
  const sourceWindow = evidenceWindow?.description
    ? evidenceWindow.description
    : evidenceWindow?.lookbackDays
      ? `${evidenceWindow.lookbackDays} days`
      : usageWindow
        ? `${usageWindow.value}${usageWindow.unit ? ` ${usageWindow.unit}` : ''}`
        : 'Not supplied by the recommendation source'

  async function submitException() {
    if (!reason.trim()) return
    await onCreateException(recommendationId, {
      reason: reason.trim(),
      createdBy: 'Prospector operator',
      ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
    })
    setMode('details')
  }

  async function submitAction() {
    if (!actionTitle.trim()) return
    await onCreateAction(recommendationId, {
      title: actionTitle.trim(),
      notes: actionNotes.trim() || undefined,
      actionType: 'manual',
      requestedBy: 'Prospector operator',
    })
    setMode('details')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Badge>
              {kind}
            </Badge>
            <Badge variant={readiness === 'ready' ? 'outline' : 'secondary'}>
              {readiness === 'ready'
                ? 'Ready for operator review'
                : 'Needs validation'}
            </Badge>
            {claim?.validationState && (
              <Badge variant="outline">
                {claim.validationState.replaceAll('_', ' ')}
              </Badge>
            )}
            <Badge variant="secondary">{formatStatus(recommendation.status)}</Badge>
            <Badge variant="outline">{recommendation.source.replace('_', ' ')}</Badge>
          </div>
          <DialogTitle className="pr-8 text-2xl leading-tight">
            {recommendation.title}
          </DialogTitle>
          <DialogDescription className="leading-6">
            {recommendation.description}
          </DialogDescription>
        </DialogHeader>

        {mode === 'details' && (
          <div className="space-y-6">
            <section
              className="rounded-xl border border-primary bg-accent p-4"
              aria-label="Decision readiness"
            >
              <div className="text-sm font-bold text-accent-foreground">
                {readiness === 'ready'
                  ? 'Evidence supports an operator review'
                  : 'Validate evidence before planning a change'}
              </div>
              <p className="mt-1 text-sm leading-6 text-foreground">
                {readiness === 'ready'
                  ? 'A dated evidence set and comparable cost baseline are attached. Operational safety and workload intent still require approval.'
                  : evidenceGaps[0] ??
                    (claim?.validationState === 'azure_authored'
                      ? 'This is an Azure-authored estimate that still requires an independent workload and commercial review.'
                      : 'The available evidence does not yet support an action-ready decision.')}
              </p>
            </section>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Metric
                icon={CircleDollarSign}
                label={kind}
                value={
                  claimedMonthlyValue !== null &&
                  recommendation.currency
                    ? formatCurrency(
                        claimedMonthlyValue,
                        recommendation.currency,
                      )
                    : claimedMonthlyValue !== null
                      ? 'Currency unavailable'
                      : 'Not quantified'
                }
              />
              <Metric
                icon={CircleDollarSign}
                label="Cost baseline"
                value={
                  (recommendation.currentMonthlyCost ?? 0) > 0
                    ? recommendation.currency
                      ? formatCurrency(
                          recommendation.currentMonthlyCost ?? 0,
                          recommendation.currency,
                        )
                      : 'Currency unavailable'
                    : 'Not matched'
                }
              />
              <Metric
                icon={ShieldAlert}
                label="Change risk"
                value={recommendation.risk}
              />
              <Metric icon={Wrench} label="Effort" value={recommendation.effort} />
            </div>

            <section>
              <h3 className="text-sm font-bold text-foreground">
                Evidence quality explained
              </h3>
              <div className="mt-2 rounded-[0.625rem] border bg-secondary p-4">
                <div className="text-sm font-bold capitalize text-foreground">
                  {recommendation.confidenceBand} evidence confidence
                </div>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  {confidenceExplanation(recommendation)}
                </p>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  This is an evidence-quality score, not the probability of
                  achieving the estimated saving or a statement that the
                  change is operationally safe.
                </p>
              </div>
            </section>

            <section>
              <h3 className="text-sm font-bold text-foreground">Recommended action</h3>
              <div className="mt-2 rounded-[0.625rem] border bg-secondary p-4 text-sm leading-6 text-foreground">
                {recommendation.suggestedAction}
              </div>
            </section>

            <section>
              <h3 className="text-sm font-bold text-foreground">Evidence</h3>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {recommendation.evidence.map((evidence) => (
                  <div
                    key={`${evidence.label}-${evidence.source}`}
                    className="rounded-[0.625rem] border bg-card p-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="text-xs text-muted-foreground">
                        {evidence.label}
                      </div>
                      <Badge variant="outline">{evidenceKind(evidence)}</Badge>
                    </div>
                    <div className="mt-1 font-semibold text-foreground">
                      {evidence.value}
                      {evidence.unit ? ` ${evidence.unit}` : ''}
                    </div>
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      {evidence.source}
                      {evidence.observedAt ? ` · ${formatDate(evidence.observedAt)}` : ''}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section>
              <h3 className="text-sm font-bold text-foreground">
                Basis, assumptions and freshness
              </h3>
              <dl className="mt-2 grid gap-x-6 gap-y-4 rounded-[0.625rem] border bg-secondary p-4 text-sm sm:grid-cols-2">
                <DetailFact label="Cost basis" value={costBasis} />
                <DetailFact
                  label="Source window"
                  value={sourceWindow}
                />
                <DetailFact
                  label="Calculation treatment"
                  value={formulaDescription}
                />
                <DetailFact
                  label="Overlap and currency"
                  value={
                    claim
                      ? `De-duplicated within its opportunity spend pool; sequence ${claim.overlap.sequenceStage.replaceAll(
                          '_',
                          ' ',
                        )} (${claim.overlap.sequenceOrder})${
                          claim.overlap.mutuallyExclusiveActivities.length
                            ? ` · ${claim.overlap.mutuallyExclusiveActivities.length} mutually exclusive ${
                                claim.overlap.mutuallyExclusiveActivities
                                  .length === 1
                                  ? 'activity'
                                  : 'activities'
                              }`
                            : ''
                        }. ${
                          mismatch
                            ? 'A source-currency mismatch prevents comparison with the cost baseline.'
                            : 'Native currencies remain separate; no FX conversion is applied.'
                        }`
                      : `Opportunity scenarios are de-duplicated by resource scope. ${
                          mismatch
                            ? 'A source-currency mismatch prevents comparison with the cost baseline.'
                            : 'Native currencies remain separate; no FX conversion is applied.'
                        }`
                  }
                />
                <DetailFact
                  label="Freshness"
                  value={`Evidence ${formatDate(
                    evidenceFreshness(recommendation),
                    true,
                  )} · first seen ${formatDate(
                    recommendation.firstSeenAt,
                    true,
                  )} · last seen ${formatDate(
                    recommendation.lastSeenAt,
                    true,
                  )}`}
                />
                <DetailFact
                  label="Provenance"
                  value={
                    claim
                      ? `${claim.provenance.sourceApi}${
                          claim.provenance.sourceApiVersion
                            ? ` ${claim.provenance.sourceApiVersion}`
                            : ''
                        } · collected ${formatDate(
                          claim.provenance.collectedAt,
                          true,
                        )}`
                      : `${recommendation.source.replaceAll(
                          '_',
                          ' ',
                        )} · detailed provenance is not available in this stored result`
                  }
                />
              </dl>
            </section>

            {(claim?.formula?.assumptions.length ||
              claim?.formula?.exclusions.length) && (
              <section className="grid gap-3 sm:grid-cols-2">
                <ClaimList
                  title="Assumptions"
                  items={claim.formula?.assumptions ?? []}
                  empty="No explicit assumptions supplied."
                />
                <ClaimList
                  title="Exclusions"
                  items={claim.formula?.exclusions ?? []}
                  empty="No explicit exclusions supplied."
                />
              </section>
            )}

            {evidenceGaps.length > 0 && (
              <section>
                <h3 className="text-sm font-bold text-foreground">
                  Missing evidence
                </h3>
                <ul className="mt-2 space-y-2">
                  {evidenceGaps.map((gap) => (
                    <li
                      key={gap}
                      className="flex items-start gap-2 rounded-[0.625rem] border bg-secondary p-3 text-sm text-muted-foreground"
                    >
                      <ShieldAlert
                        className="mt-0.5 size-4 shrink-0 text-warning"
                        aria-hidden="true"
                      />
                      {gap}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-[0.625rem] border p-4">
                <div className="flex items-center gap-2 text-sm font-bold text-foreground">
                  <UserRound className="size-4" aria-hidden="true" />
                  Ownership
                </div>
                <div className="mt-2 text-sm text-foreground">
                  {recommendation.owner.displayName}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {recommendation.owner.source} ·{' '}
                  {Math.round(recommendation.owner.confidence * 100)}% confidence
                </div>
              </div>
              <div className="rounded-[0.625rem] border p-4">
                <div className="text-sm font-bold text-foreground">Resource</div>
                {onOpenResource ? (
                  <button
                    type="button"
                    className="mt-2 min-h-11 break-all rounded-md text-left text-sm font-semibold text-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => onOpenResource(recommendation)}
                  >
                    {recommendation.resourceName}
                  </button>
                ) : (
                  <div className="mt-2 break-all text-sm text-foreground">
                    {recommendation.resourceName}
                  </div>
                )}
                <div className="mt-1 text-xs text-muted-foreground">
                  {recommendation.subscriptionName}
                  {recommendation.resourceGroup ? ` · ${recommendation.resourceGroup}` : ''}
                </div>
              </div>
            </section>

            {recommendation.exception && (
              <div className="rounded-[0.625rem] border border-warning bg-secondary p-4">
                <div className="flex items-center gap-2 font-semibold text-foreground">
                  <Ban className="size-4 text-warning" aria-hidden="true" />
                  Active exception
                </div>
                <p className="mt-2 text-sm text-muted-foreground">
                  {recommendation.exception.reason}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  Added by {recommendation.exception.createdBy}
                  {recommendation.exception.expiresAt
                    ? ` · expires ${formatDate(recommendation.exception.expiresAt)}`
                    : ' · no expiry'}
                </p>
              </div>
            )}

            <div className="flex flex-wrap justify-end gap-2 border-t pt-5">
              {recommendation.resourceId?.startsWith('/subscriptions/') && (
                <Button variant="ghost" asChild>
                  <a
                    href={`https://portal.azure.com/#resource${recommendation.resourceId}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open in Azure
                    <ExternalLink aria-hidden="true" />
                  </a>
                </Button>
              )}
              {recommendation.exception ? (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => onClearException(recommendation.id)}
                >
                  Clear exception
                </Button>
              ) : (
                <Button variant="outline" onClick={() => setMode('exception')}>
                  Add exception
                </Button>
              )}
              <Button disabled={busy} onClick={() => setMode('action')}>
                <BadgeCheck aria-hidden="true" />
                Plan remediation
              </Button>
            </div>
          </div>
        )}

        {mode === 'exception' && (
          <div className="space-y-4">
            <label className="block">
              <span className="text-sm font-semibold text-foreground">Reason</span>
              <textarea
                className="mt-2 min-h-28 w-full rounded-[0.625rem] border bg-card px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
                placeholder="Why should this finding be excluded?"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
            <label className="block">
              <span className="text-sm font-semibold text-foreground">
                Expiry date <span className="font-normal text-muted-foreground">(optional)</span>
              </span>
              <input
                type="date"
                className="mt-2 h-10 w-full rounded-[0.625rem] border bg-card px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
                value={expiresAt}
                onChange={(event) => setExpiresAt(event.target.value)}
              />
            </label>
            <div className="flex justify-end gap-2 border-t pt-4">
              <Button variant="ghost" onClick={() => setMode('details')}>
                Cancel
              </Button>
              <Button disabled={busy || !reason.trim()} onClick={submitException}>
                Save exception
              </Button>
            </div>
          </div>
        )}

        {mode === 'action' && (
          <div className="space-y-4">
            <label className="block">
              <span className="text-sm font-semibold text-foreground">Action title</span>
              <input
                className="mt-2 h-10 w-full rounded-[0.625rem] border bg-card px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
                value={actionTitle}
                onChange={(event) => setActionTitle(event.target.value)}
              />
            </label>
            <label className="block">
              <span className="text-sm font-semibold text-foreground">Notes</span>
              <textarea
                className="mt-2 min-h-28 w-full rounded-[0.625rem] border bg-card px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
                placeholder="Approval, change-window, or implementation details."
                value={actionNotes}
                onChange={(event) => setActionNotes(event.target.value)}
              />
            </label>
            <p className="rounded-[0.625rem] border bg-secondary p-3 text-xs leading-5 text-muted-foreground">
              Azure Prospector records the workflow but never changes Azure resources without a
              separately configured and explicitly approved automation integration.
            </p>
            <div className="flex justify-end gap-2 border-t pt-4">
              <Button variant="ghost" onClick={() => setMode('details')}>
                Cancel
              </Button>
              <Button disabled={busy || !actionTitle.trim()} onClick={submitAction}>
                Create action
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function Metric({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof CircleDollarSign
  label: string
  value: string
}) {
  return (
    <div className="rounded-[0.625rem] border bg-secondary p-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className="size-3.5" aria-hidden="true" />
        {label}
      </div>
      <div className="mt-1.5 capitalize font-bold text-foreground">{value}</div>
    </div>
  )
}

function DetailFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 leading-6 text-foreground">{value}</dd>
    </div>
  )
}

function ClaimList({
  title,
  items,
  empty,
}: {
  title: string
  items: string[]
  empty: string
}) {
  return (
    <div className="rounded-[0.625rem] border bg-secondary p-4">
      <h3 className="text-sm font-bold text-foreground">{title}</h3>
      {items.length ? (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-6 text-muted-foreground">
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">{empty}</p>
      )}
    </div>
  )
}
