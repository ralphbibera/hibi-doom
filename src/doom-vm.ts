// Copyright (C) 2026 Ralph Bibera. SPDX-License-Identifier: GPL-3.0-only
import type { Action } from './model.ts'
import { Machine, parse } from './vm.mjs'
import { createWasiHost } from './wasi.ts'

const keyCodes: Readonly<Record<Action, number>> = {
  forward: 0xad,
  backward: 0xaf,
  turnLeft: 0xac,
  turnRight: 0xae,
  strafeLeft: 44,
  strafeRight: 46,
  fire: 0x9d,
  use: 32,
  run: 0xb6,
  enter: 13,
  escape: 27,
  map: 9,
}
const abi = [
  ['hibi', 'clock_ms', [], [127]],
  ['hibi', 'sleep_ms', [127], []],
  ['hibi', 'draw_rgba', [127], []],
  ['wasi_snapshot_preview1', 'fd_close', [127], [127]],
  ['wasi_snapshot_preview1', 'fd_fdstat_get', [127, 127], [127]],
  ['wasi_snapshot_preview1', 'fd_fdstat_set_flags', [127, 127], [127]],
  ['wasi_snapshot_preview1', 'fd_prestat_get', [127, 127], [127]],
  ['wasi_snapshot_preview1', 'fd_prestat_dir_name', [127, 127, 127], [127]],
  ['wasi_snapshot_preview1', 'fd_read', [127, 127, 127, 127], [127]],
  ['wasi_snapshot_preview1', 'fd_seek', [127, 126, 127, 127], [127]],
  ['wasi_snapshot_preview1', 'fd_write', [127, 127, 127, 127], [127]],
  ['wasi_snapshot_preview1', 'path_create_directory', [127, 127, 127], [127]],
  [
    'wasi_snapshot_preview1',
    'path_open',
    [127, 127, 127, 127, 127, 126, 126, 127, 127],
    [127],
  ],
  ['wasi_snapshot_preview1', 'path_remove_directory', [127, 127, 127], [127]],
  [
    'wasi_snapshot_preview1',
    'path_rename',
    [127, 127, 127, 127, 127, 127],
    [127],
  ],
  ['wasi_snapshot_preview1', 'path_unlink_file', [127, 127, 127], [127]],
  ['wasi_snapshot_preview1', 'proc_exit', [127], []],
] as const

export function boot(
  engine: Uint8Array,
  iwad: Uint8Array,
  clock: () => number,
) {
  const module = parse(engine)
  const imported = module.functions.filter((fn) => fn.imported)
  if (
    JSON.stringify(
      imported.map((fn) => [
        fn.namespace,
        fn.name,
        fn.signature.parameters,
        fn.signature.results,
      ]),
    ) !== JSON.stringify(abi) ||
    module.start !== null ||
    module.memories.length !== 1 ||
    module.memories[0]?.initial !== 512 ||
    module.memories[0]?.maximum !== 512 ||
    module.tables.length !== 1 ||
    module.tables[0]?.initial !== 163 ||
    module.tables[0]?.maximum !== 163
  )
    throw new Error('Unsupported Doom guest ABI.')
  for (const [name, parameters, results] of [
    ['_initialize', [], []],
    ['doom_init', [], []],
    ['doom_tick', [], []],
    ['doom_key', [127, 127], [127]],
    ['doom_snapshot', [], [127]],
  ] as const) {
    const exported = module.exports.get(name)
    const fn =
      exported?.kind === 0 ? module.functions[exported.index] : undefined
    if (
      !fn ||
      JSON.stringify(fn.signature) !== JSON.stringify({ parameters, results })
    )
      throw new Error(`Missing or invalid Doom export ${name}.`)
  }
  let machine: Machine | undefined
  const host = createWasiHost(
    iwad,
    () => {
      if (!machine) throw new Error('Doom guest memory is not ready.')
      return machine.buffer
    },
    clock,
  )
  machine = new Machine(module, host.imports, 512, 512)
  machine.callExport('_initialize')
  machine.callExport('doom_init')
  const guest = machine
  const held = new Set<Action>()
  return {
    step() {
      guest.callExport('doom_tick')
    },
    key(action: Action, pressed: boolean) {
      if (held.has(action) === pressed) return
      const [result] = guest.callExport('doom_key', [
        pressed ? 1 : 0,
        keyCodes[action],
      ])
      if (result !== 0) throw new Error('Doom input queue is full.')
      if (pressed) held.add(action)
      else held.delete(action)
    },
    frame: host.frame,
    snapshot() {
      const [address] = guest.callExport('doom_snapshot')
      if (
        typeof address !== 'number' ||
        address < 0 ||
        address > guest.buffer.byteLength - 64 ||
        address % 4 !== 0
      )
        throw new Error('Invalid Doom snapshot extent.')
      return Array.from(new Int32Array(guest.buffer, address, 16))
    },
    get statistics() {
      return { sequence: host.sequence }
    },
  }
}

export type DoomVm = ReturnType<typeof boot>
