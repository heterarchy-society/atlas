/**
 * Resolve GitHub usernames from git author emails.
 * Queries the GitHub API for any email not already in the cache.
 * Updates .github/authors.json in place.
 *
 * Usage: bunx atlas resolve-authors
 * Requires: GITHUB_TOKEN env var (optional locally, required in CI to avoid rate limits)
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { authorEmails } from './git.js'

const ROOT = process.cwd()
const CACHE_PATH = join(ROOT, '.github', 'authors.json')
const REPO = 'heterarchy-society/glossary'

const cache = JSON.parse(readFileSync(CACHE_PATH, 'utf8'))
const token = process.env.GITHUB_TOKEN

const emails = await authorEmails(ROOT, 'glossary/*.md')
const uncached = emails.filter(e => !(e in cache))

if (uncached.length === 0) {
  console.log('All emails already resolved.')
  process.exit(0)
}

console.log(`Resolving ${uncached.length} new email(s)...`)

for (const email of uncached) {
  const headers = { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
  if (token) headers['Authorization'] = `Bearer ${token}`

  try {
    const url = `https://api.github.com/repos/${REPO}/commits?author=${encodeURIComponent(email)}&per_page=1`
    const res = await fetch(url, { headers })

    if (res.status === 403 || res.status === 429) {
      console.warn(`  rate limited — stopping early`)
      break
    }

    if (!res.ok) {
      console.warn(`  ${email}: HTTP ${res.status}`)
      cache[email] = null
      continue
    }

    const commits = await res.json()
    const login = commits[0]?.author?.login ?? null
    cache[email] = login
    console.log(`  ${email} → ${login ?? 'not found'}`)
  } catch (err) {
    console.warn(`  ${email}: ${err.message}`)
    cache[email] = null
  }
}

writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2) + '\n', 'utf8')
console.log(`\nCache updated: ${CACHE_PATH}`)
