import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { readFileSync, readdirSync } from 'node:fs'
import { join, basename, extname } from 'node:path'
import matter from 'gray-matter'

const ROOT = process.cwd()

const schema = JSON.parse(readFileSync(join(ROOT, 'schema', 'term.json'), 'utf8'))
const ajv = new Ajv({ allErrors: true })
addFormats(ajv)
const validateFn = ajv.compile(schema)

export function validateTerm(data, id) {
  const valid = validateFn(data)
  if (!valid) {
    const errors = ajv.errorsText(validateFn.errors, { separator: '\n  ' })
    throw new Error(`Validation failed for "${id}":\n  ${errors}`)
  }
  return true
}

export function validateAll() {
  const glossaryDir = join(ROOT, 'glossary')
  const files = readdirSync(glossaryDir).filter(f => extname(f) === '.md').sort()
  let failed = 0

  for (const filename of files) {
    const id = basename(filename, '.md')
    const parsed = matter.read(join(glossaryDir, filename))
    const term = { id, ...parsed.data, description: parsed.content.trim() }
    try {
      validateTerm(term, id)
      console.log(`  ✓ ${id}`)
    } catch (err) {
      console.error(`  ✗ ${err.message}`)
      failed++
    }
  }

  console.log(`\n${files.length - failed}/${files.length} terms valid`)
  if (failed > 0) process.exitCode = 1
}
