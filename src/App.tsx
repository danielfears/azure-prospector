import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  AlertCircle,
  ArrowLeft,
  BarChart3,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  CircleDollarSign,
  Cloud,
  Coins,
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
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Sun,
  TrendingDown,
  UserRound,
  WalletCards,
  Wrench,
} from 'lucide-react'

import { BrandMark } from '@/components/brand-mark'
import { AssessmentCollection } from '@/components/assessment-collection'
import { AssessmentExportMenu } from '@/components/assessment-export-menu'
import { CostTrendChart } from '@/components/cost-trend-chart'
import { CoveragePanel } from '@/components/coverage-panel'
import { RecommendationDetail } from '@/components/recommendation-detail'
import { RecommendationTable } from '@/components/recommendation-table'
import { ScanProgress } from '@/components/scan-progress'
import { SavingsActivityPanel } from '@/components/savings-activity-panel'
import { StatCard } from '@/components/stat-card'
import { SubscriptionPicker } from '@/components/subscription-picker'
import { SubscriptionComparison } from '@/components/subscription-comparison'
import { TrustScopeStrip } from '@/components/trust-scope-strip'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  createAction,
  createException,
  clearException,
  deleteAssessmentWorkspace,
  getActions,
  getAssessments,
  getAuthStatus,
  getAzureSubscriptions,
  getOverview,
  getRecommendations,
  openAssessmentWorkspace,
  signInWithBrowser,
  startScan,
  updateActionStatus,
} from '@/lib/api'
import {
  formatCategory,
  formatActivity,
  formatActionStatus,
  formatCurrency,
  formatCurrencyAmounts,
  formatDate,
  formatStatus,
} from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  evidenceFreshness,
  findingReadiness,
  hasCurrencyMismatch,
} from '@/components/finding-readiness'
import {
  azureEstimatedOpportunityAmountsByCurrency,
  calculatedScheduleAmountsByCurrency,
  roundRobinByNativeCurrency,
  selectAzureEstimatedOpportunities,
  selectCalculatedScheduleScenarios,
  selectCanonicalOpportunityRecommendations,
} from '@/components/opportunity-aggregation'
import {
  recommendationCategories,
  recommendationStatuses,
  savingsActivities,
  type ActionStatus,
  type AssessmentSummary,
  type AuthStatusResponse,
  type AzureSubscriptionOption,
  type CreateActionRequest,
  type CreateExceptionRequest,
  type CostTrendPoint,
  type OverviewResponse,
  type Recommendation,
  type RecommendationCategory,
  type RecommendationStatus,
  type RemediationAction,
  type SavingsActivity,
  type ScanMode,
} from '@/shared/types'

type View = 'overview' | 'findings' | 'actions' | 'savings' | 'coverage'
type StatusFilter = RecommendationStatus | 'active' | 'all'
type QuickFindingView =
  | 'all'
  | 'ready'
  | 'validation'
  | 'unowned'
  | 'currency-mismatch'
type FindingSort = 'priority' | 'monthly' | 'confidence' | 'freshness'
type DashboardRoute =
  | { kind: 'home' }
  | { kind: 'assessment'; assessmentId: string; view: View }
  | { kind: 'subscription'; assessmentId: string; subscriptionId: string }
  | { kind: 'resource'; assessmentId: string; resourceKey: string }
  | { kind: 'finding'; assessmentId: string; recommendationId: string }

const navigation: Array<{
  id: View
  label: string
  icon: typeof LayoutDashboard
}> = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'findings', label: 'Findings', icon: ListChecks },
  { id: 'actions', label: 'Actions', icon: ClipboardCheck },
  { id: 'savings', label: 'Outcomes', icon: Coins },
  { id: 'coverage', label: 'Coverage', icon: ShieldCheck },
]

const validViews = new Set<View>([
  'overview',
  'findings',
  'actions',
  'savings',
  'coverage',
])

function readDashboardRoute(): DashboardRoute {
  const params = new URLSearchParams(window.location.search)
  const assessmentId = params.get('assessment')
  if (!assessmentId) return { kind: 'home' }

  const recommendationId = params.get('finding')
  if (recommendationId) {
    return { kind: 'finding', assessmentId, recommendationId }
  }
  const resourceKey = params.get('resource')
  if (resourceKey) return { kind: 'resource', assessmentId, resourceKey }
  const subscriptionId = params.get('subscription')
  if (subscriptionId) {
    return { kind: 'subscription', assessmentId, subscriptionId }
  }
  const requestedView = params.get('view') as View | null
  return {
    kind: 'assessment',
    assessmentId,
    view: requestedView && validViews.has(requestedView) ? requestedView : 'overview',
  }
}

function routeUrl(route: DashboardRoute): string {
  const url = new URL(window.location.href)
  for (const key of [
    'assessment',
    'view',
    'subscription',
    'resource',
    'finding',
  ]) {
    url.searchParams.delete(key)
  }
  if (route.kind === 'home') return `${url.pathname}${url.search}${url.hash}`

  url.searchParams.set('assessment', route.assessmentId)
  if (route.kind === 'assessment') url.searchParams.set('view', route.view)
  if (route.kind === 'subscription') {
    url.searchParams.set('subscription', route.subscriptionId)
  }
  if (route.kind === 'resource') {
    url.searchParams.set('resource', route.resourceKey)
  }
  if (route.kind === 'finding') {
    url.searchParams.set('finding', route.recommendationId)
  }
  return `${url.pathname}${url.search}${url.hash}`
}

function resourceRouteKey(recommendation: Recommendation): string {
  return recommendation.resourceId ?? recommendation.fingerprint
}

function recommendationHierarchyRank(
  recommendation: Recommendation,
): number {
  const level = (
    recommendation.claim as Recommendation['claim'] | undefined
  )?.level
  if (level === 'azure_estimate' || recommendation.source === 'advisor') return 0
  if (level === 'observed_fact') return 1
  if (level === 'calculated_scenario') return 2
  if (level === 'investigation_lead' || recommendation.source === 'prospector') {
    return 3
  }
  return 4
}

function observedTrendCost(point: CostTrendPoint): number {
  return (
    point.observedAmortizedCost ??
    (point as CostTrendPoint & { actualCost?: number }).actualCost ??
    0
  )
}

function loadDashboardData() {
  return Promise.all([
    getOverview(),
    getRecommendations({ includeExcepted: true }),
    getActions(),
    getAssessments(),
  ])
}

function recommendationsByNativeValue(
  recommendations: Recommendation[],
  limit: number,
): Recommendation[] {
  return roundRobinByNativeCurrency(
    selectCanonicalOpportunityRecommendations(recommendations),
    (left, right) =>
      recommendationHierarchyRank(left) -
        recommendationHierarchyRank(right) ||
      (right.estimatedMonthlySavings ?? 0) * right.confidence -
        (left.estimatedMonthlySavings ?? 0) * left.confidence,
    limit,
  )
}

function App() {
  const [overview, setOverview] = useState<OverviewResponse>()
  const [recommendations, setRecommendations] = useState<Recommendation[]>([])
  const [actions, setActions] = useState<RemediationAction[]>([])
  const [assessments, setAssessments] = useState<AssessmentSummary[]>([])
  const [selected, setSelected] = useState<Recommendation>()
  const [activeView, setActiveView] = useState<View>('overview')
  const [route, setRoute] = useState<DashboardRoute>(readDashboardRoute)
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
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
  const [editingAssessmentId, setEditingAssessmentId] = useState<string>()
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
  const [activity, setActivity] = useState<SavingsActivity | 'all'>('all')
  const [category, setCategory] = useState<RecommendationCategory | 'all'>('all')
  const [status, setStatus] = useState<StatusFilter>('active')
  const [subscriptionId, setSubscriptionId] = useState('all')
  const [minimumConfidence, setMinimumConfidence] = useState(0)
  const [includeExcepted, setIncludeExcepted] = useState(false)
  const [quickView, setQuickView] = useState<QuickFindingView>('all')
  const [findingSort, setFindingSort] = useState<FindingSort>('priority')
  const [findingPage, setFindingPage] = useState(1)

  const latestWarnings = useMemo(
    () => overview?.recentScans[0]?.warnings ?? [],
    [overview],
  )

  async function refresh(selectedId?: string) {
    const [
      nextOverview,
      nextRecommendations,
      nextActions,
      nextAssessments,
    ] =
      await loadDashboardData()
    setOverview(nextOverview)
    setRecommendations(nextRecommendations)
    setActions(nextActions)
    setAssessments(nextAssessments)
    if (selectedId) {
      setSelected(nextRecommendations.find((item) => item.id === selectedId))
    }
    setError(undefined)
    void getAuthStatus().then(setAuthentication).catch(() => undefined)
    return nextOverview
  }

  function navigate(nextRoute: DashboardRoute, replace = false) {
    const nextUrl = routeUrl(nextRoute)
    if (replace) {
      window.history.replaceState({}, '', nextUrl)
    } else {
      window.history.pushState({}, '', nextUrl)
    }
    setRoute(nextRoute)
  }

  function navigateToAssessment(view: View = 'overview') {
    const assessmentId = overview?.estate.assessmentId
    if (!assessmentId) return
    setActiveView(view)
    setSelected(undefined)
    navigate({ kind: 'assessment', assessmentId, view })
  }

  function navigateToSubscription(nextSubscriptionId: string) {
    const assessmentId = overview?.estate.assessmentId
    if (!assessmentId) return
    setSelected(undefined)
    navigate({
      kind: 'subscription',
      assessmentId,
      subscriptionId: nextSubscriptionId,
    })
  }

  function navigateToResource(recommendation: Recommendation) {
    const assessmentId = overview?.estate.assessmentId
    if (!assessmentId) return
    setSelected(undefined)
    navigate({
      kind: 'resource',
      assessmentId,
      resourceKey: resourceRouteKey(recommendation),
    })
  }

  function navigateToFinding(recommendation: Recommendation) {
    const assessmentId = overview?.estate.assessmentId
    if (!assessmentId) {
      setSelected(recommendation)
      return
    }
    setSelected(recommendation)
    navigate({
      kind: 'finding',
      assessmentId,
      recommendationId: recommendation.id,
    })
  }

  function closeFinding() {
    setSelected(undefined)
    const assessmentId = overview?.estate.assessmentId
    if (!assessmentId) return
    setActiveView('findings')
    navigate(
      { kind: 'assessment', assessmentId, view: 'findings' },
      true,
    )
  }

  useEffect(() => {
    let active = true
    void loadDashboardData()
      .then(
        ([
          nextOverview,
          nextRecommendations,
          nextActions,
          nextAssessments,
        ]) => {
        if (!active) return
        setOverview(nextOverview)
        setRecommendations(nextRecommendations)
        setActions(nextActions)
        setAssessments(nextAssessments)
        },
      )
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

  useEffect(() => {
    const onPopState = () => {
      const nextRoute = readDashboardRoute()
      if (nextRoute.kind === 'home') {
        setWorkspaceOpen(false)
        resetWorkspaceView()
      } else if (nextRoute.kind === 'assessment') {
        setActiveView(nextRoute.view)
        setSelected(undefined)
      } else if (nextRoute.kind === 'finding') {
        setActiveView('findings')
        setSelected(
          recommendations.find(
            (recommendation) =>
              recommendation.id === nextRoute.recommendationId,
          ),
        )
      } else {
        setSelected(undefined)
      }
      setRoute(nextRoute)
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [recommendations])

  useEffect(() => {
    if (loading) return
    if (route.kind === 'home') return

    if (
      !workspaceOpen &&
      overview?.estate.assessmentId === route.assessmentId
    ) {
      let active = true
      void Promise.resolve().then(() => {
        if (!active) return
        setWorkspaceOpen(true)
        if (route.kind === 'assessment') setActiveView(route.view)
        if (route.kind === 'finding') {
          setActiveView('findings')
          setSelected(
            recommendations.find(
              (recommendation) =>
                recommendation.id === route.recommendationId,
            ),
          )
        }
      })
      return () => {
        active = false
      }
    }

    if (
      !workspaceOpen ||
      overview?.estate.assessmentId !== route.assessmentId
    ) {
      let active = true
      void openAssessmentWorkspace(route.assessmentId)
        .then(loadDashboardData)
        .then(
          ([
            nextOverview,
            nextRecommendations,
            nextActions,
            nextAssessments,
          ]) => {
            if (!active) return
            setOverview(nextOverview)
            setRecommendations(nextRecommendations)
            setActions(nextActions)
            setAssessments(nextAssessments)
            setWorkspaceOpen(true)
            if (route.kind === 'assessment') setActiveView(route.view)
            if (route.kind === 'finding') {
              setActiveView('findings')
              setSelected(
                nextRecommendations.find(
                  (recommendation) =>
                    recommendation.id === route.recommendationId,
                ),
              )
            } else {
              setSelected(undefined)
            }
          },
        )
        .catch((assessmentError: unknown) => {
          if (!active) return
          setError(messageFromError(assessmentError))
          navigate({ kind: 'home' }, true)
        })
      return () => {
        active = false
      }
    }

  }, [
    loading,
    overview?.estate.assessmentId,
    recommendations,
    route,
    workspaceOpen,
  ])

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
      if (activity !== 'all' && recommendation.activity !== activity) return false
      if (category !== 'all' && recommendation.category !== category) return false
      if (subscriptionId !== 'all' && recommendation.subscriptionId !== subscriptionId) {
        return false
      }
      if (minimumConfidence && recommendation.confidence < minimumConfidence) return false
      if (!includeExcepted && recommendation.exception) return false
      if (
        quickView === 'ready' &&
        findingReadiness(recommendation, latestWarnings) !== 'ready'
      ) {
        return false
      }
      if (
        quickView === 'validation' &&
        findingReadiness(recommendation, latestWarnings) !== 'validation'
      ) {
        return false
      }
      if (
        quickView === 'unowned' &&
        recommendation.owner.source !== 'unassigned'
      ) {
        return false
      }
      if (
        quickView === 'currency-mismatch' &&
        !hasCurrencyMismatch(recommendation, latestWarnings)
      ) {
        return false
      }
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
    activity,
    category,
    includeExcepted,
    latestWarnings,
    minimumConfidence,
    quickView,
    recommendations,
    search,
    status,
    subscriptionId,
  ])

  const sortedRecommendations = useMemo(() => {
    return roundRobinByNativeCurrency(filteredRecommendations, (left, right) => {
      if (findingSort === 'monthly') {
        return (
          (right.estimatedMonthlySavings ?? 0) -
            (left.estimatedMonthlySavings ?? 0) ||
          right.confidence - left.confidence
        )
      }
      if (findingSort === 'confidence') {
        return (
          right.confidence - left.confidence ||
          (right.estimatedMonthlySavings ?? 0) -
            (left.estimatedMonthlySavings ?? 0)
        )
      }
      if (findingSort === 'freshness') {
        return (
          Date.parse(evidenceFreshness(right)) -
          Date.parse(evidenceFreshness(left))
        )
      }
      const readinessDifference =
        Number(findingReadiness(right, latestWarnings) === 'ready') -
        Number(findingReadiness(left, latestWarnings) === 'ready')
      return (
        readinessDifference ||
        recommendationHierarchyRank(left) -
          recommendationHierarchyRank(right) ||
        (right.estimatedMonthlySavings ?? 0) * right.confidence -
          (left.estimatedMonthlySavings ?? 0) * left.confidence
      )
    })
  }, [
    filteredRecommendations,
    findingSort,
    latestWarnings,
  ])

  const topRecommendations = useMemo(
    () =>
      recommendationsByNativeValue(
        recommendations.filter(
          (recommendation) =>
            ['open', 'accepted', 'in_progress'].includes(
              recommendation.status,
            ) &&
            !recommendation.exception &&
            findingReadiness(recommendation, latestWarnings) === 'ready',
        ),
        6,
      ),
    [latestWarnings, recommendations],
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

  async function openAssessment(assessment?: AssessmentSummary) {
    setNotice(undefined)
    setError(undefined)
    if (!(await connectAzure(false))) return
    setLoadingSubscriptions(true)
    try {
      const subscriptions = await getAzureSubscriptions()
      setSubscriptionOptions(subscriptions)
      setSelectedSubscriptionIds(
        assessment?.selectedSubscriptionIds ?? [],
      )
      setSubscriptionSearch('')
      setAssessmentName(assessment?.name ?? '')
      setEditingAssessmentId(assessment?.id)
      setSubscriptionPickerOpen(true)
    } catch (subscriptionError) {
      setError(messageFromError(subscriptionError))
    } finally {
      setLoadingSubscriptions(false)
    }
  }

  async function refreshSubscriptionSessions() {
    setLoadingSubscriptions(true)
    try {
      const subscriptions = await getAzureSubscriptions()
      setSubscriptionOptions(subscriptions)
    } catch (subscriptionError) {
      setSubscriptionPickerOpen(false)
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
        assessmentId: editingAssessmentId,
        assessmentName: normalizedName,
        subscriptionIds,
      })
      const nextOverview = await refresh()
      setWorkspaceOpen(true)
      resetWorkspaceView()
      if (nextOverview.estate.assessmentId) {
        navigate(
          {
            kind: 'assessment',
            assessmentId: nextOverview.estate.assessmentId,
            view: 'overview',
          },
        )
      }
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
      setEditingAssessmentId(undefined)
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
      const nextOverview = await refresh()
      setWorkspaceOpen(true)
      resetWorkspaceView()
      if (nextOverview.estate.assessmentId) {
        navigate(
          {
            kind: 'assessment',
            assessmentId: nextOverview.estate.assessmentId,
            view: 'overview',
          },
        )
      }
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
    setActivity('all')
    setCategory('all')
    setStatus('active')
    setSubscriptionId('all')
    setMinimumConfidence(0)
    setIncludeExcepted(false)
    setQuickView('all')
    setFindingSort('priority')
    setFindingPage(1)
  }

  async function openSavedAssessment(assessment: AssessmentSummary) {
    setLoading(true)
    setNotice(undefined)
    setError(undefined)
    try {
      await openAssessmentWorkspace(assessment.id)
      await refresh()
      setWorkspaceOpen(true)
      resetWorkspaceView()
      navigate(
        {
          kind: 'assessment',
          assessmentId: assessment.id,
          view: 'overview',
        },
      )
    } catch (assessmentError) {
      setError(messageFromError(assessmentError))
    } finally {
      setLoading(false)
    }
  }

  async function deleteSavedAssessment(assessment: AssessmentSummary) {
    const confirmed = window.confirm(
      `Delete "${assessment.name}" and its saved results? This cannot be undone.`,
    )
    if (!confirmed) return
    setLoading(true)
    setNotice(undefined)
    setError(undefined)
    try {
      await deleteAssessmentWorkspace(assessment.id)
      if (overview?.estate.assessmentId === assessment.id) {
        setWorkspaceOpen(false)
      }
      await refresh()
      setNotice(`Deleted ${assessment.name}.`)
    } catch (assessmentError) {
      setError(messageFromError(assessmentError))
    } finally {
      setLoading(false)
    }
  }

  function goHome() {
    setWorkspaceOpen(false)
    setSubscriptionPickerOpen(false)
    resetWorkspaceView()
    setNotice(undefined)
    setError(undefined)
    navigate({ kind: 'home' })
  }

  const connectionLabel = !authentication
    ? 'Checking Azure'
    : authentication.authenticated
      ? authentication.source === 'azure_cli'
        ? 'CLI connected'
        : 'Azure connected'
      : 'Connect Azure'
  const hasStoredAssessment = Boolean(overview?.estate.lastScanAt)
  const routeAssessmentId =
    route.kind === 'home' ? undefined : route.assessmentId
  const routePending = Boolean(
    routeAssessmentId &&
      overview?.estate.assessmentId !== routeAssessmentId,
  )
  const hasAssessment =
    workspaceOpen &&
    hasStoredAssessment &&
    (!routeAssessmentId ||
      overview?.estate.assessmentId === routeAssessmentId)
  const currentAssessment = assessments.find(
    (assessment) => assessment.id === overview?.estate.assessmentId,
  )

  function showSavingsActivity(nextActivity: SavingsActivity) {
    setSearch('')
    setActivity(nextActivity)
    setCategory('all')
    setStatus('active')
    setSubscriptionId('all')
    setMinimumConfidence(0)
    setIncludeExcepted(false)
    setQuickView('all')
    setFindingSort('priority')
    setFindingPage(1)
    setActiveView('findings')
    const assessmentId = overview?.estate.assessmentId
    if (assessmentId) {
      navigate({ kind: 'assessment', assessmentId, view: 'findings' })
    }
  }

  function showSubscriptionActivity(
    nextSubscriptionId: string,
    nextActivity: SavingsActivity,
  ) {
    setSearch('')
    setActivity(nextActivity)
    setCategory('all')
    setStatus('active')
    setSubscriptionId(nextSubscriptionId)
    setMinimumConfidence(0)
    setIncludeExcepted(false)
    setQuickView('all')
    setFindingSort('priority')
    setFindingPage(1)
    navigateToAssessment('findings')
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
          <button
            type="button"
            className="rounded-[0.625rem] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Return to Azure Prospector home"
            onClick={goHome}
          >
            <BrandMark />
          </button>
        </div>

        {hasAssessment && overview && (
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
                  onClick={() => navigateToAssessment(item.id)}
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

        <div className="mt-auto">
          <div className="px-2 text-[11px] leading-5 text-muted-foreground">
            Read-only by default · not an official Microsoft product.
          </div>
        </div>
      </aside>

      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 border-b bg-[var(--cp-panel-strong)]">
          <div className="flex min-h-16 items-center gap-3 px-4 sm:px-6 lg:px-8">
            <div className="lg:hidden">
              <button
                type="button"
                className="rounded-[0.625rem] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="Return to Azure Prospector home"
                onClick={goHome}
              >
                <BrandMark compact />
              </button>
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
            {hasAssessment && overview && (
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
                aria-label="Connect Azure"
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
            {hasAssessment && overview?.estate.assessmentId && (
              <AssessmentExportMenu
                assessmentId={overview.estate.assessmentId}
              />
            )}
            {hasAssessment && (
              <Button
                disabled={Boolean(scanning) || loadingSubscriptions}
                aria-label={
                  overview?.estate.mode === 'demo'
                    ? 'Start live assessment'
                    : 'New assessment'
                }
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
                    onClick={() => navigateToAssessment(item.id)}
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
                error ? 'border-destructive bg-secondary' : 'border-primary bg-secondary',
              )}
              role={error ? 'alert' : 'status'}
            >
              <div className="flex items-start gap-2.5">
                {error ? (
                  <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
                ) : (
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />
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

          {hasAssessment && overview && (
            <>
              <RouteBreadcrumbs
                route={route}
                overview={overview}
                recommendations={recommendations}
                onHome={goHome}
                onAssessment={() => navigateToAssessment('overview')}
                onSubscription={navigateToSubscription}
              />
              <TrustScopeStrip
                overview={overview}
                assessment={currentAssessment}
                onCoverage={() => navigateToAssessment('coverage')}
              />
            </>
          )}

          {loading || routePending ? (
            <LoadingState />
          ) : !overview ? (
            <DashboardUnavailable
              busy={Boolean(scanning)}
              onRetry={() => void retryDashboard()}
              onDemo={() => void runDemo()}
            />
          ) : !hasAssessment ? (
            <WelcomeView
              authentication={authentication}
              connecting={connecting || loadingSubscriptions}
              scanning={scanning}
              assessments={assessments.filter(
                (assessment) => assessment.mode === 'live',
              )}
              onConnect={() => void connectAzure()}
              onLiveScan={() => void openAssessment()}
              onDemo={() => void runDemo()}
              onOpenAssessment={(assessment) =>
                void openSavedAssessment(assessment)
              }
              onRescanAssessment={(assessment) =>
                void openAssessment(assessment)
              }
              onDeleteAssessment={(assessment) =>
                void deleteSavedAssessment(assessment)
              }
            />
          ) : (
            <>
              {route.kind === 'subscription' && overview ? (
                <SubscriptionView
                  overview={overview}
                  recommendations={recommendations}
                  subscriptionId={route.subscriptionId}
                  warnings={latestWarnings}
                  onSelect={navigateToFinding}
                  onSelectResource={navigateToResource}
                  onSelectActivity={(activity) =>
                    showSubscriptionActivity(route.subscriptionId, activity)
                  }
                />
              ) : route.kind === 'resource' && overview ? (
                <ResourceView
                  overview={overview}
                  recommendations={recommendations}
                  resourceKey={route.resourceKey}
                  warnings={latestWarnings}
                  onSelect={navigateToFinding}
                  onSelectSubscription={navigateToSubscription}
                />
              ) : activeView === 'overview' ? (
                <OverviewView
                  overview={overview}
                  recommendations={recommendations}
                  topRecommendations={topRecommendations}
                  warnings={latestWarnings}
                  onSelect={navigateToFinding}
                  onNavigate={navigateToAssessment}
                  onSelectActivity={showSavingsActivity}
                  onSelectSubscription={navigateToSubscription}
                  onSelectResource={navigateToResource}
                />
              ) : null}
              {route.kind !== 'subscription' &&
                route.kind !== 'resource' &&
                activeView === 'findings' && (
                <FindingsView
                  overview={overview}
                  recommendations={sortedRecommendations}
                  warnings={latestWarnings}
                  search={search}
                  activity={activity}
                  category={category}
                  status={status}
                  subscriptionId={subscriptionId}
                  minimumConfidence={minimumConfidence}
                  includeExcepted={includeExcepted}
                  quickView={quickView}
                  sort={findingSort}
                  page={findingPage}
                  onSearch={setSearch}
                  onActivity={setActivity}
                  onCategory={setCategory}
                  onStatus={setStatus}
                  onSubscription={setSubscriptionId}
                  onMinimumConfidence={setMinimumConfidence}
                  onIncludeExcepted={setIncludeExcepted}
                  onQuickView={setQuickView}
                  onSort={setFindingSort}
                  onPage={setFindingPage}
                  onSelect={navigateToFinding}
                  onSelectSubscription={navigateToSubscription}
                  onSelectResource={navigateToResource}
                />
              )}
              {route.kind !== 'subscription' &&
                route.kind !== 'resource' &&
                activeView === 'actions' && (
                <ActionsView
                  actions={actions}
                  recommendations={recommendations}
                  busy={mutating}
                  onUpdateStatus={changeActionStatus}
                  onSelectRecommendation={navigateToFinding}
                />
              )}
              {route.kind !== 'subscription' &&
                route.kind !== 'resource' &&
                activeView === 'savings' && <OutcomesView overview={overview} />}
              {route.kind !== 'subscription' &&
                route.kind !== 'resource' &&
                activeView === 'coverage' && (
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
        editing={Boolean(editingAssessmentId)}
        busy={Boolean(scanning)}
        refreshing={loadingSubscriptions}
        onOpenChange={setSubscriptionPickerOpen}
        onSelectedIdsChange={setSelectedSubscriptionIds}
        onSearchChange={setSubscriptionSearch}
        onAssessmentNameChange={setAssessmentName}
        onRefresh={() => void refreshSubscriptionSessions()}
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
          if (!open) closeFinding()
        }}
        onCreateException={addException}
        onClearException={removeException}
        onCreateAction={addAction}
        warnings={latestWarnings}
        onOpenResource={navigateToResource}
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
                            {recommendation.estimatedMonthlySavings !== null &&
                            recommendation.currency
                              ? `${formatCurrency(
                                  recommendation.estimatedMonthlySavings,
                                  recommendation.currency,
                                )} monthly value`
                              : recommendation.estimatedMonthlySavings !== null
                                ? 'Monthly value currency unavailable'
                                : 'Monthly value not quantified'}
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
  assessments,
  onConnect,
  onLiveScan,
  onDemo,
  onOpenAssessment,
  onRescanAssessment,
  onDeleteAssessment,
}: {
  authentication?: AuthStatusResponse
  connecting: boolean
  scanning?: ScanMode
  assessments: AssessmentSummary[]
  onConnect: () => void
  onLiveScan: () => void
  onDemo: () => void
  onOpenAssessment: (assessment: AssessmentSummary) => void
  onRescanAssessment: (assessment: AssessmentSummary) => void
  onDeleteAssessment: (assessment: AssessmentSummary) => void
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

        <AssessmentCollection
          assessments={assessments}
          busy={connecting || Boolean(scanning)}
          onOpen={onOpenAssessment}
          onRescan={onRescanAssessment}
          onDelete={onDeleteAssessment}
        />
      </div>
    </div>
  )
}

function RouteBreadcrumbs({
  route,
  overview,
  recommendations,
  onHome,
  onAssessment,
  onSubscription,
}: {
  route: DashboardRoute
  overview: OverviewResponse
  recommendations: Recommendation[]
  onHome: () => void
  onAssessment: () => void
  onSubscription: (subscriptionId: string) => void
}) {
  const recommendation =
    route.kind === 'finding'
      ? recommendations.find((item) => item.id === route.recommendationId)
      : route.kind === 'resource'
        ? recommendations.find(
            (item) => resourceRouteKey(item) === route.resourceKey,
          )
        : undefined
  const routedSubscriptionId =
    route.kind === 'subscription'
      ? route.subscriptionId
      : recommendation?.subscriptionId
  const routedSubscription = overview.subscriptions.find(
    (subscription) => subscription.id === routedSubscriptionId,
  )
  const viewLabel =
    route.kind === 'assessment'
      ? navigation.find((item) => item.id === route.view)?.label
      : route.kind === 'finding'
        ? recommendation?.title ?? 'Finding'
        : route.kind === 'resource'
          ? recommendation?.resourceName ?? 'Resource'
          : routedSubscription?.name ?? 'Subscription'

  return (
    <nav
      className="mb-3 flex min-h-9 items-center gap-1 overflow-x-auto text-xs text-muted-foreground"
      aria-label="Breadcrumb"
    >
      <button
        type="button"
        className="shrink-0 rounded-md px-2 py-2 font-semibold hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onHome}
      >
        <ArrowLeft className="mr-1 inline size-3.5" aria-hidden="true" />
        Assessments
      </button>
      <ChevronRight className="size-3.5 shrink-0" aria-hidden="true" />
      <button
        type="button"
        className="max-w-64 shrink-0 truncate rounded-md px-2 py-2 font-semibold hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onAssessment}
      >
        {overview.estate.assessmentName ?? overview.estate.tenantName}
      </button>
      {routedSubscription && route.kind !== 'assessment' && (
        <>
          <ChevronRight className="size-3.5 shrink-0" aria-hidden="true" />
          {route.kind === 'subscription' ? (
            <span className="max-w-64 shrink-0 truncate px-2 py-2 font-semibold text-foreground">
              {routedSubscription.name}
            </span>
          ) : (
            <button
              type="button"
              className="max-w-64 shrink-0 truncate rounded-md px-2 py-2 font-semibold hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onSubscription(routedSubscription.id)}
            >
              {routedSubscription.name}
            </button>
          )}
        </>
      )}
      {route.kind !== 'subscription' && (
        <>
          <ChevronRight className="size-3.5 shrink-0" aria-hidden="true" />
          <span
            className="max-w-96 shrink-0 truncate px-2 py-2 font-semibold text-foreground"
            aria-current="page"
          >
            {viewLabel}
          </span>
        </>
      )}
    </nav>
  )
}

function SubscriptionView({
  overview,
  recommendations,
  subscriptionId,
  warnings,
  onSelect,
  onSelectResource,
  onSelectActivity,
}: {
  overview: OverviewResponse
  recommendations: Recommendation[]
  subscriptionId: string
  warnings: string[]
  onSelect: (recommendation: Recommendation) => void
  onSelectResource: (recommendation: Recommendation) => void
  onSelectActivity: (activity: SavingsActivity) => void
}) {
  const subscription = overview.subscriptions.find(
    (item) => item.id === subscriptionId,
  )
  const findings = recommendations.filter(
    (recommendation) => recommendation.subscriptionId === subscriptionId,
  )
  if (!subscription) {
    return (
      <div className="mx-auto max-w-[1200px]">
        <PageHeading
          title="Subscription scope unavailable"
          description="This subscription is not present in the current assessment results."
        />
      </div>
    )
  }

  const active = findings.filter(
    (recommendation) =>
      ['open', 'accepted', 'in_progress'].includes(recommendation.status) &&
      !recommendation.exception,
  )
  const azureEstimated = selectAzureEstimatedOpportunities(active)
  const calculatedSchedules = selectCalculatedScheduleScenarios(active)
  const ready = active.filter(
    (recommendation) =>
      findingReadiness(recommendation, warnings) === 'ready',
  )
  const opportunity =
    azureEstimatedOpportunityAmountsByCurrency(azureEstimated)
  const calculatedScheduleAmounts =
    calculatedScheduleAmountsByCurrency(calculatedSchedules)

  return (
    <div className="mx-auto max-w-[1500px]">
      <PageHeading
        title={subscription.name}
        description={`${subscription.state} subscription · ${
          subscription.currency ?? 'billing currency unavailable'
        } · no FX conversion`}
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Typical monthly cost"
          value={
            subscription.monthlyCost !== null && subscription.currency
              ? formatCurrency(
                  subscription.monthlyCost,
                  subscription.currency,
                  true,
                )
              : 'Not available'
          }
          detail="assessment cost basis"
          icon={WalletCards}
        />
        <StatCard
          label="Azure estimated opportunity"
          value={
            opportunity.length
              ? formatCurrencyAmounts(opportunity, true)
              : 'Not available'
          }
          detail="native estimates with canonical overlap sequencing · operator approval and telemetry validation required"
          icon={TrendingDown}
          tone="opportunity"
        />
        <StatCard
          label="Action-ready"
          value={ready.length.toLocaleString()}
          detail={`${active.length - ready.length} need validation`}
          icon={CheckCircle2}
        />
        <StatCard
          label="Owner coverage"
          value={`${Math.round(subscription.ownerCoverage)}%`}
          detail={`${active.filter((item) => item.owner.source === 'unassigned').length} active unowned`}
          icon={UserRound}
        />
      </div>

      {calculatedSchedules.length > 0 && (
        <div className="mt-4 rounded-xl border bg-secondary p-4 text-sm">
          <div className="font-bold text-foreground">
            Calculated schedule scenarios are separate
          </div>
          <p className="mt-1 leading-6 text-muted-foreground">
            {calculatedSchedules.length}{' '}
            {calculatedSchedules.length === 1 ? 'scenario' : 'scenarios'}
            {calculatedScheduleAmounts.length
              ? ` · ${formatCurrencyAmounts(
                  calculatedScheduleAmounts,
                  true,
                )} illustrative monthly value`
              : ' · not quantified'}
            . These are excluded from the Azure estimated opportunity and
            require runtime telemetry validation.
          </p>
        </div>
      )}

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(360px,0.8fr)]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Subscription findings</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Evidence, ownership and cost basis remain visible before opening a
              finding.
            </p>
          </CardHeader>
          <CardContent>
            <RecommendationTable
              recommendations={findings.slice(0, 25)}
              onSelect={onSelect}
              onSelectResource={onSelectResource}
              warnings={warnings}
              compact
            />
          </CardContent>
        </Card>
        <SavingsActivityPanel
          recommendations={findings}
          onSelect={onSelectActivity}
        />
      </div>
    </div>
  )
}

function ResourceView({
  overview,
  recommendations,
  resourceKey,
  warnings,
  onSelect,
  onSelectSubscription,
}: {
  overview: OverviewResponse
  recommendations: Recommendation[]
  resourceKey: string
  warnings: string[]
  onSelect: (recommendation: Recommendation) => void
  onSelectSubscription: (subscriptionId: string) => void
}) {
  const findings = recommendations.filter(
    (recommendation) => resourceRouteKey(recommendation) === resourceKey,
  )
  const resource = findings[0]
  if (!resource) {
    return (
      <div className="mx-auto max-w-[1200px]">
        <PageHeading
          title="Resource scope unavailable"
          description="No finding in the current assessment matches this resource route."
        />
      </div>
    )
  }

  const costBaselines = [
    ...findings
      .reduce((totals, finding) => {
        if (!finding.currency || finding.currentMonthlyCost === null) {
          return totals
        }
        totals.set(
          finding.currency,
          Math.max(
            totals.get(finding.currency) ?? 0,
            finding.currentMonthlyCost,
          ),
        )
        return totals
      }, new Map<string, number>())
      .entries(),
  ].map(([currency, amount]) => ({ currency, amount }))
  const latestEvidence = findings
    .map(evidenceFreshness)
    .sort()
    .at(-1)
  const costCurrencyUnavailable = findings.some(
    (finding) =>
      (finding.currentMonthlyCost ?? 0) > 0 && !finding.currency,
  )
  const azureEstimated = selectAzureEstimatedOpportunities(findings)
  const calculatedSchedules = selectCalculatedScheduleScenarios(findings)

  return (
    <div className="mx-auto max-w-[1200px]">
      <PageHeading
        title={resource.resourceName}
        description={`Routeable resource scope assembled only from findings and evidence in ${
          overview.estate.assessmentName ?? 'this assessment'
        }.`}
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Matched cost basis"
          value={
            costBaselines.some((amount) => amount.amount > 0)
              ? formatCurrencyAmounts(
                  costBaselines.filter((amount) => amount.amount > 0),
                  true,
                )
              : costCurrencyUnavailable
                ? 'Currency unavailable'
                : 'Not matched'
          }
          detail={
            costCurrencyUnavailable
              ? 'attached amount is not comparable'
              : 'highest attached monthly baseline'
          }
          icon={WalletCards}
        />
        <StatCard
          label="Azure estimated opportunity"
          value={
            azureEstimated.length
              ? formatCurrencyAmounts(
                  azureEstimatedOpportunityAmountsByCurrency(azureEstimated),
                  true,
                )
              : 'Not available'
          }
          detail="native estimate · operator approval still required"
          icon={Gem}
          tone="opportunity"
        />
        <StatCard
          label="Findings"
          value={findings.length.toLocaleString()}
          detail={`${findings.filter((item) => findingReadiness(item, warnings) === 'ready').length} ready for review`}
          icon={ListChecks}
        />
        <StatCard
          label="Evidence freshness"
          value={latestEvidence ? formatDate(latestEvidence) : 'Unavailable'}
          detail="latest attached observation"
          icon={CalendarClock}
        />
      </div>

      {calculatedSchedules.length > 0 && (
        <div className="mt-4 rounded-xl border bg-secondary p-4 text-sm text-muted-foreground">
          <strong className="text-foreground">
            Calculated schedule scenario:
          </strong>{' '}
          excluded from the Azure estimate and pending runtime telemetry
          validation.
        </div>
      )}

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">Resource context</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <Definition label="Resource type" value={resource.resourceType} />
            <Definition
              label="Resource group"
              value={resource.resourceGroup ?? 'Not supplied'}
            />
            <Definition label="Region" value={resource.location ?? 'Not supplied'} />
            <Definition
              label="Subscription"
              value={resource.subscriptionName}
              action={() => onSelectSubscription(resource.subscriptionId)}
            />
          </dl>
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">Findings for this resource</CardTitle>
        </CardHeader>
        <CardContent>
          <RecommendationTable
            recommendations={findings}
            onSelect={onSelect}
            warnings={warnings}
            compact
          />
        </CardContent>
      </Card>
    </div>
  )
}

function Definition({
  label,
  value,
  action,
}: {
  label: string
  value: string
  action?: () => void
}) {
  return (
    <div>
      <dt className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 break-all font-semibold text-foreground">
        {action ? (
          <button
            type="button"
            className="min-h-11 text-left text-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={action}
          >
            {value}
          </button>
        ) : (
          value
        )}
      </dd>
    </div>
  )
}

function OverviewView({
  overview,
  recommendations,
  topRecommendations,
  warnings,
  onSelect,
  onNavigate,
  onSelectActivity,
  onSelectSubscription,
  onSelectResource,
}: {
  overview: OverviewResponse
  recommendations: Recommendation[]
  topRecommendations: Recommendation[]
  warnings: string[]
  onSelect: (recommendation: Recommendation) => void
  onNavigate: (view: View) => void
  onSelectActivity: (activity: SavingsActivity) => void
  onSelectSubscription: (subscriptionId: string) => void
  onSelectResource: (recommendation: Recommendation) => void
}) {
  const activeRecommendations = recommendations.filter(
    (recommendation) =>
      ['open', 'accepted', 'in_progress'].includes(recommendation.status) &&
      !recommendation.exception,
  )
  const azureEstimatedRecommendations =
    selectAzureEstimatedOpportunities(activeRecommendations)
  const calculatedSchedules =
    selectCalculatedScheduleScenarios(activeRecommendations)
  const actionReady = activeRecommendations.filter(
    (recommendation) =>
      findingReadiness(recommendation, warnings) === 'ready',
  )
  const needsValidation = activeRecommendations.filter(
    (recommendation) =>
      findingReadiness(recommendation, warnings) === 'validation',
  )
  const monthlyCosts = overview.savings.byCurrency
    .filter((summary) => summary.monthlyCost > 0)
    .map((summary) => ({
      currency: summary.currency,
      amount: summary.monthlyCost,
    }))
  const azureEstimatedSavings = azureEstimatedOpportunityAmountsByCurrency(
    azureEstimatedRecommendations,
  )
  const calculatedScheduleAmounts =
    calculatedScheduleAmountsByCurrency(calculatedSchedules)
  const azureEstimatedRates = overview.savings.byCurrency
    .map(
      (summary) => {
        const opportunity =
          azureEstimatedSavings.find(
            (amount) => amount.currency === summary.currency,
          )?.amount ?? 0
        return summary.monthlyCost > 0 && opportunity > 0
          ? `${summary.currency} ${(
            (opportunity / summary.monthlyCost) *
            100
          ).toFixed(1)}% of cost`
          : ''
      },
    )
    .filter(Boolean)
    .join(' · ')
  const periodDirection = overview.savings.byCurrency
    .map((summary) => {
      const previous = summary.costTrend.at(-2)
      const current = summary.costTrend.at(-1)
      if (!previous || !current || observedTrendCost(previous) === 0) return ''
      const change =
        ((observedTrendCost(current) - observedTrendCost(previous)) /
          observedTrendCost(previous)) *
        100
      const direction =
        Math.abs(change) < 0.05 ? 'flat' : change > 0 ? 'up' : 'down'
      return `${summary.currency} ${direction}${
        direction === 'flat' ? '' : ` ${Math.abs(change).toFixed(1)}%`
      } vs ${previous.period}`
    })
    .filter(Boolean)
    .join(' · ')
  const missingBaselines = activeRecommendations.filter(
    (recommendation) => (recommendation.currentMonthlyCost ?? 0) <= 0,
  ).length
  const nextRecommendations = topRecommendations.length
    ? topRecommendations
    : recommendationsByNativeValue(needsValidation, 6)
  const coverageGaps = [...overview.coverage]
    .filter((item) => item.status !== 'complete')
    .sort(
      (left, right) =>
        (left.status === 'missing' ? 0 : left.status === 'partial' ? 1 : 2) -
          (right.status === 'missing'
          ? 0
          : right.status === 'partial'
            ? 1
            : 2) ||
        left.percentage - right.percentage,
    )

  return (
    <div className="mx-auto max-w-[1500px]">
      <PageHeading
        title="Where to act next"
        description="Prioritise findings with a comparable cost basis and dated evidence, then resolve validation and ownership gaps."
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Typical monthly cost"
          value={formatCurrencyAmounts(monthlyCosts, true)}
          detail={`Median completed-month amortised cost${
          periodDirection ? ` · ${periodDirection}` : ''
          }`}
          icon={WalletCards}
        />
        <StatCard
          label="Azure estimated opportunity"
          value={
            azureEstimatedSavings.length
              ? formatCurrencyAmounts(azureEstimatedSavings, true)
              : 'Not available'
          }
          detail={
            azureEstimatedRates
              ? `${azureEstimatedRates} · canonically sequenced native estimates; operator approval and telemetry validation required`
              : 'No comparable native Azure estimate is available'
          }
          icon={TrendingDown}
          tone="opportunity"
        />
        <StatCard
          label="Action-ready"
          value={actionReady.length.toLocaleString()}
          detail="cost based, dated evidence · operator approval still required"
          icon={CheckCircle2}
        />
        <StatCard
          label="Needs validation"
          value={needsValidation.length.toLocaleString()}
          detail={`${missingBaselines} without a matched cost baseline`}
          icon={ShieldAlert}
        />
      </div>

      {calculatedSchedules.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-secondary px-4 py-3 text-sm">
          <div>
            <span className="font-bold text-foreground">
              Calculated schedule scenarios
            </span>
            <span className="ml-2 text-muted-foreground">
              {calculatedSchedules.length}{' '}
              {calculatedSchedules.length === 1 ? 'scenario' : 'scenarios'} ·
              excluded from the Azure estimated opportunity · telemetry
              validation required
            </span>
          </div>
          <span className="font-semibold text-primary">
            {calculatedScheduleAmounts.length
              ? formatCurrencyAmounts(calculatedScheduleAmounts, true)
              : 'Not quantified'}
          </span>
        </div>
      )}

      <Card className="mt-6">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Subscription comparison</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
          Native-currency cost, portfolio share and canonically sequenced Azure
          estimates. Select a subscription to inspect its findings.
          </p>
        </CardHeader>
        <CardContent>
          <SubscriptionComparison
          subscriptions={overview.subscriptions}
          recommendations={recommendations}
          warnings={warnings}
          onSelect={onSelectSubscription}
          />
        </CardContent>
      </Card>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(360px,0.8fr)]">
        <Card>
          <CardHeader className="pb-3">
          <CardTitle className="text-base">Opportunity trajectory</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Actual completed-period cost versus the calculated opportunity
            scenario. Gold is potential, never a measured outcome.
          </p>
          </CardHeader>
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
        <SavingsActivityPanel
          recommendations={recommendations}
          onSelect={onSelectActivity}
        />
      </div>

      <Card className="mt-6">
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
          <div>
          <CardTitle className="text-base">
            {topRecommendations.length
              ? 'Top action-ready findings'
              : 'Top validation priorities'}
          </CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            {topRecommendations.length
              ? 'Ranked by confidence-adjusted native value; currencies remain separate.'
              : 'No finding is decision-ready yet. Resolve these highest-value evidence gaps first.'}
          </p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => onNavigate('findings')}>
          View all findings
          </Button>
        </CardHeader>
        <CardContent>
          <RecommendationTable
          recommendations={nextRecommendations}
          onSelect={onSelect}
          onSelectResource={onSelectResource}
          warnings={warnings}
          compact
          />
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
          <div>
            <CardTitle className="text-base">Signal coverage</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Worst gaps first. Missing telemetry limits which findings can
              become action-ready.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => onNavigate('coverage')}>
          Inspect all coverage
          </Button>
        </CardHeader>
        <CardContent>
          <CoveragePanel coverage={coverageGaps.slice(0, 5)} />
        </CardContent>
      </Card>
    </div>
  )
}

function FindingsView({
  overview,
  recommendations,
  warnings,
  search,
  activity,
  category,
  status,
  subscriptionId,
  minimumConfidence,
  includeExcepted,
  quickView,
  sort,
  page,
  onSearch,
  onActivity,
  onCategory,
  onStatus,
  onSubscription,
  onMinimumConfidence,
  onIncludeExcepted,
  onQuickView,
  onSort,
  onPage,
  onSelect,
  onSelectSubscription,
  onSelectResource,
}: {
  overview: OverviewResponse
  recommendations: Recommendation[]
  warnings: string[]
  search: string
  activity: SavingsActivity | 'all'
  category: RecommendationCategory | 'all'
  status: StatusFilter
  subscriptionId: string
  minimumConfidence: number
  includeExcepted: boolean
  quickView: QuickFindingView
  sort: FindingSort
  page: number
  onSearch: (value: string) => void
  onActivity: (value: SavingsActivity | 'all') => void
  onCategory: (value: RecommendationCategory | 'all') => void
  onStatus: (value: StatusFilter) => void
  onSubscription: (value: string) => void
  onMinimumConfidence: (value: number) => void
  onIncludeExcepted: (value: boolean) => void
  onQuickView: (value: QuickFindingView) => void
  onSort: (value: FindingSort) => void
  onPage: (value: number) => void
  onSelect: (recommendation: Recommendation) => void
  onSelectSubscription: (subscriptionId: string) => void
  onSelectResource: (recommendation: Recommendation) => void
}) {
  const azureEstimatedValue = azureEstimatedOpportunityAmountsByCurrency(
    selectAzureEstimatedOpportunities(recommendations),
  )
  const calculatedScheduleValue = calculatedScheduleAmountsByCurrency(
    selectCalculatedScheduleScenarios(recommendations),
  )
  const scenarioActivity =
    activity === 'reserved_instances' || activity === 'savings_plans'
  const canonicalScenarioIds = new Set(
    selectCanonicalOpportunityRecommendations(recommendations).map(
      (recommendation) => recommendation.id,
    ),
  )
  const displayedRecommendations = scenarioActivity
    ? recommendations.filter((recommendation) =>
        canonicalScenarioIds.has(recommendation.id),
      )
    : recommendations
  const pageSize = 25
  const pageCount = Math.max(
    1,
    Math.ceil(displayedRecommendations.length / pageSize),
  )
  const currentPage = Math.min(page, pageCount)
  const pagedRecommendations = displayedRecommendations.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  )
  const advancedFilterCount = [
    activity !== 'all',
    category !== 'all',
    status !== 'active',
    subscriptionId !== 'all',
    minimumConfidence > 0,
    includeExcepted,
  ].filter(Boolean).length
  const quickViews: Array<{ id: QuickFindingView; label: string }> = [
    { id: 'all', label: 'All active' },
    { id: 'ready', label: 'Ready to act' },
    { id: 'validation', label: 'Needs validation' },
    { id: 'unowned', label: 'Unowned' },
    { id: 'currency-mismatch', label: 'Currency mismatch' },
  ]

  return (
    <div className="mx-auto max-w-[1500px]">
      <PageHeading
        title="Findings and evidence"
        description="Start with a decision-ready view, then use advanced scope and evidence filters only when needed."
      />

      <Card>
        <CardContent className="p-4 sm:p-5">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-center">
            <label className="relative min-w-64 flex-1">
              <span className="sr-only">Search findings or resources</span>
              <Search
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <input
                className="h-11 w-full rounded-[0.625rem] border bg-card pl-9 pr-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
                placeholder="Search findings or resources"
                aria-label="Search findings or resources"
                value={search}
                onChange={(event) => {
                  onSearch(event.target.value)
                  onPage(1)
                }}
              />
            </label>
            <FilterSelect
              label="Sort findings"
              value={sort}
              onChange={(value) => {
                onSort(value as FindingSort)
                onPage(1)
              }}
            >
              <option value="priority">Decision readiness</option>
              <option value="monthly">Monthly value</option>
              <option value="confidence">Evidence score</option>
              <option value="freshness">Evidence freshness</option>
            </FilterSelect>
          </div>

          <div className="mt-4 flex flex-wrap gap-2" aria-label="Quick finding views">
            {quickViews.map((item) => (
              <button
                key={item.id}
                type="button"
                className={cn(
                  'min-h-11 rounded-full border px-4 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  quickView === item.id
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'bg-card text-muted-foreground hover:border-[var(--cp-border-strong)] hover:text-foreground',
                )}
                aria-pressed={quickView === item.id}
                onClick={() => {
                  onQuickView(item.id)
                  if (item.id === 'all') onStatus('active')
                  onPage(1)
                }}
              >
                {item.label}
              </button>
            ))}
          </div>

          <details className="mt-4 border-t pt-3">
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-md text-sm font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <SlidersHorizontal className="size-4 text-primary" aria-hidden="true" />
              Advanced filters
              {advancedFilterCount > 0 && (
                <Badge variant="secondary">{advancedFilterCount} active</Badge>
              )}
            </summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              <FilterSelect
                label="Activity"
                value={activity}
                onChange={(value) => {
                  onActivity(value as SavingsActivity | 'all')
                  onPage(1)
                }}
              >
                <option value="all">All activities</option>
                {savingsActivities.map((item) => (
                  <option key={item} value={item}>
                    {formatActivity(item)}
                  </option>
                ))}
              </FilterSelect>
              <FilterSelect
                label="Category"
                value={category}
                onChange={(value) => {
                  onCategory(value as RecommendationCategory | 'all')
                  onPage(1)
                }}
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
                onChange={(value) => {
                  onStatus(value as StatusFilter)
                  onPage(1)
                }}
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
                onChange={(value) => {
                  onSubscription(value)
                  onPage(1)
                }}
              >
                <option value="all">All subscriptions</option>
                {overview.subscriptions.map((subscription) => (
                  <option key={subscription.id} value={subscription.id}>
                    {subscription.name}
                  </option>
                ))}
              </FilterSelect>
              <FilterSelect
                label="Evidence score"
                value={String(minimumConfidence)}
                onChange={(value) => {
                  onMinimumConfidence(Number(value))
                  onPage(1)
                }}
              >
                <option value="0">Any evidence score</option>
                <option value="0.55">55% and above</option>
                <option value="0.8">80% and above</option>
                <option value="0.9">90% and above</option>
              </FilterSelect>
            </div>
            <label className="mt-4 flex min-h-11 w-fit cursor-pointer items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                className="size-4 accent-[var(--cp-accent)]"
                checked={includeExcepted}
                onChange={(event) => {
                  onIncludeExcepted(event.target.checked)
                  onPage(1)
                }}
              />
              Include excepted findings
            </label>
          </details>
        </CardContent>
      </Card>

      {activity === 'shutdown_scheduling' && (
        <div
          className="mt-4 flex items-start gap-3 rounded-[0.625rem] border border-warning bg-secondary p-4"
          role="status"
        >
          <AlertCircle
            className="mt-0.5 size-4 shrink-0 text-warning"
            aria-hidden="true"
          />
          <div>
            <div className="text-sm font-bold text-foreground">
              DevTest Lab schedule gap, not runtime proof
            </div>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              These VMs have no detected DevTest Lab auto-shutdown schedule.
              This does not rule out Azure Automation or external schedulers,
              and it does not prove 24/7 uptime. Historical Azure Monitor
              telemetry is required to establish actual runtime.
            </p>
          </div>
        </div>
      )}

      {scenarioActivity &&
        displayedRecommendations.length < recommendations.length && (
          <div
            className="mt-4 flex items-start gap-3 rounded-[0.625rem] border bg-secondary p-4"
            role="status"
          >
            <AlertCircle
              className="mt-0.5 size-4 shrink-0 text-primary"
              aria-hidden="true"
            />
            <div>
              <div className="text-sm font-bold text-foreground">
                Highest-value scenario per opportunity scope
              </div>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                Showing {displayedRecommendations.length} affected resource
                or commitment scopes from {recommendations.length} Advisor term
                and lookback scenarios. All source scenarios remain available
                in the report export.
              </p>
            </div>
          </div>
        )}

      <div className="my-4 flex flex-wrap items-center justify-between gap-3 text-sm">
        <span className="text-muted-foreground">
          <strong className="text-foreground">
            {displayedRecommendations.length}
          </strong>{' '}
          {scenarioActivity ? 'opportunity scopes' : 'findings'}
        </span>
        <div className="text-right">
          <div className="font-semibold text-foreground">
            {azureEstimatedValue.length
              ? `${formatCurrencyAmounts(
                  azureEstimatedValue,
                )} Azure estimated monthly opportunity`
              : 'No quantified Azure estimated opportunity'}
          </div>
          {calculatedScheduleValue.length > 0 && (
            <div className="mt-0.5 text-xs text-muted-foreground">
              {formatCurrencyAmounts(calculatedScheduleValue)} calculated
              schedule scenario · separate
            </div>
          )}
        </div>
      </div>

      <Card>
        <CardContent className="p-2 sm:p-4">
          <RecommendationTable
            recommendations={pagedRecommendations}
            onSelect={onSelect}
            onSelectSubscription={onSelectSubscription}
            onSelectResource={onSelectResource}
            warnings={warnings}
          />
        </CardContent>
      </Card>

      {pageCount > 1 && (
        <nav
          className="mt-4 flex items-center justify-between gap-3"
          aria-label="Finding pages"
        >
          <Button
            variant="outline"
            disabled={currentPage === 1}
            onClick={() => onPage(currentPage - 1)}
          >
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            Page <strong className="text-foreground">{currentPage}</strong> of{' '}
            {pageCount}
          </span>
          <Button
            variant="outline"
            disabled={currentPage === pageCount}
            onClick={() => onPage(currentPage + 1)}
          >
            Next
          </Button>
        </nav>
      )}
    </div>
  )
}

function OutcomesView({ overview }: { overview: OverviewResponse }) {
  const realizedLast30Days = overview.savings.byCurrency.flatMap((summary) =>
    typeof summary.measuredSavingsLast30Days === 'number'
      ? [
          {
            currency: summary.currency,
            amount: summary.measuredSavingsLast30Days,
          },
        ]
      : [],
  )
  const realizedAllTime = overview.savings.byCurrency.flatMap((summary) =>
    typeof summary.measuredSavingsAllTime === 'number'
      ? [
          {
            currency: summary.currency,
            amount: summary.measuredSavingsAllTime,
          },
        ]
      : [],
  )
  const measured =
    typeof overview.savings.measuredResultCount === 'number' &&
    overview.savings.measuredResultCount > 0
  const storedPeriods = overview.savings.byCurrency.reduce(
    (total, summary) => total + summary.costTrend.length,
    0,
  )
  return (
    <div className="mx-auto max-w-[1500px]">
      <PageHeading
        title={measured ? 'Measured outcomes' : 'Outcomes are not measured yet'}
        description={
          measured
            ? 'Measured results remain separate from Azure estimates and calculated opportunity scenarios.'
            : 'Potential value is not an outcome. Complete remediation and compare subsequent cost periods before reporting realised savings.'
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Measurement status"
          value={measured ? 'Measured' : 'Not measured'}
          detail={
            measured
              ? `${overview.savings.measuredResultCount} measured results`
              : `${storedPeriods} stored cost periods · none verified`
          }
          icon={CircleDollarSign}
          tone={measured ? 'outcome' : 'default'}
        />
        <StatCard
          label="Measured result count"
          value={
            measured
              ? overview.savings.measuredResultCount.toLocaleString()
              : 'Not measured'
          }
          detail={`${storedPeriods} stored cost periods`}
          icon={CheckCircle2}
          tone={measured ? 'outcome' : 'default'}
        />
        <StatCard
          label="Realised, latest period"
          value={
            measured
              ? formatCurrencyAmounts(realizedLast30Days, true)
              : 'Not measured'
          }
          detail="reported only from verified cost comparison"
          icon={BarChart3}
          tone={measured ? 'outcome' : 'default'}
        />
        <StatCard
          label="Realised, all measured periods"
          value={
            measured
              ? formatCurrencyAmounts(realizedAllTime, true)
              : 'Not measured'
          }
          detail={
            measured
              ? `${Math.round(
                  overview.savings.measuredResultCoverage ?? 0,
                )}% measurement coverage`
              : 'No verified outcome baseline'
          }
          icon={Gauge}
          tone={measured ? 'outcome' : 'default'}
        />
      </div>

      {!measured && (
        <div className="mt-6 flex items-start gap-3 rounded-xl border border-primary bg-accent p-4">
          <ShieldAlert
            className="mt-0.5 size-5 shrink-0 text-primary"
            aria-hidden="true"
          />
          <div>
            <div className="font-bold text-foreground">
              Opportunity is not an outcome
            </div>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              Gold values remain Azure estimates or calculated scenarios until
              an approved remediation has a comparable post-change cost period.
              Green is reserved for measured realised results.
            </p>
          </div>
        </div>
      )}
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
                      ? 'bg-primary'
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
  title,
  description,
}: {
  title: string
  description: string
}) {
  return (
    <div className="mb-7">
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
        className="h-11 w-full rounded-[0.625rem] border bg-card px-3 text-sm font-semibold text-foreground outline-none focus:ring-2 focus:ring-ring"
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
