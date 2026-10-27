'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import type { DealType } from '@/lib/listings'
import { LIMITS } from '@/lib/saved-searches'

export type SaveSearchInput = { name: string; scope: DealType }

type SaveSearchFormProps = {
  defaultScope: DealType
  suggestedName: string
  onSave: (input: SaveSearchInput) => Promise<boolean>
  onCancel: () => void
}

export function SaveSearchForm({ defaultScope, suggestedName, onSave, onCancel }: SaveSearchFormProps) {
  const [name, setName] = useState(suggestedName)
  const [scope, setScope] = useState<DealType>(defaultScope)
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    if (!name.trim() || saving) return
    setSaving(true)
    const saved = await onSave({ name: name.trim(), scope })
    setSaving(false)
    if (saved) onCancel()
  }

  return (
    <div className="col-span-2 flex flex-col gap-3 rounded-lg border bg-background p-3" role="group" aria-label="Save search">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="saved-search-name" className="text-xs font-medium text-muted-foreground">
          Search name
        </Label>
        <Input
          id="saved-search-name"
          value={name}
          maxLength={LIMITS.name}
          autoFocus
          placeholder="Marc - Old North 3 rooms"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            // Enter submits the outer filter form otherwise; IME composition must not save.
            e.preventDefault()
            if (e.nativeEvent.isComposing || e.keyCode === 229) return
            void submit()
          }}
          className="h-9"
        />
      </div>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 text-xs font-medium text-muted-foreground">Transaction</legend>
        <div className="grid grid-cols-2 gap-1.5">
          {(['rent', 'sale'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={scope === value}
              onClick={() => setScope(value)}
              className={cn(
                'h-8 rounded-md border text-xs font-medium transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                scope === value ? 'border-primary/40 bg-accent text-accent-foreground' : 'bg-card hover:bg-muted',
              )}
            >
              {value === 'rent' ? 'Rent' : 'Sale'}
            </button>
          ))}
        </div>
      </fieldset>
      <div className="grid grid-cols-2 gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" size="sm" onClick={submit} disabled={!name.trim() || saving} aria-busy={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  )
}
