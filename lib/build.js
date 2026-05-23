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

function collectionLatestCommit(rootDir, sourceDir, format, dirBased) {
  const ext = format === 'yaml' ? 'yaml' : format
  const glob = dirBased ? `${sourceDir}/*/index.${ext}` : `${sourceDir}/*.${ext}`
  try {
    const out = execSync(
      `git log -1 --format="%H%x1f%aI" -- "${glob}"`,
      { cwd: rootDir, encoding: 'utf8' }
    ).trim()
    if (!out) return null
    const [hash, date] = out.split('\x1f')
    return { hash, date }
  } catch {
    return null
  }
}

function copyDirSources(srcDir, destDir, indexFile) {
  mkdirSync(destDir, { recursive: true })
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.name === indexFile) continue
    const src = join(srcDir, entry.name)
    const dest = join(destDir, entry.name)
    if (entry.isDirectory()) {
      copyDirSources(src, dest, indexFile)
    } else {
      copyFileSync(src, dest)
    }
  }
}

function datasetGitCommit(rootDir) {
  try {
    const out = execSync(
      'git log -1 --format="%H%x1f%aI"',
      { cwd: rootDir, encoding: 'utf8' }
    ).trim()
    if (!out) return null
    const [hash, date] = out.split('\x1f')
    return { hash, date }
  } catch {
    return null
  }
}

function stripIndexContent(value) {
  if (Array.isArray(value)) return value.map(stripIndexContent)
  if (!value || typeof value !== 'object') return value

  const result = {}
  for (const [key, nested] of Object.entries(value)) {
    if (['description', 'resources', 'history', 'resolvedLinks'].includes(key)) continue
    result[key] = stripIndexContent(nested)
  }
  return result
}

async function loadCollection(col, rootDir, distDir) {
  const SOURCE_DIR = join(rootDir, col.source_dir)

  const EXT = col.format === 'yaml' ? 'yaml' : col.format

  if (col.dir_based) {
    const indexFile = `index.${EXT}`
    const dirs = readdirSync(SOURCE_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort()

    const items = []
    for (const dir of dirs) {
      const raw = await loadFile(join(SOURCE_DIR, dir, indexFile), col.format)
      items.push({ id: dir, ...raw })
    }

    if (col.git_history) {
      buildHistory(items, rootDir, col.source_dir, EXT, distDir, { dirBased: true })
    }

    return items
  }

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
      commit: datasetGitCommit(ROOT),
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

    if (col.copy_sources && col.dir_based) {
      const SOURCE_DIR = join(ROOT, col.source_dir)
      const EXT = col.format === 'yaml' ? 'yaml' : col.format
      const indexFile = `index.${EXT}`
      for (const item of transformed) {
        copyDirSources(join(SOURCE_DIR, item.id), join(DIST_DIR, outputKey, item.id), indexFile)
      }
      console.log(`  Copied sources: ${col.source_dir}/*/  → dist/${outputKey}/*/`)
    }

    index.meta[outputKey] = {
      count: transformed.length,
      latestCommit: collectionLatestCommit(ROOT, col.source_dir, col.format, col.dir_based),
    }
    index[outputKey] = transformed

    writeFileSync(join(DIST_DIR, `${outputKey}.js`), `export default ${JSON.stringify({ meta: index.meta, [outputKey]: transformed })};\n`, 'utf8')
    console.log(`  Written: dist/${outputKey}.js`)

    const itemsDir = join(DIST_DIR, outputKey)
    mkdirSync(itemsDir, { recursive: true })
    for (const item of transformed) {
      writeFileSync(join(itemsDir, `${item.id}.json`), JSON.stringify(item, null, 2) + '\n', 'utf8')
    }
    console.log(`  Written: dist/${outputKey}/*.json`)

    const indexItems = transformed.map(stripIndexContent)
    writeFileSync(join(DIST_DIR, `${outputKey}-index.json`), JSON.stringify({ meta: index.meta, [outputKey]: indexItems }, null, 2) + '\n', 'utf8')
    console.log(`  Written: dist/${outputKey}-index.json`)
  }

  writeFileSync(join(DIST_DIR, 'index.json'), JSON.stringify(index, null, 2) + '\n', 'utf8')
  console.log(`\nWritten: dist/index.json`)
}
