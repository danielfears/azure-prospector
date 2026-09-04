import type {
  CreateActionRequest,
  CreateExceptionRequest,
  ActionStatus,
  AssessmentSummary,
  AuthStatusResponse,
  AzureSubscriptionOption,
  OverviewResponse,
  Recommendation,
  RecommendationQuery,
  RemediationAction,
  ScanRecord,
  StartScanRequest,
} from '@/shared/types'

export class ApiRequestError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiRequestError'
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: string; details?: string }
      | null
    throw new ApiRequestError(
      payload?.details || payload?.error || `Request failed with status ${response.status}`,
      response.status,
    )
  }

  if (response.status === 204) {
    return undefined as T
  }

  return (await response.json()) as T
}

export function getOverview() {
  return request<OverviewResponse>('/api/overview')
}

export function getAssessments() {
  return request<AssessmentSummary[]>('/api/assessments')
}

export function openAssessmentWorkspace(assessmentId: string) {
  return request<AssessmentSummary>(
    `/api/assessments/${encodeURIComponent(assessmentId)}`,
    { method: 'POST' },
  )
}

export function deleteAssessmentWorkspace(assessmentId: string) {
  return request<void>(
    `/api/assessments/${encodeURIComponent(assessmentId)}`,
    { method: 'DELETE' },
  )
}

export function getAuthStatus() {
  return request<AuthStatusResponse>('/api/auth/status')
}

export function getAzureSubscriptions() {
  return request<AzureSubscriptionOption[]>('/api/azure/subscriptions')
}

export function signInWithBrowser() {
  return request<AuthStatusResponse>('/api/auth/login', {
    method: 'POST',
  })
}

export function getRecommendations(query: RecommendationQuery = {}) {
  const params = new URLSearchParams()
  if (query.search) params.set('search', query.search)
  if (query.category) params.set('category', query.category)
  if (query.status) params.set('status', query.status)
  if (query.subscriptionId) params.set('subscriptionId', query.subscriptionId)
  if (query.owner) params.set('owner', query.owner)
  if (query.minimumConfidence !== undefined) {
    params.set('minimumConfidence', String(query.minimumConfidence))
  }
  if (query.includeExcepted) params.set('includeExcepted', 'true')

  const suffix = params.size ? `?${params.toString()}` : ''
  return request<Recommendation[]>(`/api/recommendations${suffix}`)
}

export function startScan(payload: StartScanRequest) {
  return request<ScanRecord>('/api/scans', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function createException(
  recommendationId: string,
  payload: CreateExceptionRequest,
) {
  return request<Recommendation>(
    `/api/recommendations/${encodeURIComponent(recommendationId)}/exceptions`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
  )
}

export function clearException(recommendationId: string) {
  return request<void>(
    `/api/recommendations/${encodeURIComponent(recommendationId)}/exceptions`,
    { method: 'DELETE' },
  )
}

export function createAction(
  recommendationId: string,
  payload: CreateActionRequest,
) {
  return request<RemediationAction>(
    `/api/recommendations/${encodeURIComponent(recommendationId)}/actions`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
  )
}

export function getActions() {
  return request<RemediationAction[]>('/api/actions')
}

export function updateActionStatus(actionId: string, status: ActionStatus) {
  return request<RemediationAction>(`/api/actions/${encodeURIComponent(actionId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  })
}
