import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function tooling(hibiRoot = process.env.HIBI_ROOT) {
  if (!hibiRoot)
    throw new Error('Set HIBI_ROOT to the pinned Hibi source checkout.')
  const host = resolve(hibiRoot)
  return { host, require: createRequire(join(host, 'package.json')) }
}
