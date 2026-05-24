import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import matter from 'gray-matter'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATASETS_DIR = join(__dirname, '..', 'datasets')
const PIXELS_PER_SECOND = 3

export async function generatePeaks() {
  const id = process.argv[3]
  if (!id) {
    console.error('Usage: atlas peaks <writing-id>')
    process.exit(1)
  }

  const indexPath = join(DATASETS_DIR, 'writings', 'writings', id, 'index.md')
  if (!existsSync(indexPath)) {
    console.error(`Writing not found: ${id}`)
    process.exit(1)
  }

  const check = spawnSync('audiowaveform', ['--version'])
  if (check.error) {
    console.error('audiowaveform not found — install with: brew install audiowaveform')
    process.exit(1)
  }

  const raw = readFileSync(indexPath, 'utf8')
  const parsed = matter(raw)
  const audio = parsed.data.audio

  if (!audio?.length || !audio[0]?.url) {
    console.error(`No audio.url found in ${id}/index.md`)
    process.exit(1)
  }

  const url = audio[0].url
  console.log(`Fetching: ${url}`)

  const tmpDir = mkdtempSync(join(tmpdir(), 'atlas-peaks-'))
  const ext = url.split('.').pop().split('?')[0] || 'mp3'
  const inputFile = join(tmpDir, `audio.${ext}`)
  const outputFile = join(tmpDir, 'peaks.json')

  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = await res.arrayBuffer()
    writeFileSync(inputFile, Buffer.from(buf))
    console.log(`Downloaded ${Math.round(buf.byteLength / 1024)} KB`)

    execFileSync('audiowaveform', [
      '-i', inputFile,
      '-o', outputFile,
      '--output-format', 'json',
      '--pixels-per-second', String(PIXELS_PER_SECOND),
      '--bits', '8',
    ], { stdio: 'inherit' })

    const result = JSON.parse(readFileSync(outputFile, 'utf8'))
    const peaks = result.data
    console.log(`Generated ${peaks.length} peaks`)

    const b64 = Buffer.from(new Int8Array(peaks).buffer).toString('base64')
    console.log(`Encoded as base64: ${b64.length} chars`)
    parsed.data.audio[0].peaks = b64
    writeFileSync(indexPath, matter.stringify(parsed.content, parsed.data))
    console.log(`✓ Written to ${indexPath}`)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}
