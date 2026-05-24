import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, basename, extname } from 'node:path'
import matter from 'gray-matter'
import { readConfig } from './config.js'

const ajv = new Ajv({ allErrors: true })
addFormats(ajv)

function loadSchema(rootDir, col) {
  const filename = col.schema ?? `${col.name}.json`
  const path = join(rootDir, 'schema', filename)
  if (!existsSync(path)) throw new Error(`Schema file not found: ${path}`)
  return JSON.parse(readFileSync(path, 'utf8'))
}

function loadItems(rootDir, col) {
  const sourceDir = join(rootDir, col.source_dir)
  const items = []

  if (col.dir_based) {
    for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const id = entry.name
      const indexPath = join(sourceDir, id, `index.${col.format}`)
      if (!existsSync(indexPath)) continue
      const parsed = matter.read(indexPath)
      items.push({ id, ...parsed.data, description: parsed.content.trim() })
    }
  } else {
    for (const filename of readdirSync(sourceDir).filter(f => extname(f) === `.${col.format}`).sort()) {
      const id = basename(filename, `.${col.format}`)
      const parsed = matter.read(join(sourceDir, filename))
      items.push({ id, ...parsed.data, description: parsed.content.trim() })
    }
  }

  return items
}

export function validateAll() {
  const rootDir = process.cwd()
  const config = readConfig(rootDir)
  let totalFailed = 0
  let totalItems = 0

  for (const col of config.collections) {
    const schema = loadSchema(rootDir, col)
    const validateFn = ajv.compile(schema)
    const items = loadItems(rootDir, col)

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
