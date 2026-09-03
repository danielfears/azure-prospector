import { Cloud, Play, Search } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { AzureSubscriptionOption } from '@/shared/types'

interface SubscriptionPickerProps {
  open: boolean
  subscriptions: AzureSubscriptionOption[]
  selectedIds: string[]
  search: string
  assessmentName: string
  busy: boolean
  onOpenChange: (open: boolean) => void
  onSelectedIdsChange: (ids: string[]) => void
  onSearchChange: (search: string) => void
  onAssessmentNameChange: (name: string) => void
  onSubmit: () => void
}

export function SubscriptionPicker({
  open,
  subscriptions,
  selectedIds,
  search,
  assessmentName,
  busy,
  onOpenChange,
  onSelectedIdsChange,
  onSearchChange,
  onAssessmentNameChange,
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
  const byTenant = new Map<string, AzureSubscriptionOption[]>()
  for (const subscription of filtered) {
    const group = byTenant.get(subscription.tenantName) ?? []
    group.push(subscription)
    byTenant.set(subscription.tenantName, group)
  }

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
            <DialogTitle>New cost assessment</DialogTitle>
            <DialogDescription>
              Name the assessment, then search and tick only the subscriptions
              that belong to this project.
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
          </div>
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
              {[...byTenant.entries()].map(([tenantName, items]) => (
                <section key={tenantName}>
                  <div className="mb-2 px-2 text-[11px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
                    {tenantName}
                  </div>
                  <div className="space-y-2">
                    {items.map((subscription) => (
                      <label
                        key={subscription.id}
                        className="flex cursor-pointer items-center gap-3 rounded-[0.625rem] border bg-card p-3 transition-colors hover:bg-secondary"
                      >
                        <input
                          type="checkbox"
                          className="size-4 shrink-0 accent-[var(--cp-accent)]"
                          checked={selectedIds.includes(subscription.id)}
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
                              : 'Enabled subscription'}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>

        <DialogFooter className="border-t bg-secondary p-4">
          <Button
            disabled={
              busy ||
              !assessmentName.trim() ||
              selectedIds.length === 0
            }
            onClick={onSubmit}
          >
            <Play aria-hidden="true" />
            Start assessment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
