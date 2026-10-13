import type { Action } from './model.ts'

export const keys: Readonly<Record<string, Action>> = {
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'backward',
  ArrowDown: 'backward',
  KeyA: 'strafeLeft',
  ArrowLeft: 'turnLeft',
  KeyD: 'strafeRight',
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
  private sources = new Map<string, Action>()
  private taps = new Map<string, Action>()
  private origin: { pointer: number; x: number } | null = null
  private fraction = 0
  private turn = 0
  epoch = 0

  press(code: string, repeat: boolean) {
    const action = keys[code]
    if (action) this.pressSource(`key:${code}`, action, repeat)
  }

  release(code: string) {
    return this.sources.delete(`key:${code}`)
  }

  private pressSource(source: string, action: Action, repeat = false) {
    if (repeat || this.sources.has(source)) return
    const alreadyHeld = [...this.sources.values()].includes(action)
    this.sources.set(source, action)
    if (!alreadyHeld) this.taps.set(source, action)
  }

  pointerPress(button: number) {
    const action = button === 0 ? 'fire' : button === 2 ? 'use' : null
    if (!action) return false
    this.pressSource(`pointer:${button}`, action)
    return true
  }

  pointerRelease(button: number) {
    return this.sources.delete(`pointer:${button}`)
  }

  pointerButtons(buttons: number) {
    for (const [button, mask] of [
      [0, 1],
      [2, 2],
    ] as const) {
      if (buttons & mask) this.pointerPress(button)
      else this.pointerRelease(button)
    }
  }

  get pointerHeld() {
    return [...this.sources.keys()].some((source) =>
      source.startsWith('pointer:'),
    )
  }

  point(pointer: number, x: number, canvasWidth: number) {
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(canvasWidth) ||
      canvasWidth <= 0
    ) {
      this.resetOrigin()
      return
    }
    const previous = this.origin
    this.origin = { pointer, x }
    if (!previous || previous.pointer !== pointer) return
    const delta = (((x - previous.x) * 640) / canvasWidth) * 8
    const scaled = Math.max(-2048, Math.min(2048, delta)) + this.fraction
    const whole = Math.trunc(scaled)
    this.fraction = scaled - whole
    this.turn = Math.max(-2048, Math.min(2048, this.turn + whole))
  }

  resetOrigin() {
    this.origin = null
    this.fraction = 0
  }

  clearPointer() {
    for (const source of new Set([
      ...this.sources.keys(),
      ...this.taps.keys(),
    ])) {
      if (source.startsWith('pointer:')) {
        this.sources.delete(source)
        this.taps.delete(source)
      }
    }
    this.resetOrigin()
    this.turn = 0
    this.epoch++
  }

  clear() {
    this.sources.clear()
    this.taps.clear()
    this.resetOrigin()
    this.turn = 0
    this.epoch++
  }

  take() {
    const held = [...new Set(this.sources.values())]
    const taps = [...new Set(this.taps.values())]
    const turn = this.turn
    this.taps.clear()
    this.turn = 0
    return { held, taps, turn }
  }
}
