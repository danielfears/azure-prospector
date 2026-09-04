import { Cloud, Pickaxe, Sparkles } from 'lucide-react'

interface ScanProgressProps {
  assessmentName: string
  subscriptionCount: number
}

export function ScanProgress({
  assessmentName,
  subscriptionCount,
}: ScanProgressProps) {
  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-[var(--cp-overlay)] p-6 backdrop-blur-sm"
      role="status"
      aria-live="polite"
    >
      <div className="w-full max-w-md rounded-2xl border bg-card p-8 text-center shadow-card">
        <div className="relative mx-auto size-28">
          <div className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-primary" />
          <div className="absolute inset-3 animate-[spin_2.8s_linear_infinite_reverse] rounded-full border border-transparent border-b-success" />
          <div className="absolute inset-6 flex items-center justify-center rounded-full border bg-secondary text-primary shadow-sm">
            <Pickaxe className="size-8 animate-pulse" aria-hidden="true" />
          </div>
          <Sparkles
            className="absolute right-0 top-2 size-5 animate-pulse text-primary"
            aria-hidden="true"
          />
          <Cloud
            className="absolute bottom-1 left-0 size-5 animate-pulse text-primary"
            aria-hidden="true"
          />
        </div>
        <div className="mt-6 text-xs font-bold uppercase tracking-[0.16em] text-primary">
          Prospecting Azure
        </div>
        <h2 className="mt-2 text-xl font-bold text-foreground">
          {assessmentName}
        </h2>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Gathering inventory, Advisor recommendations, native billing data,
          ownership and coverage for {subscriptionCount}{' '}
          {subscriptionCount === 1 ? 'subscription' : 'subscriptions'}.
        </p>
        <div className="mx-auto mt-5 flex w-fit items-center gap-1.5">
          {[0, 1, 2].map((index) => (
            <span
              key={index}
              className="size-2 animate-pulse rounded-full bg-primary"
              style={{ animationDelay: `${index * 180}ms` }}
            />
          ))}
        </div>
        <p className="mt-4 text-xs text-muted-foreground">
          Cost evidence is paced to respect Azure throttling. Larger
          assessments can take several minutes.
        </p>
      </div>
    </div>
  )
}
