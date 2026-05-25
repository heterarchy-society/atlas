import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, basename, extname } from 'node:path'
import { readConfig } from './config.js'
import { loadFile } from './loaders.js'

const ajv = new Ajv({ allErrors: true })
addFormats(ajv)

function loadSchema(rootDir, col) {
  const filename = col.schema ?? `${col.name}.json`
  const path = join(rootDir, 'schema', filename)
  if (!existsSync(path)) throw new Error(`Schema file not found: ${path}`)
  return JSON.parse(readFileSync(path, 'utf8'))
}

async function loadItems(rootDir, col) {
  const sourceDir = join(rootDir, col.source_dir)
  const items = []

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

export async function validateAll() {
  const rootDir = process.cwd()
  const config = readConfig(rootDir)
  let totalFailed = 0
  let totalItems = 0

  for (const col of config.collections) {
    const schema = loadSchema(rootDir, col)
    const validateFn = ajv.compile(schema)
    const items = await loadItems(rootDir, col)

    if (config.collections.length > 1) console.log(`\n[${col.name}]`)

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

  console.log(`\n${totalItems - totalFailed}/${totalItems} items valid`)
  if (totalFailed > 0) process.exitCode = 1
}
