import {
  AlertTriangle,
  FolderOpen,
  RefreshCw,
  Trash2,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { formatDate } from '@/lib/format'
import type { AssessmentSummary } from '@/shared/types'

interface AssessmentCollectionProps {
  assessments: AssessmentSummary[]
  busy: boolean
  onOpen: (assessment: AssessmentSummary) => void
  onRescan: (assessment: AssessmentSummary) => void
  onDelete: (assessment: AssessmentSummary) => void
}

export function AssessmentCollection({
  assessments,
  busy,
  onOpen,
  onRescan,
  onDelete,
}: AssessmentCollectionProps) {
  if (!assessments.length) return null

  return (
    <section className="mx-auto mt-8 max-w-5xl">
      <div className="mb-3 flex items-end justify-between gap-4 px-1">
        <div>
          <h2 className="text-base font-bold text-foreground">
            Saved assessments
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Reopen results, refresh an existing scope, or remove old work.
          </p>
        </div>
        <span className="text-xs font-semibold text-muted-foreground">
          {assessments.length}{' '}
          {assessments.length === 1 ? 'assessment' : 'assessments'}
        </span>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {assessments.map((assessment) => (
          <Card key={assessment.id}>
            <CardContent className="p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="truncate text-sm font-bold text-foreground">
                    {assessment.name}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {assessment.subscriptionsDiscovered}{' '}
                    {assessment.subscriptionsDiscovered === 1
                      ? 'subscription'
                      : 'subscriptions'}{' '}
                    · {assessment.recommendationsFound} findings
                  </div>
                </div>
                <Badge
                  variant={
                    assessment.status === 'failed'
                      ? 'destructive'
                      : assessment.warningCount
                        ? 'secondary'
                        : 'outline'
                  }
                >
                  {assessment.status === 'failed'
                    ? 'Failed'
                    : assessment.status === 'running'
                      ? 'Running'
                    : assessment.warningCount
                      ? `${assessment.warningCount} ${
                          assessment.warningCount === 1
                            ? 'warning'
                            : 'warnings'
                        }`
                      : 'Complete'}
                </Badge>
              </div>

              <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                {assessment.status === 'failed' ? (
                  <AlertTriangle className="size-3.5" aria-hidden="true" />
                ) : (
                  <FolderOpen className="size-3.5" aria-hidden="true" />
                )}
                {assessment.lastScanAt
                  ? `Last run ${formatDate(assessment.lastScanAt, true)}`
                  : `Created ${formatDate(assessment.createdAt, true)}`}
              </div>

              <div className="mt-5 flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  disabled={busy || assessment.status !== 'completed'}
                  onClick={() => onOpen(assessment)}
                >
                  <FolderOpen aria-hidden="true" />
                  Open
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || assessment.status === 'running'}
                  onClick={() => onRescan(assessment)}
                >
                  <RefreshCw aria-hidden="true" />
                  Rescan
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={busy || assessment.status === 'running'}
                  aria-label={`Delete ${assessment.name}`}
                  title={`Delete ${assessment.name}`}
                  onClick={() => onDelete(assessment)}
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  )
}
