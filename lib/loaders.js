import { readFileSync } from 'node:fs'
import matter from 'gray-matter'

let _yaml = null
async function yaml() {
  if (!_yaml) _yaml = (await import('js-yaml')).default
  return _yaml
}

function trimStrings(obj) {
  if (typeof obj === 'string') return obj.trim()
  if (Array.isArray(obj)) return obj.map(trimStrings)
  if (obj && typeof obj === 'object') return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, trimStrings(v)]))
  return obj
}

export async function loadFile(filepath, format) {
  const content = readFileSync(filepath, 'utf8')
  if (format === 'md') {
    const parsed = matter(content)
    return { ...parsed.data, description: parsed.content.trim() }
  }
  if (format === 'yaml' || format === 'yml') {
    const y = await yaml()
    return trimStrings(y.load(content))
  }
  if (format === 'json') {
    return JSON.parse(content)
  }
  throw new Error(`Unsupported format: "${format}". Use md, yaml, or json.`)
}
