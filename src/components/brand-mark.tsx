import { Pickaxe } from 'lucide-react'

interface BrandMarkProps {
  compact?: boolean
}

export function BrandMark({ compact = false }: BrandMarkProps) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-[0.625rem] bg-primary text-primary-foreground shadow-card">
        <Pickaxe className="size-5" aria-hidden="true" />
      </div>
      {!compact && (
        <div className="min-w-0">
          <div className="truncate text-[15px] font-bold tracking-[-0.01em] text-foreground">
            Azure Prospector
          </div>
          <div className="truncate text-xs text-muted-foreground">
            Cloud savings intelligence
          </div>
        </div>
      )}
    </div>
  )
}
