import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs'
import { join, extname } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { readConfig, readFirstCollection } from './config.js'
import { loadFile } from './loaders.js'
import { buildHistory } from './history.js'

const ROOT = process.cwd()
const ATLAS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function atlasGitCommit() {
  const explicit = process.env.ATLAS_REF || process.env.GITHUB_SHA
  if (explicit) return explicit

  try {
    return execSync('git rev-parse HEAD', { cwd: ATLAS_ROOT, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

function atlasVersion() {
  try {
    return JSON.parse(readFileSync(join(ATLAS_ROOT, 'package.json'), 'utf8')).version ?? null
  } catch {
    return null
  }
}

async function loadCollection(col, rootDir, distDir) {
  const SOURCE_DIR = join(rootDir, col.source_dir)
  const EXT = col.format === 'yaml' ? 'yaml' : col.format

  const files = readdirSync(SOURCE_DIR)
    .filter(f => extname(f) === `.${EXT}` || (col.format === 'yaml' && extname(f) === '.yml'))
    .sort()

  const items = []
  for (const filename of files) {
    const id = filename.replace(/\.\w+$/, '')
    const raw = await loadFile(join(SOURCE_DIR, filename), col.format)
    items.push({ id, ...raw })
  }

  if (col.git_history) {
    buildHistory(items, rootDir, col.source_dir, EXT, distDir)
  }

  return items
}

async function loadHooks(rootDir) {
  for (const name of ['atlas-scripts.ts', 'atlas-scripts.js']) {
    const path = join(rootDir, name)
    if (existsSync(path)) {
      const mod = await import(path)
      return mod.default ?? mod
    }
  }
  return {}
}

// Used by unresolved.js and stale.js — reads the first collection via config
export async function loadTerms() {
  const col = readFirstCollection(ROOT)
  return loadCollection(col, ROOT, join(ROOT, 'dist'))
}

// Used by unresolved.js
const LINK_RE = /\[\[([^\|\]]+)\|?([^\]]*)\]\]/g

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

export async function build() {
  const config = readConfig(ROOT)
  const DIST_DIR = join(ROOT, config.output?.dir ?? 'dist')
  mkdirSync(DIST_DIR, { recursive: true })

  const hooks = await loadHooks(ROOT)
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

  const index = {
    meta: {
      generated: new Date().toISOString(),
      version: pkg.version,
      atlas: {
        version: atlasVersion(),
        commit: atlasGitCommit(),
      },
    },
  }

  for (const col of config.collections) {
    const outputKey = col.output_key ?? col.name ?? col.source_dir
    console.log(`\nLoading ${col.source_dir}/ (${col.format}) → "${outputKey}"...`)

    if (col.git_history) console.log('  Building git history...')
    const items = await loadCollection(col, ROOT, DIST_DIR)
    console.log(`  ${items.length} items`)

    const context = { allItems: items, config, col, rootDir: ROOT }
    const transformed = hooks.transform
      ? items.map(item => hooks.transform(item, context))
      : items

    if (col.assets_dir) {
      const ASSETS_SRC = join(ROOT, col.assets_dir)
      const ASSETS_DIST = join(DIST_DIR, 'assets')
      mkdirSync(ASSETS_DIST, { recursive: true })
      for (const file of readdirSync(ASSETS_SRC)) {
        copyFileSync(join(ASSETS_SRC, file), join(ASSETS_DIST, file))
      }
      console.log(`  Copied: ${col.assets_dir}/ → dist/assets/`)
    }

    index.meta[outputKey] = { count: transformed.length }
    index[outputKey] = transformed

    writeFileSync(join(DIST_DIR, `${outputKey}.js`), `export default ${JSON.stringify({ meta: index.meta, [outputKey]: transformed })};\n`, 'utf8')
    console.log(`  Written: dist/${outputKey}.js`)
  }

  writeFileSync(join(DIST_DIR, 'index.json'), JSON.stringify(index, null, 2) + '\n', 'utf8')
  console.log(`\nWritten: dist/index.json`)
}
