import { loadTerms, resolveWikiLinks } from './build.js'

export async function showUnresolved() {
  const terms = await loadTerms()
  const { unresolvedByKey } = resolveWikiLinks(terms)

  if (unresolvedByKey.size === 0) {
    console.log('All wiki links resolved.')
  } else {
    const sorted = [...unresolvedByKey.entries()].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))
    for (const [keyword, ids] of sorted) {
      console.log(`[[${keyword}]] — referenced by: ${[...ids].join(', ')}`)
    }
    console.log(`\n${unresolvedByKey.size} unresolved keywords`)
  }
}
