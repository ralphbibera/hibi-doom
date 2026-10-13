// Copyright (C) 2026 Ralph Bibera. SPDX-License-Identifier: GPL-3.0-only

import abi from '../engine/abi.json' with { type: 'json' }
import type { AudioScene } from './audio-scene.ts'
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
export function boot(
  engine: Uint8Array,
  iwad: Uint8Array,
  clock: () => number,
  notify: (scene: AudioScene) => void = () => {},
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
    ) !== JSON.stringify(abi.imports) ||
    module.start !== abi.start ||
    JSON.stringify(module.memories) !== JSON.stringify(abi.memories) ||
    JSON.stringify(module.tables) !== JSON.stringify(abi.tables) ||
    JSON.stringify(
      [...module.exports].map(([name, value]) => ({
        name,
        kind: value.kind,
        signature:
          value.kind === 0 ? module.functions[value.index]?.signature : null,
      })),
    ) !== JSON.stringify(abi.exports)
  )
    throw new Error('Unsupported Doom guest ABI.')
  for (const [name, parameters, results] of [
    ['_initialize', [], []],
    ['doom_init', [], []],
    ['doom_tick', [], []],
    ['doom_key', [127, 127], [127]],
    ['doom_snapshot', [], [127]],
    ['doom_mouse', [127], [127]],
    ['doom_mouse_reset', [], []],
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
    notify,
  )
  machine = new Machine(module, host.imports, 512, 512)
  machine.callExport('_initialize')
  host.sound.beginStep()
  machine.callExport('doom_init')
  const guest = machine
  const held = new Set<Action>()
  return {
    beginAudioStep: () => host.sound.beginStep(),
    setAudioEpoch: (epoch: number) => host.sound.setEpoch(epoch),
    audio: () => host.sound.scene(),
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
    turn(delta: number) {
      if (!delta) return
      const [result] = guest.callExport('doom_mouse', [delta])
      if (result !== 0) throw new Error('Invalid Doom mouse motion.')
    },
    resetTurn() {
      guest.callExport('doom_mouse_reset')
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
