'use client'

import { BedDouble, Building, CalendarDays, ExternalLink, MapPin, Phone, Ruler } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import { SOURCE_LABELS, amenityDisplayLabel, type Listing } from '@/lib/listings'
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
import { SourceBadge } from './source-badge'

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
  const phone = listing.phone ? displayPhone(listing.phone) : ''
  const sourceLabel = SOURCE_LABELS[listing.source]

  return (
    <>
      <div className="relative aspect-[16/10] shrink-0 overflow-hidden bg-muted">
        <ListingPhoto
          photos={photoCandidates}
          alt={listing.title || `Property on ${listing.street || listing.neighborhood || listing.city}`}
          className="absolute inset-0 size-full object-cover"
        />
        <div className="absolute top-3 left-3 flex items-center gap-2">
          <SourceBadge source={listing.source} />
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
          {phone && (
            <div className="flex items-center justify-between gap-3">
              <dt className="flex items-center gap-1.5 text-muted-foreground">
                <Phone className="size-3.5" aria-hidden="true" /> Phone
              </dt>
              <dd>
                <a href={phoneHref(listing.phone)} className="font-medium tabular-nums underline-offset-4 hover:underline">
                  {phone}
                </a>
              </dd>
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <dt className="flex items-center gap-1.5 text-muted-foreground">
              <CalendarDays className="size-3.5" aria-hidden="true" /> Published
            </dt>
            <dd className="font-medium">{published ?? 'Unknown'}</dd>
          </div>
        </dl>
      </div>

      {listing.url && (
        <SheetFooter className="mt-auto border-t p-5">
          <a
            href={listing.url}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(buttonVariants(), 'h-10 w-full gap-1.5')}
          >
            {`Open original ${sourceLabel} post`}
            <ExternalLink className="size-3.5" aria-hidden="true" />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
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
