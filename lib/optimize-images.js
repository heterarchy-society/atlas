import { readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync, statSync, mkdirSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import sharp from 'sharp'
import { readConfig } from './config.js'
import { loadFile } from './loaders.js'

const ROOT = process.cwd()
const DEFAULT_QUALITY = 85
const SOURCE_EXTENSIONS = 'png|jpe?g|gif|tiff?|bmp|jfif'
const SOURCE_FILENAME = new RegExp(`^[\\w./+-]+\\.(${SOURCE_EXTENSIONS})$`, 'i')
const SOURCE_EXT = new RegExp(`\\.(${SOURCE_EXTENSIONS})$`, 'i')

function parseArgs(argv) {
  const dryRun = argv.includes('--dry-run')
  let quality = DEFAULT_QUALITY
  const positional = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') continue
    if (arg === '--quality') {
      quality = Number(argv[++i])
      continue
    }
    positional.push(arg)
  }

  const id = positional[0]
  if (!Number.isFinite(quality) || quality < 1 || quality > 100) {
    throw new Error('--quality must be a number between 1 and 100')
  }
  return { dryRun, quality, id }
}

function isOptimizableImage(name) {
  return typeof name === 'string'
    && !name.includes('..')
    && SOURCE_FILENAME.test(name)
}

function webpName(filename) {
  return filename.replace(SOURCE_EXT, '.webp')
}

function collectImageRefs(value, refs = new Set()) {
  if (typeof value === 'string') {
    if (isOptimizableImage(value)) refs.add(value)
  } else if (Array.isArray(value)) {
    for (const item of value) collectImageRefs(item, refs)
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectImageRefs(v, refs)
  }
  return refs
}

function updateYamlReferences(yaml, replacements) {
  let out = yaml
  for (const [oldName, newName] of replacements) {
    out = out.replace(new RegExp(`(?<=[:\\s-])${escapeRegExp(oldName)}(?=\\s*$)`, 'gm'), newName)
  }
  return out
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

async function writeOptimizedWebp(srcPath, destPath, quality) {
  const tmpPath = `${destPath}.optimize.tmp`
  mkdirSync(dirname(destPath), { recursive: true })
  await sharp(srcPath).webp({ quality }).toFile(tmpPath)
  unlinkSync(srcPath)
  renameSync(tmpPath, destPath)
}

async function optimizeItemDir(itemDir, indexFile, format, { dryRun, quality }) {
  const indexPath = join(itemDir, indexFile)
  if (!existsSync(indexPath)) return []

  const rawYaml = readFileSync(indexPath, 'utf8')
  const data = await loadFile(indexPath, format)
  const refs = [...collectImageRefs(data)]
  if (refs.length === 0) return []

  const results = []
  const replacements = []

  for (const filename of refs) {
    const srcPath = join(itemDir, filename)
    if (!existsSync(srcPath)) {
      results.push({ filename, status: 'missing' })
      continue
    }

    const destName = webpName(filename)
    const destPath = join(itemDir, destName)
    const before = statSync(srcPath).size

    if (dryRun) {
      const tmpPath = `${destPath}.optimize.tmp`
      await sharp(srcPath).webp({ quality }).toFile(tmpPath)
      const after = statSync(tmpPath).size
      unlinkSync(tmpPath)
      results.push({
        filename,
        destName,
        before,
        after,
        status: 'would convert',
      })
      if (filename !== destName) replacements.push([filename, destName])
      continue
    }

    await writeOptimizedWebp(srcPath, destPath, quality)
    const after = statSync(destPath).size
    if (filename !== destName) replacements.push([filename, destName])
    results.push({
      filename,
      destName,
      before,
      after,
      status: 'converted',
    })
  }

  if (replacements.length > 0 && !dryRun) {
    writeFileSync(indexPath, updateYamlReferences(rawYaml, replacements), 'utf8')
  }

  return results
}

function listSourceDirs(col, sourceDir, id) {
  if (!existsSync(sourceDir)) return []
  return readdirSync(sourceDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .filter(name => !id || name === id)
    .sort()
}

export async function optimizeImages() {
  const { dryRun, quality, id } = parseArgs(process.argv.slice(3))
  const config = readConfig(ROOT)
  let totalBefore = 0
  let totalAfter = 0
  let converted = 0

  for (const col of config.collections) {
    if (!col.dir_based && !col.collection_dirs) continue

    const sourceDir = join(ROOT, col.source_dir)
    const ext = col.format === 'yaml' ? 'yaml' : col.format
    const indexFile = `index.${ext}`

    const dirs = listSourceDirs(col, sourceDir, id)

    if (id && dirs.length === 0) {
      throw new Error(`No item "${id}" found in ${col.source_dir}/`)
    }

    for (const dir of dirs) {
      const itemDir = join(sourceDir, dir)
      const results = await optimizeItemDir(itemDir, indexFile, col.format, { dryRun, quality })

      for (const result of results) {
        if (result.status === 'missing') {
          console.log(`  ${dir}: ${result.filename} (missing)`)
          continue
        }

        const saved = result.before - result.after
        const pct = ((saved / result.before) * 100).toFixed(1)
        const label = dryRun ? 'would optimize' : 'optimized'
        console.log(
          `  ${dir}: ${result.filename} → ${result.destName} (${label}: ${formatBytes(result.before)} → ${formatBytes(result.after)}, -${pct}%)`,
        )
        totalBefore += result.before
        totalAfter += result.after
        converted++
      }

      if (results.some(r => r.status === 'converted') && !dryRun) {
        console.log(`  ${dir}: updated ${indexFile}`)
      }
    }
  }

  if (converted === 0) {
    console.log('No optimizable images found.')
    return
  }

  const saved = totalBefore - totalAfter
  const pct = ((saved / totalBefore) * 100).toFixed(1)
  const prefix = dryRun ? 'Would save' : 'Saved'
  console.log(`\n${prefix} ${formatBytes(saved)} (${pct}%) across ${converted} image${converted === 1 ? '' : 's'}`)
}
