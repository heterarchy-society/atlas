import { createHash } from 'node:crypto'

export function sourceHash(term) {
  return createHash('sha256')
    .update(term.name + '\n' + term.description)
    .digest('hex')
    .slice(0, 16)
}
