import { readFileSync, readdirSync } from 'node:fs'
import { join, basename, extname } from 'node:path'
import matter from 'gray-matter'
import { sourceHash } from './hash.js'

const ROOT = process.cwd()
const GLOSSARY_DIR = join(ROOT, 'glossary')
const TRANSLATIONS_DIR = join(ROOT, 'translations')

export function showStale() {
  let langs
  try {
    langs = readdirSync(TRANSLATIONS_DIR)
  } catch {
    console.log('No translations directory found.')
    return
  }

  let stale = 0

  for (const lang of langs) {
    const files = readdirSync(join(TRANSLATIONS_DIR, lang)).filter(f => extname(f) === '.json' && !f.startsWith('_'))
    for (const file of files) {
      const id = basename(file, '.json')
      const translation = JSON.parse(readFileSync(join(TRANSLATIONS_DIR, lang, file), 'utf8'))
      const sourcePath = join(GLOSSARY_DIR, `${id}.md`)

      let term
      try {
        const parsed = matter.read(sourcePath)
        term = { name: parsed.data.name, description: parsed.content.trim() }
      } catch {
        console.warn(`  ⚠ ${lang}/${id}: source file not found`)
        stale++
        continue
      }

      const current = sourceHash(term)
      if (!translation.source_hash) {
        console.log(`  ? ${lang}/${id}: no hash recorded`)
        stale++
      } else if (translation.source_hash !== current) {
        console.log(`  ✗ ${lang}/${id}: source changed (${translation.source_hash} → ${current})`)
        stale++
      } else {
        console.log(`  ✓ ${lang}/${id}: up to date`)
      }
    }
  }

  console.log(`\n${stale} stale translation(s)`)
  if (stale > 0) process.exitCode = 1
}
