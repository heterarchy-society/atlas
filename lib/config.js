import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'smol-toml'

function validateCollection(col, label) {
  if (!col.source_dir) throw new Error(`${label} must specify source_dir`)
  if (!col.format) throw new Error(`${label} must specify format`)
}

export function readConfig(rootDir) {
  const path = join(rootDir, 'config.toml')
  if (!existsSync(path)) throw new Error(`No config.toml found in ${rootDir}`)

  const config = parse(readFileSync(path, 'utf8'))

  // Normalize to always have config.collections as an array.
  // Supports both [collection] (single) and [[collections]] (multiple).
  if (config.collections) {
    for (const col of config.collections) validateCollection(col, '[[collections]] entry')
  } else if (config.collection) {
    validateCollection(config.collection, '[collection]')
    config.collections = [config.collection]
  } else {
    throw new Error('config.toml must have a [collection] or [[collections]] section')
  }

  return config
}

// Returns the first collection — used by unresolved/stale which are single-collection commands
export function readFirstCollection(rootDir) {
  return readConfig(rootDir).collections[0]
}
