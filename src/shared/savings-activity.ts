import {
  savingsActivities,
  type SavingsActivity,
} from './types.js'

export interface SavingsActivityClassificationInput {
  title: string
  description: string
  category: string
  resourceType: string
}

export interface SavingsOpportunityScopeInput {
  activity: SavingsActivity
  subscriptionId: string
  title: string
  resourceType: string
  resourceId?: string
  fingerprint: string
  evidence?: Array<{
    label: string
    value: string | number
  }>
}

const SAVINGS_PLAN = /\bsavings?[\s-]+plans?\b/i
const RESERVED_INSTANCE =
  /\b(?:reserved(?:[\s-]+(?:vm|virtual[\s-]+machine|database|sql))?[\s-]+instances?|reserved[\s-]+capacity|reservations?|reservation[\s-]*orders?)\b/i
const HYBRID_BENEFIT =
  /\b(?:azure[\s-]+hybrid[\s-]+benefit|hybrid[\s-]+benefit|bring[\s-]+your[\s-]+own[\s-]+licen[cs]e|byol|licen[cs]e[\s-]+mobility)\b/i
const SHUTDOWN_SCHEDULING =
  /\b(?:auto[\s-]*shut[\s-]*down|shut[\s-]*down[\s-]+schedul|start[\s/,-]*stop[\s-]+schedul|off[\s-]*hours|operating[\s-]+hours|deallocat\w*[\s-]+(?:overnight|outside)|schedul\w*[\s-]+(?:gap|coverage|missing|not[\s-]+found))\b/i
const ORPHAN = /\borphan(?:ed)?\b/i
const ORPHAN_RESOURCE =
  /\b(?:(?:managed[\s-]*)?disks?|public[\s-]*ip(?:[\s-]*addresses?)?|network[\s-]*interfaces?|nics?|app[\s-]*service[\s-]*plans?)\b/i
const ORPHAN_STATE =
  /\b(?:unattached|not[\s-]+attached|unused|unassociated|not[\s-]+associated|empty|no[\s-]+(?:ip[\s-]+configuration|virtual[\s-]+machine|deployed[\s-]+sites?|attachment)|attachment[\s-]+(?:is[\s-]+)?none)\b/i
const EXPLICIT_RIGHT_SIZING =
  /\b(?:right[\s-]*siz\w*|resiz\w*|downsiz\w*)\b/i
const UTILISATION_RIGHT_SIZING =
  /\b(?:under[\s-]*utili[sz]ed|low[\s-]+utili[sz]ation|over[\s-]*provisioned|smaller[\s-]+(?:sku|size|tier)|reduce[\s-]+(?:node|instance)[\s-]+count)\b/i
const STORAGE_TEXT =
  /\b(?:storage|blob|disk|snapshot|archive|retention|lifecycle|access[\s-]+tier|hot[\s-]+tier|cool[\s-]+tier|cold[\s-]+tier)\b/i
const DATABASE_TEXT =
  /\b(?:database|sql|postgres(?:ql)?|mysql|cosmos[\s-]*db|maria[\s-]*db|dbfor)\b/i
const NETWORK_TEXT =
  /\b(?:network|bandwidth|egress|nat[\s-]*gateways?|load[\s-]*balancers?|application[\s-]*gateways?|expressroute|virtual[\s-]*wan)\b/i
const COMPUTE_RESOURCE =
  /\b(?:compute|virtual[\s-]*machines?|managedclusters|agentpools|containers?|serverfarms)\b/i

export function isSavingsActivity(value: unknown): value is SavingsActivity {
  return (
    typeof value === 'string' &&
    (savingsActivities as readonly string[]).includes(value)
  )
}

export function classifySavingsActivity(
  input: SavingsActivityClassificationInput,
): SavingsActivity {
  const title = input.title.trim()
  const category = input.category.toLowerCase()
  const details = [
    input.description,
    input.category,
    input.resourceType,
  ].join(' ')
  const allText = `${title} ${details}`

  // Prefer the recommendation title when descriptions mention alternatives.
  if (SAVINGS_PLAN.test(title)) return 'savings_plans'
  if (RESERVED_INSTANCE.test(title)) return 'reserved_instances'
  if (SAVINGS_PLAN.test(details)) return 'savings_plans'
  if (RESERVED_INSTANCE.test(details)) return 'reserved_instances'
  if (HYBRID_BENEFIT.test(allText)) return 'licensing_hybrid_benefit'
  if (
    category === 'scheduling' ||
    SHUTDOWN_SCHEDULING.test(allText)
  ) {
    return 'shutdown_scheduling'
  }
  if (
    ORPHAN.test(allText) ||
    (ORPHAN_RESOURCE.test(allText) && ORPHAN_STATE.test(allText))
  ) {
    return 'orphan_cleanup'
  }
  if (
    EXPLICIT_RIGHT_SIZING.test(allText) ||
    (UTILISATION_RIGHT_SIZING.test(allText) &&
      (category === 'compute' ||
        COMPUTE_RESOURCE.test(input.resourceType)))
  ) {
    return 'right_sizing'
  }
  if (
    category === 'database' ||
    DATABASE_TEXT.test(input.resourceType)
  ) {
    return 'database_optimization'
  }
  if (
    category === 'network' ||
    NETWORK_TEXT.test(input.resourceType)
  ) {
    return 'network_optimization'
  }
  if (
    category === 'storage' ||
    STORAGE_TEXT.test(input.resourceType)
  ) {
    return 'storage_optimization'
  }
  if (DATABASE_TEXT.test(allText)) return 'database_optimization'
  if (NETWORK_TEXT.test(allText)) {
    return 'network_optimization'
  }
  if (STORAGE_TEXT.test(allText)) return 'storage_optimization'
  return 'other'
}

export function savingsOpportunityScopeKey(
  recommendation: SavingsOpportunityScopeInput,
): string {
  if (
    recommendation.activity !== 'reserved_instances' &&
    recommendation.activity !== 'savings_plans'
  ) {
    return recommendation.resourceId ?? recommendation.fingerprint
  }
  const evidenceValue = (label: string): string =>
    String(
      recommendation.evidence?.find(
        (item) => item.label === label,
      )?.value ?? '',
    )
      .trim()
      .toLowerCase()
  const baseTitle = recommendation.title
    .replace(/\s*\([^)]*(?:lookback|years?)[^)]*\)\s*$/i, '')
    .trim()
    .toLowerCase()
  return [
    recommendation.subscriptionId.toLowerCase(),
    recommendation.activity,
    recommendation.resourceType.toLowerCase(),
    baseTitle,
    evidenceValue('Recommended SKU'),
    evidenceValue('Recommendation region'),
  ].join('|')
}
