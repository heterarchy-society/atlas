import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'smol-toml'

function validateCollection(col, label) {
  if (!col.source_dir) throw new Error(`${label} must specify source_dir`)
  if (!col.format) throw new Error(`${label} must specify format`)
}

const BUILD_ONLY_COLLECTION_KEYS = new Set([
  'schema',
  'item_schema',
  'source_dir',
  'format',
  'git_history',
  'dir_based',
  'collection_dirs',
  'copy_sources',
  'assets_dir',
  'asset_fields',
  'image_sizes',
  'redirects',
])

function publicCollection(col) {
  const out = {
    name: col.name,
    output_key: col.output_key ?? col.name ?? col.source_dir,
  }
  for (const [key, value] of Object.entries(col)) {
    if (BUILD_ONLY_COLLECTION_KEYS.has(key)) continue
    if (key in out) continue
    out[key] = value
  }
  return out
}

/** Config.toml sections safe to ship in dist/ (excludes build/CLI-only settings). */
export function buildBundleConfig(config) {
  const { output, translation, collection, collections, ...rest } = config
  const bundle = { ...rest }

  if (collections?.length === 1) {
    bundle.collection = publicCollection(collections[0])
  } else if (collections?.length > 1) {
    bundle.collections = collections.map(publicCollection)
  }

  return bundle
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
