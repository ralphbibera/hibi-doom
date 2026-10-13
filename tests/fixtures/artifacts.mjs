import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import pins from '../../engine/pins.json' with { type: 'json' }
import { fixtureIwad } from '../../scripts/download-iwad.mjs'
import { readGameArtifact } from '../../scripts/resources.mjs'
import { root } from '../../scripts/tooling.mjs'
import { parseBundle } from '../../src/bundle.ts'
import { validateGame } from '../../src/runtime.ts'

export async function artifacts() {
  return validateGame(
    await readGameArtifact('engine', pins.engine),
    await fixtureIwad(),
  )
}
export async function bundleMetadata() {
  return parseBundle(
    JSON.parse(await readFile(join(root, 'addon/bundle.json'), 'utf8')),
  )
}
export const packageBase = new URL(
  'app://hibi/installed-addons/hibi-doom/test-package/index.js',
)
export async function packageFetch(url) {
  const base = new URL('.', packageBase)
  if (!String(url).startsWith(base.href))
    throw new Error('Unexpected package request.')
  const path = new URL(url).pathname.slice(base.pathname.length)
  const bytes = await readFile(join(root, 'addon', path))
  return new Response(bytes, {
    headers: { 'content-length': String(bytes.length) },
  })
}
