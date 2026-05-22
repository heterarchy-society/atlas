import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, basename, extname } from 'node:path'
import { execSync } from 'node:child_process'
import matter from 'gray-matter'
import { validateTerm } from './validate.js'

const ROOT = process.cwd()
const GLOSSARY_DIR = join(ROOT, 'glossary')
const DIST_DIR = join(ROOT, 'dist')
const TERMS_DIR = join(DIST_DIR, 'terms')
const TRANSLATIONS_DIR = join(ROOT, 'translations')
const HISTORY_DIR = join(DIST_DIR, 'history')
const AUTHOR_CACHE_PATH = join(ROOT, '.github', 'authors.json')

const LINK_RE = /\[\[([^\|\]]+)\|?([^\]]*)\]\]/g
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const STATUS_OPS = { A: 'added', M: 'modified', D: 'deleted' }

function loadAuthorCache() {
  try { return JSON.parse(readFileSync(AUTHOR_CACHE_PATH, 'utf8')) } catch { return {} }
}

function buildGitIndex() {
  const index = new Map()
  const changelog = []
  let out
  try {
    out = execSync(
      `git log --format="COMMIT\x1f%H\x1f%aI\x1f%an\x1f%ae\x1f%s" --name-status -- "glossary/*.md"`,
      { cwd: ROOT, encoding: 'utf8' }
    ).trim()
  } catch {
    return { index, changelog }
  }
  if (!out) return { index, changelog }

  let current = null
  for (const line of out.split('\n')) {
    if (line.startsWith('COMMIT\x1f')) {
      const [, hash, date, author, email, message] = line.split('\x1f')
      current = { hash, date, author, email, message, changes: [] }
      changelog.push(current)
    } else if (line && current) {
      const [status, filename] = line.split('\t')
      if (!filename?.startsWith('glossary/')) continue
      const id = basename(filename, '.md')
      const op = STATUS_OPS[status] ?? 'modified'
      current.changes.push({ id, op })
      if (!index.has(filename)) index.set(filename, [])
      index.get(filename).push({ hash: current.hash, date: current.date, author: current.author, email: current.email, message: current.message })
    }
  }
  return { index, changelog }
}

function gitDiff(hash, filename) {
  let parent
  try {
    parent = execSync(
      `git rev-parse --verify ${hash}^`,
      { cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim()
  } catch {
    parent = EMPTY_TREE
  }
  try {
    return execSync(
      `git diff ${parent} ${hash} -- ${JSON.stringify(filename)}`,
      { cwd: ROOT, encoding: 'utf8' }
    ).trim()
  } catch {
    return null
  }
}

function loadTypesMap() {
  const map = {}
  let langsDir
  try { langsDir = readdirSync(TRANSLATIONS_DIR) } catch { return map }
  for (const lang of langsDir) {
    try {
      map[lang] = JSON.parse(readFileSync(join(TRANSLATIONS_DIR, lang, '_types.json'), 'utf8'))
    } catch { /* no types file for this lang */ }
  }
  return map
}

function loadTranslations(id, type, typesMap) {
  const translations = {}
  let langsDir
  try { langsDir = readdirSync(TRANSLATIONS_DIR) } catch { return translations }
  for (const lang of langsDir) {
    const file = join(TRANSLATIONS_DIR, lang, `${id}.json`)
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'))
      if (typesMap[lang]?.[type]) data.type = typesMap[lang][type]
      translations[lang] = data
    } catch {
      if (typesMap[lang]?.[type]) translations[lang] = { type: typesMap[lang][type] }
    }
  }
  return translations
}

export function loadTerms() {
  const typesMap = loadTypesMap()
  const files = readdirSync(GLOSSARY_DIR).filter(f => extname(f) === '.md').sort()
  const terms = []
  for (const filename of files) {
    const id = basename(filename, '.md')
    const parsed = matter.read(join(GLOSSARY_DIR, filename))
    const description = parsed.content.trim()
    const translations = loadTranslations(id, parsed.data.type, typesMap)
    const term = { id, ...parsed.data, description, ...(Object.keys(translations).length ? { translations } : {}) }
    validateTerm(term, id)
    terms.push(term)
  }
  return terms
}

export function resolveWikiLinks(terms) {
  const lookup = new Map()
  for (const t of terms) {
    for (const c of [t.id, t.name, ...(t.keywords || [])]) {
      if (c) lookup.set(c.toLowerCase(), t.id)
    }
  }
  let total = 0
  const unresolvedByKey = new Map()
  for (const term of terms) {
    const resolvedLinks = []
    for (const match of term.description.matchAll(LINK_RE)) {
      const display = match[1]
      const explicit = match[2]
      const target = lookup.get((explicit || display).toLowerCase()) ?? null
      resolvedLinks.push({ key: display, link: explicit || null, target })
      total++
      if (!target) {
        const label = explicit ? `${display}|${explicit}` : display
        if (!unresolvedByKey.has(label)) unresolvedByKey.set(label, new Set())
        unresolvedByKey.get(label).add(term.id)
      }
    }
    term.resolvedLinks = resolvedLinks
  }
  return { total, unresolvedByKey }
}

function buildHistory(terms) {
  mkdirSync(HISTORY_DIR, { recursive: true })
  const { index, changelog } = buildGitIndex()
  const authorCache = loadAuthorCache()

  for (const term of terms) {
    const filename = `glossary/${term.id}.md`
    const commits = index.get(filename) ?? []
    term.history = commits.map(({ hash, date, author, message }) => ({ hash, date, author, message }))

    const seen = new Map()
    for (const { author, email } of commits) {
      if (!seen.has(email)) {
        const entry = { name: author }
        const gh = authorCache[email]
        if (gh) entry.gh_username = gh
        seen.set(email, entry)
      }
    }
    if (seen.size > 0) term.authors = [...seen.values()]

    if (commits.length > 0) {
      const diffs = commits.map(({ hash, date, author, email, message }) => ({
        hash, date, author, email, message,
        diff: gitDiff(hash, filename),
      }))
      writeFileSync(join(HISTORY_DIR, `${term.id}.json`), JSON.stringify(diffs, null, 2), 'utf8')
    }
  }

  writeFileSync(join(DIST_DIR, 'changelog.json'), JSON.stringify(changelog, null, 2), 'utf8')
}

export function build() {
  console.log('Loading glossary entries...')
  const terms = loadTerms()

  console.log('Resolving wiki links...')
  const { total, unresolvedByKey } = resolveWikiLinks(terms)

  console.log('Building history...')
  buildHistory(terms)

  mkdirSync(TERMS_DIR, { recursive: true })

  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const index = {
    meta: { generated: new Date().toISOString(), count: terms.length, version: pkg.version },
    terms,
  }

  writeFileSync(join(DIST_DIR, 'index.json'), JSON.stringify(index, null, 2), 'utf8')
  console.log(`Written: ${join(DIST_DIR, 'index.json')}`)

  for (const term of terms) {
    writeFileSync(join(TERMS_DIR, `${term.id}.json`), JSON.stringify(term, null, 2), 'utf8')
  }
  console.log(`Written: ${terms.length} individual term files in ${TERMS_DIR}`)

  writeFileSync(join(DIST_DIR, 'glossary.js'), `export default ${JSON.stringify(index)};\n`, 'utf8')
  console.log(`Written: ${join(DIST_DIR, 'glossary.js')}`)

  const imported = terms.filter(t => t.imported).length
  console.log(`\nStats:`)
  console.log(`  Terms: ${terms.length} total, ${imported} imported, ${terms.length - imported} original`)
  console.log(`  Wiki links: ${total} total, ${unresolvedByKey.size} unresolved keywords`)
}
