// SPDX-License-Identifier: GPL-3.0-only
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parse } from '../src/vm.mjs'
import { digest, json } from './resources.mjs'
import { root } from './tooling.mjs'

const directory = resolve(process.argv[2] ?? '')
if (process.argv.length !== 3)
  throw new Error('Pass one completed engine-build.py work directory.')
const bytes = await readFile(join(directory, 'doom.wasm'))
const linked = JSON.parse(
  await readFile(join(directory, 'linked.json'), 'utf8'),
)
const build = JSON.parse(await readFile(join(directory, 'build.json'), 'utf8'))
if (
  digest(bytes) !== linked.engineSha256 ||
  build.sha256 !== linked.engineSha256 ||
  bytes.length !== build.bytes ||
  !build.compiler.includes('20.1.8-wasi-sdk')
)
  throw new Error('The completed engine build does not match its provenance.')
for (const overlay of [...linked.headerOverlays, ...linked.sourceOverlays])
  if (
    digest(await readFile(join(root, overlay.source))) !==
    (overlay.sourceSha256 ?? overlay.sha256)
  )
    throw new Error('An owned engine source changed after compilation.')
if (
  digest(await readFile(join(root, 'engine/platform.c'))) !==
  linked.platformSha256
)
  throw new Error('The platform adapter changed after compilation.')
const module = parse(bytes)
const abi = {
  imports: module.functions
    .filter((fn) => fn.imported)
    .map((fn) => [
      fn.namespace,
      fn.name,
      fn.signature.parameters,
      fn.signature.results,
    ]),
  exports: [...module.exports].map(([name, value]) => ({
    name,
    kind: value.kind,
    signature:
      value.kind === 0 ? module.functions[value.index].signature : null,
  })),
  memories: module.memories,
  tables: module.tables,
  start: module.start,
}
const pins = JSON.parse(await readFile(join(root, 'engine/pins.json'), 'utf8'))
pins.engine.bytes = bytes.length
pins.engine.sha256 = digest(bytes)
await writeFile(join(root, 'engine/pins.json'), json(pins))
await writeFile(join(root, 'engine/linked.json'), json(linked))
await writeFile(join(root, 'engine/abi.json'), json(abi))
await writeFile(
  join(root, 'addon/assets/engine/000.json'),
  JSON.stringify({ base64: bytes.toString('base64') }),
)
console.log(JSON.stringify({ bytes: bytes.length, sha256: digest(bytes), abi }))
