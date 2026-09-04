import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  LockKeyhole,
} from 'lucide-react'

import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'
import type { CoverageItem } from '@/shared/types'

interface CoveragePanelProps {
  coverage: CoverageItem[]
}

const statusIcon = {
  complete: CheckCircle2,
  partial: CircleDashed,
  missing: AlertTriangle,
  unavailable: LockKeyhole,
}

export function CoveragePanel({ coverage }: CoveragePanelProps) {
  return (
    <div className="space-y-5">
      {coverage.map((item) => {
        const Icon = statusIcon[item.status]
        return (
          <div key={item.key}>
            <div className="mb-2 flex items-start justify-between gap-4">
              <div className="flex min-w-0 items-start gap-2.5">
                <Icon
                  className={cn(
                    'mt-0.5 size-4 shrink-0',
                    item.status === 'complete' && 'text-foreground',
                    item.status === 'partial' && 'text-warning',
                    item.status === 'missing' && 'text-destructive',
                    item.status === 'unavailable' &&
                      'text-muted-foreground',
                  )}
                  aria-hidden="true"
                />
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-foreground">{item.label}</div>
                  <div className="mt-0.5 text-xs leading-5 text-muted-foreground">
                    {item.description}
                  </div>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    Source: {item.source}
                  </div>
                </div>
              </div>
              <span className="shrink-0 text-sm font-bold text-foreground">
                {item.status === 'unavailable'
                  ? 'N/A'
                  : `${Math.round(item.percentage)}%`}
              </span>
            </div>
            {item.status !== 'unavailable' && (
              <Progress value={item.percentage} />
            )}
            {item.action && (
              <p className="mt-1.5 pl-6 text-xs text-muted-foreground">{item.action}</p>
            )}
          </div>
        )
      })}
    </div>
  )
}
