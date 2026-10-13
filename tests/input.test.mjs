import assert from 'node:assert/strict'
import test from 'node:test'
import { GameInput } from '../src/input.ts'

test('button masks reconcile intermediate chord presses and releases', () => {
  const input = new GameInput()
  input.pointerButtons(1)
  assert.deepEqual(input.take(), { held: ['fire'], taps: ['fire'], turn: 0 })
  input.pointerButtons(3)
  assert.deepEqual(input.take(), {
    held: ['fire', 'use'],
    taps: ['use'],
    turn: 0,
  })
  input.pointerButtons(2)
  assert.deepEqual(input.take(), { held: ['use'], taps: [], turn: 0 })
  assert.equal(input.pointerHeld, true)
  input.pointerButtons(0)
  assert.deepEqual(input.take(), { held: [], taps: [], turn: 0 })
  assert.equal(input.pointerHeld, false)
  input.press('KeyF', false)
  input.pointerButtons(1)
  input.take()
  input.pointerButtons(3)
  input.pointerButtons(2)
  assert.deepEqual(input.take(), {
    held: ['fire', 'use'],
    taps: ['use'],
    turn: 0,
  })
  input.pointerButtons(0)
  assert.deepEqual(input.take(), { held: ['fire'], taps: [], turn: 0 })
})

test('mouse and keyboard action sources release independently', () => {
  const input = new GameInput()
  input.press('KeyF', false)
  input.pointerPress(0)
  assert.deepEqual(input.take(), { held: ['fire'], taps: ['fire'], turn: 0 })
  input.pointerRelease(0)
  assert.deepEqual(input.take(), { held: ['fire'], taps: [], turn: 0 })
  input.pointerPress(0)
  input.release('KeyF')
  assert.deepEqual(input.take(), { held: ['fire'], taps: [], turn: 0 })
  input.pointerRelease(0)
  input.press('KeyA', false)
  input.press('KeyD', false)
  input.pointerPress(2)
  assert.deepEqual(input.take(), {
    held: ['strafeLeft', 'strafeRight', 'use'],
    taps: ['strafeLeft', 'strafeRight', 'use'],
    turn: 0,
  })
  input.clearPointer()
  assert.deepEqual(input.take(), {
    held: ['strafeLeft', 'strafeRight'],
    taps: [],
    turn: 0,
  })
})

test('entry coordinates establish a baseline and fractional horizontal motion survives samples', () => {
  const input = new GameInput()
  input.point(1, 700, 640)
  assert.equal(input.take().turn, 0)
  input.point(1, 700.05, 640)
  assert.equal(input.take().turn, 0)
  input.point(1, 700.1, 640)
  assert.equal(input.take().turn, 0)
  input.point(1, 700.15, 640)
  assert.equal(input.take().turn, 1)
  input.point(1, 701, 640)
  assert.equal(input.take().turn, 7)
  assert.equal(input.take().turn, 0)
  input.resetOrigin()
  input.point(1, 5000, 640)
  assert.equal(input.take().turn, 0)
  input.point(1, 4900, 640)
  assert.equal(input.take().turn, -800)
  input.point(2, 1, 640)
  assert.equal(input.take().turn, 0)
})

test('split in-range sweeps agree, overflow is bounded, and reset discards pending motion', () => {
  const split = new GameInput()
  const together = new GameInput()
  split.point(1, 0, 800)
  together.point(1, 0, 800)
  for (const x of [10, 20, 50, 100]) split.point(1, x, 800)
  together.point(1, 100, 800)
  assert.equal(split.take().turn, 640)
  assert.equal(together.take().turn, 640)
  together.point(1, 100000, 800)
  assert.equal(together.take().turn, 2048)
  together.point(1, -100000, 800)
  assert.equal(together.take().turn, -2048)
  together.point(1, -99990, 800)
  const epoch = together.epoch
  together.clear()
  assert.equal(together.epoch, epoch + 1)
  assert.deepEqual(together.take(), { held: [], taps: [], turn: 0 })
  together.point(1, 0, 0)
  together.point(1, Infinity, 800)
  assert.equal(together.take().turn, 0)
})
