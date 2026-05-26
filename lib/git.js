import { existsSync } from 'node:fs'
import fs from 'node:fs'
import { join } from 'node:path'
import git from 'isomorphic-git'
import { createTwoFilesPatch, diffLines } from 'diff'

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

function hasGitRepo(dir) {
  return existsSync(join(dir, '.git'))
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

export function formatAuthorDate(author) {
  const tzOffset = author.timezoneOffset ?? 0
  const isoOffsetMin = -tzOffset
  const sign = isoOffsetMin >= 0 ? '+' : '-'
  const abs = Math.abs(isoOffsetMin)
  const offH = pad2(Math.floor(abs / 60))
  const offM = pad2(abs % 60)
  const localMs = author.timestamp * 1000 - tzOffset * 60_000
  const d = new Date(localMs)
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}${sign}${offH}:${offM}`
}

export function matchGlob(filepath, glob) {
  const re = new RegExp(
    '^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\0/g, '.*') + '$'
  )
  return re.test(filepath)
}

function commitMeta(oid, commit) {
  return {
    hash: oid,
    date: formatAuthorDate(commit.author),
    author: commit.author.name,
    email: commit.author.email,
    message: commit.message.trim(),
  }
}

async function readFileAtRef(dir, ref, filepath) {
  if (ref === EMPTY_TREE) return null
  let content = null
  try {
    await git.walk({
      fs,
      dir,
      trees: [git.TREE({ ref })],
      map: async (fp, [entry]) => {
        if (fp === filepath) {
          const buf = await entry.content()
          content = buf ? Buffer.from(buf).toString('utf8') : null
        }
      },
    })
  } catch {
    return null
  }
  return content
}

async function getParent(dir, oid) {
  try {
    const { commit } = await git.readCommit({ fs, dir, oid })
    return commit.parent?.[0] ?? EMPTY_TREE
  } catch {
    return EMPTY_TREE
  }
}

const nameStatusCache = new Map()
const parentCache = new Map()

async function getNameStatus(dir, parent, oid) {
  const key = `${dir}\0${parent}\0${oid}`
  if (nameStatusCache.has(key)) return nameStatusCache.get(key)

  const changes = []
  await git.walk({
    fs,
    dir,
    trees: [git.TREE({ ref: parent }), git.TREE({ ref: oid })],
    map: async (filepath, [A, B]) => {
      if (filepath === '.') return
      if (A && (await A.type()) === 'tree') return
      if (B && (await B.type()) === 'tree') return

      const Aoid = A ? await A.oid() : undefined
      const Boid = B ? await B.oid() : undefined
      if (Aoid === Boid) return

      let status = 'M'
      if (Aoid === undefined) status = 'A'
      else if (Boid === undefined) status = 'D'

      changes.push({ status, path: filepath })
    },
  })

  nameStatusCache.set(key, changes)
  return changes
}

async function cachedParent(dir, oid) {
  const key = `${dir}\0${oid}`
  if (parentCache.has(key)) return parentCache.get(key)
  const parent = await getParent(dir, oid)
  parentCache.set(key, parent)
  return parent
}

export async function resolveHead(dir) {
  if (!hasGitRepo(dir)) return null
  try {
    return await git.resolveRef({ fs, dir, ref: 'HEAD' })
  } catch {
    return null
  }
}

export async function latestCommit(dir, { glob, filepath } = {}) {
  if (!hasGitRepo(dir)) return null

  try {
    if (!glob && !filepath) {
      const commits = await git.log({ fs, dir, depth: 1 })
      if (commits.length === 0) return null
      const { oid, commit } = commits[0]
      return { hash: oid, date: formatAuthorDate(commit.author) }
    }

    if (filepath && !glob) {
      const commits = await git.log({ fs, dir, filepath, depth: 1 })
      if (commits.length === 0) return null
      const { oid, commit } = commits[0]
      return { hash: oid, date: formatAuthorDate(commit.author) }
    }

    const commits = await git.log({ fs, dir })
    for (const { oid, commit } of commits) {
      const parent = await cachedParent(dir, oid)
      const changes = await getNameStatus(dir, parent, oid)
      const files = changes.map(c => c.path).filter(path => matchGlob(path, glob))
      if (files.length > 0) {
        return { hash: oid, date: formatAuthorDate(commit.author) }
      }
    }
    return null
  } catch {
    return null
  }
}

export async function authorEmails(dir, glob) {
  if (!hasGitRepo(dir)) return []

  const emails = new Set()
  try {
    const commits = await git.log({ fs, dir })
    for (const { oid, commit } of commits) {
      const parent = await cachedParent(dir, oid)
      const changes = await getNameStatus(dir, parent, oid)
      const touched = glob
        ? changes.some(c => matchGlob(c.path, glob))
        : changes.length > 0
      if (touched) emails.add(commit.author.email)
    }
  } catch {
    return []
  }
  return [...emails]
}

export async function fileDiff(dir, hash, filepath) {
  if (!hasGitRepo(dir)) return null

  const parent = await cachedParent(dir, hash)
  const oldContent = await readFileAtRef(dir, parent, filepath)
  const newContent = await readFileAtRef(dir, hash, filepath)
  if (oldContent === null && newContent === null) return null

  return createTwoFilesPatch(
    `a/${filepath}`,
    `b/${filepath}`,
    oldContent ?? '',
    newContent ?? '',
    undefined,
    undefined,
    { context: 3 }
  ).trim()
}

export async function fileDiffStats(dir, hash, filepath) {
  if (!hasGitRepo(dir)) return { added: 0, removed: 0 }

  const parent = await cachedParent(dir, hash)
  const oldContent = await readFileAtRef(dir, parent, filepath)
  const newContent = await readFileAtRef(dir, hash, filepath)
  if (oldContent === null && newContent === null) return { added: 0, removed: 0 }

  let added = 0
  let removed = 0
  for (const part of diffLines(oldContent ?? '', newContent ?? '')) {
    if (part.added) added += part.count ?? 0
    if (part.removed) removed += part.count ?? 0
  }
  return { added, removed }
}

export async function buildGitIndex(dir, sourceDir, ext, { dirBased = false } = {}) {
  const dataGlob = dirBased ? `${sourceDir}/*/index.${ext}` : `${sourceDir}/*.${ext}`
  const index = new Map()
  const changelog = []

  if (!hasGitRepo(dir)) return { index, changelog }

  function extractId(filename) {
    const relative = filename.slice(sourceDir.length + 1)
    if (dirBased) return relative.split('/')[0]
    return relative.replace(/\.\w+$/, '')
  }

  try {
    const commits = await git.log({ fs, dir })
    for (const { oid, commit } of commits) {
      const meta = commitMeta(oid, commit)
      const parent = await cachedParent(dir, oid)
      const changes = await getNameStatus(dir, parent, oid)

      const sourceChanges = changes.filter(c => c.path.startsWith(`${sourceDir}/`))
      if (sourceChanges.length > 0) {
        const entry = { ...meta, changes: [] }
        for (const { status, path } of sourceChanges) {
          entry.changes.push({
            id: extractId(path),
            op: { A: 'added', M: 'modified', D: 'deleted' }[status] ?? 'modified',
            stats: await fileDiffStats(dir, oid, path),
          })
        }
        changelog.push(entry)
      } else {
        changelog.push({ ...meta, changes: [] })
      }

      const dataChanges = changes.filter(c => matchGlob(c.path, dataGlob))
      for (const { path } of dataChanges) {
        if (!index.has(path)) index.set(path, [])
        index.get(path).push(meta)
      }
    }
  } catch {
    // No git history available.
  }

  return { index, changelog }
}

export function clearGitCaches() {
  nameStatusCache.clear()
  parentCache.clear()
}
