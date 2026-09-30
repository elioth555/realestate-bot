import { CloudOff, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

export function ListingsLoading() {
  return (
    <div role="status" aria-label="Loading listings from Supabase">
      <p className="mb-4 text-sm text-muted-foreground">Loading listings…</p>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="overflow-hidden rounded-xl border bg-card">
            <Skeleton className="aspect-[4/3] w-full rounded-none" />
            <div className="flex flex-col gap-3 p-4">
              <Skeleton className="h-6 w-32" />
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function ListingsError({ message, hint, onRetry }: { message: string; hint?: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center rounded-xl border border-destructive/30 bg-card px-6 py-16 text-center"
    >
      <span className="mb-3 flex size-11 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <CloudOff className="size-5" aria-hidden="true" />
      </span>
      <h3 className="text-sm font-semibold">{message}</h3>
      {hint && <p className="mt-1 max-w-md text-sm text-muted-foreground">{hint}</p>}
      <Button variant="outline" size="sm" onClick={onRetry} className="mt-4 gap-1.5">
        <RotateCcw className="size-3.5" aria-hidden="true" />
        Try again
      </Button>
    </div>
  )
}
