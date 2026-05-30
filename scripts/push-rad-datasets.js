#!/usr/bin/env node
/**
 * Push main to Radicle (rad) for atlas and each dataset submodule.
 * Usage: npm run push-rad
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const ATLAS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_DATASETS = ['glossary', 'people', 'books', 'writings', 'talks', 'events']

function datasetPaths() {
  const gitmodules = join(ATLAS_ROOT, '.gitmodules')
  if (existsSync(gitmodules)) {
    const paths = [...readFileSync(gitmodules, 'utf8').matchAll(/^path = (datasets\/[^\n]+)/gm)].map(m => m[1])
    if (paths.length > 0) return paths
  }
  return DEFAULT_DATASETS.map(d => `datasets/${d}`)
}

const remote = process.env.RAD_REMOTE || 'rad'
const branch = process.env.RAD_BRANCH || 'main'

let failed = 0

function pushRepo(cwd, name) {
  if (!existsSync(join(cwd, '.git'))) {
    console.warn(`skip ${name}: not a git repo`)
    return
  }

  try {
    execSync(`git remote get-url ${remote}`, { cwd, stdio: 'pipe' })
  } catch {
    console.warn(`skip ${name}: no remote "${remote}"`)
    return
  }

  console.log(`\n→ ${name}: git push ${remote} ${branch}`)
  try {
    execSync(`git push ${remote} ${branch}`, { cwd, stdio: 'inherit' })
  } catch {
    failed++
    console.error(`✗ ${name}: push failed`)
  }
}

for (const rel of datasetPaths()) {
  pushRepo(join(ATLAS_ROOT, rel), rel.replace(/^datasets\//, ''))
}

pushRepo(ATLAS_ROOT, 'atlas')

if (failed > 0) process.exit(1)
