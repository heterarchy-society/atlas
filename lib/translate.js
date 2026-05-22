/**
 * Translate missing or stale glossary entries using Codex CLI.
 * Usage: node lib/translate.js [lang] [id]
 *   lang  — language code, default from config.toml
 *   id    — specific term ID (skips interactive mode, translates immediately)
 *
 * Sessions: the first translation bootstraps a Codex session with full instructions.
 * Subsequent translations resume the same session — saving tokens and keeping
 * terminology consistent across terms.
 * Session ID is stored in .translation-session-{lang} (git-ignored).
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import matter from 'gray-matter'
import { parse as parseToml } from 'smol-toml'
import { sourceHash } from './hash.js'

const ROOT = process.cwd()
const GLOSSARY_DIR = join(ROOT, 'glossary')
const TRANSLATIONS_DIR = join(ROOT, 'translations')

function loadConfig() {
  try {
    return parseToml(readFileSync(join(ROOT, 'config.toml'), 'utf8'))
  } catch {
    return { languages: { default: 'cs' } }
  }
}

function codexModel() {
  try {
    const raw = readFileSync(join(homedir(), '.codex', 'config.toml'), 'utf8')
    const match = raw.match(/^model\s*=\s*"([^"]+)"/m)
    return match ? match[1] : 'unknown'
  } catch {
    return 'unknown'
  }
}

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()) }))
}

// Run codex with prompt via stdin, stream progress to terminal, return thread_id
function runCodex(args, prompt) {
  return new Promise((resolve, reject) => {
    const proc = spawn('codex', [...args, '-'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'inherit'] })
    proc.stdin.end(prompt)

    let threadId = null
    let buf = ''

    proc.stdout.on('data', chunk => {
      buf += chunk.toString()
      const lines = buf.split('\n')
      buf = lines.pop() // keep incomplete line
      for (const line of lines) {
        if (!line) continue
        let event
        try { event = JSON.parse(line) } catch { continue }
        if (event.type === 'thread.started') {
          threadId = event.thread_id
        } else if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
          process.stdout.write(`  ${event.item.text}\n`)
        } else if (event.type === 'exec.start') {
          process.stdout.write(`  $ ${event.command}\n`)
        }
      }
    })

    proc.on('close', code => {
      if (code !== 0) reject(new Error(`codex exited with code ${code}`))
      else resolve(threadId)
    })
  })
}

const CODEX_FLAGS = ['--sandbox', 'workspace-write', '--dangerously-bypass-approvals-and-sandbox', '--json']
const CODEX_RESUME_FLAGS = ['--dangerously-bypass-approvals-and-sandbox', '--json']

const config = loadConfig()
const defaultLang = config.languages?.default ?? 'cs'
const model = codexModel()
const lang = process.argv[2] || defaultLang
const onlyId = process.argv[3] || null
const langName = config.languages?.[lang]?.name ?? lang
const sessionFile = join(ROOT, `.translation-session-${lang}`)

mkdirSync(join(TRANSLATIONS_DIR, lang), { recursive: true })

const allFiles = readdirSync(GLOSSARY_DIR).filter(f => f.endsWith('.md')).sort()

function needsTranslation(filename) {
  const id = filename.replace(/\.md$/, '')
  const destPath = join(TRANSLATIONS_DIR, lang, `${id}.json`)
  const parsed = matter.read(join(GLOSSARY_DIR, filename))
  const name = parsed.data.name
  const description = parsed.content.trim()
  const hash = sourceHash({ name, description })
  if (!existsSync(destPath)) return { id, filename, hash, name, description, reason: 'missing' }
  const existing = JSON.parse(readFileSync(destPath, 'utf8'))
  if (existing.source_hash !== hash) return { id, filename, hash, name, description, reason: 'stale' }
  return null
}

const bootstrapTemplate = config.translation?.prompt ?? ''
const resumeTemplate = config.translation?.resume_prompt ?? 'Translate glossary/{filename}.'

function renderTemplate(template, { id, filename, name, description }) {
  return template
    .replace(/\{filename\}/g, filename)
    .replace(/\{langName\}/g, langName)
    .replace(/\{lang\}/g, lang)
    .replace(/\{id\}/g, id)
    .replace(/\{name\}/g, name ?? '')
    .replace(/\{description\}/g, description ?? '')
    .trim()
}

function toSlug(name) {
  return name
    .normalize('NFD').replace(/[̀-ͯ]/g, '')  // remove diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function saveMetadata(destPath, hash) {
  if (!existsSync(destPath)) throw new Error(`codex did not write ${destPath}`)
  const raw = JSON.parse(readFileSync(destPath, 'utf8'))
  const name = raw.name ?? ''
  const description = raw.description ?? ''
  if (!name || !description) {
    console.warn(`  ⚠ codex wrote empty fields — raw output: ${JSON.stringify(raw).slice(0, 200)}`)
  }
  writeFileSync(destPath, JSON.stringify({
    source_hash: hash,
    model,
    translated_at: new Date().toISOString(),
    slug: toSlug(name),
    name,
    description,
  }, null, 2) + '\n', 'utf8')
}

async function translateTerm(entry) {
  const { id, filename, hash, name, description } = entry
  const destPath = join(TRANSLATIONS_DIR, lang, `${id}.json`)
  // Remove any stale/partial file so codex writes fresh
  if (existsSync(destPath)) rmSync(destPath)
  let threadId = existsSync(sessionFile) ? readFileSync(sessionFile, 'utf8').trim() : null
  const t0 = Date.now()

  if (threadId) {
    const prompt = renderTemplate(resumeTemplate, { id, filename, name, description })
    const newThreadId = await runCodex(['exec', 'resume', threadId, ...CODEX_RESUME_FLAGS], prompt)
    if (newThreadId) writeFileSync(sessionFile, newThreadId, 'utf8')
  } else {
    const prompt = renderTemplate(bootstrapTemplate, { id, filename, name, description })
    threadId = await runCodex(['exec', ...CODEX_FLAGS], prompt)
    if (threadId) writeFileSync(sessionFile, threadId, 'utf8')
  }

  saveMetadata(destPath, hash)
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  return elapsed
}

// Non-interactive mode: specific ID given
if (onlyId) {
  const filename = `${onlyId}.md`
  const entry = needsTranslation(filename)
  if (!entry) {
    console.log(`${onlyId}: already up to date`)
  } else {
    console.log(`Translating ${onlyId} (${entry.reason})...`)
    const elapsed = await translateTerm(entry)
    console.log(`✓ Done (${elapsed}s)`)
  }
  process.exit(0)
}

// Interactive mode
const pending = allFiles.map(needsTranslation).filter(Boolean)

if (pending.length === 0) {
  console.log(`All ${lang} translations are up to date.`)
  process.exit(0)
}

const sessionExists = existsSync(sessionFile)
console.log(`${pending.length} term(s) need translation to ${langName}.`)
console.log(sessionExists ? `Resuming existing session.\n` : `Starting new session.\n`)

let translated = 0
let skipped = 0
let translateAll = false

for (const entry of pending) {
  const label = entry.reason === 'stale' ? `${entry.id} (stale)` : entry.id
  let answer
  if (translateAll) {
    answer = 'y'
  } else {
    answer = await ask(`Translate "${label}"? [y/n/a/q] `)
    if (answer === 'a') { translateAll = true; answer = 'y' }
  }

  if (answer === 'q') {
    console.log('\nAborted.')
    break
  }
  if (answer !== 'y') {
    skipped++
    continue
  }

  try {
    const elapsed = await translateTerm(entry)
    console.log(`✓ ${entry.id} (${elapsed}s)\n`)
    translated++
  } catch (err) {
    console.error(`✗ ${entry.id}: ${err.message}\n`)
  }
}

console.log(`Done: ${translated} translated, ${skipped} skipped`)
