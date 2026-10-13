import pins from '../engine/pins.json' with { type: 'json' }

export interface Chunk {
  readonly path: string
  readonly jsonBytes: number
  readonly decodedBytes: number
  readonly sha256: string
}
export interface Artifact {
  readonly bytes: number
  readonly sha256: string
  readonly chunks: readonly Chunk[]
}
export interface DoomBundle {
  readonly schema: 2
  readonly engine: Artifact & { readonly abi: 'doomgeneric-wasi-v1' }
  readonly iwad: typeof pins.iwad
  readonly source: Artifact & {
    readonly archive: 'tar.gz'
    readonly exportName: 'hibi-doom-0.3.0-source.tar.gz'
  }
  readonly notices: {
    readonly path: 'LICENSES.md'
    readonly bytes: number
    readonly sha256: string
  }
}

const maxChunk = 3 * 1024 * 1024
const maxArtifact = 16 * 1024 * 1024
const hashPattern = /^[0-9a-f]{64}$/

function record(value: unknown, fields: readonly string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid Doom bundle metadata.')
  const object = value as Record<string, unknown>
  if (
    Object.keys(object).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(object, field))
  )
    throw new Error('Unexpected Doom bundle fields.')
  return object
}
function size(value: unknown, max: number) {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > max
  )
    throw new Error('Invalid Doom bundle size.')
  return value
}
function hash(value: unknown) {
  if (typeof value !== 'string' || !hashPattern.test(value))
    throw new Error('Invalid Doom bundle digest.')
  return value
}
function artifact(input: unknown, role: 'engine' | 'source') {
  const extra = role === 'engine' ? ['abi'] : ['archive', 'exportName']
  const value = record(input, ['bytes', 'sha256', 'chunks', ...extra])
  const bytes = size(value.bytes, maxArtifact)
  if (
    !Array.isArray(value.chunks) ||
    value.chunks.length === 0 ||
    value.chunks.length > 6
  )
    throw new Error('Invalid Doom bundle chunks.')
  const chunks = value.chunks.map((input: unknown, index: number): Chunk => {
    const chunk = record(input, ['path', 'jsonBytes', 'decodedBytes', 'sha256'])
    const decodedBytes = size(chunk.decodedBytes, maxChunk)
    const jsonBytes = size(chunk.jsonBytes, 5 * 1024 * 1024)
    if (
      chunk.path !== `assets/${role}/${String(index).padStart(3, '0')}.json` ||
      jsonBytes !== 4 * Math.ceil(decodedBytes / 3) + 13
    )
      throw new Error('Invalid Doom chunk path or encoded size.')
    return Object.freeze({
      path: chunk.path,
      jsonBytes,
      decodedBytes,
      sha256: hash(chunk.sha256),
    })
  })
  if (chunks.reduce((sum, chunk) => sum + chunk.decodedBytes, 0) !== bytes)
    throw new Error('Doom chunk sizes do not match the artifact.')
  return {
    bytes,
    sha256: hash(value.sha256),
    chunks: Object.freeze(chunks),
    value,
  }
}

export function parseBundle(input: unknown): DoomBundle {
  const value = record(input, ['schema', 'engine', 'iwad', 'source', 'notices'])
  const engine = artifact(value.engine, 'engine')
  const iwad = record(value.iwad, [
    'bytes',
    'sha256',
    'edition',
    'license',
    'feed',
  ])
  const feed = record(iwad.feed, ['url', 'bytes', 'sha256'])
  const source = artifact(value.source, 'source')
  const notices = record(value.notices, ['path', 'bytes', 'sha256'])
  if (
    value.schema !== 2 ||
    engine.value.abi !== 'doomgeneric-wasi-v1' ||
    engine.bytes > 1024 * 1024 ||
    iwad.edition !== pins.iwad.edition ||
    iwad.bytes !== pins.iwad.bytes ||
    iwad.sha256 !== pins.iwad.sha256 ||
    iwad.license !== pins.iwad.license ||
    feed.url !== pins.iwad.feed.url ||
    feed.bytes !== pins.iwad.feed.bytes ||
    feed.sha256 !== pins.iwad.feed.sha256 ||
    source.value.archive !== 'tar.gz' ||
    source.value.exportName !== 'hibi-doom-0.3.0-source.tar.gz' ||
    notices.path !== 'LICENSES.md'
  )
    throw new Error('Unsupported Doom bundle.')
  const common = ({ bytes, sha256, chunks }: Artifact): Artifact => ({
    bytes,
    sha256,
    chunks,
  })
  return Object.freeze({
    schema: 2,
    engine: Object.freeze({ ...common(engine), abi: 'doomgeneric-wasi-v1' }),
    iwad: Object.freeze({
      ...pins.iwad,
      feed: Object.freeze({ ...pins.iwad.feed }),
    }),
    source: Object.freeze({
      ...common(source),
      archive: 'tar.gz',
      exportName: 'hibi-doom-0.3.0-source.tar.gz',
    }),
    notices: Object.freeze({
      path: 'LICENSES.md',
      bytes: size(notices.bytes, 512 * 1024),
      sha256: hash(notices.sha256),
    }),
  })
}

export async function sha256(bytes: Uint8Array<ArrayBuffer>) {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export async function readPackageFile(
  path: string,
  expectedBytes: number,
  base: URL,
  signal: AbortSignal,
  fetchFile: typeof fetch = fetch,
): Promise<Uint8Array<ArrayBuffer>> {
  signal.throwIfAborted()
  const url = new URL(path, base)
  const directory = new URL('.', base)
  if (
    !/^(assets\/(engine|source)\/\d{3}\.json|LICENSES\.md)$/.test(path) ||
    url.protocol !== directory.protocol ||
    url.host !== directory.host ||
    !url.pathname.startsWith(directory.pathname)
  )
    throw new Error('Doom resource is outside its installed package.')
  const response = await fetchFile(url, {
    signal,
    credentials: 'omit',
    redirect: 'error',
  })
  if (!response.ok || !response.body)
    throw new Error(
      'The installed Doom package is incomplete. Reinstall the addon.',
    )
  const length = response.headers.get('content-length')
  if (length !== null && Number(length) !== expectedBytes) {
    await response.body.cancel().catch(() => {})
    throw new Error('Doom package resource size does not match.')
  }
  const reader = response.body.getReader()
  const result = new Uint8Array(expectedBytes)
  let offset = 0
  const abort = () => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      signal.throwIfAborted()
      if (chunk.done) break
      if (chunk.value.byteLength > expectedBytes - offset)
        throw new Error('Doom package resource exceeds its size limit.')
      result.set(chunk.value, offset)
      offset += chunk.value.byteLength
    }
    if (offset !== expectedBytes)
      throw new Error('Doom package resource is truncated.')
    return result
  } finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export async function loadArtifact(
  artifact: Artifact,
  base: URL,
  signal: AbortSignal,
  fetchFile: typeof fetch = fetch,
): Promise<Uint8Array<ArrayBuffer>> {
  const output = new Uint8Array(artifact.bytes)
  let offset = 0
  for (const chunk of artifact.chunks) {
    const raw = await readPackageFile(
      chunk.path,
      chunk.jsonBytes,
      base,
      signal,
      fetchFile,
    )
    const value = record(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)),
      ['base64'],
    )
    const encoded = value.base64
    if (
      typeof encoded !== 'string' ||
      encoded.length !== 4 * Math.ceil(chunk.decodedBytes / 3) ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
    )
      throw new Error('Invalid Doom resource encoding.')
    const decoded = atob(encoded)
    if (decoded.length !== chunk.decodedBytes || btoa(decoded) !== encoded)
      throw new Error('Noncanonical Doom resource encoding.')
    const bytes = Uint8Array.from(decoded, (character) =>
      character.charCodeAt(0),
    )
    if ((await sha256(bytes)) !== chunk.sha256)
      throw new Error('Doom resource chunk digest does not match.')
    signal.throwIfAborted()
    output.set(bytes, offset)
    offset += bytes.byteLength
  }
  if ((await sha256(output)) !== artifact.sha256)
    throw new Error('Doom artifact digest does not match.')
  signal.throwIfAborted()
  return output
}
