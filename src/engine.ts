import type { AudioScene } from './audio-scene.ts'
import { ActiveClock } from './clock.ts'
import { boot, type DoomVm } from './doom-vm.ts'
import type { Action, Activity, WorkerCommand, WorkerReply } from './model.ts'
import { validateGame } from './runtime.ts'

type EngineState =
  | { kind: 'empty' | 'starting' | 'failed' }
  | { kind: 'ready'; vm: DoomVm; activity: Activity }

export class DoomEngine {
  private state: EngineState = { kind: 'empty' }
  private held = new Set<Action>()
  private taps = new Map<Action, number>()
  private clock: ActiveClock
  private epoch = 0
  private notify: (scene: AudioScene) => void

  constructor(
    clock = new ActiveClock(),
    notify: (scene: AudioScene) => void = () => {},
  ) {
    this.clock = clock
    this.notify = notify
  }

  async handle(input: WorkerCommand): Promise<WorkerReply> {
    if (input.kind === 'startup') {
      if (this.state.kind !== 'empty')
        throw new Error('Doom has already started.')
      this.state = { kind: 'starting' }
      try {
        const { engine, iwad } = await validateGame(input.engine, input.iwad)
        this.clock.set('running')
        const vm = boot(engine, iwad, this.clock.read, this.notify)
        this.clock.set('paused')
        this.state = { kind: 'ready', vm, activity: 'paused' }
        return { id: input.id, kind: 'ready', engine: 'doom' }
      } catch (error) {
        this.clock.set('paused')
        this.state = { kind: 'failed' }
        throw error
      }
    }
    const state = this.state
    if (state.kind !== 'ready') throw new Error('Doom is not ready.')
    state.vm.beginAudioStep()
    if (input.kind === 'activity') {
      for (const action of this.held) state.vm.key(action, false)
      this.held.clear()
      this.taps.clear()
      state.vm.resetTurn()
      this.epoch = input.epoch
      state.vm.setAudioEpoch(input.epoch)
      this.clock.set(input.activity)
      state.activity = input.activity
      return {
        id: input.id,
        kind: 'activity',
        activity: input.activity,
        epoch: this.epoch,
      }
    }
    if (input.after > state.vm.statistics.sequence)
      throw new Error('Doom frame cursor is ahead of the engine.')
    if (input.epoch !== this.epoch)
      throw new Error('Doom input epoch is out of date.')
    if (state.activity === 'paused' || input.activity === 'paused')
      return {
        id: input.id,
        kind: 'update',
        update: {
          kind: 'paused',
          sequence: state.vm.statistics.sequence,
          elapsedMs: Math.floor(this.clock.read()),
          gameTics: state.vm.snapshot()[3] ?? 0,
          audio: state.vm.audio(),
        },
      }
    const next = new Set(input.held)
    const startedAt = this.clock.read()
    // Doom polls input at 35 Hz. Keep released taps through one active tic.
    for (const action of input.taps) this.taps.set(action, startedAt + 30)
    const latched = new Set(this.taps.keys())
    for (const action of this.held)
      if (!next.has(action) && !latched.has(action)) state.vm.key(action, false)
    for (const action of new Set([...next, ...latched])) {
      if (!this.held.has(action) || input.taps.includes(action)) {
        if (this.held.has(action)) state.vm.key(action, false)
        state.vm.key(action, true)
      }
    }
    this.held = new Set([...next, ...latched])
    state.vm.turn(input.turn)
    state.vm.step()
    for (const [action, releaseAfter] of this.taps)
      if (startedAt >= releaseAfter) {
        if (!next.has(action)) {
          state.vm.key(action, false)
          this.held.delete(action)
        }
        this.taps.delete(action)
      }
    const frame = state.vm.frame(input.after)
    const audio = state.vm.audio()
    const common = {
      sequence: state.vm.statistics.sequence,
      elapsedMs: Math.floor(audio.at),
      gameTics: state.vm.snapshot()[3] ?? 0,
      audio,
    }
    return {
      id: input.id,
      kind: 'update',
      update: frame
        ? { kind: 'frame', ...frame, ...common }
        : { kind: 'unchanged', ...common },
    }
  }
}
