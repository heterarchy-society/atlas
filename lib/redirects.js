import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ID_RE = /^[a-z0-9-]+$/

async function yaml() {
  return (await import('js-yaml')).default
}

export function redirectsPath(rootDir, col, config) {
  return join(rootDir, col.redirects ?? config.redirects ?? 'redirects.yaml')
}

export async function loadRedirects(rootDir, col, config) {
  const path = redirectsPath(rootDir, col, config)
  if (!existsSync(path)) return {}

  const y = await yaml()
  const parsed = y.load(readFileSync(path, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

  const outputKey = col.output_key ?? col.name ?? col.source_dir

  if (Object.values(parsed).every(v => typeof v === 'string')) return parsed

  const scoped = parsed[outputKey] ?? parsed[col.name]
  if (!scoped || typeof scoped !== 'object' || Array.isArray(scoped)) return {}

  return scoped
}

export function validateRedirects(redirects, itemIds) {
  const errors = []
  const ids = new Set(itemIds)

  for (const [from, to] of Object.entries(redirects)) {
    if (typeof to !== 'string') {
      errors.push(`"${from}": target must be a string`)
      continue
    }
    if (!ID_RE.test(from)) errors.push(`"${from}": invalid id`)
    if (!ID_RE.test(to)) errors.push(`"${from}" → "${to}": invalid target id`)
    if (from === to) errors.push(`"${from}": cannot redirect to itself`)
    if (ids.has(from)) errors.push(`"${from}": source id still exists — remove the item or the redirect`)
    if (!ids.has(to)) errors.push(`"${from}" → "${to}": target does not exist`)
    if (redirects[to]) errors.push(`"${from}" → "${to}": target is also a redirect source (no chains)`)
  }

  return errors
}
