'use client'

import { useState } from 'react'
import { Mail } from 'lucide-react'
import useSWR from 'swr'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import type { AlertActionResult } from '@/app/actions/saved-search-alerts'
import type { AlertEmail } from '@/lib/saved-search-alerts'
import type { SavedSearch } from '@/lib/saved-searches'

type AlertEmailSheetProps = {
  search: SavedSearch
  pendingCount: number
  refreshing: boolean
  onPreview: (searchId: string) => Promise<AlertActionResult<AlertEmail>>
  onSend: (searchId: string) => Promise<AlertActionResult<{ itemCount: number; to: string }>>
}

/** Manual control: the exact email is always previewed before it can be sent. */
export function AlertEmailSheet({ search, pendingCount, refreshing, onPreview, onSend }: AlertEmailSheetProps) {
  const [open, setOpen] = useState(false)
  const [sending, setSending] = useState(false)
  const [view, setView] = useState<'html' | 'text'>('html')
  const preview = useSWR(open ? ['saved-search-alert-preview', search.id, pendingCount] : null, () => onPreview(search.id), {
    revalidateOnFocus: false,
  })
  const email = preview.data?.ok ? preview.data.data : null

  const send = async () => {
    setSending(true)
    const result = await onSend(search.id)
    setSending(false)
    if (!result.ok) {
      toast.error(result.message)
      return
    }
    toast.success('Alert email sent', {
      description: `${result.data.itemCount} ${result.data.itemCount === 1 ? 'listing' : 'listings'} to ${result.data.to}`,
    })
    setOpen(false)
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={<Button variant="outline" size="sm" className="gap-1.5" disabled={refreshing} />}
        title={refreshing ? 'Wait for Refresh all sources to finish' : undefined}
      >
        <Mail className="size-3.5" aria-hidden="true" />
        Send alert email
      </SheetTrigger>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-2xl">
        <SheetHeader className="border-b">
          <SheetTitle>Alert email preview</SheetTitle>
          <SheetDescription>Nothing is sent until you click Send. This is the exact email the client will receive.</SheetDescription>
        </SheetHeader>

        <div className="flex flex-1 flex-col gap-4 p-4">
          {preview.isLoading ? (
            <p className="text-sm text-muted-foreground">Building preview…</p>
          ) : !preview.data ? null : !preview.data.ok ? (
            <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {preview.data.message}
            </p>
          ) : email ? (
            <>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                <dt className="text-muted-foreground">To</dt>
                <dd className="truncate font-medium">{email.to}</dd>
                <dt className="text-muted-foreground">Subject</dt>
                <dd className="font-medium text-pretty">{email.subject}</dd>
                <dt className="text-muted-foreground">Listings</dt>
                <dd className="tabular-nums">
                  {email.itemCount}
                  {email.omitted > 0 && <span className="text-muted-foreground">{` (${email.omitted} summarized as "and more")`}</span>}
                </dd>
              </dl>
              <div className="flex gap-1" role="group" aria-label="Preview format">
                <Button size="sm" variant={view === 'html' ? 'secondary' : 'ghost'} aria-pressed={view === 'html'} onClick={() => setView('html')}>
                  Email
                </Button>
                <Button size="sm" variant={view === 'text' ? 'secondary' : 'ghost'} aria-pressed={view === 'text'} onClick={() => setView('text')}>
                  Plain text
                </Button>
              </div>
              {view === 'html' ? (
                <iframe title="Email preview" srcDoc={email.html} sandbox="" className="h-[60vh] w-full rounded-lg border bg-background" />
              ) : (
                <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-lg border bg-muted p-3 font-sans text-sm leading-relaxed">
                  {email.text}
                </pre>
              )}
            </>
          ) : null}
        </div>

        <SheetFooter className="border-t">
          <Button onClick={send} disabled={!email || sending || refreshing} className="gap-1.5">
            <Mail className="size-4" aria-hidden="true" />
            {sending ? 'Sending…' : 'Send alert email'}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
