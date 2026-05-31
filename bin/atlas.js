#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const LIB = join(ROOT, 'lib')

function atlasVersion() {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
}

const command = process.argv[2]

if (command === '--version' || command === '-v' || command === 'version') {
  console.log(atlasVersion())
  process.exit(0)
}

switch (command) {
  case 'build': {
    const { build } = await import(`${LIB}/build.js`)
    await build()
    break
  }
  case 'validate': {
    const { validateAll } = await import(`${LIB}/validate.js`)
    await validateAll()
    break
  }
  case 'unresolved': {
    const { showUnresolved } = await import(`${LIB}/unresolved.js`)
    await showUnresolved()
    break
  }
  case 'stale': {
    const { showStale } = await import(`${LIB}/stale.js`)
    showStale()
    break
  }
  case 'translate': {
    // translate passes remaining argv: atlas translate [lang] [id]
    process.argv.splice(2, 1) // remove 'translate', leave [lang] [id]
    await import(`${LIB}/translate.js`)
    break
  }
  case 'resolve-authors': {
    await import(`${LIB}/resolve-authors.js`)
    break
  }
  case 'peaks': {
    const { generatePeaks } = await import(`${LIB}/peaks.js`)
    await generatePeaks()
    break
  }
  case 'transcript':
  case 'transcribe': {
    const { importTranscript } = await import(`${LIB}/transcript.js`)
    importTranscript()
    break
  }
  case 'optimize-images': {
    const { optimizeImages } = await import(`${LIB}/optimize-images.js`)
    await optimizeImages()
    break
  }
  default:
    console.log(`Atlas — build tooling for Heterarchy data collections

Usage: atlas <command>

Options:
  -v, --version     Show Atlas version
  -h, --help        Show this help

Commands:
  build             Build dist/ from glossary sources
  validate          Validate all source files against schema
  unresolved        Show unresolved [[wiki links]]
  stale             Show translations with outdated source hash
  translate         Translate missing/stale entries via Codex CLI
  resolve-authors   Resolve GitHub usernames from git emails
  peaks <id>              Generate waveform peaks for a writing's audio
  transcript <id> <file>  Import AssemblyAI or ElevenLabs word timestamps from JSON file
  transcribe <id> <file>  Alias for transcript
  optimize-images [id]    Convert index-referenced images to WebP (quality 80)
`)
    if (command && command !== '--help' && command !== '-h' && command !== 'help') {
      console.error(`Unknown command: ${command}`)
      process.exitCode = 1
    }
}
