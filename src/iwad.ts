// SPDX-License-Identifier: GPL-3.0-only
import type { AddonContext } from '@hibi/addon-sdk/api'
import pins from '../engine/pins.json' with { type: 'json' }
import { sha256 } from './bundle.ts'
import { parseIwadBytes } from './runtime.ts'

type Network = Pick<AddonContext['host']['network'], 'getText'>
type Storage = AddonContext['storage']
type CacheHandle = Awaited<ReturnType<Storage['global']>>

export type IwadProgress =
  | { kind: 'checking' | 'verifying' }
  | { kind: 'downloading'; completedBytes: number; totalBytes: number }

export interface IwadReady {
  bytes: Uint8Array<ArrayBuffer>
  source: 'cache' | 'download'
  persistent: boolean
}

interface Part {
  path: string
  bytes: number
  sha256: string
}

const maxTextBytes = 1024 * 1024
const partBytes = 516096
const partCount = 9
const hashPattern = /^[0-9a-f]{64}$/
const manifestUrl = new URL(pins.iwad.feed.url)
const baseUrl = new URL('.', manifestUrl)

function record(value: unknown, fields: readonly string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid Doom shareware feed.')
  const object = value as Record<string, unknown>
  if (
    Object.keys(object).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(object, field))
  )
    throw new Error('Unexpected Doom shareware feed fields.')
  return object
}

export function parseIwadManifest(input: unknown): readonly Part[] {
  const value = record(input, [
    'schema',
    'edition',
    'bytes',
    'sha256',
    'encoding',
    'license',
    'parts',
    'terms',
  ])
  if (
    value.schema !== 1 ||
    value.edition !== pins.iwad.edition ||
    value.bytes !== pins.iwad.bytes ||
    value.sha256 !== pins.iwad.sha256 ||
    value.encoding !== 'base64' ||
    value.license !== pins.iwad.license ||
    !Array.isArray(value.parts) ||
    value.parts.length !== partCount ||
    !Array.isArray(value.terms) ||
    value.terms.length !== 2 ||
    value.terms[0] !== 'shareware-debian-terms.txt' ||
    value.terms[1] !== 'shareware-netbsd-terms.txt'
  )
    throw new Error('Unsupported Doom shareware feed.')
  return Object.freeze(
    value.parts.map((input: unknown, index: number) => {
      const part = record(input, ['path', 'bytes', 'sha256'])
      const expectedBytes = Math.min(
        partBytes,
        pins.iwad.bytes - index * partBytes,
      )
      if (
        part.path !== `doom1-part-${String(index).padStart(2, '0')}.json` ||
        part.bytes !== expectedBytes ||
        typeof part.sha256 !== 'string' ||
        !hashPattern.test(part.sha256)
      )
        throw new Error('Invalid Doom shareware part path, size, or digest.')
      return Object.freeze({
        path: part.path,
        bytes: expectedBytes,
        sha256: part.sha256,
      })
    }),
  )
}

function decodeBase64(encoded: unknown, expectedBytes: number) {
  if (
    typeof encoded !== 'string' ||
    encoded.length !== 4 * Math.ceil(expectedBytes / 3) ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
  )
    throw new Error('Invalid Doom shareware encoding.')
  const decoded = atob(encoded)
  if (decoded.length !== expectedBytes || btoa(decoded) !== encoded)
    throw new Error('Noncanonical Doom shareware encoding.')
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0))
}

async function verifiedIwad(encoded: unknown) {
  const bytes = decodeBase64(encoded, pins.iwad.bytes)
  if ((await sha256(bytes)) !== pins.iwad.sha256)
    throw new Error('Doom shareware data digest does not match.')
  parseIwadBytes(bytes)
  return bytes
}

function validResponseUrl(input: string, path: string) {
  const url = new URL(input)
  const expected = new URL(path, baseUrl)
  const prefix = baseUrl.pathname.replace(/[^/]+\/$/, '')
  const remainder = url.pathname.slice(prefix.length).split('/')
  return (
    url.origin === expected.origin &&
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    url.pathname.startsWith(prefix) &&
    remainder.length === 2 &&
    /^[0-9a-f]{40}$/.test(remainder[0] ?? '') &&
    remainder[1] === path
  )
}

export async function downloadIwad({
  network,
  signal,
  progress = () => {},
  current = () => {},
}: {
  network: Network
  signal: AbortSignal
  progress?: (state: IwadProgress) => void
  current?: () => void
}) {
  const check = () => {
    signal.throwIfAborted()
    current()
  }
  const text = async (path: string, expectedBytes: number) => {
    check()
    const result = await network.getText({ url: new URL(path, baseUrl).href })
    check()
    if (!result.ok)
      throw new Error(
        `Doom could not download its shareware data (${result.code}). Check your connection, then close and reopen the game.`,
      )
    const response = result.value
    if (
      response.status !== 200 ||
      !validResponseUrl(response.url, path) ||
      response.text.includes('\0') ||
      expectedBytes > maxTextBytes ||
      new TextEncoder().encode(response.text).byteLength !== expectedBytes
    )
      throw new Error(
        'Doom shareware response exceeds its bounds or has an unexpected address or status.',
      )
    return response.text
  }
  const manifest = await text('manifest.json', pins.iwad.feed.bytes)
  if (
    (await sha256(new TextEncoder().encode(manifest))) !== pins.iwad.feed.sha256
  )
    throw new Error('Doom shareware manifest digest does not match.')
  check()
  const parts = parseIwadManifest(JSON.parse(manifest))
  const output = new Uint8Array(pins.iwad.bytes)
  const encodedParts: string[] = []
  let offset = 0
  progress({
    kind: 'downloading',
    completedBytes: 0,
    totalBytes: pins.iwad.bytes,
  })
  for (const part of parts) {
    const raw = await text(part.path, 4 * Math.ceil(part.bytes / 3) + 14)
    const value = record(JSON.parse(raw), ['base64'])
    const bytes = decodeBase64(value.base64, part.bytes)
    if ((await sha256(bytes)) !== part.sha256)
      throw new Error('Doom shareware part digest does not match.')
    check()
    output.set(bytes, offset)
    offset += bytes.byteLength
    if (typeof value.base64 !== 'string')
      throw new Error('Invalid shareware encoding.')
    encodedParts.push(value.base64)
    progress({
      kind: 'downloading',
      completedBytes: offset,
      totalBytes: pins.iwad.bytes,
    })
  }
  progress({ kind: 'verifying' })
  if (offset !== pins.iwad.bytes || (await sha256(output)) !== pins.iwad.sha256)
    throw new Error('Doom shareware data digest does not match.')
  parseIwadBytes(output)
  check()
  return { bytes: output, base64: encodedParts.join('') }
}

export class IwadCache {
  private generation = 0
  private handle: Promise<CacheHandle> | null = null
  private pendingWrite: Promise<unknown> = Promise.resolve()
  private storage: Storage
  private network: Network

  constructor(context: Pick<AddonContext, 'storage' | 'host'>) {
    this.storage = context.storage
    this.network = context.host.network
  }

  private open() {
    this.handle ??= this.storage.global('iwad-cache', 1)
    return this.handle
  }

  private write(handle: CacheHandle, value: unknown, current: () => void) {
    const writing = this.pendingWrite
      .catch(() => {})
      .then(() => {
        current()
        return handle.set(value)
      })
    this.pendingWrite = writing
    return writing
  }

  async load(
    signal: AbortSignal,
    progress: (state: IwadProgress) => void,
  ): Promise<IwadReady> {
    const generation = this.generation
    const current = () => {
      signal.throwIfAborted()
      if (generation !== this.generation)
        throw new Error(
          'Cached game data was cleared. Close and reopen the game.',
        )
    }
    progress({ kind: 'checking' })
    let handle: CacheHandle | null = null
    try {
      handle = await this.open()
    } catch {
      /* Download remains usable if storage is unavailable. */
    }
    current()
    let snapshot: ReturnType<CacheHandle['snapshot']> | null = null
    try {
      snapshot = handle?.snapshot() ?? null
    } catch {
      /* A failed read permits uncached play. */
    }
    if (snapshot?.status === 'ready' && snapshot.value !== null) {
      try {
        const cache = record(snapshot.value, [
          'schema',
          'bytes',
          'sha256',
          'base64',
        ])
        if (
          cache.schema !== 1 ||
          cache.bytes !== pins.iwad.bytes ||
          cache.sha256 !== pins.iwad.sha256
        )
          throw new Error('Cached Doom shareware metadata does not match.')
        const bytes = await verifiedIwad(cache.base64)
        current()
        return { bytes, source: 'cache', persistent: true }
      } catch (error) {
        current()
        if (!(error instanceof Error)) throw error
      }
    }
    const game = await downloadIwad({
      network: this.network,
      signal,
      progress,
      current,
    })
    current()
    let persistent = false
    if (
      handle &&
      (snapshot?.status === 'ready' || snapshot?.status === 'missing')
    ) {
      try {
        persistent =
          (
            await this.write(
              handle,
              {
                schema: 1,
                bytes: pins.iwad.bytes,
                sha256: pins.iwad.sha256,
                base64: game.base64,
              },
              current,
            )
          ).status === 'saved'
      } catch {
        /* Report uncached play without claiming persistence. */
      }
    }
    current()
    return { bytes: game.bytes, source: 'download', persistent }
  }

  async clear() {
    this.generation++
    const handle = await this.open()
    const result = await this.write(handle, null, () => {})
    if (result.status !== 'saved')
      throw new Error(
        'Hibi could not clear cached game data. Close the game and try again.',
      )
  }
}
