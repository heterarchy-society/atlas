import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { buildGitIndex, clearGitCaches, fileDiff } from './git.js'

function loadAuthorCache(rootDir) {
  const path = join(rootDir, '.github', 'authors.json')
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return {} }
}

export async function buildHistory(items, rootDir, sourceDir, ext, distDir, { dirBased = false } = {}) {
  const historyDir = join(distDir, 'history')
  mkdirSync(historyDir, { recursive: true })

  clearGitCaches()
  const { index, changelog } = await buildGitIndex(rootDir, sourceDir, ext, { dirBased })
  const authorCache = loadAuthorCache(rootDir)

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

    if (commits.length > 0) {
      const diffs = []
      for (const { hash, date, author, email, message } of commits) {
        diffs.push({
          hash, date, author, email, message,
          diff: await fileDiff(rootDir, hash, filename),
        })
      }
      writeFileSync(join(historyDir, `${item.id}.json`), JSON.stringify(diffs, null, 2), 'utf8')
    }
  }

  writeFileSync(join(distDir, 'changelog.json'), JSON.stringify(changelog, null, 2), 'utf8')
}
