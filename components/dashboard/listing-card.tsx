import { BedDouble, Building, Clock, ExternalLink, Heart, MapPin, Phone, Ruler } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { amenityDisplayLabel, type Listing } from '@/lib/listings'
import { formatPrice, formatPublished } from '@/lib/filters'
import { AMENITY_ICONS } from './amenity-icons'
import { ListingPhoto } from './listing-photo'
import { SourceBadge } from './source-badge'

const MAX_AMENITIES = 6

type ListingCardProps = {
  listing: Listing
  isFavorite: boolean
  onToggleFavorite: (id: string) => void
}

export function ListingCard({ listing, isFavorite, onToggleFavorite }: ListingCardProps) {
  const visibleAmenities = listing.amenities.slice(0, MAX_AMENITIES)
  const hiddenCount = listing.amenities.length - visibleAmenities.length
  const floorLabel = listing.floor === null ? '—' : listing.floor === 0 ? 'Ground' : String(listing.floor)
  const photoCandidates = listing.photos?.length ? listing.photos : [listing.image]

  return (
    <article className="group flex flex-col overflow-hidden rounded-xl border bg-card transition-shadow hover:shadow-lg hover:shadow-foreground/5">
      <div className="relative aspect-[4/3] overflow-hidden bg-muted">
        {/* Plain <img> (via ListingPhoto) so external Yad2/Supabase URLs render without next/image remote-domain config. */}
        <ListingPhoto
          photos={photoCandidates}
          alt={listing.title || `${listing.propertyType || 'Property'} on ${listing.street}, ${listing.neighborhood}`}
          className="absolute inset-0 size-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
        />
        <div className="absolute inset-x-3 top-3 flex items-start justify-between">
          <SourceBadge source={listing.source} />
          <button
            type="button"
            onClick={() => onToggleFavorite(listing.id)}
            aria-pressed={isFavorite}
            aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
            className="flex size-9 items-center justify-center rounded-full bg-card/95 shadow-sm ring-1 ring-foreground/5 backdrop-blur transition-colors hover:bg-card focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <Heart
              className={cn('size-4 transition-colors', isFavorite ? 'fill-rose-500 text-rose-500' : 'text-foreground')}
              aria-hidden="true"
            />
          </button>
        </div>
        <span
          className={cn(
            'absolute bottom-3 left-3 rounded-md px-2 py-0.5 text-xs font-semibold',
            listing.dealType === 'rent' ? 'bg-primary text-primary-foreground' : 'bg-foreground text-background',
          )}
        >
          {listing.dealType === 'rent' ? 'For rent' : 'For sale'}
        </span>
      </div>

      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <p className="text-xl font-semibold tracking-tight tabular-nums">
            {listing.known.price ? formatPrice(listing.price) : 'Price not stated'}
            {listing.dealType === 'rent' && (
              <span className="text-sm font-normal text-muted-foreground"> /month</span>
            )}
          </p>
          <span className="flex shrink-0 items-center gap-1 pt-1 text-xs text-muted-foreground">
            <Clock className="size-3.5" aria-hidden="true" />
            <time>{formatPublished(listing.publishedMinutesAgo)}</time>
          </span>
        </div>

        <div className="space-y-0.5">
          <h3 className="text-sm font-medium">
            {listing.neighborhood || listing.city}
            {listing.neighborhood && listing.city ? (
              <span className="font-normal text-muted-foreground">{`, ${listing.city}`}</span>
            ) : null}
          </h3>
          <p className="flex items-center gap-1 text-sm text-muted-foreground">
            <MapPin className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{listing.street}</span>
          </p>
        </div>

        <dl className="grid grid-cols-3 divide-x rounded-lg border bg-background text-center">
          <div className="px-2 py-2">
            <dt className="flex items-center justify-center gap-1 text-[11px] text-muted-foreground">
              <BedDouble className="size-3.5" aria-hidden="true" /> Rooms
            </dt>
            <dd className="text-sm font-semibold tabular-nums">{listing.rooms}</dd>
          </div>
          <div className="px-2 py-2">
            <dt className="flex items-center justify-center gap-1 text-[11px] text-muted-foreground">
              <Ruler className="size-3.5" aria-hidden="true" /> Surface
            </dt>
            <dd className="text-sm font-semibold tabular-nums">{`${listing.surface} m²`}</dd>
          </div>
          <div className="px-2 py-2">
            <dt className="flex items-center justify-center gap-1 text-[11px] text-muted-foreground">
              <Building className="size-3.5" aria-hidden="true" /> Floor
            </dt>
            <dd className="text-sm font-semibold tabular-nums">{floorLabel}</dd>
          </div>
        </dl>

        <ul className="flex flex-wrap items-center gap-1.5" aria-label="Amenities">
          {visibleAmenities.map((key) => {
            const Icon = AMENITY_ICONS[key]
            const label = amenityDisplayLabel(listing, key)
            return (
              <li
                key={key}
                title={label}
                className="flex size-7 items-center justify-center rounded-md bg-accent text-accent-foreground"
              >
                <Icon className="size-3.5" aria-hidden="true" />
                <span className="sr-only">{label}</span>
              </li>
            )
          })}
          {hiddenCount > 0 && (
            <li
              className="flex h-7 items-center rounded-md bg-muted px-2 text-xs font-medium text-muted-foreground"
              title={listing.amenities.slice(MAX_AMENITIES).map((k) => amenityDisplayLabel(listing, k)).join(', ')}
            >
              {`+${hiddenCount}`}
            </li>
          )}
        </ul>

        <div className="mt-auto flex items-center gap-2 border-t pt-3">
          <a
            href={`tel:${listing.phone.replace(/-/g, '')}`}
            className={cn(buttonVariants({ variant: 'outline' }), 'h-9 flex-1 gap-1.5 tabular-nums')}
          >
            <Phone className="size-3.5" aria-hidden="true" />
            {listing.phone}
          </a>
          <a
            href={listing.url}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(buttonVariants(), 'h-9 flex-1 gap-1.5')}
          >
            View original listing
            <ExternalLink className="size-3.5" aria-hidden="true" />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        </div>
      </div>
    </article>
  )
}
