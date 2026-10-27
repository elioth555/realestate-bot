'use client'

import { useState } from 'react'
import { BookmarkPlus, RefreshCw, RotateCcw, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { AMENITY_KEYS, AMENITY_LABELS, type AmenityKey, type DealType } from '@/lib/listings'
import { ROOM_OPTIONS, type Filters } from '@/lib/filters'
import { AMENITY_ICONS } from './amenity-icons'
import { SaveSearchForm, type SaveSearchInput } from './save-search-form'

type FilterPanelProps = {
  filters: Filters
  cities: Record<string, string[]>
  propertyTypes: string[]
  onChange: (filters: Filters) => void
  onSearch: () => void
  onSave: (input: SaveSearchInput) => Promise<boolean>
  /** Rent/Sale preselected in the save form (the current tab, or Rent from "All"). */
  saveScope: DealType
  suggestedSaveName: string
  onReset: () => void
  /** Starts Yad2, Madlan and Facebook together. */
  onRefreshAll: () => void
  /** A combined refresh is running; never blocks local filtering. */
  refreshing?: boolean
  priceStep?: number
}

type Option = { label: string; value: string | null }

function toOptions(values: readonly string[], anyLabel: string): Option[] {
  return [{ label: anyLabel, value: null }, ...values.map((v) => ({ label: v, value: v }))]
}

function FieldSelect({
  id,
  label,
  value,
  options,
  placeholder,
  disabled,
  onValueChange,
}: {
  id: string
  label: string
  value: string | null
  options: Option[]
  placeholder: string
  disabled?: boolean
  onValueChange: (value: string | null) => void
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </Label>
      <Select items={options} value={value} onValueChange={(v) => onValueChange(v as string | null)} disabled={disabled}>
        <SelectTrigger id={id} className="h-9 w-full bg-background">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.label} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function RangeInputs({
  label,
  unit,
  minId,
  minValue,
  maxValue,
  onMin,
  onMax,
  step,
}: {
  label: string
  unit: string
  minId: string
  minValue: string
  maxValue: string
  onMin: (v: string) => void
  onMax: (v: string) => void
  step?: number
}) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="mb-1.5 text-xs font-medium text-muted-foreground">{label}</legend>
      <div className="grid grid-cols-2 gap-2">
        {(['min', 'max'] as const).map((bound) => (
          <div key={bound} className="relative">
            <Label htmlFor={bound === 'min' ? minId : `${minId}-max`} className="sr-only">
              {`${bound === 'min' ? 'Minimum' : 'Maximum'} ${label.toLowerCase()}`}
            </Label>
            <Input
              id={bound === 'min' ? minId : `${minId}-max`}
              type="number"
              inputMode="numeric"
              min={0}
              step={step}
              placeholder={bound === 'min' ? 'Min' : 'Max'}
              value={bound === 'min' ? minValue : maxValue}
              onChange={(e) => (bound === 'min' ? onMin : onMax)(e.target.value)}
              className="h-9 bg-background pr-9 tabular-nums"
            />
            <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">
              {unit}
            </span>
          </div>
        ))}
      </div>
    </fieldset>
  )
}

function NeighborhoodPicker({
  options,
  selected,
  disabled,
  onChange,
}: {
  options: readonly string[]
  selected: string[]
  disabled: boolean
  onChange: (next: string[]) => void
}) {
  // Keep selections visible even if the current city index no longer lists them (e.g. restored from URL).
  const all = [...new Set([...selected, ...options])]
  const toggle = (name: string, checked: boolean) =>
    onChange(checked ? [...selected, name] : selected.filter((n) => n !== name))

  return (
    <fieldset className="flex flex-col gap-1.5" disabled={disabled}>
      <legend className="sr-only">Neighborhoods</legend>
      <div className="flex items-center justify-between">
        <span aria-hidden="true" className="text-xs font-medium text-muted-foreground">
          Neighborhoods
          {selected.length > 0 && <span className="ml-1 tabular-nums text-foreground">{`(${selected.length})`}</span>}
        </span>
        {selected.length > 0 && (
          <button
            type="button"
            onClick={() => onChange([])}
            className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            Clear
          </button>
        )}
      </div>
      {disabled ? (
        <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">Select a city first</p>
      ) : all.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
          No neighborhoods known for this city yet
        </p>
      ) : (
        <ul className="flex max-h-44 flex-col gap-0.5 overflow-y-auto rounded-md border bg-background p-1.5">
          {all.map((name) => {
            const id = `hood-${name.replace(/\s+/g, '-')}`
            return (
              <li key={name}>
                <label
                  htmlFor={id}
                  className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-muted"
                >
                  <Checkbox
                    id={id}
                    checked={selected.includes(name)}
                    onCheckedChange={(checked) => toggle(name, checked === true)}
                  />
                  <span className="truncate">{name}</span>
                </label>
              </li>
            )
          })}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">Leave empty for any neighborhood.</p>
    </fieldset>
  )
}

export function FilterPanel({
  filters,
  cities,
  propertyTypes,
  onChange,
  onSearch,
  onSave,
  saveScope,
  suggestedSaveName,
  onReset,
  onRefreshAll,
  refreshing = false,
  priceStep = 500,
}: FilterPanelProps) {
  const [savingOpen, setSavingOpen] = useState(false)
  const set = <K extends keyof Filters>(key: K, value: Filters[K]) => onChange({ ...filters, [key]: value })

  const neighborhoods = filters.city ? (cities[filters.city] ?? []) : []

  const toggleAmenity = (key: AmenityKey) =>
    set(
      'amenities',
      filters.amenities.includes(key) ? filters.amenities.filter((a) => a !== key) : [...filters.amenities, key],
    )

  return (
    <form
      // The price step only drives the arrow keys; typed values like 11,250 must still submit.
      noValidate
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault()
        onSearch()
      }}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Search filters</h2>
        <Button type="button" variant="ghost" size="sm" onClick={onReset} className="gap-1 text-muted-foreground">
          <RotateCcw className="size-3.5" aria-hidden="true" />
          Reset
        </Button>
      </div>

      <div className="grid gap-3">
        <FieldSelect
          id="city"
          label="City"
          value={filters.city}
          placeholder="Any city"
          options={toOptions(Object.keys(cities), 'Any city')}
          onValueChange={(v) => onChange({ ...filters, city: v, neighborhoods: [] })}
        />
        <NeighborhoodPicker
          options={neighborhoods}
          selected={filters.neighborhoods}
          disabled={!filters.city}
          onChange={(next) => set('neighborhoods', next)}
        />
        <FieldSelect
          id="property-type"
          label="Property type"
          value={filters.propertyType}
          placeholder="Any type"
          options={toOptions(propertyTypes, 'Any type')}
          onValueChange={(v) => set('propertyType', v)}
        />
      </div>

      <RangeInputs
        label="Price"
        unit="₪"
        minId="min-price"
        minValue={filters.minPrice}
        maxValue={filters.maxPrice}
        onMin={(v) => set('minPrice', v)}
        onMax={(v) => set('maxPrice', v)}
        step={priceStep}
      />

      <fieldset>
        <legend className="mb-1.5 text-xs font-medium text-muted-foreground">Rooms</legend>
        <div className="grid grid-cols-2 gap-2">
          <Select
            items={toOptions(ROOM_OPTIONS, 'Min')}
            value={filters.minRooms}
            onValueChange={(v) => set('minRooms', v as string | null)}
          >
            <SelectTrigger aria-label="Minimum rooms" className="h-9 w-full bg-background">
              <SelectValue placeholder="Min" />
            </SelectTrigger>
            <SelectContent>
              {toOptions(ROOM_OPTIONS, 'Any').map((o) => (
                <SelectItem key={o.label} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            items={toOptions(ROOM_OPTIONS, 'Max')}
            value={filters.maxRooms}
            onValueChange={(v) => set('maxRooms', v as string | null)}
          >
            <SelectTrigger aria-label="Maximum rooms" className="h-9 w-full bg-background">
              <SelectValue placeholder="Max" />
            </SelectTrigger>
            <SelectContent>
              {toOptions(ROOM_OPTIONS, 'Any').map((o) => (
                <SelectItem key={o.label} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </fieldset>

      <RangeInputs
        label="Surface"
        unit="m²"
        minId="min-surface"
        minValue={filters.minSurface}
        maxValue={filters.maxSurface}
        onMin={(v) => set('minSurface', v)}
        onMax={(v) => set('maxSurface', v)}
      />

      <fieldset>
        <legend className="mb-2 flex w-full items-center justify-between text-xs font-medium text-muted-foreground">
          Amenities
          {filters.amenities.length > 0 && (
            <span className="text-primary">{`${filters.amenities.length} selected`}</span>
          )}
        </legend>
        <div className="grid grid-cols-2 gap-1.5">
          {AMENITY_KEYS.map((key) => {
            const Icon = AMENITY_ICONS[key]
            const active = filters.amenities.includes(key)
            return (
              <button
                key={key}
                type="button"
                aria-pressed={active}
                onClick={() => toggleAmenity(key)}
                className={cn(
                  'flex h-9 items-center gap-2 rounded-lg border px-2.5 text-left text-xs font-medium transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                  active
                    ? 'border-primary/40 bg-accent text-accent-foreground'
                    : 'bg-background text-foreground/80 hover:bg-muted',
                )}
              >
                <Icon className={cn('size-3.5 shrink-0', active ? 'text-primary' : 'text-muted-foreground')} aria-hidden="true" />
                {AMENITY_LABELS[key]}
              </button>
            )
          })}
        </div>
      </fieldset>

      <div className="sticky bottom-0 -mx-5 -mb-5 grid grid-cols-2 gap-2 border-t bg-card p-5">
        {savingOpen && (
          <SaveSearchForm
            defaultScope={saveScope}
            suggestedName={suggestedSaveName}
            onSave={onSave}
            onCancel={() => setSavingOpen(false)}
          />
        )}
        <Button
          type="button"
          variant="outline"
          aria-expanded={savingOpen}
          onClick={() => setSavingOpen((open) => !open)}
          className="h-10 gap-1.5"
        >
          <BookmarkPlus className="size-4" aria-hidden="true" />
          Save search
        </Button>
        <Button type="submit" className="h-10 gap-1.5">
          <Search className="size-4" aria-hidden="true" />
          Apply filters
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={onRefreshAll}
          disabled={refreshing}
          aria-busy={refreshing}
          className="col-span-2 h-10 gap-1.5"
        >
          <RefreshCw className={cn('size-4', refreshing && 'animate-spin')} aria-hidden="true" />
          {refreshing ? 'Refreshing sources…' : 'Refresh all sources'}
        </Button>
        <p className="col-span-2 text-xs leading-relaxed text-muted-foreground">
          Filters apply instantly to stored listings. Source refreshes import new listings in the background.
        </p>
      </div>
    </form>
  )
}
