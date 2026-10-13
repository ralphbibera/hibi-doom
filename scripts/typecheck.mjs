import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { root, tooling } from './tooling.mjs'

const { host, require } = tooling()
const tsc = join(dirname(require.resolve('typescript/package.json')), 'bin/tsc')
const scratch = await mkdtemp(join(tmpdir(), 'hibi-doom-types-'))
function compile(config) {
  const result = spawnSync(process.execPath, [tsc, '-p', config], {
    cwd: root,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error('TypeScript checking failed.')
}
try {
  const sdk = join(scratch, 'sdk.json')
  await writeFile(
    sdk,
    JSON.stringify({
      extends: join(host, 'tsconfig.web.json'),
      compilerOptions: {
        noEmit: false,
        noEmitOnError: true,
        declaration: true,
        emitDeclarationOnly: true,
        skipLibCheck: false,
        incremental: false,
        rootDir: host,
        outDir: join(scratch, 'sdk'),
        types: ['react'],
        typeRoots: [join(host, 'node_modules/@types')],
      },
      files: [
        ...['api', 'sdk-loader'].map((name) =>
          join(host, 'src/addons', `${name}.ts`),
        ),
        join(host, 'node_modules/vite/client.d.ts'),
      ],
      include: [],
    }),
  )
  compile(sdk)
  const source = join(scratch, 'source.json')
  await writeFile(
    source,
    JSON.stringify({
      compilerOptions: {
        noEmit: true,
        target: 'ES2023',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        resolveJsonModule: true,
        allowImportingTsExtensions: true,
        strict: true,
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        noUnusedLocals: true,
        noUnusedParameters: true,
        noFallthroughCasesInSwitch: true,
        verbatimModuleSyntax: true,
        isolatedModules: true,
        skipLibCheck: true,
        lib: ['ES2023', 'DOM'],
        types: ['react'],
        typeRoots: [join(host, 'node_modules/@types')],
        jsx: 'react',
        paths: {
          '@hibi/addon-sdk/*': [join(scratch, 'sdk/src/addons/*')],
          react: [join(host, 'node_modules/@types/react/index.d.ts')],
        },
      },
      include: [
        join(root, 'src/**/*.ts'),
        join(root, 'src/**/*.tsx'),
        join(root, 'src/**/*.d.mts'),
      ],
    }),
  )
  compile(source)
} finally {
  await rm(scratch, { recursive: true, force: true })
}
