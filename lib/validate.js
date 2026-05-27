import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, basename, extname } from 'node:path'
import { readConfig } from './config.js'
import { loadFile } from './loaders.js'
import { loadRedirects, validateRedirects } from './redirects.js'

const ajv = new Ajv({ allErrors: true })
addFormats(ajv)

function loadSchema(rootDir, filename) {
  if (!filename) return null
  const path = join(rootDir, 'schema', filename)
  if (!existsSync(path)) throw new Error(`Schema file not found: ${path}`)
  return JSON.parse(readFileSync(path, 'utf8'))
}

async function loadItems(rootDir, col) {
  const sourceDir = join(rootDir, col.source_dir)
  const items = []

  if (col.collection_dirs) {
    const indexName = `index.${col.format}`
    for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const indexPath = join(sourceDir, entry.name, indexName)
      if (!existsSync(indexPath)) continue
      const raw = await loadFile(indexPath, col.format)
      const collectionId = raw.id ?? entry.name
      for (const talk of raw.items ?? []) {
        items.push({ ...talk, collection: collectionId })
      }
    }
    return items
  }

  if (col.dir_based) {
    for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const id = entry.name
      const indexPath = join(sourceDir, id, `index.${col.format}`)
      if (!existsSync(indexPath)) continue
      const raw = await loadFile(indexPath, col.format)
      items.push({ id, ...raw })
    }
  } else {
    for (const filename of readdirSync(sourceDir).filter(f => extname(f) === `.${col.format}`).sort()) {
      const id = basename(filename, `.${col.format}`)
      const raw = await loadFile(join(sourceDir, filename), col.format)
      items.push({ id, ...raw })
    }
  }

  return items
}

async function validateCollectionDirs(rootDir, col) {
  const sourceDir = join(rootDir, col.source_dir)
  const collectionSchema = loadSchema(rootDir, col.schema)
  const itemSchema = loadSchema(rootDir, col.item_schema)
  if (!collectionSchema) return { failed: 0, items: 0 }

  if (itemSchema) ajv.addSchema(itemSchema)

  const validateCollection = ajv.compile(collectionSchema)
  const validateItem = itemSchema ? ajv.compile(itemSchema) : null

  let failed = 0
  let totalItems = 0
  const indexName = `index.${col.format}`

  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const indexPath = join(sourceDir, entry.name, indexName)
    if (!existsSync(indexPath)) continue

    const raw = await loadFile(indexPath, col.format)
    const collectionId = raw.id ?? entry.name

    if (!validateCollection(raw)) {
      const errors = ajv.errorsText(validateCollection.errors, { separator: '\n  ' })
      console.error(`  ✗ ${collectionId} (collection):\n  ${errors}`)
      failed++
      continue
    }
    console.log(`  ✓ ${collectionId} (${raw.items?.length ?? 0} items)`)

    if (!validateItem) continue
    for (const talk of raw.items ?? []) {
      totalItems++
      if (validateItem(talk)) {
        console.log(`    ✓ ${talk.id}`)
      } else {
        const errors = ajv.errorsText(validateItem.errors, { separator: '\n  ' })
        console.error(`    ✗ ${collectionId}/${talk.id}:\n    ${errors}`)
        failed++
      }
    }
  }

  return { failed, items: totalItems }
}

export async function validateAll() {
  const rootDir = process.cwd()
  const config = readConfig(rootDir)
  let totalFailed = 0
  let totalItems = 0

  for (const col of config.collections) {
    if (config.collections.length > 1) console.log(`\n[${col.name}]`)

    if (col.collection_dirs) {
      const { failed, items } = await validateCollectionDirs(rootDir, col)
      totalFailed += failed
      totalItems += items
      const flatItems = await loadItems(rootDir, col)
      const redirects = await loadRedirects(rootDir, col, config)
      const redirectErrors = validateRedirects(redirects, flatItems.map(i => i.id))
      if (redirectErrors.length > 0) {
        console.error(`  ✗ redirects:\n  ${redirectErrors.join('\n  ')}`)
        totalFailed += redirectErrors.length
      } else if (Object.keys(redirects).length > 0) {
        console.log(`  ✓ redirects (${Object.keys(redirects).length})`)
      }
      continue
    }

    const items = await loadItems(rootDir, col)
    const schema = loadSchema(rootDir, col.schema)

    if (!schema) {
      console.log(`  (no schema — skipping ${items.length} items)`)
    } else {
      const validateFn = ajv.compile(schema)
      for (const item of items) {
        totalItems++
        const valid = validateFn(item)
        if (valid) {
          console.log(`  ✓ ${item.id}`)
        } else {
          const errors = ajv.errorsText(validateFn.errors, { separator: '\n  ' })
          console.error(`  ✗ ${item.id}:\n  ${errors}`)
          totalFailed++
        }
      }
    }

    const redirects = await loadRedirects(rootDir, col, config)
    const redirectErrors = validateRedirects(redirects, items.map(i => i.id))
    if (redirectErrors.length > 0) {
      console.error(`  ✗ redirects:\n  ${redirectErrors.join('\n  ')}`)
      totalFailed += redirectErrors.length
    } else if (Object.keys(redirects).length > 0) {
      console.log(`  ✓ redirects (${Object.keys(redirects).length})`)
    }
  }

  console.log(`\n${totalItems - totalFailed}/${totalItems} items valid`)
  if (totalFailed > 0) process.exitCode = 1
}
