import {
  AlertTriangle,
  Cloud,
  Play,
  RefreshCw,
  Search,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import type { AzureSubscriptionOption } from '@/shared/types'

interface SubscriptionPickerProps {
  open: boolean
  subscriptions: AzureSubscriptionOption[]
  selectedIds: string[]
  search: string
  assessmentName: string
  editing: boolean
  busy: boolean
  refreshing: boolean
  onOpenChange: (open: boolean) => void
  onSelectedIdsChange: (ids: string[]) => void
  onSearchChange: (search: string) => void
  onAssessmentNameChange: (name: string) => void
  onRefresh: () => void
  onSubmit: () => void
}

export function SubscriptionPicker({
  open,
  subscriptions,
  selectedIds,
  search,
  assessmentName,
  editing,
  busy,
  refreshing,
  onOpenChange,
  onSelectedIdsChange,
  onSearchChange,
  onAssessmentNameChange,
  onRefresh,
  onSubmit,
}: SubscriptionPickerProps) {
  const normalizedSearch = search.trim().toLocaleLowerCase()
  const filtered = subscriptions.filter((subscription) =>
    [
      subscription.name,
      subscription.tenantName,
    ].some((value) =>
      value.toLocaleLowerCase().includes(normalizedSearch),
    ),
  )
  const byTenant = new Map<
    string,
    { tenantName: string; subscriptions: AzureSubscriptionOption[] }
  >()
  for (const subscription of filtered) {
    const group = byTenant.get(subscription.tenantId) ?? {
      tenantName: subscription.tenantName,
      subscriptions: [],
    }
    group.subscriptions.push(subscription)
    byTenant.set(subscription.tenantId, group)
  }
  const staleTenantCount = new Set(
    subscriptions
      .filter(
        (subscription) =>
          subscription.authenticationStatus === 'refresh_required',
      )
      .map((subscription) => subscription.tenantId),
  ).size
  const subscriptionById = new Map(
    subscriptions.map((subscription) => [subscription.id, subscription]),
  )
  const staleSelectedCount = selectedIds.filter(
    (id) =>
      subscriptionById.get(id)?.authenticationStatus ===
      'refresh_required',
  ).length
  const unavailableSelectedCount = selectedIds.filter(
    (id) => !subscriptionById.has(id),
  ).length

  function toggle(subscriptionId: string) {
    onSelectedIdsChange(
      selectedIds.includes(subscriptionId)
        ? selectedIds.filter((id) => id !== subscriptionId)
        : [...selectedIds, subscriptionId],
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl gap-0 overflow-hidden p-0">
        <div className="border-b p-6">
          <DialogHeader>
            <DialogTitle>
              {editing ? 'Rescan cost assessment' : 'New cost assessment'}
            </DialogTitle>
            <DialogDescription>
              {editing
                ? 'Review the saved scope, refresh stale tenant sessions, then run the assessment again.'
                : 'Name the assessment, then search and tick only the subscriptions that belong to this project.'}
            </DialogDescription>
          </DialogHeader>

          <label className="mt-5 block">
            <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
              Assessment name
            </span>
            <input
              className="mt-2 h-10 w-full rounded-[0.625rem] border bg-card px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
              placeholder="Project X cost assessment"
              value={assessmentName}
              maxLength={120}
              onChange={(event) =>
                onAssessmentNameChange(event.target.value)
              }
            />
          </label>

          <label className="relative mt-4 block">
            <span className="sr-only">Search subscriptions</span>
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <input
              className="h-10 w-full rounded-[0.625rem] border bg-card pl-9 pr-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
              placeholder="Search subscriptions or tenants"
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
            />
          </label>
          <div className="mt-2 text-xs text-muted-foreground">
            {filtered.length} matching · {selectedIds.length} selected
            {staleTenantCount
              ? ` · ${staleTenantCount} ${
                  staleTenantCount === 1 ? 'tenant needs' : 'tenants need'
                } refresh`
              : ''}
          </div>
          {(staleSelectedCount > 0 || unavailableSelectedCount > 0) && (
            <div className="mt-3 rounded-[0.625rem] border border-destructive bg-secondary p-3 text-xs leading-5 text-foreground">
              {staleSelectedCount > 0
                ? `${staleSelectedCount} saved ${
                    staleSelectedCount === 1
                      ? 'subscription needs'
                      : 'subscriptions need'
                  } a tenant session refresh before this assessment can run.`
                : null}
              {staleSelectedCount > 0 && unavailableSelectedCount > 0
                ? ' '
                : null}
              {unavailableSelectedCount > 0
                ? `${unavailableSelectedCount} saved ${
                    unavailableSelectedCount === 1
                      ? 'subscription is'
                      : 'subscriptions are'
                  } no longer visible to the signed-in account.`
                : null}
              {unavailableSelectedCount > 0 && (
                <button
                  type="button"
                  className="ml-2 font-bold text-primary hover:underline"
                  onClick={() =>
                    onSelectedIdsChange(
                      selectedIds.filter((id) =>
                        subscriptionById.has(id),
                      ),
                    )
                  }
                >
                  Remove unavailable
                </button>
              )}
            </div>
          )}
        </div>

        <div className="max-h-[46vh] overflow-y-auto p-4">
          {!filtered.length ? (
            <div className="flex min-h-40 flex-col items-center justify-center text-center">
              <Search className="size-6 text-primary" aria-hidden="true" />
              <div className="mt-3 text-sm font-bold text-foreground">
                No subscriptions match
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Try a shorter part of the project or subscription name.
              </p>
            </div>
          ) : (
            <div className="space-y-5">
              {[...byTenant.entries()].map(
                ([tenantId, { tenantName, subscriptions: items }]) => {
                  const refreshRequired = items.every(
                    (subscription) =>
                      subscription.authenticationStatus ===
                      'refresh_required',
                  )
                  return (
                <section key={tenantId}>
                  <div className="mb-2 flex items-center justify-between gap-3 px-2">
                    <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
                      {tenantName}
                    </div>
                    <span
                      className={cn(
                        'text-[11px] font-semibold',
                        refreshRequired
                          ? 'text-destructive'
                          : 'text-success',
                      )}
                    >
                      {refreshRequired ? 'Refresh required' : 'Session ready'}
                    </span>
                  </div>
                  {refreshRequired && (
                    <div className="mb-2 rounded-[0.625rem] border border-destructive bg-secondary p-3">
                      <div className="flex items-start gap-2">
                        <AlertTriangle
                          className="mt-0.5 size-4 shrink-0 text-destructive"
                          aria-hidden="true"
                        />
                        <div className="min-w-0">
                          <div className="text-xs font-bold text-foreground">
                            Azure CLI sign-in has expired for this tenant
                          </div>
                          <p className="mt-1 text-xs leading-5 text-muted-foreground">
                            Refresh it in a terminal, then recheck sessions.
                          </p>
                          <code className="mt-2 block overflow-x-auto rounded-md border bg-card px-2 py-1 text-xs text-foreground">
                            az login --tenant {tenantId} --use-device-code
                            {' '}--allow-no-subscriptions
                          </code>
                        </div>
                      </div>
                    </div>
                  )}
                  <div className="space-y-2">
                    {items.map((subscription) => (
                      <label
                        key={subscription.id}
                        className={cn(
                          'flex items-center gap-3 rounded-[0.625rem] border bg-card p-3 transition-colors',
                          refreshRequired
                            ? 'cursor-not-allowed opacity-55'
                            : 'cursor-pointer hover:bg-secondary',
                        )}
                      >
                        <input
                          type="checkbox"
                          className="size-4 shrink-0 accent-[var(--cp-accent)]"
                          checked={selectedIds.includes(subscription.id)}
                          disabled={refreshRequired}
                          onChange={() => toggle(subscription.id)}
                        />
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-primary">
                          <Cloud className="size-4" aria-hidden="true" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold text-foreground">
                            {subscription.name}
                          </span>
                          <span className="mt-0.5 block text-xs text-muted-foreground">
                            {subscription.isDefault
                              ? 'Current CLI subscription'
                              : refreshRequired
                                ? 'Refresh tenant sign-in to select'
                                : 'Enabled subscription'}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                </section>
                  )
                },
              )}
            </div>
          )}
        </div>

        <DialogFooter className="border-t bg-secondary p-4">
          {staleTenantCount > 0 && (
            <Button
              variant="outline"
              disabled={busy || refreshing}
              onClick={onRefresh}
            >
              <RefreshCw
                className={cn(refreshing && 'animate-spin')}
                aria-hidden="true"
              />
              {refreshing ? 'Checking sessions' : 'Recheck sessions'}
            </Button>
          )}
          <Button
            disabled={
              busy ||
              refreshing ||
              !assessmentName.trim() ||
              selectedIds.length === 0 ||
              staleSelectedCount > 0 ||
              unavailableSelectedCount > 0
            }
            onClick={onSubmit}
          >
            <Play aria-hidden="true" />
            {editing ? 'Run assessment again' : 'Start assessment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
