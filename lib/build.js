import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, copyFileSync, statSync } from 'node:fs'
import sharp from 'sharp'
import { join, extname } from 'node:path'
import { dirname, basename, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { readConfig, readFirstCollection } from './config.js'
import { loadFile } from './loaders.js'
import { buildHistory } from './history.js'
import { loadRedirects, validateRedirects } from './redirects.js'
import { latestCommit, resolveHead } from './git.js'
import { loadCollectionDirs } from './collection-dirs.js'

const ROOT = process.cwd()
const ATLAS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

async function atlasGitCommit() {
  const explicit = process.env.ATLAS_REF || process.env.GITHUB_SHA
  if (explicit) return explicit
  return resolveHead(ATLAS_ROOT)
}

function atlasVersion() {
  try {
    return JSON.parse(readFileSync(join(ATLAS_ROOT, 'package.json'), 'utf8')).version ?? null
  } catch {
    return null
  }
}

async function collectionLatestCommit(rootDir, sourceDir, format, { dirBased = false, collectionDirs = false } = {}) {
  const ext = format === 'yaml' ? 'yaml' : format
  const glob = (dirBased || collectionDirs)
    ? `${sourceDir}/*/index.${ext}`
    : `${sourceDir}/*.${ext}`
  return latestCommit(rootDir, { glob })
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

function detectImage(buf) {
  if (buf.length < 12) return null
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg'
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp'
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif'
  return null
}

function imageDimensions(buf, format) {
  try {
    if (format === 'png' && buf.length >= 24) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
    }
    if (format === 'jpeg') {
      let i = 2
      while (i + 4 < buf.length) {
        if (buf[i] !== 0xff) break
        const marker = buf[i + 1]
        if (marker === 0xda) break
        const len = buf.readUInt16BE(i + 2)
        if (marker >= 0xc0 && marker <= 0xc3 && i + 9 < buf.length)
          return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) }
        i += 2 + len
      }
    }
  } catch { }
  return null
}

function fileMimeType(filepath) {
  try {
    return execSync(`file --mime-type -b ${JSON.stringify(filepath)}`, { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

function stripMarkdown(md) {
  return md
    .replace(/^---[\s\S]*?^---\s*/m, '')   // frontmatter
    .replace(/```[\s\S]*?```/g, ' ')        // fenced code blocks
    .replace(/`[^`]+`/g, ' ')              // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')  // images
    .replace(/\[[^\]]*\]\([^)]*\)/g, '$1') // links → text
    .replace(/^#{1,6}\s+/gm, '')           // headings
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1') // bold/italic
    .replace(/^\s*[-*+]\s+/gm, '')         // list bullets
    .replace(/^\s*\d+\.\s+/gm, '')         // ordered lists
    .replace(/^\s*>\s+/gm, '')             // blockquotes
}

function computeTextStats(content, ext) {
  const plain = ext === '.md' ? stripMarkdown(content) : content
  const words = plain.trim().split(/\s+/).filter(Boolean)
  const sentences = plain.split(/[.!?]+\s/).filter(s => s.trim().length > 0)
  return {
    words: words.length,
    chars: plain.replace(/\s/g, '').length,
    sentences: sentences.length,
  }
}

function pdfPageCount(filepath) {
  try {
    const out = execSync(`pdfinfo ${JSON.stringify(filepath)}`, { encoding: 'utf8' })
    const m = out.match(/^Pages:\s*(\d+)/m)
    return m ? parseInt(m[1], 10) : null
  } catch {
    return null
  }
}


async function generateImageVersions(filepath, sizes, fileHash) {
  const CACHE_DIR = join(ROOT, '.atlas-cache', relative(ROOT, dirname(filepath)))
  mkdirSync(CACHE_DIR, { recursive: true })
  
  const base = basename(filepath).replace(/\.[^/.]+$/, '')
  
  const versions = {}
  for (const width of sizes) {
    const outName = `${base}-${width}w.webp`
    const cachePath = join(CACHE_DIR, outName)
    const hashFile = `${cachePath}.hash`
    
    let generate = true
    if (existsSync(cachePath) && existsSync(hashFile)) {
      const cachedHash = readFileSync(hashFile, 'utf8')
      if (cachedHash === fileHash) {
        generate = false
      }
    }
    if (generate) {
      await sharp(filepath).resize({ width }).webp().toFile(cachePath)
      writeFileSync(hashFile, fileHash, 'utf8')
    }
    const cacheStat = statSync(cachePath)
    const meta = await sharp(cachePath).metadata()
    versions[`${width}w`] = {
      src: outName,
      width: meta.width,
      height: meta.height,
      size: cacheStat.size
    }
  }
  return versions
}

async function fileMetadata(filepath, imageSizes) {
  const data = readFileSync(filepath)
  const meta = { size: data.length, hash: createHash('sha256').update(data).digest('hex') }
  const mime = fileMimeType(filepath)
  if (mime) meta.mime = mime
  const imgFormat = detectImage(data)
  if (imgFormat) {
    const dims = imageDimensions(data, imgFormat)
    meta.image = { format: imgFormat, ...dims }
    if (imageSizes && imageSizes.length > 0) {
      meta.image.versions = await generateImageVersions(filepath, imageSizes, meta.hash)
    }
  }
  const ext = extname(filepath).toLowerCase()
  if (ext === '.md' || ext === '.txt') {
    meta.text = computeTextStats(data.toString('utf8'), ext)
  } else if (ext === '.pdf') {
    const pages = pdfPageCount(filepath)
    if (pages !== null) meta.text = { pages }
  }
  return meta
}

async function buildDirAssets(dir, indexFile, imageSizes) {
  const assets = {}
  async function scan(cur, prefix) {
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (rel === indexFile) continue
      if (entry.isDirectory()) { await scan(join(cur, entry.name), rel); continue }
      try { assets[rel] = await fileMetadata(join(cur, entry.name), imageSizes) } catch { }
    }
  }
  await scan(dir, '')
  return Object.keys(assets).length > 0 ? assets : undefined
}

async function buildFieldAssets(item, assetsDir, fields, imageSizes) {
  const assets = {}
  for (const field of fields) {
    const val = item[field]
    if (!val) continue
    const filepath = join(assetsDir, val)
    if (!existsSync(filepath)) continue
    try { assets[val] = await fileMetadata(filepath, imageSizes) } catch (err) { console.error(err) }
  }
  return Object.keys(assets).length > 0 ? assets : undefined
}

async function datasetGitCommit(rootDir) {
  return latestCommit(rootDir)
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

  if (col.collection_dirs) {
    return loadCollectionDirs(col, rootDir, distDir, { fileMetadata, buildDirAssets })
  }

  if (col.dir_based) {
    const indexFile = `index.${EXT}`
    const dirs = readdirSync(SOURCE_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort()

    const items = []
    for (const dir of dirs) {
      const raw = await loadFile(join(SOURCE_DIR, dir, indexFile), col.format)
      const item = { id: dir, ...raw }
      const _assets = await buildDirAssets(join(SOURCE_DIR, dir), indexFile, col.image_sizes)
      if (_assets) item._assets = _assets
      items.push(item)
    }

    if (col.git_history) {
      await buildHistory(items, rootDir, col.source_dir, EXT, distDir, { dirBased: true })
    }

    return { items, collections: null }
  }

  const files = readdirSync(SOURCE_DIR)
    .filter(f => extname(f) === `.${EXT}` || (col.format === 'yaml' && extname(f) === '.yml'))
    .sort()

  const ASSETS_DIR = col.assets_dir ? join(rootDir, col.assets_dir) : null
  const items = []
  for (const filename of files) {
    const id = filename.replace(/\.\w+$/, '')
    const raw = await loadFile(join(SOURCE_DIR, filename), col.format)
    const item = { id, ...raw }
    if (ASSETS_DIR && col.asset_fields?.length) {
      const _assets = await buildFieldAssets(item, ASSETS_DIR, col.asset_fields, col.image_sizes)
      if (_assets) item._assets = _assets
    }
    items.push(item)
  }

  if (col.git_history) {
    await buildHistory(items, rootDir, col.source_dir, EXT, distDir)
  }

  return { items, collections: null }
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
  const { items } = await loadCollection(col, ROOT, join(ROOT, 'dist'))
  return items
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
      // MediaWiki order: [[target|display]] — left is id, right is visible label
      const targetKey = match[1].trim()
      const displayKey = match[2]?.trim() || ''
      const display = displayKey || targetKey
      const target = lookup.get(targetKey.toLowerCase()) ?? null
      resolvedLinks.push({
        key: display,
        link: displayKey ? `${targetKey}|${displayKey}` : null,
        target,
      })
      total++
      if (!target) {
        const label = displayKey ? `${targetKey}|${displayKey}` : targetKey
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
      commit: await datasetGitCommit(ROOT),
      atlas: {
        version: atlasVersion(),
        commit: await atlasGitCommit(),
      },
    },
  }

  for (const col of config.collections) {
    const outputKey = col.output_key ?? col.name ?? col.source_dir
    console.log(`\nLoading ${col.source_dir}/ (${col.format}) → "${outputKey}"...`)

    if (col.git_history) console.log('  Building git history...')
    const { items, collections } = await loadCollection(col, ROOT, DIST_DIR)
    console.log(`  ${items.length} items${collections ? ` in ${collections.length} collections` : ''}`)

    const context = { allItems: items, config, col, rootDir: ROOT }
    const transformed = hooks.transform
      ? items.map(item => hooks.transform(item, context))
      : items

    if (col.assets_dir) {
      const ASSETS_SRC = join(ROOT, col.assets_dir)
      const ASSETS_DIST = join(DIST_DIR, 'assets')
      mkdirSync(ASSETS_DIST, { recursive: true })
      const CACHE_SRC = join(ROOT, '.atlas-cache', col.assets_dir)
      for (const file of readdirSync(ASSETS_SRC)) {
        copyFileSync(join(ASSETS_SRC, file), join(ASSETS_DIST, file))
      }
      if (existsSync(CACHE_SRC)) {
        for (const file of readdirSync(CACHE_SRC)) {
          copyFileSync(join(CACHE_SRC, file), join(ASSETS_DIST, file))
        }
      }
      console.log(`  Copied: ${col.assets_dir}/ → dist/assets/`)
    }

    if (col.copy_sources && (col.dir_based || col.collection_dirs)) {
      const SOURCE_DIR = join(ROOT, col.source_dir)
      const EXT = col.format === 'yaml' ? 'yaml' : col.format
      const indexFile = `index.${EXT}`
      const dirIds = col.collection_dirs
        ? (collections ?? []).map(c => c.id)
        : transformed.map(item => item.id)
      for (const id of dirIds) {
        copyDirSources(join(SOURCE_DIR, id), join(DIST_DIR, outputKey, id), indexFile)
        const cacheSrc = join(ROOT, '.atlas-cache', col.source_dir, id)
        if (existsSync(cacheSrc)) {
          copyDirSources(cacheSrc, join(DIST_DIR, outputKey, id), indexFile)
        }
      }
      console.log(`  Copied sources: ${col.source_dir}/*/  → dist/${outputKey}/*/`)
    }

    index.meta[outputKey] = {
      count: transformed.length,
      latestCommit: await collectionLatestCommit(ROOT, col.source_dir, col.format, {
        dirBased: col.dir_based,
        collectionDirs: col.collection_dirs,
      }),
      ...(collections ? { collections: collections.length } : {}),
    }
    index[outputKey] = transformed

    if (collections) {
      index.collections = collections
      writeFileSync(
        join(DIST_DIR, 'collections-index.json'),
        JSON.stringify({ meta: index.meta, collections }, null, 2) + '\n',
        'utf8',
      )
      console.log(`  Written: dist/collections-index.json (${collections.length} collections)`)
    }

    const redirects = await loadRedirects(ROOT, col, config)
    const redirectErrors = validateRedirects(redirects, transformed.map(i => i.id))
    if (redirectErrors.length > 0) {
      throw new Error(`Invalid redirects:\n  ${redirectErrors.join('\n  ')}`)
    }
    if (Object.keys(redirects).length > 0) {
      index.meta.redirects = { ...(index.meta.redirects ?? {}), ...redirects }
      console.log(`  Redirects: ${Object.keys(redirects).length}`)
    }

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
