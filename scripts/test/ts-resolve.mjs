// Node loader hook so app modules (extensionless relative imports, "@/" alias) run under --experimental-strip-types.
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = new URL('../../', import.meta.url)

export async function resolve(specifier, context, nextResolve) {
  let url
  if (specifier.startsWith('@/')) url = new URL(specifier.slice(2), ROOT)
  else if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL) {
    url = new URL(specifier, context.parentURL)
  } else return nextResolve(specifier, context)

  if (!/\.[cm]?[jt]sx?$|\.json$/.test(url.pathname)) {
    for (const ext of ['.ts', '.tsx', '/index.ts']) {
      const candidate = pathToFileURL(fileURLToPath(url) + ext)
      if (existsSync(candidate)) return nextResolve(candidate.href, context)
    }
  }
  return nextResolve(url.href, context)
}
