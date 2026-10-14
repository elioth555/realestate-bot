/**
 * Facebook photo mirroring tests. Offline: fake fetch and in-memory storage, no Facebook, no Supabase.
 * Run:
 *   node --experimental-strip-types --import ./scripts/test/register.mjs --test scripts/test/facebook-photos.test.mts
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { importFacebookItems } from '../../lib/facebook-import.ts'
import {
  MAX_IMAGE_BYTES,
  extractFacebookImageUrls,
  facebookPhotoFolder,
  mirrorFacebookPhotos,
  type PhotoStorage,
} from '../../lib/facebook-photos.ts'

const fb = (n: number, sig = 'a') => `https://scontent.ftlv1-1.fna.fbcdn.net/v/t39/${n}_n.jpg?oe=6A00${sig}&_nc_sid=x`
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])

type Behavior = 'ok' | 'expired' | 'html' | 'huge' | 'png'
function fakeFetch(behavior: (url: string) => Behavior) {
  const calls: string[] = []
  const impl = (async (input: string | URL) => {
    const url = String(input)
    calls.push(url)
    switch (behavior(url)) {
      case 'expired':
        return new Response('URL signature expired', { status: 403, headers: { 'content-type': 'text/plain' } })
      case 'html':
        return new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } })
      case 'huge':
        return new Response(new Uint8Array(MAX_IMAGE_BYTES + 1), { status: 200, headers: { 'content-type': 'image/jpeg' } })
      case 'png':
        return new Response(JPEG, { status: 200, headers: { 'content-type': 'image/png' } })
      default:
        return new Response(JPEG, { status: 200, headers: { 'content-type': 'image/jpeg; charset=binary' } })
    }
  }) as typeof fetch
  return { impl, calls }
}

function memoryStorage() {
  const files = new Map<string, Uint8Array>()
  let uploads = 0
  const storage: PhotoStorage = {
    async upload(path, bytes) {
      uploads++
      files.set(path, bytes)
      return `https://proj.supabase.co/storage/v1/object/public/facebook-property-photos/${path}`
    },
    async list(folder) {
      return [...files.keys()].filter((p) => p.startsWith(`${folder}/`)).map((p) => p.slice(folder.length + 1))
    },
    async remove(paths) {
      for (const p of paths) files.delete(p)
    },
  }
  return { storage, files, uploadCount: () => uploads }
}

const FOLDER = 'facebook/1234567890'

test('one image is copied and stored under a deterministic path', async () => {
  const { storage, files } = memoryStorage()
  const res = await mirrorFacebookPhotos(FOLDER, [fb(1)], storage, fakeFetch(() => 'ok').impl)
  assert.deepEqual(res.errors, [])
  assert.deepEqual([...files.keys()], [`${FOLDER}/0.jpg`])
  assert.equal(res.publicUrls.length, 1)
  assert.ok(!res.publicUrls[0].includes('fbcdn'), 'stored URL must not be the temporary Facebook URL')
})

test('5 images keep their order', async () => {
  const { storage } = memoryStorage()
  const urls = [1, 2, 3, 4, 5].map((n) => fb(n))
  const res = await mirrorFacebookPhotos(FOLDER, urls, storage, fakeFetch(() => 'ok').impl)
  assert.deepEqual(
    res.publicUrls.map((u) => u.split('/').pop()),
    ['0.jpg', '1.jpg', '2.jpg', '3.jpg', '4.jpg'],
  )
})

test('duplicate image URLs (even with different signatures) are kept once, in first-seen order', () => {
  const { urls } = extractFacebookImageUrls({ images: [fb(1, 'a'), fb(2), fb(1, 'b'), fb(2)] })
  assert.deepEqual(urls, [fb(1, 'a'), fb(2)])
})

test('invalid and non-Facebook URLs are rejected and never fetched', () => {
  const { urls, rejected } = extractFacebookImageUrls({
    images: ['not a url', 'ftp://scontent.fbcdn.net/x.jpg', 'https://evil.example.com/x.jpg', 'http://169.254.169.254/', 42, fb(1)],
  })
  assert.deepEqual(urls, [fb(1)])
  assert.equal(rejected.length, 5)
})

test('falls back to imageUrl when images is missing', () => {
  assert.deepEqual(extractFacebookImageUrls({ imageUrl: fb(9) }).urls, [fb(9)])
})

test('expired Facebook image is reported, not stored', async () => {
  const { storage, files } = memoryStorage()
  const res = await mirrorFacebookPhotos(FOLDER, [fb(1)], storage, fakeFetch(() => 'expired').impl)
  assert.deepEqual(res.publicUrls, [])
  assert.match(res.errors[0], /403/)
  assert.equal(files.size, 0)
})

test('non-image response is rejected', async () => {
  const { storage } = memoryStorage()
  const res = await mirrorFacebookPhotos(FOLDER, [fb(1)], storage, fakeFetch(() => 'html').impl)
  assert.deepEqual(res.publicUrls, [])
  assert.match(res.errors[0], /Not an image/)
})

test('oversized image is rejected', async () => {
  const { storage } = memoryStorage()
  const res = await mirrorFacebookPhotos(FOLDER, [fb(1)], storage, fakeFetch(() => 'huge').impl)
  assert.deepEqual(res.publicUrls, [])
  assert.match(res.errors[0], /larger than/)
})

test('partial failure: 4 of 5 succeed, order of the rest is preserved', async () => {
  const { storage } = memoryStorage()
  const urls = [1, 2, 3, 4, 5].map((n) => fb(n))
  const res = await mirrorFacebookPhotos(FOLDER, urls, storage, fakeFetch((u) => (u === fb(3) ? 'expired' : 'ok')).impl)
  assert.equal(res.publicUrls.length, 4)
  assert.deepEqual(res.publicUrls.map((u) => u.split('/').pop()), ['0.jpg', '1.jpg', '3.jpg', '4.jpg'])
  assert.equal(res.errors.length, 1)
  assert.match(res.errors[0], /^image 2:/)
})

test('re-importing the same post overwrites the same files and removes leftovers', async () => {
  const mem = memoryStorage()
  const fetchOk = fakeFetch(() => 'ok').impl
  await mirrorFacebookPhotos(FOLDER, [1, 2, 3, 4, 5].map((n) => fb(n, 'a')), mem.storage, fetchOk)
  const first = [...mem.files.keys()].sort()
  await mirrorFacebookPhotos(FOLDER, [1, 2, 3, 4, 5].map((n) => fb(n, 'b')), mem.storage, fetchOk)
  assert.deepEqual([...mem.files.keys()].sort(), first, 'same 5 paths, no new files')

  await mirrorFacebookPhotos(FOLDER, [fb(1, 'c'), fb(2, 'c')], mem.storage, fetchOk)
  assert.deepEqual([...mem.files.keys()].sort(), [`${FOLDER}/0.jpg`, `${FOLDER}/1.jpg`])
})

test('an extension change on reimport replaces the old file', async () => {
  const mem = memoryStorage()
  await mirrorFacebookPhotos(FOLDER, [fb(1)], mem.storage, fakeFetch(() => 'ok').impl)
  await mirrorFacebookPhotos(FOLDER, [fb(1)], mem.storage, fakeFetch(() => 'png').impl)
  assert.deepEqual([...mem.files.keys()], [`${FOLDER}/0.png`])
})

test('leftovers are kept when the reimport had failures', async () => {
  const mem = memoryStorage()
  await mirrorFacebookPhotos(FOLDER, [fb(1), fb(2)], mem.storage, fakeFetch(() => 'ok').impl)
  await mirrorFacebookPhotos(FOLDER, [fb(1)], mem.storage, fakeFetch(() => 'expired').impl)
  assert.equal(mem.files.size, 2)
})

test('folder uses the post id, or a stable hash when the id is unusable', () => {
  assert.equal(facebookPhotoFolder('1234567890', null), 'facebook/1234567890')
  const a = facebookPhotoFolder(null, 'https://www.facebook.com/groups/1/posts/2')
  assert.match(a, /^facebook\/h-[0-9a-f]{24}$/)
  assert.equal(a, facebookPhotoFolder(null, 'https://www.facebook.com/groups/1/posts/2'))
  assert.match(facebookPhotoFolder('../../etc', null), /^facebook\/h-/)
})

const offer = (id: string, extra: Record<string, unknown>) => ({
  postId: id,
  url: `https://www.facebook.com/groups/938644249820363/posts/${id}/`,
  time: '2026-10-06T09:00:00.000Z',
  text: 'להשכרה דירת 3 חדרים ברחוב דיזנגוף 100 תל אביב, 7500 ש"ח',
  ...extra,
})

test('import: no images means no photo sync; a failing photo sync never fails the listing', async () => {
  const syncedFor: string[] = []
  const summary = await importFacebookItems(
    [offer('111', {}), offer('222', { images: [fb(1)] })],
    {
      upsert: async (p) => ({ ok: true, action: 'created', id: p.source_url }),
      syncPhotos: async (_id, _urls, post) => {
        syncedFor.push(String(post.postId))
        throw new Error('storage down')
      },
    },
  )
  assert.deepEqual(syncedFor, ['222'])
  assert.equal(summary.created, 2)
  assert.equal(summary.failed, 0)
  assert.equal(summary.photo_errors.length, 1)
})

test('import: images are passed in order with the post id', async () => {
  let received: { urls: string[]; postId: string | null } | null = null
  await importFacebookItems([offer('333', { images: [fb(1), fb(2), fb(1, 'z')] })], {
    upsert: async () => ({ ok: true, action: 'updated', id: 7 }),
    syncPhotos: async (_id, urls, post) => {
      received = { urls, postId: post.postId }
      return { inserted: urls.length, errors: [] }
    },
  })
  assert.deepEqual(received, { urls: [fb(1), fb(2)], postId: '333' })
})
