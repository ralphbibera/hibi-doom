import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { readTarGz, tarGz } from '../scripts/archive.mjs'
import { checkPackage, compiledPackage } from '../scripts/build.mjs'
import { fixtureFeed } from '../scripts/download-iwad.mjs'
import {
  digest,
  packageResources,
  preferredFiles,
} from '../scripts/resources.mjs'
import { root, tooling } from '../scripts/tooling.mjs'

test('the source archive has portable bytes and a canonical gzip header', () => {
  const files = new Map([
    ['src/main.txt', Buffer.from('portable gzip\n'.repeat(5120))],
    ['LICENSE', Buffer.from('Test fixture notice.\n')],
    ['tools/build.sh', Buffer.from('#!/bin/sh\nprintf "ok\\n"\n')],
  ])
  const archive = tarGz(files)
  assert.equal(
    digest(archive),
    '8151f42dbbc20d0d62fa27ef53c7dcfd8d96ae9c56b86fde2774856338e51379',
  )
  assert.equal(archive.length, 389)
  assert.equal(archive.subarray(0, 10).toString('hex'), '1f8b0800000000000203')
  assert.deepEqual(tarGz(new Map([...files].reverse())), archive)
  const decoded = readTarGz(archive)
  assert.equal(decoded.size, files.size)
  for (const [path, bytes] of files) assert.deepEqual(decoded.get(path), bytes)
})

test('the committed prepared addon is reproducible and fresh', async () => {
  const first = await compiledPackage()
  const second = await compiledPackage()
  for (const path of [
    'LICENSE.txt',
    'LICENSES.md',
    'README.md',
    'doom.worker.js',
    'hibi-addon.json',
    'bundle.json',
    'index.js',
    'assets/engine/000.json',
    'assets/source/000.json',
  ])
    assert(first.has(path), path)
  for (const [name, bytes] of first)
    assert.deepEqual(second.get(name), bytes, name)
  await checkPackage(first)
  assert.equal(
    [...first.keys()].some((path) => path.startsWith('assets/iwad/')),
    false,
  )
  assert.deepEqual(
    first.get('LICENSE.txt'),
    await readFile(join(root, 'LICENSE')),
  )
  assert.equal(
    first.get('README.md').toString(),
    (await readFile(join(root, 'README.md'), 'utf8')).replaceAll(
      '(addon/LICENSES.md)',
      '(LICENSES.md)',
    ),
  )
})

test('stock Hibi admits the exact compiled folder and finds only one package', async (t) => {
  const { host, require } = tooling()
  const { build } = require('esbuild')
  const scratch = await mkdtemp(join(tmpdir(), 'hibi-doom-admission-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const output = join(scratch, 'admission.mjs')
  await build({
    stdin: {
      contents: `export { inventoryAddonArchive, inventoryAddonDirectory, addonCandidatePaths, addonPackageFiles } from ${JSON.stringify(join(host, 'src/main/addon-inventory.ts'))};\nexport { admitInstalledAddon } from ${JSON.stringify(join(host, 'src/shared/addon-manifest.ts'))};`,
      resolveDir: host,
      sourcefile: 'admission-fixture.mjs',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    external: ['@aws-sdk/client-s3'],
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
    outfile: output,
    logLevel: 'silent',
  })
  const api = await import(pathToFileURL(output).href)
  const packageInventory = await api.inventoryAddonDirectory(
    join(root, 'addon'),
  )
  assert.deepEqual(api.addonCandidatePaths(packageInventory), [''])
  const prepared = await compiledPackage()
  assert.deepEqual(
    api.addonPackageFiles(packageInventory, ''),
    [...prepared.keys()].sort(),
  )
  const admitted = api.admitInstalledAddon(
    JSON.parse((await packageInventory.read('hibi-addon.json')).toString()),
    [],
  )
  assert.equal(admitted.entry, 'index.js')
  assert.equal(admitted.manifest.defaultEnabled, false)
  assert.deepEqual(admitted.manifest.capabilities, ['ui'])
  assert.deepEqual(admitted.manifest.network.origins, [
    'https://gist.githubusercontent.com',
  ])
  const repositoryInventory = await api.inventoryAddonDirectory(root)
  assert.deepEqual(api.addonCandidatePaths(repositoryInventory), ['addon'])
  const { zipFiles } = await import(
    pathToFileURL(join(host, 'tests/zip.mjs')).href
  )
  const repositoryFiles = await preferredFiles()
  repositoryFiles.set(
    'engine/upstream.json',
    await readFile(join(root, 'engine/upstream.json')),
  )
  for (const [path, bytes] of prepared)
    repositoryFiles.set(`addon/${path}`, bytes)
  const zip = zipFiles(
    [...repositoryFiles].map(([path, bytes]) => ({
      name: `hibi-doom-main/${path}`,
      content: bytes,
      deflate: true,
    })),
  )
  assert(zip.length <= 25 * 1024 * 1024)
  const archive = await api.inventoryAddonArchive(zip)
  assert.deepEqual(api.addonCandidatePaths(archive), ['hibi-doom-main/addon'])
  const paths = api.addonPackageFiles(archive, 'hibi-doom-main/addon')
  assert.deepEqual(paths, [...prepared.keys()].sort())
  for (const [path, bytes] of prepared)
    assert.deepEqual(
      await archive.read(`hibi-doom-main/addon/${path}`),
      bytes,
      path,
    )
  if (process.env.HIBI_DOOM_BUNDLE_PROOF_DIR) {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const output = process.env.HIBI_DOOM_BUNDLE_PROOF_DIR
    await mkdir(output, { recursive: true })
    await writeFile(join(output, 'repository.zip'), zip)
    await writeFile(
      join(output, 'package-admission.json'),
      `${JSON.stringify(
        {
          preparedBytes: [...prepared.values()].reduce(
            (sum, bytes) => sum + bytes.length,
            0,
          ),
          files: [...prepared].map(([path, bytes]) => ({
            path,
            bytes: bytes.length,
            sha256: digest(bytes),
          })),
          zipBytes: zip.length,
          zipSha256: digest(zip),
          candidates: api.addonCandidatePaths(archive),
          repositoryFiles: repositoryFiles.size,
        },
        null,
        2,
      )}\n`,
    )
  }
})

test('source delivery contains current code and linked libraries with no game data or archive-hash cycle', async () => {
  const { files, bundle, sourceFiles } = await packageResources()
  const archiveBytes = Buffer.concat(
    bundle.source.chunks.map((chunk) =>
      Buffer.from(JSON.parse(files.get(chunk.path)).base64, 'base64'),
    ),
  )
  assert.equal(digest(archiveBytes), bundle.source.sha256)
  const archive = readTarGz(archiveBytes)
  assert.equal(archive.size, sourceFiles.size)
  const inventory = JSON.parse(archive.get('SOURCE-INVENTORY.json'))
  for (const [path, hash] of Object.entries(inventory.files))
    assert.equal(digest(archive.get(path)), hash, path)
  for (const [path, bytes] of await preferredFiles())
    assert.deepEqual(archive.get(path), bytes, path)
  assert(archive.has('engine/vendor/wasi-libc/Makefile'))
  assert(
    archive.has('engine/vendor/llvm-project/compiler-rt/lib/builtins/multi3.c'),
  )
  assert.equal(archive.has('addon/bundle.json'), false)
  assert.equal(
    [...archive.keys()].some((path) => path.startsWith('addon/assets/source/')),
    false,
  )
  assert(archive.has('engine/config.h'))
  assert.equal(
    [...archive.keys()].some((path) => path.startsWith('addon/assets/iwad/')),
    false,
  )
  const feed = await fixtureFeed()
  const needles = [...feed.files]
    .filter(([path]) => path !== 'manifest.json')
    .map(([, text]) => Buffer.from(JSON.parse(text).base64.slice(0, 256)))
  for (const [path, bytes] of [
    ...files,
    ...archive,
    ...(await preferredFiles()),
  ]) {
    assert.equal(bytes.equals(feed.bytes), false, path)
    for (const needle of needles)
      assert.equal(bytes.includes(needle), false, path)
  }
})
