import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadFile } from './loaders.js'
import { buildHistory } from './history.js'

export async function buildTalkAssets(collectionDir, thumbnail, imageSizes, fileMetadata) {
  if (!thumbnail) return undefined
  const filepath = join(collectionDir, thumbnail)
  if (!existsSync(filepath)) return undefined
  try {
    return { [thumbnail]: await fileMetadata(filepath, imageSizes) }
  } catch {
    return undefined
  }
}

export async function loadCollectionDirs(col, rootDir, distDir, { fileMetadata, buildDirAssets }) {
  const SOURCE_DIR = join(rootDir, col.source_dir)
  const EXT = col.format === 'yaml' ? 'yaml' : col.format
  const indexFile = `index.${EXT}`

  const dirs = readdirSync(SOURCE_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort()

  const collections = []
  const items = []

  for (const dir of dirs) {
    const dirPath = join(SOURCE_DIR, dir)
    const indexPath = join(dirPath, indexFile)
    if (!existsSync(indexPath)) continue

    const raw = await loadFile(indexPath, col.format)
    const { items: rawItems = [], ...meta } = raw
    const collectionId = meta.id ?? dir

    collections.push({
      id: collectionId,
      title: meta.title,
      source: meta.source,
      ...(meta.event ? { event: meta.event } : {}),
      ...(meta.project ? { project: meta.project } : {}),
      ...(meta.description ? { description: meta.description } : {}),
      count: rawItems.length,
    })

    for (const talk of rawItems) {
      const item = {
        ...talk,
        id: talk.id,
        collection: collectionId,
      }
      if (!item.event && meta.event) item.event = meta.event
      if (!item.project && meta.project) item.project = meta.project
      if (!item.source && meta.source) item.source = meta.source

      const thumbAssets = await buildTalkAssets(dirPath, talk.thumbnail, col.image_sizes, fileMetadata)
      if (thumbAssets) item._assets = thumbAssets

      items.push(item)
    }
  }

  if (col.git_history) {
    await buildHistory(collections, rootDir, col.source_dir, EXT, distDir, { dirBased: true })
  }

  return { items, collections }
}
