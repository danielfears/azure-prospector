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
  LogIn,
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
import { ScanProgress } from '@/components/scan-progress'
import { StatCard } from '@/components/stat-card'
import { SubscriptionPicker } from '@/components/subscription-picker'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  createAction,
  createException,
  clearException,
  getActions,
  getAuthStatus,
  getAzureSubscriptions,
  getOverview,
  getRecommendations,
  signInWithBrowser,
  startScan,
  updateActionStatus,
} from '@/lib/api'
import {
  formatCategory,
  formatActionStatus,
  formatCurrency,
  formatCurrencyAmounts,
  formatDate,
  formatStatus,
} from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  recommendationCategories,
  recommendationStatuses,
  type ActionStatus,
  type AuthStatusResponse,
  type AzureSubscriptionOption,
  type CreateActionRequest,
  type CreateExceptionRequest,
  type MonetaryAmount,
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

function amountsByCurrency(
  recommendations: Recommendation[],
): MonetaryAmount[] {
  return [
    ...recommendations
      .reduce((totals, recommendation) => {
        totals.set(
          recommendation.currency,
          (totals.get(recommendation.currency) ?? 0) +
            recommendation.estimatedMonthlySavings,
        )
        return totals
      }, new Map<string, number>())
      .entries(),
  ].map(([currency, amount]) => ({ currency, amount }))
}

function recommendationsByNativeValue(
  recommendations: Recommendation[],
  limit: number,
): Recommendation[] {
  const byCurrency = new Map<string, Recommendation[]>()
  for (const recommendation of recommendations) {
    const group = byCurrency.get(recommendation.currency) ?? []
    group.push(recommendation)
    byCurrency.set(recommendation.currency, group)
  }
  const groups = [...byCurrency.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, items]) =>
      items.sort(
        (left, right) =>
          right.estimatedMonthlySavings * right.confidence -
          left.estimatedMonthlySavings * left.confidence,
      ),
    )
  const ranked: Recommendation[] = []
  for (let index = 0; ranked.length < limit; index += 1) {
    let added = false
    for (const group of groups) {
      const recommendation = group[index]
      if (!recommendation) continue
      ranked.push(recommendation)
      added = true
      if (ranked.length === limit) break
    }
    if (!added) break
  }
  return ranked
}

function App() {
  const [overview, setOverview] = useState<OverviewResponse>()
  const [recommendations, setRecommendations] = useState<Recommendation[]>([])
  const [actions, setActions] = useState<RemediationAction[]>([])
  const [selected, setSelected] = useState<Recommendation>()
  const [activeView, setActiveView] = useState<View>('overview')
  const [authentication, setAuthentication] = useState<AuthStatusResponse>()
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState<ScanMode>()
  const [connecting, setConnecting] = useState(false)
  const [loadingSubscriptions, setLoadingSubscriptions] = useState(false)
  const [subscriptionPickerOpen, setSubscriptionPickerOpen] =
    useState(false)
  const [subscriptionOptions, setSubscriptionOptions] = useState<
    AzureSubscriptionOption[]
  >([])
  const [selectedSubscriptionIds, setSelectedSubscriptionIds] = useState<
    string[]
  >([])
  const [subscriptionSearch, setSubscriptionSearch] = useState('')
  const [assessmentName, setAssessmentName] = useState('')
  const [activeAssessment, setActiveAssessment] = useState<{
    name: string
    subscriptionCount: number
  }>()
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
    const [nextOverview, nextRecommendations, nextActions] =
      await loadDashboardData()
    setOverview(nextOverview)
    setRecommendations(nextRecommendations)
    setActions(nextActions)
    if (selectedId) {
      setSelected(nextRecommendations.find((item) => item.id === selectedId))
    }
    setError(undefined)
    void getAuthStatus().then(setAuthentication).catch(() => undefined)
  }

  useEffect(() => {
    let active = true
    void loadDashboardData()
      .then(([nextOverview, nextRecommendations, nextActions]) => {
        if (!active) return
        setOverview(nextOverview)
        setRecommendations(nextRecommendations)
        setActions(nextActions)
      })
      .catch((requestError: unknown) => {
        if (active) setError(messageFromError(requestError))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    void getAuthStatus()
      .then((nextAuthentication) => {
        if (active) setAuthentication(nextAuthentication)
      })
      .catch((requestError: unknown) => {
        if (!active) return
        setAuthentication({
          authenticated: false,
          source: 'none',
          browserLoginAvailable: true,
          message: messageFromError(requestError),
        })
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
      recommendationsByNativeValue(
        recommendations.filter(
          (recommendation) =>
            ['open', 'accepted', 'in_progress'].includes(
              recommendation.status,
            ) && !recommendation.exception,
        ),
        6,
      ),
    [recommendations],
  )

  async function connectAzure(showConnectedNotice = true): Promise<boolean> {
    setConnecting(true)
    setNotice(undefined)
    setError(undefined)
    try {
      const status = await getAuthStatus()
      setAuthentication(status)
      if (status.authenticated) {
        if (showConnectedNotice) setNotice(status.message)
        return true
      }
      if (status.browserLoginAvailable) {
        const browserStatus = await signInWithBrowser()
        setAuthentication(browserStatus)
        if (browserStatus.authenticated) {
          if (showConnectedNotice) setNotice(browserStatus.message)
          return true
        }
        setError(browserStatus.message)
        return false
      }
      setError(status.message)
      return false
    } catch (connectionError) {
      setError(messageFromError(connectionError))
      return false
    } finally {
      setConnecting(false)
    }
  }

  async function openAssessment() {
    setNotice(undefined)
    setError(undefined)
    if (!(await connectAzure(false))) return
    setLoadingSubscriptions(true)
    try {
      const subscriptions = await getAzureSubscriptions()
      setSubscriptionOptions(subscriptions)
      setSelectedSubscriptionIds([])
      setSubscriptionSearch('')
      setAssessmentName('')
      setSubscriptionPickerOpen(true)
    } catch (subscriptionError) {
      setError(messageFromError(subscriptionError))
    } finally {
      setLoadingSubscriptions(false)
    }
  }

  async function runScan(name: string, subscriptionIds: string[]) {
    const normalizedName = name.trim()
    setSubscriptionPickerOpen(false)
    setActiveAssessment({
      name: normalizedName,
      subscriptionCount: subscriptionIds.length,
    })
    setScanning('live')
    try {
      const scan = await startScan({
        mode: 'live',
        assessmentName: normalizedName,
        subscriptionIds,
      })
      await refresh()
      resetWorkspaceView()
      setNotice(
        `Assessment completed: ${scan.recommendationsFound} findings across ${
          scan.subscriptionsDiscovered
        } ${
          scan.subscriptionsDiscovered === 1
            ? 'subscription'
            : 'subscriptions'
        }${
          scan.warningCount
            ? `, with ${scan.warningCount} coverage ${
                scan.warningCount === 1 ? 'warning' : 'warnings'
              }.`
            : '.'
        }`,
      )
    } catch (scanError) {
      setError(messageFromError(scanError))
    } finally {
      setScanning(undefined)
      setActiveAssessment(undefined)
    }
  }

  async function runDemo() {
    setNotice(undefined)
    setError(undefined)
    setScanning('demo')
    try {
      const scan = await startScan({
        mode: 'demo',
        assessmentName: 'Sample workspace',
      })
      await refresh()
      resetWorkspaceView()
      setNotice(
        `Sample workspace loaded with ${scan.recommendationsFound} representative findings.`,
      )
    } catch (scanError) {
      setError(messageFromError(scanError))
    } finally {
      setScanning(undefined)
    }
  }

  async function retryDashboard() {
    setLoading(true)
    setError(undefined)
    try {
      await refresh()
    } catch (requestError) {
      setError(messageFromError(requestError))
    } finally {
      setLoading(false)
    }
  }

  function toggleTheme() {
    const nextTheme = theme === 'dark' ? 'light' : 'dark'
    document.documentElement.setAttribute('data-theme', nextTheme)
    setTheme(nextTheme)
  }

  function resetWorkspaceView() {
    setActiveView('overview')
    setSelected(undefined)
    setSearch('')
    setCategory('all')
    setStatus('active')
    setSubscriptionId('all')
    setMinimumConfidence(0)
    setIncludeExcepted(false)
  }

  const connectionLabel = !authentication
    ? 'Checking Azure'
    : authentication.authenticated
      ? authentication.source === 'azure_cli'
        ? 'CLI connected'
        : 'Azure connected'
      : 'Connect Azure'
  const hasAssessment = Boolean(overview?.estate.lastScanAt)

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

        {hasAssessment && (
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
        )}

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
                {hasAssessment
                  ? overview?.estate.assessmentName ??
                    overview?.estate.tenantName ??
                    'Azure estate'
                  : 'Azure Prospector'}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {hasAssessment && overview
                  ? `${overview.estate.subscriptions} ${
                      overview.estate.subscriptions === 1
                        ? 'subscription'
                        : 'subscriptions'
                    } · last scan ${formatDate(
                      overview.estate.lastScanAt,
                      true,
                    )}`
                  : 'Ready for a new cost assessment'}
              </div>
            </div>
            {overview?.estate.lastScanAt && (
              <Badge variant="outline" className="hidden sm:inline-flex">
                {overview.estate.mode === 'demo' ? 'Sample data' : 'Live data'}
              </Badge>
            )}
            {authentication?.authenticated ? (
              <Badge
                variant="outline"
                className="hidden gap-2 px-3 py-2 sm:inline-flex"
                title={authentication.message}
              >
                <Cloud aria-hidden="true" />
                {connectionLabel}
              </Badge>
            ) : (
              <Button
                disabled={connecting || loadingSubscriptions}
                title={authentication?.message}
                onClick={() => void connectAzure()}
              >
                {connecting ? (
                  <LoaderCircle className="animate-spin" aria-hidden="true" />
                ) : (
                  <LogIn aria-hidden="true" />
                )}
                <span className="hidden md:inline">{connectionLabel}</span>
              </Button>
            )}
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
            {hasAssessment && (
              <Button
                disabled={Boolean(scanning) || loadingSubscriptions}
                onClick={() => void openAssessment()}
              >
                {scanning === 'live' || loadingSubscriptions ? (
                  <LoaderCircle className="animate-spin" aria-hidden="true" />
                ) : (
                  <Play aria-hidden="true" />
                )}
                <span className="hidden sm:inline">
                  {scanning === 'live'
                    ? 'Scanning'
                    : loadingSubscriptions
                      ? 'Loading scope'
                      : overview?.estate.mode === 'demo'
                        ? 'Start live assessment'
                        : 'New assessment'}
                </span>
              </Button>
            )}
          </div>

          {hasAssessment && (
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
          )}
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

          {loading ? (
            <LoadingState />
          ) : !overview ? (
            <DashboardUnavailable
              busy={Boolean(scanning)}
              onRetry={() => void retryDashboard()}
              onDemo={() => void runDemo()}
            />
          ) : !overview.estate.lastScanAt ? (
            <WelcomeView
              authentication={authentication}
              connecting={connecting || loadingSubscriptions}
              scanning={scanning}
              onConnect={() => void connectAzure()}
              onLiveScan={() => void openAssessment()}
              onDemo={() => void runDemo()}
            />
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
                  authentication={authentication}
                  connecting={connecting}
                  onConnect={() => void connectAzure()}
                />
              )}
            </>
          )}
        </main>
      </div>

      <SubscriptionPicker
        open={subscriptionPickerOpen}
        subscriptions={subscriptionOptions}
        selectedIds={selectedSubscriptionIds}
        search={subscriptionSearch}
        assessmentName={assessmentName}
        busy={Boolean(scanning)}
        onOpenChange={setSubscriptionPickerOpen}
        onSelectedIdsChange={setSelectedSubscriptionIds}
        onSearchChange={setSubscriptionSearch}
        onAssessmentNameChange={setAssessmentName}
        onSubmit={() =>
          void runScan(assessmentName, selectedSubscriptionIds)
        }
      />

      {scanning === 'live' && activeAssessment && (
        <ScanProgress
          assessmentName={activeAssessment.name}
          subscriptionCount={activeAssessment.subscriptionCount}
        />
      )}

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

function WelcomeView({
  authentication,
  connecting,
  scanning,
  onConnect,
  onLiveScan,
  onDemo,
}: {
  authentication?: AuthStatusResponse
  connecting: boolean
  scanning?: ScanMode
  onConnect: () => void
  onLiveScan: () => void
  onDemo: () => void
}) {
  const connected = authentication?.authenticated
  return (
    <div className="mx-auto flex min-h-[72vh] max-w-[1100px] items-center">
      <div className="w-full">
        <div className="mx-auto max-w-3xl text-center">
          <div className="mx-auto flex size-14 items-center justify-center rounded-xl bg-accent text-accent-foreground">
            <Pickaxe className="size-7" aria-hidden="true" />
          </div>
          <div className="mt-6 text-xs font-bold uppercase tracking-[0.16em] text-primary">
            Azure cost intelligence
          </div>
          <h1 className="mt-3 text-balance text-4xl font-bold tracking-[-0.05em] text-foreground sm:text-5xl">
            Find the gold hiding in your cloud bill.
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
            Run a focused assessment across the subscriptions you choose and
            surface evidence-backed savings opportunities.
          </p>
        </div>

        <div className="mt-10 grid gap-5 md:grid-cols-[minmax(0,1.25fr)_minmax(280px,0.75fr)]">
          <Card className="border-primary">
            <CardContent className="p-6 sm:p-7">
              <div className="flex items-start gap-4">
                <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-foreground">
                  <Cloud className="size-5" aria-hidden="true" />
                </span>
                <div>
                  <h2 className="text-lg font-bold text-foreground">
                    {connected
                      ? 'Choose subscriptions to assess'
                      : 'Connect your Azure estate'}
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">
                    {connected
                      ? `${authentication.message} Start a named assessment by choosing its project subscriptions.`
                      : authentication?.message ??
                        'Checking your current Azure CLI session.'}
                  </p>
                  <Button
                    className="mt-5"
                    disabled={connecting || Boolean(scanning)}
                    onClick={connected ? onLiveScan : onConnect}
                  >
                    {connecting || scanning === 'live' ? (
                      <LoaderCircle
                        className="animate-spin"
                        aria-hidden="true"
                      />
                    ) : connected ? (
                      <Play aria-hidden="true" />
                    ) : (
                      <LogIn aria-hidden="true" />
                    )}
                    {scanning === 'live'
                      ? 'Scanning Azure'
                      : connected
                        ? 'Choose subscriptions'
                        : 'Connect Azure'}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6 sm:p-7">
              <Sparkles className="size-5 text-primary" aria-hidden="true" />
              <h2 className="mt-4 text-base font-bold text-foreground">
                Explore sample data
              </h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                Load a clearly labelled demonstration workspace without
                connecting to Azure.
              </p>
              <Button
                className="mt-5"
                variant="outline"
                disabled={Boolean(scanning)}
                onClick={onDemo}
              >
                {scanning === 'demo' ? (
                  <LoaderCircle className="animate-spin" aria-hidden="true" />
                ) : (
                  <Sparkles aria-hidden="true" />
                )}
                {scanning === 'demo' ? 'Loading sample' : 'Explore demo'}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
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
  const savingsRates = overview.savings.byCurrency
    .filter((summary) => summary.monthlyCost > 0)
    .map(
      (summary) =>
        `${(
          (summary.potentialMonthlySavings / summary.monthlyCost) *
          100
        ).toFixed(1)}% ${summary.currency}`,
    )
    .join(' · ')
  const monthlyCosts = overview.savings.byCurrency
    .map((summary) => ({
      currency: summary.currency,
      amount: summary.monthlyCost,
    }))
    .filter((amount) => amount.amount !== 0)
  const potentialSavings = overview.savings.byCurrency.map((summary) => ({
    currency: summary.currency,
    amount: summary.potentialMonthlySavings,
  }))
  const verifiedSavings = overview.savings.byCurrency
    .filter((summary) => summary.costTrend.length > 0)
    .map((summary) => ({
      currency: summary.currency,
      amount: summary.realizedSavingsLast30Days,
    }))

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
          label="Median monthly cloud cost"
          value={formatCurrencyAmounts(monthlyCosts, true)}
          detail={`${overview.estate.resources.toLocaleString()} inventoried resources`}
          icon={WalletCards}
        />
        <StatCard
          label="Potential monthly savings"
          value={formatCurrencyAmounts(potentialSavings, true)}
          detail={savingsRates || 'No comparable run rate'}
          icon={TrendingDown}
          accent
        />
        <StatCard
          label="Verified savings"
          value={formatCurrencyAmounts(verifiedSavings, true)}
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
            <div className="space-y-8">
              {overview.savings.byCurrency
                .filter((summary) => summary.costTrend.length > 0)
                .map((summary) => (
                  <CostTrendChart
                    key={summary.currency}
                    points={summary.costTrend}
                    currency={summary.currency}
                  />
                ))}
            </div>
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
              .filter((item) =>
                item.estimatedMonthlySavings.some(
                  (amount) => amount.amount > 0,
                ),
              )
              .sort(
                (left, right) =>
                  right.recommendations - left.recommendations,
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
                    {formatCurrencyAmounts(
                      item.estimatedMonthlySavings,
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
                Ranked within each native billing currency.
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
  const totalValue = amountsByCurrency(recommendations)

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
          {formatCurrencyAmounts(totalValue)} potential monthly value
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
  const annualized = overview.savings.byCurrency.map((summary) => ({
    currency: summary.currency,
    amount: summary.annualizedPotentialSavings,
  }))
  const realizedLast30Days = overview.savings.byCurrency.map((summary) => ({
    currency: summary.currency,
    amount: summary.realizedSavingsLast30Days,
  }))
  const realizedAllTime = overview.savings.byCurrency.map((summary) => ({
    currency: summary.currency,
    amount: summary.realizedSavingsAllTime,
  }))
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
          value={formatCurrencyAmounts(annualized, true)}
          detail="if current findings are implemented"
          icon={Gem}
          accent
        />
        <StatCard
          label="Realized, last 30 days"
          value={formatCurrencyAmounts(realizedLast30Days, true)}
          detail="measured against approved baselines"
          icon={CircleDollarSign}
        />
        <StatCard
          label="Realized, all time"
          value={formatCurrencyAmounts(realizedAllTime, true)}
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
            <div className="space-y-8">
              {overview.savings.byCurrency
                .filter((summary) => summary.costTrend.length > 0)
                .map((summary) => (
                  <CostTrendChart
                    key={summary.currency}
                    points={summary.costTrend}
                    currency={summary.currency}
                  />
                ))}
            </div>
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
                  left.currency.localeCompare(right.currency) ||
                  right.potentialMonthlySavings -
                    left.potentialMonthlySavings,
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
  authentication,
  connecting,
  onConnect,
}: {
  overview: OverviewResponse
  authentication?: AuthStatusResponse
  connecting: boolean
  onConnect: () => void
}) {
  const latestScan = overview.recentScans[0]
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
          {latestScan?.warnings.length ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  Assessment warnings
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2 text-xs leading-5 text-muted-foreground">
                  {latestScan.warnings.map((warning) => (
                    <li
                      key={warning}
                      className="rounded-[0.625rem] border bg-secondary p-3"
                    >
                      {warning}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Azure connection</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-start gap-3">
                <span
                  className={cn(
                    'mt-1.5 size-2.5 shrink-0 rounded-full',
                    authentication?.authenticated
                      ? 'bg-success'
                      : 'bg-muted-foreground',
                  )}
                />
                <div className="min-w-0">
                  <div className="text-sm font-bold text-foreground">
                    {authentication?.authenticated
                      ? authentication.source === 'azure_cli'
                        ? 'Azure CLI connected'
                        : 'Microsoft account connected'
                      : 'Not connected'}
                  </div>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {authentication?.message ??
                      'Checking the current Azure CLI session.'}
                  </p>
                </div>
              </div>
              {!authentication?.authenticated && (
                <Button disabled={connecting} onClick={onConnect}>
                  {connecting ? (
                    <LoaderCircle className="animate-spin" aria-hidden="true" />
                  ) : (
                    <LogIn aria-hidden="true" />
                  )}
                  Connect Azure
                </Button>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Live onboarding</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <SetupStep
                number="1"
                title="Connect Azure CLI"
                description="Prospector checks your current Azure CLI session automatically and uses it when valid."
                code="az login --use-device-code --allow-no-subscriptions"
              />
              <SetupStep
                number="2"
                title="Browser fallback"
                description={
                  authentication?.browserLoginAvailable
                    ? 'If Azure CLI is unavailable, Connect Azure uses the supported Azure Identity browser flow with PKCE.'
                    : 'Browser sign-in is disabled for this installation.'
                }
              />
              <SetupStep
                number="3"
                title="Grant read access"
                description="Reader, Cost Management Reader, and Monitoring Reader at the intended management-group or subscription scopes."
              />
              <SetupStep
                number="4"
                title="Start an assessment"
                description="Use New assessment in the header, then choose the project subscriptions. Prospector never requests Azure write permissions."
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

function DashboardUnavailable({
  busy,
  onRetry,
  onDemo,
}: {
  busy: boolean
  onRetry: () => void
  onDemo: () => void
}) {
  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center text-center">
      <div className="flex size-14 items-center justify-center rounded-xl bg-secondary text-destructive">
        <AlertCircle className="size-6" aria-hidden="true" />
      </div>
      <div className="mt-4 text-lg font-bold text-foreground">
        Dashboard data is unavailable
      </div>
      <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
        Retry the local data service, or open the sample workspace while Azure
        remains untouched.
      </p>
      <div className="mt-5 flex gap-2">
        <Button disabled={busy} onClick={onRetry}>
          <RefreshCw aria-hidden="true" />
          Retry
        </Button>
        <Button variant="outline" disabled={busy} onClick={onDemo}>
          <Sparkles aria-hidden="true" />
          Explore demo
        </Button>
      </div>
    </div>
  )
}

function messageFromError(error: unknown) {
  return error instanceof Error ? error.message : 'An unexpected error occurred.'
}

export default App
