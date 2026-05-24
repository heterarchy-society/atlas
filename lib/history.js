import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const STATUS_OPS = { A: 'added', M: 'modified', D: 'deleted' }

function loadAuthorCache(rootDir) {
  const path = join(rootDir, '.github', 'authors.json')
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return {} }
}

function gitLog(rootDir, glob) {
  const filter = glob ? `-- "${glob}"` : ''
  try {
    return execSync(
      `git log --format="COMMIT\x1f%H\x1f%aI\x1f%an\x1f%ae\x1f%s" --name-status ${filter}`,
      { cwd: rootDir, encoding: 'utf8' }
    ).trim()
  } catch {
    return ''
  }
}

function gitDiff(rootDir, hash, filename) {
  let parent
  try {
    parent = execSync(
      `git rev-parse --verify ${hash}^`,
      { cwd: rootDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim()
  } catch {
    parent = EMPTY_TREE
  }
  try {
    return execSync(
      `git diff ${parent} ${hash} -- ${JSON.stringify(filename)}`,
      { cwd: rootDir, encoding: 'utf8' }
    ).trim()
  } catch {
    return null
  }
}

function gitDiffStats(rootDir, hash, filename) {
  let parent
  try {
    parent = execSync(
      `git rev-parse --verify ${hash}^`,
      { cwd: rootDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim()
  } catch {
    parent = EMPTY_TREE
  }
  try {
    const out = execSync(
      `git diff --numstat ${parent} ${hash} -- ${JSON.stringify(filename)}`,
      { cwd: rootDir, encoding: 'utf8' }
    ).trim()
    if (!out) return { added: 0, removed: 0 }
    const [added, removed] = out.split('\t')
    return {
      added: Number(added) || 0,
      removed: Number(removed) || 0,
    }
  } catch {
    return { added: 0, removed: 0 }
  }
}

function buildGitIndex(rootDir, sourceDir, ext, { dirBased = false } = {}) {
  const dataGlob = dirBased ? `${sourceDir}/*/index.${ext}` : `${sourceDir}/*.${ext}`

  function extractId(filename) {
    const relative = filename.slice(sourceDir.length + 1)
    if (dirBased) return relative.split('/')[0]
    return relative.replace(/\.\w+$/, '')
  }

  // All commits → changelog (includes tooling commits with empty changes)
  const allOut = gitLog(rootDir)
  // Data-file commits only → per-item index
  const dataOut = gitLog(rootDir, dataGlob)

  const index = new Map()
  const changelog = []

  if (allOut) {
    let current = null
    for (const line of allOut.split('\n')) {
      if (line.startsWith('COMMIT\x1f')) {
        const [, hash, date, author, email, message] = line.split('\x1f')
        current = { hash, date, author, email, message, changes: [] }
        changelog.push(current)
      } else if (line && current) {
        const [status, filename] = line.split('\t')
        if (!filename?.startsWith(`${sourceDir}/`)) continue
        const id = extractId(filename)
        current.changes.push({
          id,
          op: STATUS_OPS[status] ?? 'modified',
          stats: gitDiffStats(rootDir, current.hash, filename),
        })
      }
    }
  }

  if (dataOut) {
    let current = null
    for (const line of dataOut.split('\n')) {
      if (line.startsWith('COMMIT\x1f')) {
        const [, hash, date, author, email, message] = line.split('\x1f')
        current = { hash, date, author, email, message }
      } else if (line && current) {
        const [, filename] = line.split('\t')
        if (!filename?.startsWith(`${sourceDir}/`)) continue
        if (!index.has(filename)) index.set(filename, [])
        index.get(filename).push({
          hash: current.hash, date: current.date,
          author: current.author, email: current.email,
          message: current.message,
        })
      }
    }
  }

  return { index, changelog }
}

export function buildHistory(items, rootDir, sourceDir, ext, distDir, { dirBased = false } = {}) {
  const historyDir = join(distDir, 'history')
  mkdirSync(historyDir, { recursive: true })

  const { index, changelog } = buildGitIndex(rootDir, sourceDir, ext, { dirBased })
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
      const diffs = commits.map(({ hash, date, author, email, message }) => ({
        hash, date, author, email, message,
        diff: gitDiff(rootDir, hash, filename),
      }))
      writeFileSync(join(historyDir, `${item.id}.json`), JSON.stringify(diffs, null, 2), 'utf8')
    }
  }

  writeFileSync(join(distDir, 'changelog.json'), JSON.stringify(changelog, null, 2), 'utf8')
}
