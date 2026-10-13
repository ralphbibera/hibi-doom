// SPDX-License-Identifier: GPL-3.0-only
import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import pins from '../engine/pins.json' with { type: 'json' }
import { downloadIwad, parseIwadManifest } from '../src/iwad.ts'
import { parseIwadBytes } from '../src/runtime.ts'
import { root } from './tooling.mjs'

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const directory = resolve(
  process.env.HIBI_DOOM_FIXTURE_DIR ??
    join(tmpdir(), 'hibi-doom-shareware-cache'),
)
function assertFixtureOutside(checkout, destination) {
  const path = relative(checkout, destination)
  if (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
    throw new Error(
      'Shareware test data must stay outside the source checkout.',
    )
}
assertFixtureOutside(root, directory)

export async function fixtureDirectory(destination, checkout = root) {
  assertFixtureOutside(resolve(checkout), resolve(destination))
  await mkdir(destination, { recursive: true })
  const canonical = await realpath(destination)
  assertFixtureOutside(await realpath(checkout), canonical)
  return canonical
}
let pending

async function publicText(url) {
  const response = await fetch(url, {
    credentials: 'omit',
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok || !response.body)
    throw new Error(`Shareware feed returned HTTP ${response.status}.`)
  const reader = response.body.getReader()
  const chunks = []
  let bytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > 1024 * 1024)
        throw new Error('Shareware test response exceeds the SDK text limit.')
      chunks.push(Buffer.from(chunk.value))
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(
    Buffer.concat(chunks),
  )
  return {
    ok: true,
    value: { url: response.url, status: response.status, text },
  }
}

async function acquire() {
  const canonical = await fixtureDirectory(directory)
  const iwadPath = join(canonical, 'doom1.wad')
  const manifestPath = join(canonical, 'manifest.json')
  try {
    const bytes = await readFile(iwadPath)
    if (
      bytes.length === pins.iwad.bytes &&
      digest(bytes) === pins.iwad.sha256
    ) {
      parseIwadBytes(bytes)
      return bytes
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  let manifest
  const game = await downloadIwad({
    network: {
      async getText({ url }) {
        const result = await publicText(url)
        if (url === pins.iwad.feed.url) manifest = result.value.text
        return result
      },
    },
    signal: new AbortController().signal,
  })
  if (!manifest)
    throw new Error('The verified shareware manifest was not observed.')
  const scratch = await mkdtemp(join(canonical, 'download-'))
  try {
    await writeFile(join(scratch, 'doom1.wad'), game.bytes)
    await writeFile(join(scratch, 'manifest.json'), manifest)
    await rename(join(scratch, 'manifest.json'), manifestPath)
    await rename(join(scratch, 'doom1.wad'), iwadPath)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
  return Buffer.from(game.bytes)
}

export async function fixtureIwad() {
  pending ??= acquire()
  return Buffer.from(await pending)
}

export async function fixtureFeed() {
  const bytes = await fixtureIwad()
  const manifest = await readFile(
    join(await fixtureDirectory(directory), 'manifest.json'),
    'utf8',
  )
  if (
    Buffer.byteLength(manifest) !== pins.iwad.feed.bytes ||
    digest(Buffer.from(manifest)) !== pins.iwad.feed.sha256
  )
    throw new Error('Cached test feed manifest does not match its pin.')
  const parts = parseIwadManifest(JSON.parse(manifest))
  const files = new Map([['manifest.json', manifest]])
  let offset = 0
  for (const part of parts) {
    const chunk = bytes.subarray(offset, offset + part.bytes)
    if (digest(chunk) !== part.sha256)
      throw new Error('Test feed part digest does not match.')
    files.set(
      part.path,
      `${JSON.stringify({ base64: chunk.toString('base64') })}\n`,
    )
    offset += part.bytes
  }
  return { bytes, files, parts }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const bytes = await fixtureIwad()
  console.log(
    JSON.stringify({
      path: join(await fixtureDirectory(directory), 'doom1.wad'),
      bytes: bytes.length,
      sha256: digest(bytes),
    }),
  )
}
