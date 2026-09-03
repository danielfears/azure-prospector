import type {
  ActionStatus,
  ConfidenceBand,
  RecommendationCategory,
  RecommendationStatus,
} from '@/shared/types'

export function formatCurrency(
  value: number,
  currency = 'USD',
  compact = false,
) {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    maximumFractionDigits: compact ? 1 : 0,
    notation: compact ? 'compact' : 'standard',
  }).format(value)
}

export function formatDate(value?: string, includeTime = false) {
  if (!value) return 'Not yet'
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    ...(includeTime ? { timeStyle: 'short' } : {}),
  }).format(new Date(value))
}

export function formatCategory(category: RecommendationCategory) {
  return category.charAt(0).toUpperCase() + category.slice(1)
}

export function formatStatus(status: RecommendationStatus) {
  return formatLabel(status)
}

export function formatActionStatus(status: ActionStatus) {
  return formatLabel(status)
}

function formatLabel(value: string) {
  return value
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export function confidenceBand(confidence: number): ConfidenceBand {
  if (confidence >= 0.8) return 'high'
  if (confidence >= 0.55) return 'medium'
  return 'low'
}
