import type { LucideIcon } from 'lucide-react'
import { ArrowDownRight, ArrowUpRight } from 'lucide-react'

import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'

interface StatCardProps {
  label: string
  value: string
  detail: string
  icon: LucideIcon
  trend?: number
  accent?: boolean
}

export function StatCard({
  label,
  value,
  detail,
  icon: Icon,
  trend,
  accent = false,
}: StatCardProps) {
  const improving = trend !== undefined && trend >= 0

  return (
    <Card className={cn('overflow-hidden', accent && 'border-primary')}>
      <CardContent className="p-5">
        <div className="mb-5 flex items-start justify-between gap-4">
          <span className="text-sm font-medium text-muted-foreground">{label}</span>
          <span
            className={cn(
              'flex size-9 items-center justify-center rounded-[0.625rem]',
              accent ? 'bg-accent text-accent-foreground' : 'bg-secondary text-foreground',
            )}
          >
            <Icon className="size-4" aria-hidden="true" />
          </span>
        </div>
        <div className="text-3xl font-bold tracking-[-0.04em] text-foreground">{value}</div>
        <div className="mt-2 flex min-h-5 items-center gap-1.5 text-xs text-muted-foreground">
          {trend !== undefined && (
            <span
              className={cn(
                'inline-flex items-center gap-0.5 font-semibold',
                improving ? 'text-success' : 'text-destructive',
              )}
            >
              {improving ? (
                <ArrowUpRight className="size-3.5" aria-hidden="true" />
              ) : (
                <ArrowDownRight className="size-3.5" aria-hidden="true" />
              )}
              {Math.abs(trend).toFixed(1)}%
            </span>
          )}
          <span>{detail}</span>
        </div>
      </CardContent>
    </Card>
  )
}
