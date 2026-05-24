import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import matter from 'gray-matter'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATASETS_DIR = join(__dirname, '..', 'datasets')

function norm(text) {
  return text.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
}

function findParagraphStart(words, paraText, searchFrom) {
  const paraWords = norm(paraText).split(' ').filter(Boolean).slice(0, 6)
  const tNorm = words.map(w => norm(w[0]))

  for (let i = searchFrom; i < tNorm.length; i++) {
    let matches = 0
    for (let j = 0; j < paraWords.length; j++) {
      if (tNorm[i + j] === paraWords[j]) matches++
    }
    if (matches >= Math.min(3, paraWords.length)) return i
  }
  return searchFrom
}

function timestampMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.round(value * 1000)
}

function assemblyAiWords(raw) {
  if (!Array.isArray(raw.words) || raw.words.length === 0) return null

  const words = raw.words
    .filter(w => w.text && w.text.trim() && w.text !== ',')
    .map(w => [w.text, w.start, w.end])
    .filter(([, start, end]) => typeof start === 'number' && typeof end === 'number')

  if (words.length === 0) return null
  return { format: 'AssemblyAI', words }
}

function elevenLabsWords(raw) {
  if (!Array.isArray(raw.segments) || raw.segments.length === 0) return null

  const segmentWords = raw.segments.flatMap(segment => Array.isArray(segment.words) ? segment.words : [])
  if (segmentWords.length === 0) return null

  const words = segmentWords
    .filter(w => w.text && w.text.trim())
    .map(w => [w.text, timestampMs(w.start_time), timestampMs(w.end_time)])
    .filter(([, start, end]) => start !== null && end !== null)

  if (words.length === 0) return null
  return { format: 'ElevenLabs', words }
}

function transcriptWords(raw) {
  return assemblyAiWords(raw) ?? elevenLabsWords(raw)
}

export function importTranscript() {
  const id = process.argv[3]
  const inputPath = process.argv[4]

  if (!id || !inputPath) {
    console.error('Usage: atlas transcript <writing-id> <transcript-json>')
    process.exit(1)
  }

  if (!existsSync(inputPath)) {
    console.error(`File not found: ${inputPath}`)
    process.exit(1)
  }

  const writingDir = join(DATASETS_DIR, 'writings', 'writings', id)
  const indexPath = join(writingDir, 'index.md')
  if (!existsSync(indexPath)) {
    console.error(`Writing not found: ${id}`)
    process.exit(1)
  }

  const raw = JSON.parse(readFileSync(inputPath, 'utf8'))
  const imported = transcriptWords(raw)
  if (!imported?.words.length) {
    console.error('No supported word timestamps found in input JSON')
    console.error('Supported formats: AssemblyAI words[], ElevenLabs segments[].words[]')
    process.exit(1)
  }

  const { format, words } = imported
  console.log(`Importing ${format} transcript with ${words.length} words...`)

  // Find paragraph start word indices from the markdown source
  const indexParsed = matter(readFileSync(indexPath, 'utf8'))
  const mdSource = indexParsed.data.sources?.find(s => s.format === 'md')
  let paragraphs = []

  if (mdSource) {
    const mdPath = join(writingDir, mdSource.path)
    if (existsSync(mdPath)) {
      let mdText = readFileSync(mdPath, 'utf8')
      const bodyMarker = mdText.indexOf('<!-- body -->')
      if (bodyMarker !== -1) mdText = mdText.slice(bodyMarker + '<!-- body -->'.length)

      // Strip markdown syntax, split into paragraphs
      const blocks = mdText.split(/\n{2,}/)
        .map(p => p.replace(/^#+\s+/, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim())
        .filter(p => p.length > 15)

      console.log(`Aligning ${blocks.length} paragraphs...`)
      let searchFrom = 0
      for (const block of blocks) {
        const idx = findParagraphStart(words, block, searchFrom)
        paragraphs.push(idx)
        console.log(`  [${idx}] "${block.slice(0, 50)}..." → "${words[idx]?.[0]}"`)
        searchFrom = idx + 1
      }
    }
  }

  const out = { words, paragraphs }
  const outPath = join(writingDir, 'transcript.json')
  writeFileSync(outPath, JSON.stringify(out))
  console.log(`✓ Saved ${words.length} words, ${paragraphs.length} paragraphs to ${outPath}`)

  if (indexParsed.data.audio?.[0] && !indexParsed.data.audio[0].transcript) {
    indexParsed.data.audio[0].transcript = 'transcript.json'
    writeFileSync(indexPath, matter.stringify(indexParsed.content, indexParsed.data))
    console.log(`✓ Updated ${indexPath}`)
  }
}
