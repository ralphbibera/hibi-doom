import type { Action } from './model.ts'

export const keys: Readonly<Record<string, Action>> = {
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'backward',
  ArrowDown: 'backward',
  KeyA: 'turnLeft',
  ArrowLeft: 'turnLeft',
  KeyD: 'turnRight',
  ArrowRight: 'turnRight',
  Comma: 'strafeLeft',
  Period: 'strafeRight',
  KeyF: 'fire',
  Space: 'use',
  ShiftLeft: 'run',
  ShiftRight: 'run',
  Enter: 'enter',
  Escape: 'escape',
  Tab: 'map',
}

export class GameInput {
  private codes = new Set<string>()
  private taps = new Set<Action>()
  epoch = 0

  press(code: string, repeat: boolean) {
    const action = keys[code]
    if (!action || repeat || this.codes.has(code)) return
    const alreadyHeld = [...this.codes].some((key) => keys[key] === action)
    this.codes.add(code)
    if (!alreadyHeld) this.taps.add(action)
  }

  release(code: string) {
    return this.codes.delete(code)
  }

  clear() {
    this.codes.clear()
    this.taps.clear()
    this.epoch++
  }

  take() {
    const held = [...new Set([...this.codes].map((code) => keys[code]))].filter(
      (action): action is Action => action !== undefined,
    )
    const taps = [...this.taps]
    this.taps.clear()
    return { held, taps }
  }
}
