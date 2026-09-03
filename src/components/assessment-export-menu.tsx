import { Download, FileJson, Table2 } from 'lucide-react'

import { Button } from '@/components/ui/button'

export function AssessmentExportMenu({
  assessmentId,
}: {
  assessmentId: string
}) {
  const basePath = `/api/assessments/${encodeURIComponent(assessmentId)}/export`
  return (
    <details className="relative">
      <summary
        className="inline-flex h-9 cursor-pointer list-none items-center justify-center gap-2 whitespace-nowrap rounded-md border border-input bg-card px-4 py-2 text-sm font-semibold text-foreground shadow-card transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden"
        aria-label="Export assessment"
      >
        <Download className="size-4" aria-hidden="true" />
        <span className="hidden sm:inline">Export</span>
      </summary>
      <div className="absolute right-0 z-40 mt-2 w-56 rounded-xl border bg-card p-2 shadow-card">
        <Button asChild variant="ghost" className="w-full justify-start">
          <a href={`${basePath}?format=json`}>
            <FileJson aria-hidden="true" />
            Complete JSON report
          </a>
        </Button>
        <Button asChild variant="ghost" className="w-full justify-start">
          <a href={`${basePath}?format=csv`}>
            <Table2 aria-hidden="true" />
            Findings CSV
          </a>
        </Button>
      </div>
    </details>
  )
}
