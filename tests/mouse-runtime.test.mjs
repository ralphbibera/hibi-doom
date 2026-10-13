import assert from 'node:assert/strict'
import test from 'node:test'
import { boot } from '../src/doom-vm.ts'
import { Machine } from '../src/vm.mjs'
import { artifacts } from './fixtures/artifacts.mjs'
import { guestFunctions } from './fixtures/guest-functions.mjs'
import { reference } from './fixtures/reference.mjs'

test('the guest retains unconsumed motion, applies core sensitivity once and consumes once', {
  timeout: 30000,
}, async () => {
  const { engine, iwad } = await artifacts()
  const debug = guestFunctions(engine, [
    'malloc',
    'DG_PollMouse',
    'D_ProcessEvents',
    'G_BuildTiccmd',
    'M_ChangeSensitivity',
  ])
  let vmTime = 100
  let nativeTime = 100
  const native = await reference(debug.exported, iwad, () => nativeTime++)
  let machine
  const original = Machine.prototype.callExport
  Machine.prototype.callExport = function (...args) {
    machine = this
    return Reflect.apply(original, this, args)
  }
  const savedWasm = globalThis.WebAssembly
  globalThis.WebAssembly = undefined
  let vm
  try {
    vm = boot(engine, iwad, () => vmTime++)
  } finally {
    Machine.prototype.callExport = original
    globalThis.WebAssembly = savedWasm
  }
  debug.install(machine)
  const step = (count = 1) => {
    for (let index = 0; index < count; index++) {
      vmTime += 30
      nativeTime += 30
      vm.step()
      native.step()
      assert.equal(vmTime, nativeTime)
      assert.deepEqual(vm.snapshot(), native.snapshot())
    }
  }
  step(2)
  for (let selection = 0; selection < 4; selection++) {
    vm.key('enter', true)
    native.key('enter', true)
    step(2)
    vm.key('enter', false)
    native.key('enter', false)
    step(2)
  }
  step(8)
  assert.deepEqual([vm.snapshot()[0], vm.snapshot()[11]], [0, 0])
  const adapters = [
    {
      call: (name, args = []) => machine.callExport(`test_${name}`, args)[0],
      memory: () => machine.buffer,
      turn: vm.turn,
      reset: vm.resetTurn,
    },
    {
      call: (name, args = []) => native.exports[`test_${name}`](...args),
      memory: native.memory,
      turn: native.turn,
      reset: native.resetTurn,
    },
  ]
  for (const adapter of adapters) {
    const command = adapter.call('malloc', [32])
    const poll = (delta) => {
      adapter.turn(delta)
      adapter.call('DG_PollMouse')
      adapter.call('D_ProcessEvents')
    }
    const consume = () => {
      adapter.call('G_BuildTiccmd', [command, 0])
      return new DataView(adapter.memory()).getInt16(command + 2, true)
    }
    poll(16)
    poll(32)
    assert.equal(
      consume(),
      -384,
      'Both accepted deltas survive before a tic command is built.',
    )
    assert.equal(consume(), 0, 'A consumed delta cannot turn a second command.')
    poll(40)
    poll(0)
    assert.equal(
      consume(),
      -320,
      'A zero-motion poll cannot overwrite unconsumed motion.',
    )
    poll(40)
    adapter.reset()
    assert.equal(consume(), 0, 'Suspension clears the responder motion too.')
    poll(2048)
    poll(2048)
    assert.equal(
      consume(),
      -16384,
      'Overflow saturates at the declared ninety-degree tic limit.',
    )
    adapter.call('M_ChangeSensitivity', [1])
    poll(10)
    assert.equal(
      consume(),
      -88,
      'The existing sensitivity setting changes the scale once.',
    )
    adapter.reset()
    poll(10)
    assert.equal(
      consume(),
      -88,
      'Reset does not overwrite the menu sensitivity setting.',
    )
    adapter.call('M_ChangeSensitivity', [0])
    poll(10)
    assert.equal(consume(), -80)
    assert.throws(() => adapter.turn(2049), /mouse/)
  }
})
