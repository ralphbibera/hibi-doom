import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packageResources } from './resources.mjs'
import { root, tooling } from './tooling.mjs'

export async function compiledPackage(hibiRoot) {
  const { require } = tooling(hibiRoot)
  const { build } = require('esbuild')
  const resources = await packageResources()
  const formatted = spawnSync(
    process.execPath,
    [
      require.resolve('@biomejs/biome/bin/biome'),
      'format',
      '--stdin-file-path=hibi-addon.json',
    ],
    {
      cwd: root,
      input: resources.files.get('hibi-addon.json'),
      encoding: 'utf8',
    },
  )
  if (formatted.error) throw formatted.error
  if (formatted.status !== 0)
    throw new Error(`Manifest formatting failed: ${formatted.stderr}`)
  resources.files.set('hibi-addon.json', Buffer.from(formatted.stdout))
  const result = await build({
    absWorkingDir: root,
    entryPoints: {
      index: 'src/index.tsx',
      'doom.worker': 'src/doom.worker.ts',
    },
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    format: 'esm',
    jsx: 'transform',
    jsxFactory: 'React.createElement',
    jsxFragment: 'React.Fragment',
    loader: { '.css': 'text' },
    legalComments: 'none',
    sourcemap: false,
    outdir: 'addon',
    write: false,
    logLevel: 'silent',
    metafile: true,
    plugins: [
      {
        name: 'immutable-doom-bundle',
        setup(build) {
          build.onResolve({ filter: /addon\/bundle\.json$/ }, () => ({
            path: 'bundle',
            namespace: 'doom',
          }))
          build.onLoad({ filter: /.*/, namespace: 'doom' }, () => ({
            contents: JSON.stringify(resources.bundle),
            loader: 'json',
          }))
        },
      },
    ],
  })
  if (
    Object.values(result.metafile.outputs).some(
      (output) => output.imports.length,
    )
  )
    throw new Error(
      'Prepared modules must contain their own code and use the host SDK.',
    )
  const files = new Map(
    result.outputFiles.map((file) => [
      basename(file.path),
      Buffer.from(file.contents),
    ]),
  )
  if (
    !files.has('index.js') ||
    !files.has('doom.worker.js') ||
    files.size !== 2
  )
    throw new Error('The browser build produced unexpected outputs.')
  for (const [path, bytes] of resources.files) files.set(path, bytes)
  if (
    [...files.values()].some((bytes) => bytes.length > 5 * 1024 * 1024) ||
    [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0) >
      25 * 1024 * 1024
  )
    throw new Error('Prepared addon exceeds the host package limits.')
  return files
}

export async function writePackage(files, destination = join(root, 'addon')) {
  await mkdir(destination, { recursive: true })
  for (const name of await packagePaths(destination))
    if (!files.has(name))
      throw new Error(`Prepared folder contains an unowned entry: ${name}`)
  for (const [name, bytes] of files) {
    await mkdir(dirname(join(destination, name)), { recursive: true })
    await writeFile(join(destination, name), bytes)
  }
}

export async function packagePaths(directory, prefix = '') {
  const paths = []
  for (const name of await readdir(join(directory, prefix))) {
    const path = prefix ? `${prefix}/${name}` : name
    const entry = await lstat(join(directory, path))
    if (entry.isSymbolicLink())
      throw new Error(`Prepared entry must not be a symlink: ${path}`)
    if (entry.isDirectory())
      paths.push(...(await packagePaths(directory, path)))
    else if (entry.isFile()) paths.push(path)
    else throw new Error(`Unexpected prepared entry: ${path}`)
  }
  return paths.sort()
}

export async function checkPackage(files) {
  const actual = await packagePaths(join(root, 'addon'))
  if (JSON.stringify(actual) !== JSON.stringify([...files.keys()].sort()))
    throw new Error(
      'The prepared addon has missing or extra files. Run npm run build.',
    )
  for (const [name, expected] of files) {
    const entry = await lstat(join(root, 'addon', name))
    if (!entry.isFile() || entry.isSymbolicLink())
      throw new Error(`Prepared file must be a regular file: ${name}`)
    if (!(await readFile(join(root, 'addon', name))).equals(expected))
      throw new Error(
        `Prepared ${name} is stale. Run npm run build and commit the prepared files.`,
      )
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2)
  if (args.length > 1 || (args[0] !== undefined && args[0] !== '--check'))
    throw new Error('Use npm run build or npm run build:check.')
  const files = await compiledPackage()
  if (args[0] === '--check') await checkPackage(files)
  else await writePackage(files)
  console.log(
    args[0] === '--check'
      ? 'Prepared addon matches its source.'
      : 'Prepared addon/ for URL installation.',
  )
}

import { spawnSync } from 'node:child_process'
