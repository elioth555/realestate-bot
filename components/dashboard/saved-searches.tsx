'use client'

import { useState } from 'react'
import { Bookmark, Pencil, Play, Trash2, UserRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { describeFilters } from '@/lib/filters'
import { LIMITS, type ClientFields, type SavedSearch } from '@/lib/saved-searches'

type Summary = { matches: number; newMatches: number }

type SavedSearchesProps = {
  searches: SavedSearch[]
  summaryOf: (search: SavedSearch) => Summary
  onOpen: (search: SavedSearch) => void
  onUpdate: (id: string, fields: ClientFields) => Promise<boolean>
  onDelete: (id: string) => Promise<boolean>
}

const dateFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

export function SavedSearches({ searches, summaryOf, onOpen, onUpdate, onDelete }: SavedSearchesProps) {
  if (searches.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed bg-card px-6 py-16 text-center">
        <span className="mb-3 flex size-11 items-center justify-center rounded-full bg-accent text-primary">
          <Bookmark className="size-5" aria-hidden="true" />
        </span>
        <h3 className="text-sm font-semibold">No saved searches yet</h3>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          Set your filters and click &quot;Save search&quot; to keep a client&apos;s criteria and track new matches.
        </p>
      </div>
    )
  }

  return (
    <ul className="grid gap-3">
      {searches.map((search) => (
        <SavedSearchRow
          key={search.id}
          search={search}
          summary={summaryOf(search)}
          onOpen={onOpen}
          onUpdate={onUpdate}
          onDelete={onDelete}
        />
      ))}
    </ul>
  )
}

type Mode = 'view' | 'rename' | 'client' | 'confirm-delete'

function SavedSearchRow({
  search,
  summary,
  onOpen,
  onUpdate,
  onDelete,
}: { search: SavedSearch; summary: Summary } & Omit<SavedSearchesProps, 'searches' | 'summaryOf'>) {
  const [mode, setMode] = useState<Mode>('view')
  const [busy, setBusy] = useState(false)
  const chips = describeFilters(search.filters, search.scope)

  const run = async (action: () => Promise<boolean>) => {
    setBusy(true)
    const ok = await action()
    setBusy(false)
    if (ok) setMode('view')
  }

  return (
    <li className="flex flex-col gap-4 rounded-xl border bg-card p-4">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="flex min-w-0 flex-col gap-2">
          {mode === 'rename' ? (
            <RenameField
              initial={search.name}
              busy={busy}
              onCancel={() => setMode('view')}
              onSubmit={(name) => run(() => onUpdate(search.id, { name }))}
            />
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="min-w-0 truncate text-sm font-semibold">{search.name}</h3>
              <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                {search.scope === 'rent' ? 'Rent' : 'Sale'}
              </span>
              <span className="shrink-0 rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-accent-foreground tabular-nums">
                {`${summary.matches} ${summary.matches === 1 ? 'match' : 'matches'}`}
              </span>
              {summary.newMatches > 0 && (
                <span className="shrink-0 rounded-full bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground tabular-nums">
                  {`${summary.newMatches} new`}
                </span>
              )}
            </div>
          )}
          <ul className="flex flex-wrap gap-1.5" aria-label="Search criteria">
            {(chips.length ? chips : ['All listings']).map((chip) => (
              <li key={chip} className="rounded-md border bg-background px-2 py-0.5 text-xs text-muted-foreground">
                {chip}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            {search.clientName ? `${search.clientName} · ` : ''}
            {`Saved ${dateFormat.format(new Date(search.createdAt))} · checked ${dateFormat.format(new Date(search.lastCheckedAt))}`}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          {mode === 'confirm-delete' ? (
            <>
              <Button variant="ghost" size="sm" onClick={() => setMode('view')} disabled={busy}>
                Keep
              </Button>
              <Button variant="destructive" size="sm" onClick={() => run(() => onDelete(search.id))} disabled={busy}>
                {busy ? 'Deleting…' : 'Delete search'}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" size="icon" onClick={() => setMode('rename')} aria-label={`Rename ${search.name}`}>
                <Pencil className="size-4" aria-hidden="true" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                aria-pressed={mode === 'client'}
                onClick={() => setMode(mode === 'client' ? 'view' : 'client')}
                aria-label={`Client details for ${search.name}`}
              >
                <UserRound className="size-4" aria-hidden="true" />
              </Button>
              <Button variant="outline" size="icon" onClick={() => setMode('confirm-delete')} aria-label={`Delete ${search.name}`}>
                <Trash2 className="size-4" aria-hidden="true" />
              </Button>
              <Button onClick={() => onOpen(search)} className="gap-1.5">
                <Play className="size-3.5" aria-hidden="true" />
                Open
              </Button>
            </>
          )}
        </div>
      </div>

      {mode === 'client' && (
        <ClientDetailsForm
          search={search}
          busy={busy}
          onCancel={() => setMode('view')}
          onSubmit={(fields) => run(() => onUpdate(search.id, fields))}
        />
      )}
    </li>
  )
}

function RenameField({
  initial,
  busy,
  onSubmit,
  onCancel,
}: {
  initial: string
  busy: boolean
  onSubmit: (name: string) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(initial)
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (name.trim()) onSubmit(name.trim())
      }}
    >
      <Input
        aria-label="Search name"
        value={name}
        maxLength={LIMITS.name}
        autoFocus
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel()
          if (e.key === 'Enter' && (e.nativeEvent.isComposing || e.keyCode === 229)) e.preventDefault()
        }}
        className="h-8 w-64 max-w-full"
      />
      <Button type="submit" size="sm" disabled={!name.trim() || busy}>
        Save
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
        Cancel
      </Button>
    </form>
  )
}

function ClientDetailsForm({
  search,
  busy,
  onSubmit,
  onCancel,
}: {
  search: SavedSearch
  busy: boolean
  onSubmit: (fields: ClientFields) => void
  onCancel: () => void
}) {
  const [fields, setFields] = useState({
    clientName: search.clientName ?? '',
    clientPhone: search.clientPhone ?? '',
    clientEmail: search.clientEmail ?? '',
    notes: search.notes ?? '',
  })
  const set = (key: keyof typeof fields) => (e: { target: { value: string } }) =>
    setFields((prev) => ({ ...prev, [key]: e.target.value }))
  const id = (key: string) => `${search.id}-${key}`

  return (
    <form
      className="grid gap-3 border-t pt-4 sm:grid-cols-3"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit(fields)
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={id('client-name')} className="text-xs text-muted-foreground">
          Client name
        </Label>
        <Input id={id('client-name')} value={fields.clientName} maxLength={LIMITS.clientName} onChange={set('clientName')} className="h-9" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={id('client-phone')} className="text-xs text-muted-foreground">
          Phone
        </Label>
        <Input
          id={id('client-phone')}
          type="tel"
          value={fields.clientPhone}
          maxLength={LIMITS.clientPhone}
          onChange={set('clientPhone')}
          className="h-9"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={id('client-email')} className="text-xs text-muted-foreground">
          Email
        </Label>
        <Input
          id={id('client-email')}
          type="email"
          value={fields.clientEmail}
          maxLength={LIMITS.clientEmail}
          onChange={set('clientEmail')}
          className="h-9"
        />
      </div>
      <div className="flex flex-col gap-1.5 sm:col-span-3">
        <Label htmlFor={id('notes')} className="text-xs text-muted-foreground">
          Notes
        </Label>
        <textarea
          id={id('notes')}
          value={fields.notes}
          maxLength={LIMITS.notes}
          rows={2}
          onChange={set('notes')}
          className="min-h-16 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm leading-relaxed outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
      </div>
      <div className="flex justify-end gap-2 sm:col-span-3">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? 'Saving…' : 'Save details'}
        </Button>
      </div>
    </form>
  )
}
