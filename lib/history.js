import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildGitIndex,
  buildGitIndexSince,
  clearGitCaches,
  fileDiff,
  isDescendent,
  resolveHead,
} from './git.js'
import {
  historyCacheDir,
  loadHistoryChangelog,
  loadHistoryIndex,
  loadHistoryManifest,
  loadItemDiffs,
  manifestMatches,
  mergeHistoryChangelog,
  mergeHistoryIndex,
  saveHistoryCache,
  saveItemDiffs,
} from './history-cache.js'

function loadAuthorCache(rootDir) {
  const path = join(rootDir, '.github', 'authors.json')
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return {} }
}

async function refreshItemDiffs(commits, cachedDiffs, rootDir, filename) {
  const byHash = new Map((cachedDiffs ?? []).map(entry => [entry.hash, entry]))
  for (const { hash, date, author, email, message } of commits) {
    if (byHash.has(hash)) continue
    byHash.set(hash, {
      hash, date, author, email, message,
      diff: await fileDiff(rootDir, hash, filename),
    })
  }
  return commits.map(({ hash }) => byHash.get(hash)).filter(Boolean)
}

async function loadOrBuildHistoryIndex(rootDir, sourceDir, ext, dirBased) {
  const cacheDir = historyCacheDir(rootDir)
  mkdirSync(cacheDir, { recursive: true })

  clearGitCaches()
  const head = await resolveHead(rootDir)
  const manifest = loadHistoryManifest(cacheDir)
  const opts = { sourceDir, ext, dirBased }

  if (manifestMatches(manifest, opts) && head && manifest.head === head) {
    return {
      mode: 'hit',
      head,
      cacheDir,
      index: loadHistoryIndex(cacheDir),
      changelog: loadHistoryChangelog(cacheDir),
      newCommits: 0,
    }
  }

  if (manifestMatches(manifest, opts) && head && manifest.head && await isDescendent(rootDir, head, manifest.head)) {
    const index = loadHistoryIndex(cacheDir)
    const changelog = loadHistoryChangelog(cacheDir)
    const delta = await buildGitIndexSince(rootDir, sourceDir, ext, { dirBased, sinceOid: manifest.head })
    mergeHistoryIndex(index, delta.index)
    return {
      mode: 'incremental',
      head,
      cacheDir,
      index,
      changelog: mergeHistoryChangelog(delta.changelog, changelog),
      newCommits: delta.commitCount,
    }
  }

  const built = await buildGitIndex(rootDir, sourceDir, ext, { dirBased })
  return {
    mode: 'full',
    head,
    cacheDir,
    index: built.index,
    changelog: built.changelog,
    newCommits: built.commitCount ?? null,
  }
}

export async function buildHistory(items, rootDir, sourceDir, ext, distDir, { dirBased = false } = {}) {
  const historyDir = join(distDir, 'history')
  mkdirSync(historyDir, { recursive: true })

  const { mode, head, cacheDir, index, changelog, newCommits } =
    await loadOrBuildHistoryIndex(rootDir, sourceDir, ext, dirBased)

  const modeLabel = mode === 'incremental' && newCommits != null
    ? `incremental (+${newCommits} commits)`
    : mode
  console.log(`  Git history cache: ${modeLabel}`)

  const authorCache = loadAuthorCache(rootDir)
  const shouldRefreshDiffs = mode !== 'hit'
  const shouldSaveCache = mode !== 'hit' && head

  for (const item of items) {
    const filename = dirBased
      ? `${sourceDir}/${item.id}/index.${ext}`
      : `${sourceDir}/${item.id}.${ext}`
    const commits = index.get(filename) ?? []
    item.history = commits.map(({ hash, date, author, message }) => ({ hash, date, author, message }))

    const seen = new Map()
    for (const { author, email } of commits) {
      if (!seen.has(email)) {
        const entry = { name: author }
        const gh = authorCache[email]
        if (gh) entry.gh_username = gh
        seen.set(email, entry)
      }
    }
    if (seen.size > 0) item.contributors = [...seen.values()]

    if (commits.length === 0) continue

    let diffs = loadItemDiffs(cacheDir, item.id) ?? []
    if (shouldRefreshDiffs) {
      diffs = await refreshItemDiffs(commits, diffs, rootDir, filename)
      saveItemDiffs(cacheDir, item.id, diffs)
    }
    writeFileSync(join(historyDir, `${item.id}.json`), JSON.stringify(diffs, null, 2), 'utf8')
  }

  writeFileSync(join(distDir, 'changelog.json'), JSON.stringify(changelog, null, 2), 'utf8')

  if (shouldSaveCache) {
    saveHistoryCache(cacheDir, { head, sourceDir, ext, dirBased, index, changelog })
  }
}
