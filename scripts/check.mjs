import { spawnSync } from 'node:child_process'
import { root, tooling } from './tooling.mjs'

const { require } = tooling()
const biome = require.resolve('@biomejs/biome/bin/biome')

function run(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

run([
  biome,
  'check',
  'src',
  'scripts',
  'tests',
  'package.json',
  'biome.json',
  'addon/hibi-addon.json',
])
run(['scripts/typecheck.mjs'])
run(['scripts/build.mjs', '--check'])
run([
  '--test',
  '--test-concurrency=1',
  'tests/model.test.mjs',
  'tests/input.test.mjs',
  'tests/audio.test.mjs',
  'tests/audio-owner.test.mjs',
  'tests/audio-worker.test.mjs',
  'tests/video.test.mjs',
  'tests/mouse-runtime.test.mjs',
  'tests/install.test.mjs',
  'tests/bundle.test.mjs',
  'tests/iwad.test.mjs',
  'tests/bundled-runtime.test.mjs',
])
