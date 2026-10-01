'use client'

import { useCallback, useMemo, useState } from 'react'

const PLACEHOLDER_SRC = '/placeholder.svg'

type ListingPhotoProps = {
  photos: (string | null | undefined)[]
  alt: string
  className?: string
}

export function ListingPhoto({ photos, alt, className }: ListingPhotoProps) {
  const candidates = useMemo(
    () => [...new Set(photos.map((url) => (url ?? '').trim()).filter((url) => /^https?:\/\//i.test(url) || url.startsWith('/')))],
    [photos],
  )
  const candidatesKey = candidates.join('|')
  const [failed, setFailed] = useState({ key: candidatesKey, index: 0 })
  const index = failed.key === candidatesKey ? failed.index : 0
  const src = candidates[index] ?? PLACEHOLDER_SRC
  const isPlaceholder = src === PLACEHOLDER_SRC

  const tryNextPhoto = useCallback(() => {
    if (isPlaceholder) return
    setFailed({ key: candidatesKey, index: index + 1 })
  }, [candidatesKey, index, isPlaceholder])

  // The image can fail before React hydrates and attaches onError; catch that case on mount.
  const detectEarlyFailure = useCallback(
    (img: HTMLImageElement | null) => {
      if (img && img.complete && img.naturalWidth === 0 && img.getAttribute('src') === src) tryNextPhoto()
    },
    [src, tryNextPhoto],
  )

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      key={src}
      ref={detectEarlyFailure}
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      // Yad2's CDN can reject hotlinked requests that carry a foreign Referer; mirror a direct open.
      referrerPolicy="no-referrer"
      onError={tryNextPhoto}
      className={className}
    />
  )
}
