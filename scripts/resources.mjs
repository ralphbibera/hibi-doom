import { createHash } from 'node:crypto'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readTarGz, tarGz } from './archive.mjs'
import { root } from './tooling.mjs'

export const digest = (bytes) =>
  createHash('sha256').update(bytes).digest('hex')
export const json = (value) =>
  Buffer.from(`${JSON.stringify(value, null, 2)}\n`)

export function chunkArtifact(bytes, role, output) {
  const chunks = []
  for (let offset = 0; offset < bytes.length; offset += 3 * 1024 * 1024) {
    const chunk = bytes.subarray(offset, offset + 3 * 1024 * 1024)
    const path = `assets/${role}/${String(chunks.length).padStart(3, '0')}.json`
    const encoded = Buffer.from(
      JSON.stringify({ base64: chunk.toString('base64') }),
    )
    chunks.push({
      path,
      jsonBytes: encoded.length,
      decodedBytes: chunk.length,
      sha256: digest(chunk),
    })
    output.set(path, encoded)
  }
  return { bytes: bytes.length, sha256: digest(bytes), chunks }
}

export async function readGameArtifact(role, pin) {
  const directory = join(root, 'addon/assets', role)
  const names = (await readdir(directory)).sort()
  if (names.length !== Math.ceil(pin.bytes / (3 * 1024 * 1024)))
    throw new Error('Incomplete game artifact chunks.')
  const chunks = []
  for (const [index, name] of names.entries()) {
    if (name !== `${String(index).padStart(3, '0')}.json`)
      throw new Error('Unexpected game artifact chunk.')
    const text = await readFile(join(directory, name), 'utf8')
    const value = JSON.parse(text)
    if (
      Object.keys(value).join(',') !== 'base64' ||
      typeof value.base64 !== 'string'
    )
      throw new Error('Invalid artifact JSON.')
    const chunk = Buffer.from(value.base64, 'base64')
    if (
      chunk.toString('base64') !== value.base64 ||
      text !== JSON.stringify({ base64: value.base64 })
    )
      throw new Error('Noncanonical artifact chunk.')
    chunks.push(chunk)
  }
  const output = Buffer.concat(chunks)
  if (output.length !== pin.bytes || digest(output) !== pin.sha256)
    throw new Error(`Pinned ${role} artifact does not match.`)
  return output
}

export async function preferredFiles() {
  const output = new Map()
  async function add(path) {
    const entry = await lstat(join(root, path))
    if (entry.isSymbolicLink())
      throw new Error(`Source must not contain symlinks: ${path}`)
    if (entry.isDirectory()) {
      for (const name of (await readdir(join(root, path))).sort())
        await add(`${path}/${name}`)
    } else if (entry.isFile())
      output.set(path, await readFile(join(root, path)))
    else throw new Error(`Unexpected source entry: ${path}`)
  }
  for (const directory of [
    'src',
    'scripts',
    'tests',
    'docs',
    'licenses',
    '.github',
    'vendor',
  ])
    await add(directory)
  for (const path of [
    'README.md',
    'LICENSE',
    'package.json',
    'biome.json',
    '.gitignore',
    'engine/platform.c',
    'engine/doomgeneric.h',
    'engine/config.h',
    'engine/pins.json',
    'engine/upstream-inventory.json',
    'engine/linked.json',
  ])
    await add(path)
  return output
}

export async function packageResources() {
  const pins = JSON.parse(
    await readFile(join(root, 'engine/pins.json'), 'utf8'),
  )
  const linked = JSON.parse(
    await readFile(join(root, 'engine/linked.json'), 'utf8'),
  )
  if (
    linked.engineSha256 !== pins.engine.sha256 ||
    linked.platformSha256 !==
      digest(await readFile(join(root, 'engine/platform.c'))) ||
    linked.compiledSources['platform.c'] !== linked.platformSha256 ||
    linked.headerOverlays?.length !== 2
  )
    throw new Error(
      'The engine does not match its owned source and linked inventory.',
    )
  const upstreamInventory = JSON.parse(
    await readFile(join(root, 'engine/upstream-inventory.json'), 'utf8'),
  )
  for (const [index, name] of ['doomgeneric.h', 'config.h'].entries()) {
    const overlay = linked.headerOverlays[index]
    const path = `vendor/doomgeneric/doomgeneric/${name}`
    if (
      overlay.source !== `engine/${name}` ||
      overlay.path !== path ||
      overlay.license !== 'GPL-3.0-only' ||
      overlay.sha256 !== digest(await readFile(join(root, overlay.source))) ||
      overlay.originalSha256 !== upstreamInventory.files[path] ||
      linked.compilerDependencies[path] !== overlay.sha256
    )
      throw new Error('The engine does not match its owned header overlays.')
  }
  const files = new Map()
  const engine = {
    ...chunkArtifact(
      await readGameArtifact('engine', pins.engine),
      'engine',
      files,
    ),
    abi: 'doomgeneric-wasi-v1',
  }
  const iwad = pins.iwad
  const licenseNames = (await readdir(join(root, 'licenses'))).sort()
  const notices = [
    '# Hibi Doom license and corresponding source\n\n',
    '## Project license\n\n',
    'Hibi Doom project code and its bundled Doom engine are licensed under GNU GPL version 3 only (GPL-3.0-only). They come with absolutely no warranty. You may redistribute them under that license.\n\n',
    'The complete corresponding source accompanies this package. Open Doom license and source, then choose Save corresponding source. The archive contains the exact preferred addon and engine source, linked library source, interface definitions, notices, and build scripts. Repository access is not required.\n\n',
    '```text\n',
    await readFile(join(root, 'LICENSE'), 'utf8'),
    '\n```\n\n',
    '## Third-party notices\n\n',
    'The selected Doom core sources retain their GPL version 2 or later grants. The SHA-1 implementation from GnuPG is copyright the Free Software Foundation, Inc., 1998-2001, and retains its GPL version 3 or later grant. Their original source notices remain in effect.\n\n',
    'The source archive preserves the original unselected dummy.c, doomgeneric.c, doomgeneric.h, and config.h with their upstream notices. The bundled engine uses project-owned startup code, a framebuffer interface, and build configuration instead.\n\n',
    'The unchanged Doom 1.9 shareware IWAD has separate id Software terms. It is downloaded free of charge from a separate public feed on first Play and is absent from this code package and corresponding source. The compiler runtime uses Apache 2.0 with the LLVM exception. WASI libc changes use its MIT option. The build-only source archive encoder retains its MIT notice.\n',
  ]
  for (const name of licenseNames)
    notices.push(
      `\n### ${name}\n\n\`\`\`text\n${await readFile(join(root, 'licenses', name), 'utf8')}\n\`\`\`\n`,
    )
  const noticeBytes = Buffer.from(notices.join(''))
  files.set('LICENSES.md', noticeBytes)
  const sources = await preferredFiles()
  const inputInventory = JSON.parse(
    await readFile(join(root, 'engine/upstream-inventory.json'), 'utf8'),
  )
  let upstream
  try {
    const encoded = JSON.parse(
      await readFile(join(root, 'engine/upstream.json'), 'utf8'),
    )
    const compressed = Buffer.from(encoded.base64, 'base64')
    if (
      compressed.length !== inputInventory.bytes ||
      digest(compressed) !== inputInventory.sha256
    )
      throw new Error('Upstream source input does not match.')
    upstream = readTarGz(compressed)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    upstream = new Map()
    for (const path of Object.keys(inputInventory.files))
      upstream.set(path, await readFile(join(root, 'engine', path)))
  }
  if (upstream.size !== Object.keys(inputInventory.files).length)
    throw new Error('Upstream preferred source is incomplete.')
  for (const [path, contents] of upstream) {
    if (digest(contents) !== inputInventory.files[path])
      throw new Error(`Upstream source digest does not match: ${path}`)
    sources.set(`engine/${path}`, contents)
  }
  for (const [path, contents] of files)
    if (path.startsWith('assets/')) sources.set(`addon/${path}`, contents)
  sources.set('LICENSES.md', noticeBytes)
  const sourceInventory = json({
    schema: 1,
    files: Object.fromEntries(
      [...sources]
        .map(([path, bytes]) => [path, digest(bytes)])
        .sort(([a], [b]) => a.localeCompare(b, 'en')),
    ),
  })
  sources.set('SOURCE-INVENTORY.json', sourceInventory)
  const compressed = tarGz(sources)
  if (compressed.length > 16 * 1024 * 1024)
    throw new Error('Corresponding source exceeds the export limit.')
  const source = {
    ...chunkArtifact(compressed, 'source', files),
    archive: 'tar.gz',
    exportName: 'hibi-doom-0.3.0-source.tar.gz',
  }
  const bundle = {
    schema: 2,
    engine,
    iwad,
    source,
    notices: {
      path: 'LICENSES.md',
      bytes: noticeBytes.length,
      sha256: digest(noticeBytes),
    },
  }
  files.set('bundle.json', json(bundle))
  const manifest = JSON.parse(
    await readFile(join(root, 'scripts/manifest.json'), 'utf8'),
  )
  manifest.licenses = [
    {
      id: 'hibi-doom-engine',
      name: 'Hibi Doom project',
      license: 'GPL-3.0-only',
      text: await readFile(join(root, 'LICENSE'), 'utf8'),
    },
    {
      id: 'doom-shareware',
      name: 'Doom 1.9 shareware data',
      license: 'LicenseRef-DOOM-shareware',
      text: await readFile(
        join(root, 'licenses/doom1-shareware-debian.txt'),
        'utf8',
      ),
    },
  ]
  const manifestBytes = json(manifest)
  if (manifestBytes.length > 65536)
    throw new Error('Addon notices exceed the manifest limit.')
  files.set('hibi-addon.json', manifestBytes)
  files.set(
    'README.md',
    Buffer.from(
      (await readFile(join(root, 'README.md'), 'utf8')).replaceAll(
        '(addon/LICENSES.md)',
        '(LICENSES.md)',
      ),
    ),
  )
  files.set('LICENSE.txt', await readFile(join(root, 'LICENSE')))
  return { files, bundle, sourceFiles: sources }
}
