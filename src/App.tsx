import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  AlertCircle,
  BarChart3,
  CheckCircle2,
  ClipboardCheck,
  CircleDollarSign,
  Cloud,
  Coins,
  Code2,
  Gauge,
  Gem,
  LayoutDashboard,
  ListChecks,
  LoaderCircle,
  Moon,
  Pickaxe,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Sun,
  Target,
  TrendingDown,
  WalletCards,
  Wrench,
} from 'lucide-react'

import { BrandMark } from '@/components/brand-mark'
import { CostTrendChart } from '@/components/cost-trend-chart'
import { CoveragePanel } from '@/components/coverage-panel'
import { RecommendationDetail } from '@/components/recommendation-detail'
import { RecommendationTable } from '@/components/recommendation-table'
import { StatCard } from '@/components/stat-card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  createAction,
  createException,
  clearException,
  getActions,
  getOverview,
  getRecommendations,
  startScan,
  updateActionStatus,
} from '@/lib/api'
import {
  formatCategory,
  formatActionStatus,
  formatCurrency,
  formatDate,
  formatStatus,
} from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  recommendationCategories,
  recommendationStatuses,
  type ActionStatus,
  type CreateActionRequest,
  type CreateExceptionRequest,
  type OverviewResponse,
  type Recommendation,
  type RecommendationCategory,
  type RecommendationStatus,
  type RemediationAction,
  type ScanMode,
} from '@/shared/types'

type View = 'overview' | 'findings' | 'actions' | 'savings' | 'coverage'
type StatusFilter = RecommendationStatus | 'active' | 'all'

const navigation: Array<{
  id: View
  label: string
  icon: typeof LayoutDashboard
}> = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'findings', label: 'Findings', icon: ListChecks },
  { id: 'actions', label: 'Actions', icon: ClipboardCheck },
  { id: 'savings', label: 'Savings', icon: Coins },
  { id: 'coverage', label: 'Coverage', icon: ShieldCheck },
]

function loadDashboardData() {
  return Promise.all([
    getOverview(),
    getRecommendations({ includeExcepted: true }),
    getActions(),
  ])
}

function App() {
  const [overview, setOverview] = useState<OverviewResponse>()
  const [recommendations, setRecommendations] = useState<Recommendation[]>([])
  const [actions, setActions] = useState<RemediationAction[]>([])
  const [selected, setSelected] = useState<Recommendation>()
  const [activeView, setActiveView] = useState<View>('overview')
  const [scanMode, setScanMode] = useState<ScanMode>()
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [mutating, setMutating] = useState(false)
  const [notice, setNotice] = useState<string>()
  const [error, setError] = useState<string>()
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light',
  )

  const [search, setSearch] = useState('')
  const [category, setCategory] = useState<RecommendationCategory | 'all'>('all')
  const [status, setStatus] = useState<StatusFilter>('active')
  const [subscriptionId, setSubscriptionId] = useState('all')
  const [minimumConfidence, setMinimumConfidence] = useState(0)
  const [includeExcepted, setIncludeExcepted] = useState(false)

  async function refresh(selectedId?: string) {
    try {
      const [nextOverview, nextRecommendations, nextActions] =
        await loadDashboardData()
      setOverview(nextOverview)
      setRecommendations(nextRecommendations)
      setActions(nextActions)
      setScanMode((current) => current ?? nextOverview.estate.mode)
      if (selectedId) {
        setSelected(nextRecommendations.find((item) => item.id === selectedId))
      }
      setError(undefined)
    } catch (requestError) {
      setError(messageFromError(requestError))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let active = true
    void loadDashboardData()
      .then(([nextOverview, nextRecommendations, nextActions]) => {
        if (!active) return
        setOverview(nextOverview)
        setRecommendations(nextRecommendations)
        setActions(nextActions)
        setScanMode(nextOverview.estate.mode)
      })
      .catch((requestError: unknown) => {
        if (active) setError(messageFromError(requestError))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  const filteredRecommendations = useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase()
    return recommendations.filter((recommendation) => {
      if (
        normalizedSearch &&
        ![
          recommendation.title,
          recommendation.description,
          recommendation.resourceName,
          recommendation.subscriptionName,
          recommendation.owner.displayName,
        ].some((value) => value.toLocaleLowerCase().includes(normalizedSearch))
      ) {
        return false
      }
      if (category !== 'all' && recommendation.category !== category) return false
      if (subscriptionId !== 'all' && recommendation.subscriptionId !== subscriptionId) {
        return false
      }
      if (minimumConfidence && recommendation.confidence < minimumConfidence) return false
      if (!includeExcepted && recommendation.exception) return false
      if (
        status === 'active' &&
        !['open', 'accepted', 'in_progress'].includes(recommendation.status)
      ) {
        return false
      }
      if (status !== 'all' && status !== 'active' && recommendation.status !== status) {
        return false
      }
      return true
    })
  }, [
    category,
    includeExcepted,
    minimumConfidence,
    recommendations,
    search,
    status,
    subscriptionId,
  ])

  const topRecommendations = useMemo(
    () =>
      recommendations
        .filter(
          (recommendation) =>
            ['open', 'accepted', 'in_progress'].includes(recommendation.status) &&
            !recommendation.exception,
        )
        .sort((left, right) => {
          const leftScore = left.estimatedMonthlySavings * left.confidence
          const rightScore = right.estimatedMonthlySavings * right.confidence
          return rightScore - leftScore
        })
        .slice(0, 6),
    [recommendations],
  )

  async function runScan() {
    const selectedMode = scanMode ?? overview?.estate.mode ?? 'demo'
    setScanning(true)
    setNotice(undefined)
    setError(undefined)
    try {
      const scan = await startScan({ mode: selectedMode })
      setScanMode(scan.mode)
      await refresh()
      setNotice(
        `${scan.mode === 'live' ? 'Live' : 'Demo'} scan completed: ${scan.recommendationsFound} findings across ${scan.subscriptionsDiscovered} subscriptions.`,
      )
    } catch (scanError) {
      setError(messageFromError(scanError))
    } finally {
      setScanning(false)
    }
  }

  function toggleTheme() {
    const nextTheme = theme === 'dark' ? 'light' : 'dark'
    document.documentElement.setAttribute('data-theme', nextTheme)
    setTheme(nextTheme)
  }

  async function addException(
    recommendationId: string,
    request: CreateExceptionRequest,
  ) {
    setMutating(true)
    try {
      await createException(recommendationId, request)
      await refresh(recommendationId)
      setNotice('Exception recorded. The finding remains visible when exceptions are included.')
    } catch (mutationError) {
      setError(messageFromError(mutationError))
    } finally {
      setMutating(false)
    }
  }

  async function removeException(recommendationId: string) {
    setMutating(true)
    try {
      await clearException(recommendationId)
      await refresh(recommendationId)
      setNotice('Exception cleared.')
    } catch (mutationError) {
      setError(messageFromError(mutationError))
    } finally {
      setMutating(false)
    }
  }

  async function addAction(recommendationId: string, request: CreateActionRequest) {
    setMutating(true)
    try {
      await createAction(recommendationId, request)
      await refresh(recommendationId)
      setNotice('Remediation action added to the workflow.')
    } catch (mutationError) {
      setError(messageFromError(mutationError))
    } finally {
      setMutating(false)
    }
  }

  async function changeActionStatus(actionId: string, status: ActionStatus) {
    setMutating(true)
    try {
      await updateActionStatus(actionId, status)
      await refresh(selected?.id)
      setNotice(`Remediation action moved to ${status.replace('_', ' ')}.`)
    } catch (mutationError) {
      setError(messageFromError(mutationError))
    } finally {
      setMutating(false)
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r bg-card px-4 py-5 lg:flex">
        <div className="px-2">
          <BrandMark />
        </div>

        <nav className="mt-10 space-y-1">
          {navigation.map((item) => {
            const Icon = item.icon
            const active = activeView === item.id
            return (
              <button
                key={item.id}
                type="button"
                className={cn(
                  'flex w-full items-center gap-3 rounded-[0.625rem] px-3 py-2.5 text-left text-sm font-semibold transition-colors',
                  active
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                )}
                onClick={() => setActiveView(item.id)}
              >
                <Icon className="size-[18px]" aria-hidden="true" />
                {item.label}
                {item.id === 'findings' && overview && (
                  <span className="ml-auto rounded-full border bg-card px-2 py-0.5 text-[11px] text-foreground">
                    {overview.openRecommendations}
                  </span>
                )}
              </button>
            )
          })}
        </nav>

        <div className="mt-auto space-y-3">
          <div className="rounded-xl border bg-secondary p-4">
            <div className="flex items-center gap-2 text-sm font-bold text-foreground">
              <Gem className="size-4 text-primary" aria-hidden="true" />
              Open source
            </div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              Self-hosted, read-only by default, and built from public Azure APIs.
            </p>
            <a
              className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold"
              href="https://github.com/danielfears/azure-prospector"
              target="_blank"
              rel="noreferrer"
            >
              <Code2 className="size-3.5" aria-hidden="true" />
              View repository
            </a>
          </div>
          <div className="px-2 text-[11px] leading-5 text-muted-foreground">
            Community project. Not an official Microsoft product.
          </div>
        </div>
      </aside>

      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 border-b bg-[var(--cp-panel-strong)]">
          <div className="flex min-h-16 items-center gap-3 px-4 sm:px-6 lg:px-8">
            <div className="lg:hidden">
              <BrandMark compact />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-bold text-foreground">
                {overview?.estate.tenantName ?? 'Azure estate'}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {overview
                  ? `${overview.estate.subscriptions} subscriptions · last scan ${formatDate(
                      overview.estate.lastScanAt,
                      true,
                    )}`
                  : 'Loading estate inventory'}
              </div>
            </div>
            <select
              aria-label="Scan mode"
              className="hidden h-9 rounded-[0.625rem] border bg-card px-3 text-sm font-semibold text-foreground outline-none focus:ring-2 focus:ring-ring sm:block"
              value={scanMode ?? overview?.estate.mode ?? 'demo'}
              onChange={(event) => setScanMode(event.target.value as ScanMode)}
            >
              <option value="demo">Demo data</option>
              <option value="live">Live Azure</option>
            </select>
            <Button
              variant="outline"
              size="icon"
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
              onClick={toggleTheme}
            >
              {theme === 'dark' ? (
                <Sun className="size-4" aria-hidden="true" />
              ) : (
                <Moon className="size-4" aria-hidden="true" />
              )}
            </Button>
            <Button disabled={scanning} onClick={runScan}>
              {scanning ? (
                <LoaderCircle className="animate-spin" aria-hidden="true" />
              ) : (
                <Play aria-hidden="true" />
              )}
              <span className="hidden sm:inline">{scanning ? 'Scanning' : 'Run scan'}</span>
            </Button>
          </div>

          <nav className="flex overflow-x-auto border-t px-3 lg:hidden">
            {navigation.map((item) => {
              const Icon = item.icon
              return (
                <button
                  key={item.id}
                  type="button"
                  className={cn(
                    'flex shrink-0 items-center gap-2 border-b-2 px-3 py-3 text-xs font-semibold',
                    activeView === item.id
                      ? 'border-primary text-primary'
                      : 'border-transparent text-muted-foreground',
                  )}
                  onClick={() => setActiveView(item.id)}
                >
                  <Icon className="size-4" aria-hidden="true" />
                  {item.label}
                </button>
              )
            })}
          </nav>
        </header>

        <main className="px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          {(notice || error) && (
            <div
              className={cn(
                'mb-6 flex items-start justify-between gap-4 rounded-[0.625rem] border p-4 text-sm',
                error ? 'border-destructive bg-secondary' : 'border-success bg-secondary',
              )}
              role={error ? 'alert' : 'status'}
            >
              <div className="flex items-start gap-2.5">
                {error ? (
                  <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
                ) : (
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
                )}
                <span className="text-foreground">{error ?? notice}</span>
              </div>
              <button
                type="button"
                className="shrink-0 text-xs font-semibold text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setError(undefined)
                  setNotice(undefined)
                }}
              >
                Dismiss
              </button>
            </div>
          )}

          {loading || !overview ? (
            <LoadingState />
          ) : (
            <>
              {activeView === 'overview' && (
                <OverviewView
                  overview={overview}
                  topRecommendations={topRecommendations}
                  onSelect={setSelected}
                  onNavigate={setActiveView}
                />
              )}
              {activeView === 'findings' && (
                <FindingsView
                  overview={overview}
                  recommendations={filteredRecommendations}
                  search={search}
                  category={category}
                  status={status}
                  subscriptionId={subscriptionId}
                  minimumConfidence={minimumConfidence}
                  includeExcepted={includeExcepted}
                  onSearch={setSearch}
                  onCategory={setCategory}
                  onStatus={setStatus}
                  onSubscription={setSubscriptionId}
                  onMinimumConfidence={setMinimumConfidence}
                  onIncludeExcepted={setIncludeExcepted}
                  onSelect={setSelected}
                />
              )}
              {activeView === 'actions' && (
                <ActionsView
                  actions={actions}
                  recommendations={recommendations}
                  busy={mutating}
                  onUpdateStatus={changeActionStatus}
                  onSelectRecommendation={setSelected}
                />
              )}
              {activeView === 'savings' && <SavingsView overview={overview} />}
              {activeView === 'coverage' && (
                <CoverageView
                  overview={overview}
                  scanMode={scanMode ?? overview.estate.mode}
                  onScanMode={setScanMode}
                />
              )}
            </>
          )}
        </main>
      </div>

      <RecommendationDetail
        key={selected?.id ?? 'closed'}
        recommendation={selected}
        open={Boolean(selected)}
        busy={mutating}
        onOpenChange={(open) => {
          if (!open) setSelected(undefined)
        }}
        onCreateException={addException}
        onClearException={removeException}
        onCreateAction={addAction}
      />
    </div>
  )
}

function ActionsView({
  actions,
  recommendations,
  busy,
  onUpdateStatus,
  onSelectRecommendation,
}: {
  actions: RemediationAction[]
  recommendations: Recommendation[]
  busy: boolean
  onUpdateStatus: (actionId: string, status: ActionStatus) => Promise<void>
  onSelectRecommendation: (recommendation: Recommendation) => void
}) {
  const recommendationById = new Map(
    recommendations.map((recommendation) => [recommendation.id, recommendation]),
  )

  return (
    <div className="mx-auto max-w-[1200px]">
      <PageHeading
        eyebrow="Remediation workflow"
        title="Move findings from evidence to action."
        description="Prospector tracks decisions and outcomes while keeping Azure write permissions outside the dashboard by default."
      />

      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Proposed"
          value={String(actions.filter((action) => action.status === 'proposed').length)}
          detail="awaiting review"
          icon={ClipboardCheck}
        />
        <StatCard
          label="In progress"
          value={String(
            actions.filter((action) => ['approved', 'running'].includes(action.status)).length,
          )}
          detail="approved or executing"
          icon={Wrench}
        />
        <StatCard
          label="Completed"
          value={String(actions.filter((action) => action.status === 'completed').length)}
          detail="ready for savings measurement"
          icon={CheckCircle2}
        />
      </div>

      <Card>
        <CardContent className="p-4 sm:p-5">
          {!actions.length ? (
            <div className="flex min-h-64 flex-col items-center justify-center text-center">
              <ClipboardCheck className="size-9 text-primary" aria-hidden="true" />
              <div className="mt-4 font-bold text-foreground">No remediation actions yet</div>
              <p className="mt-1 max-w-md text-sm leading-6 text-muted-foreground">
                Open a finding and create an action when the evidence has been reviewed.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {actions.map((action) => {
                const recommendation = recommendationById.get(action.recommendationId)
                return (
                  <div
                    key={action.id}
                    className="grid gap-4 rounded-xl border bg-card p-4 md:grid-cols-[minmax(0,1fr)_180px_150px] md:items-center"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-bold text-foreground">{action.title}</span>
                        <Badge variant="outline">{action.actionType}</Badge>
                      </div>
                      {recommendation && (
                        <button
                          type="button"
                          className="mt-1 block max-w-full truncate text-left text-sm font-semibold text-primary hover:underline"
                          onClick={() => onSelectRecommendation(recommendation)}
                        >
                          {recommendation.title} · {recommendation.resourceName}
                        </button>
                      )}
                      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span>Requested by {action.requestedBy}</span>
                        <span>Updated {formatDate(action.updatedAt, true)}</span>
                        {recommendation && (
                          <span>
                            {formatCurrency(
                              recommendation.estimatedMonthlySavings,
                              recommendation.currency,
                            )}{' '}
                            monthly value
                          </span>
                        )}
                      </div>
                      {action.notes && (
                        <p className="mt-2 text-sm leading-5 text-muted-foreground">
                          {action.notes}
                        </p>
                      )}
                    </div>
                    <div>
                      <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                        Status
                      </div>
                      <select
                        className="h-9 w-full rounded-[0.625rem] border bg-card px-3 text-sm font-semibold text-foreground outline-none focus:ring-2 focus:ring-ring"
                        value={action.status}
                        disabled={busy}
                        onChange={(event) =>
                          void onUpdateStatus(action.id, event.target.value as ActionStatus)
                        }
                      >
                        <option value="proposed">Proposed</option>
                        <option value="approved">Approved</option>
                        <option value="running">Running</option>
                        <option value="completed">Completed</option>
                        <option value="failed">Failed</option>
                      </select>
                    </div>
                    <div className="text-left md:text-right">
                      <div className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                        Outcome
                      </div>
                      <div className="mt-1 text-sm font-semibold text-foreground">
                        {action.completedAt
                          ? formatDate(action.completedAt)
                          : formatActionStatus(action.status)}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function OverviewView({
  overview,
  topRecommendations,
  onSelect,
  onNavigate,
}: {
  overview: OverviewResponse
  topRecommendations: Recommendation[]
  onSelect: (recommendation: Recommendation) => void
  onNavigate: (view: View) => void
}) {
  const savingsRate = overview.estate.monthlyCost
    ? (overview.savings.potentialMonthlySavings / overview.estate.monthlyCost) * 100
    : 0

  return (
    <div className="mx-auto max-w-[1500px]">
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-primary">
            <Pickaxe className="size-3.5" aria-hidden="true" />
            Estate overview
          </div>
          <h1 className="text-balance text-3xl font-bold tracking-[-0.04em] text-foreground sm:text-4xl">
            Find the gold hiding in your cloud bill.
          </h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground sm:text-base">
            One prioritized view of native Azure advice, deterministic waste checks, ownership,
            exceptions, remediation, and measured savings.
          </p>
        </div>
        <Badge variant="outline" className="gap-2 px-3 py-1.5">
          <Cloud className="size-3.5" aria-hidden="true" />
          {overview.estate.mode === 'live' ? 'Live Azure data' : 'Demo workspace'}
        </Badge>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Monthly cloud cost"
          value={formatCurrency(
            overview.estate.monthlyCost,
            overview.estate.currency,
            true,
          )}
          detail={`${overview.estate.resources.toLocaleString()} inventoried resources`}
          icon={WalletCards}
        />
        <StatCard
          label="Potential monthly savings"
          value={formatCurrency(
            overview.savings.potentialMonthlySavings,
            overview.savings.currency,
            true,
          )}
          detail={`${savingsRate.toFixed(1)}% of current run rate`}
          icon={TrendingDown}
          accent
        />
        <StatCard
          label="Verified savings"
          value={formatCurrency(
            overview.savings.realizedSavingsLast30Days,
            overview.savings.currency,
            true,
          )}
          detail={`${overview.savings.verifiedMeasurementCount} verified cost periods`}
          icon={CircleDollarSign}
        />
        <StatCard
          label="Open findings"
          value={overview.openRecommendations.toLocaleString()}
          detail={`${overview.highConfidenceRecommendations} high-confidence · ${overview.unownedRecommendations} unowned`}
          icon={Target}
        />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1.65fr)_minmax(320px,0.75fr)]">
        <Card>
          <CardContent className="p-5 sm:p-6">
            <CostTrendChart
              points={overview.costTrend}
              currency={overview.estate.currency}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center justify-between gap-3 text-base">
              Opportunity seams
              <Sparkles className="size-4 text-primary" aria-hidden="true" />
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {overview.categories
              .filter((item) => item.estimatedMonthlySavings > 0)
              .sort(
                (left, right) =>
                  right.estimatedMonthlySavings - left.estimatedMonthlySavings,
              )
              .slice(0, 6)
              .map((item) => (
                <div
                  key={item.category}
                  className="flex items-center justify-between gap-4 rounded-[0.625rem] border bg-secondary px-3 py-2.5"
                >
                  <div>
                    <div className="text-sm font-semibold text-foreground">
                      {formatCategory(item.category)}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {item.recommendations} findings
                    </div>
                  </div>
                  <div className="text-right text-sm font-bold text-foreground">
                    {formatCurrency(
                      item.estimatedMonthlySavings,
                      overview.estate.currency,
                      true,
                    )}
                    <div className="text-[10px] font-normal text-muted-foreground">monthly</div>
                  </div>
                </div>
              ))}
          </CardContent>
        </Card>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1.65fr)_minmax(320px,0.75fr)]">
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
            <div>
              <CardTitle className="text-base">Best next moves</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                Ranked by monthly value and confidence.
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => onNavigate('findings')}>
              View all
            </Button>
          </CardHeader>
          <CardContent>
            <RecommendationTable
              recommendations={topRecommendations}
              onSelect={onSelect}
              compact
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Signal coverage</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Confidence is capped when Azure telemetry is unavailable.
            </p>
          </CardHeader>
          <CardContent>
            <CoveragePanel coverage={overview.coverage.slice(0, 5)} />
            <Button
              variant="outline"
              className="mt-5 w-full"
              onClick={() => onNavigate('coverage')}
            >
              Inspect coverage
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function FindingsView({
  overview,
  recommendations,
  search,
  category,
  status,
  subscriptionId,
  minimumConfidence,
  includeExcepted,
  onSearch,
  onCategory,
  onStatus,
  onSubscription,
  onMinimumConfidence,
  onIncludeExcepted,
  onSelect,
}: {
  overview: OverviewResponse
  recommendations: Recommendation[]
  search: string
  category: RecommendationCategory | 'all'
  status: StatusFilter
  subscriptionId: string
  minimumConfidence: number
  includeExcepted: boolean
  onSearch: (value: string) => void
  onCategory: (value: RecommendationCategory | 'all') => void
  onStatus: (value: StatusFilter) => void
  onSubscription: (value: string) => void
  onMinimumConfidence: (value: number) => void
  onIncludeExcepted: (value: boolean) => void
  onSelect: (recommendation: Recommendation) => void
}) {
  const totalValue = recommendations.reduce(
    (sum, recommendation) => sum + recommendation.estimatedMonthlySavings,
    0,
  )

  return (
    <div className="mx-auto max-w-[1500px]">
      <PageHeading
        eyebrow="Recommendation inventory"
        title="Every finding, with the evidence attached."
        description="Filter by scope, confidence, status, and ownership before deciding what deserves action."
      />

      <Card>
        <CardContent className="p-4 sm:p-5">
          <div className="grid gap-3 lg:grid-cols-[minmax(220px,1fr)_repeat(4,minmax(140px,0.45fr))]">
            <label className="relative">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <input
                className="h-10 w-full rounded-[0.625rem] border bg-card pl-9 pr-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
                placeholder="Search findings or resources"
                value={search}
                onChange={(event) => onSearch(event.target.value)}
              />
            </label>
            <FilterSelect
              label="Category"
              value={category}
              onChange={(value) => onCategory(value as RecommendationCategory | 'all')}
            >
              <option value="all">All categories</option>
              {recommendationCategories.map((item) => (
                <option key={item} value={item}>
                  {formatCategory(item)}
                </option>
              ))}
            </FilterSelect>
            <FilterSelect
              label="Status"
              value={status}
              onChange={(value) => onStatus(value as StatusFilter)}
            >
              <option value="active">Active</option>
              <option value="all">All statuses</option>
              {recommendationStatuses.map((item) => (
                <option key={item} value={item}>
                  {formatStatus(item)}
                </option>
              ))}
            </FilterSelect>
            <FilterSelect
              label="Subscription"
              value={subscriptionId}
              onChange={onSubscription}
            >
              <option value="all">All subscriptions</option>
              {overview.subscriptions.map((subscription) => (
                <option key={subscription.id} value={subscription.id}>
                  {subscription.name}
                </option>
              ))}
            </FilterSelect>
            <FilterSelect
              label="Confidence"
              value={String(minimumConfidence)}
              onChange={(value) => onMinimumConfidence(Number(value))}
            >
              <option value="0">Any confidence</option>
              <option value="0.55">55% and above</option>
              <option value="0.8">80% and above</option>
              <option value="0.9">90% and above</option>
            </FilterSelect>
          </div>
          <label className="mt-4 flex w-fit cursor-pointer items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              className="size-4 accent-[var(--cp-accent)]"
              checked={includeExcepted}
              onChange={(event) => onIncludeExcepted(event.target.checked)}
            />
            Include excepted findings
          </label>
        </CardContent>
      </Card>

      <div className="my-4 flex flex-wrap items-center justify-between gap-3 text-sm">
        <span className="text-muted-foreground">
          <strong className="text-foreground">{recommendations.length}</strong> findings
        </span>
        <span className="font-semibold text-foreground">
          {formatCurrency(totalValue, overview.estate.currency)} potential monthly value
        </span>
      </div>

      <Card>
        <CardContent className="p-2 sm:p-4">
          <RecommendationTable recommendations={recommendations} onSelect={onSelect} />
        </CardContent>
      </Card>
    </div>
  )
}

function SavingsView({ overview }: { overview: OverviewResponse }) {
  return (
    <div className="mx-auto max-w-[1500px]">
      <PageHeading
        eyebrow="Value tracking"
        title="Separate plausible savings from proven savings."
        description="Potential value is an undiscounted estimate; confidence remains visible and drives prioritization. Realized value is measured against stored cost baselines after remediation."
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Annualized opportunity"
          value={formatCurrency(
            overview.savings.annualizedPotentialSavings,
            overview.savings.currency,
            true,
          )}
          detail="if current findings are implemented"
          icon={Gem}
          accent
        />
        <StatCard
          label="Realized, last 30 days"
          value={formatCurrency(
            overview.savings.realizedSavingsLast30Days,
            overview.savings.currency,
            true,
          )}
          detail="measured against approved baselines"
          icon={CircleDollarSign}
        />
        <StatCard
          label="Realized, all time"
          value={formatCurrency(
            overview.savings.realizedSavingsAllTime,
            overview.savings.currency,
            true,
          )}
          detail="cumulative verified value"
          icon={BarChart3}
        />
        <StatCard
          label="Verified cost periods"
          value={String(overview.savings.verifiedMeasurementCount)}
          detail={`${Math.round(overview.savings.measurementCoverage)}% of stored periods`}
          icon={Gauge}
        />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(360px,0.8fr)]">
        <Card>
          <CardContent className="p-5 sm:p-6">
            <CostTrendChart
              points={overview.costTrend}
              currency={overview.estate.currency}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Savings by subscription</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {[...overview.subscriptions]
              .sort(
                (left, right) =>
                  right.potentialMonthlySavings - left.potentialMonthlySavings,
              )
              .map((subscription) => (
                <div key={subscription.id} className="rounded-[0.625rem] border p-3">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="text-sm font-semibold text-foreground">
                        {subscription.name}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {subscription.openRecommendations} open findings
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-bold text-foreground">
                        {formatCurrency(
                          subscription.potentialMonthlySavings,
                          subscription.currency,
                          true,
                        )}
                      </div>
                      <div className="text-[10px] text-muted-foreground">monthly</div>
                    </div>
                  </div>
                  <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-secondary">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{
                        width: `${Math.min(
                          100,
                          subscription.monthlyCost
                            ? (subscription.potentialMonthlySavings /
                                subscription.monthlyCost) *
                                100
                            : 0,
                        )}%`,
                      }}
                    />
                  </div>
                </div>
              ))}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function CoverageView({
  overview,
  scanMode,
  onScanMode,
}: {
  overview: OverviewResponse
  scanMode: ScanMode
  onScanMode: (mode: ScanMode) => void
}) {
  return (
    <div className="mx-auto max-w-[1200px]">
      <PageHeading
        eyebrow="Trust and setup"
        title="Know what Prospector can see—and what it cannot."
        description="Every recommendation carries a confidence score informed by the available inventory, billing, utilization, ownership, and commitment data."
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Data coverage</CardTitle>
          </CardHeader>
          <CardContent>
            <CoveragePanel coverage={overview.coverage} />
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Connection mode</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-2">
                {(['demo', 'live'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={cn(
                      'rounded-[0.625rem] border px-4 py-3 text-left transition-colors',
                      scanMode === mode
                        ? 'border-primary bg-accent text-accent-foreground'
                        : 'bg-card text-foreground hover:bg-secondary',
                    )}
                    onClick={() => onScanMode(mode)}
                  >
                    <div className="text-sm font-bold capitalize">{mode}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {mode === 'demo' ? 'Safe seeded workspace' : 'Read-only Azure APIs'}
                    </div>
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Live onboarding</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <SetupStep
                number="1"
                title="Authenticate"
                description="Use Azure CLI locally, workload identity in CI, or managed identity when hosted."
                code="az login"
              />
              <SetupStep
                number="2"
                title="Grant read access"
                description="Reader, Cost Management Reader, and Monitoring Reader at the intended management-group or subscription scopes."
              />
              <SetupStep
                number="3"
                title="Run a live scan"
                description="Set the tenant and auth mode, then select Live Azure in the header."
                code="AZURE_TENANT_ID=<tenant-id>"
              />
              <div className="rounded-[0.625rem] border bg-secondary p-3 text-xs leading-5 text-muted-foreground">
                Billing benefits and reservation utilization may require additional billing-scope
                read roles. Guest memory and stale-blob confidence improve only when those telemetry
                sources are already enabled.
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

function PageHeading({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string
  title: string
  description: string
}) {
  return (
    <div className="mb-7">
      <div className="mb-2 text-xs font-bold uppercase tracking-[0.14em] text-primary">
        {eyebrow}
      </div>
      <h1 className="text-balance text-3xl font-bold tracking-[-0.04em] text-foreground">
        {title}
      </h1>
      <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p>
    </div>
  )
}

function FilterSelect({
  label,
  value,
  onChange,
  children,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  children: ReactNode
}) {
  return (
    <label>
      <span className="sr-only">{label}</span>
      <select
        aria-label={label}
        className="h-10 w-full rounded-[0.625rem] border bg-card px-3 text-sm font-semibold text-foreground outline-none focus:ring-2 focus:ring-ring"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {children}
      </select>
    </label>
  )
}

function SetupStep({
  number,
  title,
  description,
  code,
}: {
  number: string
  title: string
  description: string
  code?: string
}) {
  return (
    <div className="flex gap-3">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
        {number}
      </span>
      <div>
        <div className="text-sm font-bold text-foreground">{title}</div>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
        {code && (
          <code className="mt-2 inline-flex rounded-md border bg-secondary px-2 py-1 text-xs text-foreground">
            {code}
          </code>
        )}
      </div>
    </div>
  )
}

function LoadingState() {
  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center text-center">
      <div className="flex size-14 items-center justify-center rounded-xl bg-accent text-accent-foreground">
        <RefreshCw className="size-6 animate-spin" aria-hidden="true" />
      </div>
      <div className="mt-4 text-lg font-bold text-foreground">Surveying the estate</div>
      <p className="mt-2 text-sm text-muted-foreground">
        Loading cost, telemetry, ownership, and recommendation data.
      </p>
    </div>
  )
}

function messageFromError(error: unknown) {
  return error instanceof Error ? error.message : 'An unexpected error occurred.'
}

export default App
