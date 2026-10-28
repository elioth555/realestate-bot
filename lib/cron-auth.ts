import { createHash, timingSafeEqual } from 'node:crypto'

/** Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. A missing or short secret rejects everything. */
export function isAuthorizedCronRequest(authHeader: string | null, secret: string | undefined): boolean {
  if (!secret || secret.length < 16) return false
  if (!authHeader?.startsWith('Bearer ')) return false
  const a = createHash('sha256').update(authHeader.slice(7)).digest()
  const b = createHash('sha256').update(secret).digest()
  return timingSafeEqual(a, b)
}
