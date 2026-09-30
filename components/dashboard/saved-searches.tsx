import { Bookmark, Play, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { describeFilters, type SavedSearch } from '@/lib/filters'

type SavedSearchesProps = {
  searches: SavedSearch[]
  matchCount: (search: SavedSearch) => number
  onRun: (search: SavedSearch) => void
  onDelete: (id: string) => void
}

export function SavedSearches({ searches, matchCount, onRun, onDelete }: SavedSearchesProps) {
  if (searches.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed bg-card px-6 py-16 text-center">
        <span className="mb-3 flex size-11 items-center justify-center rounded-full bg-accent text-primary">
          <Bookmark className="size-5" aria-hidden="true" />
        </span>
        <h3 className="text-sm font-semibold">No saved searches yet</h3>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          Set your filters and click &quot;Save search&quot; to get back to them quickly.
        </p>
      </div>
    )
  }

  return (
    <ul className="grid gap-3">
      {searches.map((search) => {
        const chips = describeFilters(search.filters, search.scope)
        const count = matchCount(search)
        return (
          <li
            key={search.id}
            className="flex flex-col gap-4 rounded-xl border bg-card p-4 md:flex-row md:items-center md:justify-between"
          >
            <div className="min-w-0 space-y-2">
              <div className="flex items-center gap-2">
                <h3 className="truncate text-sm font-semibold">{search.name}</h3>
                <span className="shrink-0 rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-accent-foreground tabular-nums">
                  {`${count} ${count === 1 ? 'match' : 'matches'}`}
                </span>
              </div>
              <ul className="flex flex-wrap gap-1.5" aria-label="Search criteria">
                {(chips.length ? chips : ['All listings']).map((chip) => (
                  <li key={chip} className="rounded-md border bg-background px-2 py-0.5 text-xs text-muted-foreground">
                    {chip}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">{`Saved ${search.createdAt}`}</p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button variant="outline" size="icon" onClick={() => onDelete(search.id)} aria-label={`Delete ${search.name}`}>
                <Trash2 className="size-4" aria-hidden="true" />
              </Button>
              <Button onClick={() => onRun(search)} className="gap-1.5">
                <Play className="size-3.5" aria-hidden="true" />
                Run search
              </Button>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
