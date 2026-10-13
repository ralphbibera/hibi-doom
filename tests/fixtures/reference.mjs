import { createWasiHost } from '../../src/wasi.ts'

const keys = {
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

export async function reference(engine, iwad, clock) {
  let memory
  const host = createWasiHost(iwad, () => memory.buffer, clock)
  const held = new Set()
  const { instance } = await WebAssembly.instantiate(engine, host.imports)
  memory = instance.exports.memory
  instance.exports._initialize()
  instance.exports.doom_init()
  return {
    step() {
      instance.exports.doom_tick()
    },
    turn(delta) {
      if (instance.exports.doom_mouse(delta) !== 0)
        throw new Error('Invalid native mouse input.')
    },
    resetTurn() {
      instance.exports.doom_mouse_reset()
    },
    exports: instance.exports,
    memory: () => memory.buffer,
    key(action, pressed) {
      if (held.has(action) === pressed) return
      if (instance.exports.doom_key(pressed ? 1 : 0, keys[action]) !== 0)
        throw new Error('Native reference input queue is full.')
      if (pressed) held.add(action)
      else held.delete(action)
    },
    frame: host.frame,
    snapshot() {
      return Array.from(
        new Int32Array(memory.buffer, instance.exports.doom_snapshot(), 16),
      )
    },
  }
}
