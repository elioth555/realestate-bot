'use client'

import { BedDouble, Building, CalendarDays, ExternalLink, MapPin, Phone, RefreshCw, Ruler } from 'lucide-react'
import { FRESHNESS_DESCRIPTIONS } from '@/lib/listing-freshness'
import { FreshnessLabel } from './freshness-label'
import { buttonVariants } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import { SOURCE_LABELS, amenityDisplayLabel, listingLinks, listingSources, type Listing } from '@/lib/listings'
import {
  displayFloor,
  displayPhone,
  displayPrice,
  displayRooms,
  displaySurface,
  formatPublishedDate,
  phoneHref,
} from '@/lib/listing-display'
import { AMENITY_ICONS } from './amenity-icons'
import { ListingPhoto } from './listing-photo'
import { SourceBadges } from './source-badge'

type ListingDetailSheetProps = {
  listing: Listing | null
  onOpenChange: (open: boolean) => void
}

export function ListingDetailSheet({ listing, onOpenChange }: ListingDetailSheetProps) {
  return (
    <Sheet open={listing !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto p-0 sm:max-w-lg data-[side=right]:sm:max-w-lg">
        {listing && <ListingDetail listing={listing} />}
      </SheetContent>
    </Sheet>
  )
}

function ListingDetail({ listing }: { listing: Listing }) {
  const photoCandidates = listing.photos.length ? listing.photos : [listing.image]
  const published = formatPublishedDate(listing.publishedAt)
  const phones = [...new Set([listing.phone, ...(listing.phones ?? [])].filter(Boolean))]
  const links = [
    ...listingLinks(listing).filter((l) => l.url),
    ...(listing.alsoPostedAt ?? []).map((url) => ({ source: 'facebook' as const, url, id: url })),
  ].filter((l, i, all) => all.findIndex((o) => o.url === l.url) === i)
  const isMerged = listingSources(listing).length > 1

  return (
    <>
      <div className="relative aspect-[16/10] shrink-0 overflow-hidden bg-muted">
        <ListingPhoto
          photos={photoCandidates}
          alt={listing.title || `Property on ${listing.street || listing.neighborhood || listing.city}`}
          className="absolute inset-0 size-full object-cover"
        />
        <div className="absolute top-3 left-3 flex items-center gap-2">
          <SourceBadges sources={listingSources(listing)} />
          <span
            className={cn(
              'rounded-md px-2 py-0.5 text-xs font-semibold',
              listing.dealType === 'rent' ? 'bg-primary text-primary-foreground' : 'bg-foreground text-background',
            )}
          >
            {listing.dealType === 'rent' ? 'For rent' : 'For sale'}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-5 p-5">
        <SheetHeader className="gap-1.5 p-0">
          <SheetTitle className="text-2xl font-semibold tracking-tight tabular-nums">
            {displayPrice(listing)}
            {listing.dealType === 'rent' && listing.known.price && (
              <span className="text-sm font-normal text-muted-foreground"> /month</span>
            )}
          </SheetTitle>
          <SheetDescription className="flex flex-col gap-0.5 text-sm">
            <span className="font-medium text-foreground">
              {listing.neighborhood || 'Neighborhood not identified'}
              {listing.city ? <span className="font-normal text-muted-foreground">{`, ${listing.city}`}</span> : null}
            </span>
            {listing.street && (
              <span className="flex items-center gap-1">
                <MapPin className="size-3.5 shrink-0" aria-hidden="true" />
                <span dir="auto">{listing.street}</span>
              </span>
            )}
          </SheetDescription>
        </SheetHeader>

        <dl className="grid grid-cols-3 divide-x rounded-lg border bg-background text-center">
          <Fact icon={BedDouble} label="Rooms" value={displayRooms(listing)} />
          <Fact icon={Ruler} label="Surface" value={displaySurface(listing)} />
          <Fact icon={Building} label="Floor" value={displayFloor(listing.floor)} />
        </dl>

        {listing.amenities.length > 0 && (
          <section aria-labelledby="detail-amenities" className="flex flex-col gap-2">
            <h3 id="detail-amenities" className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Confirmed amenities
            </h3>
            <ul className="flex flex-wrap gap-1.5">
              {listing.amenities.map((key) => {
                const Icon = AMENITY_ICONS[key]
                return (
                  <li
                    key={key}
                    className="flex items-center gap-1.5 rounded-md bg-accent px-2 py-1 text-xs font-medium text-accent-foreground"
                  >
                    <Icon className="size-3.5" aria-hidden="true" />
                    {amenityDisplayLabel(listing, key)}
                  </li>
                )
              })}
            </ul>
          </section>
        )}

        <section aria-labelledby="detail-description" className="flex flex-col gap-2">
          <h3 id="detail-description" className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {listing.source === 'facebook' ? 'Original post' : 'Description'}
          </h3>
          {listing.description ? (
            <p dir="auto" className="text-sm leading-relaxed text-pretty whitespace-pre-line">
              {listing.description}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">No description was provided.</p>
          )}
        </section>

        <dl className="flex flex-col gap-2 rounded-lg border bg-background p-3 text-sm">
          {phones.length > 0 && (
            <div className="flex items-start justify-between gap-3">
              <dt className="flex items-center gap-1.5 text-muted-foreground">
                <Phone className="size-3.5" aria-hidden="true" /> {phones.length > 1 ? 'Phones' : 'Phone'}
              </dt>
              <dd className="flex flex-col items-end gap-0.5">
                {phones.map((p) => (
                  <a key={p} href={phoneHref(p)} className="font-medium tabular-nums underline-offset-4 hover:underline">
                    {displayPhone(p)}
                  </a>
                ))}
              </dd>
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <dt className="flex items-center gap-1.5 text-muted-foreground">
              <CalendarDays className="size-3.5" aria-hidden="true" /> Published
            </dt>
            <dd className="font-medium">{published ?? 'Unknown'}</dd>
          </div>
          {listing.freshness && (
            <div className="flex items-start justify-between gap-3">
              <dt className="flex items-center gap-1.5 text-muted-foreground">
                <RefreshCw className="size-3.5" aria-hidden="true" /> Freshness
              </dt>
              <dd className="flex flex-col items-end gap-0.5 text-right">
                <FreshnessLabel status={listing.freshness} className="font-medium text-foreground" />
                <span className="max-w-56 text-xs text-pretty text-muted-foreground">
                  {FRESHNESS_DESCRIPTIONS[listing.freshness]}
                </span>
              </dd>
            </div>
          )}
        </dl>
      </div>

      {links.length > 0 && (
        <SheetFooter className="mt-auto gap-2 border-t p-5">
          {isMerged && <p className="text-xs text-muted-foreground">Same apartment listed on several sources</p>}
          {links.map((link, i) => (
            <a
              key={link.url}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(buttonVariants({ variant: i === 0 ? 'default' : 'outline' }), 'h-10 w-full gap-1.5')}
            >
              {`Open original ${SOURCE_LABELS[link.source]} ${link.source === 'facebook' ? 'post' : 'listing'}`}
              <ExternalLink className="size-3.5" aria-hidden="true" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          ))}
        </SheetFooter>
      )}
    </>
  )
}

function Fact({ icon: Icon, label, value }: { icon: typeof BedDouble; label: string; value: string }) {
  return (
    <div className="px-2 py-2">
      <dt className="flex items-center justify-center gap-1 text-[11px] text-muted-foreground">
        <Icon className="size-3.5" aria-hidden="true" /> {label}
      </dt>
      <dd className="text-sm font-semibold tabular-nums">{value}</dd>
    </div>
  )
}
