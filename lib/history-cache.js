import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const HISTORY_CACHE_VERSION = 1

export function historyCacheDir(rootDir) {
  return join(rootDir, '.atlas-cache', 'history')
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

export function loadHistoryManifest(cacheDir) {
  return readJson(join(cacheDir, 'manifest.json'))
}

export function loadHistoryIndex(cacheDir) {
  const raw = readJson(join(cacheDir, 'index.json'))
  if (!raw) return new Map()
  return new Map(Object.entries(raw))
}

export function loadHistoryChangelog(cacheDir) {
  return readJson(join(cacheDir, 'changelog.json')) ?? []
}

export function loadItemDiffs(cacheDir, itemId) {
  return readJson(join(cacheDir, 'diffs', `${itemId}.json`))
}

export function indexToJson(index) {
  return Object.fromEntries(index)
}

export function mergeHistoryIndex(into, delta) {
  for (const [path, commits] of delta) {
    into.set(path, [...commits, ...(into.get(path) ?? [])])
  }
}

export function mergeHistoryChangelog(delta, into) {
  return [...delta, ...into]
}

export function manifestMatches(manifest, { sourceDir, ext, dirBased }) {
  return manifest?.version === HISTORY_CACHE_VERSION
    && manifest.sourceDir === sourceDir
    && manifest.ext === ext
    && manifest.dirBased === !!dirBased
}

export function saveHistoryCache(cacheDir, { head, sourceDir, ext, dirBased, index, changelog }) {
  mkdirSync(join(cacheDir, 'diffs'), { recursive: true })
  writeFileSync(join(cacheDir, 'manifest.json'), JSON.stringify({
    version: HISTORY_CACHE_VERSION,
    head,
    sourceDir,
    ext,
    dirBased: !!dirBased,
    builtAt: new Date().toISOString(),
  }, null, 2) + '\n', 'utf8')
  writeFileSync(join(cacheDir, 'index.json'), JSON.stringify(indexToJson(index), null, 2) + '\n', 'utf8')
  writeFileSync(join(cacheDir, 'changelog.json'), JSON.stringify(changelog, null, 2) + '\n', 'utf8')
}

export function saveItemDiffs(cacheDir, itemId, diffs) {
  const path = join(cacheDir, 'diffs', `${itemId}.json`)
  if (!diffs?.length) {
    if (existsSync(path)) return
    return
  }
  mkdirSync(join(cacheDir, 'diffs'), { recursive: true })
  writeFileSync(path, JSON.stringify(diffs, null, 2) + '\n', 'utf8')
}
