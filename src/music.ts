// Copyright (C) 2026 Ralph Bibera. SPDX-License-Identifier: GPL-3.0-only
import type {
  AudioBank,
  Instrument,
  MusEvent,
  MusicScore,
} from './audio-bank.ts'
import { type MusicScene, musicPosition } from './audio-scene.ts'

interface Channel {
  program: number
  bank: number
  volume: number
  expression: number
  pan: number
  bend: number
  modulation: number
  sustain: boolean
  soft: boolean
}
interface Note {
  id: number
  channel: number
  key: number
  velocity: number
  program: number
  tick: number
  released: boolean
}
type MusicChange =
  | { kind: 'start'; note: Note }
  | { kind: 'release' | 'kill'; ids: number[] }
  | { kind: 'parameters'; channel: number }
  | { kind: 'none' }

const channelDefaults = (): Channel => ({
  program: 0,
  bank: 0,
  volume: 127,
  expression: 127,
  pan: 64,
  bend: 0,
  modulation: 0,
  sustain: false,
  soft: false,
})

export class ScoreState {
  readonly channels = Array.from({ length: 16 }, channelDefaults)
  readonly notes = new Map<number, Note>()

  apply(event: MusEvent): MusicChange {
    const channel = this.channels[event.channel]
    if (!channel) throw new Error('Invalid MUS channel.')
    if (event.kind === 'on' && event.velocity > 0) {
      const note = {
        id: event.channel * 128 + event.key,
        channel: event.channel,
        key: event.key,
        velocity: event.velocity,
        program: channel.program,
        tick: event.tick,
        released: false,
      }
      this.notes.set(note.id, note)
      return { kind: 'start', note }
    }
    if (event.kind === 'off' || event.kind === 'on') {
      const id = event.channel * 128 + event.key
      const note = this.notes.get(id)
      if (note && channel.sustain) {
        note.released = true
        return { kind: 'none' }
      }
      this.notes.delete(id)
      return { kind: 'release', ids: [id] }
    }
    if (event.kind === 'pitch') channel.bend = event.bend
    else {
      switch (event.control) {
        case 0:
          channel.program = event.value
          return { kind: 'none' }
        case 1:
          channel.bank = event.value
          return { kind: 'none' }
        case 2:
          channel.modulation = event.value
          break
        case 3:
          channel.volume = event.value
          break
        case 4:
          channel.pan = event.value
          break
        case 5:
          channel.expression = event.value
          break
        case 8: {
          channel.sustain = event.value >= 64
          if (channel.sustain) return { kind: 'none' }
          const ids = [...this.notes.values()]
            .filter((note) => note.channel === event.channel && note.released)
            .map((note) => note.id)
          for (const id of ids) this.notes.delete(id)
          return { kind: 'release', ids }
        }
        case 9:
          channel.soft = event.value >= 64
          break
        case 10:
        case 11:
        case 12:
        case 13: {
          const ids = [...this.notes.values()]
            .filter((note) => note.channel === event.channel)
            .map((note) => note.id)
          for (const id of ids) {
            const note = this.notes.get(id)
            if (event.control !== 10 && channel.sustain && note)
              note.released = true
            else this.notes.delete(id)
          }
          return event.control === 10
            ? { kind: 'kill', ids }
            : channel.sustain
              ? { kind: 'none' }
              : { kind: 'release', ids }
        }
        case 14: {
          Object.assign(channel, {
            expression: 127,
            pan: 64,
            bend: 0,
            modulation: 0,
            sustain: false,
            soft: false,
          })
          const ids = [...this.notes.values()]
            .filter((note) => note.channel === event.channel && note.released)
            .map((note) => note.id)
          for (const id of ids) this.notes.delete(id)
          return { kind: 'release', ids }
        }
        default:
          return { kind: 'none' }
      }
    }
    return { kind: 'parameters', channel: event.channel }
  }
}

interface SynthVoice {
  note: Note
  carrier: OscillatorNode
  modulator: OscillatorNode
  depth: GainNode
  envelope: GainNode
  level: GainNode
  pan: StereoPannerNode
  instrument: Instrument
  frequency: number
  carrierStarted: boolean
  modulatorStarted: boolean
  released: boolean
}
export const musicVoiceLimit = 24
const lookaheadSeconds = 0.12

export class MusicOutput {
  private score: MusicScore | null = null
  private generation: number | null = null
  private state = new ScoreState()
  private voices = new Set<SynthVoice>()
  private held = new Map<number, SynthVoice>()
  private gain: GainNode
  private timer: ReturnType<typeof setInterval> | null = null
  private index = 0
  private cycle = 0
  private anchor = 0
  private looping = false
  private context: AudioContext
  private bank: AudioBank
  private failed: (error: unknown) => void

  constructor(
    context: AudioContext,
    destination: AudioNode,
    bank: AudioBank,
    failed: (error: unknown) => void,
  ) {
    this.context = context
    this.bank = bank
    this.failed = failed
    this.gain = context.createGain()
    this.gain.connect(destination)
  }

  reconcile(scene: MusicScene, at: number) {
    if (scene.kind !== 'playing') {
      this.stop()
      return
    }
    const score = this.bank.scores.get(scene.score)
    if (!score) throw new Error('Doom music score is unavailable.')
    const position = musicPosition(scene, at) / 1000
    const expected = this.context.currentTime - this.anchor
    if (
      this.generation !== scene.generation ||
      this.score !== score ||
      Math.abs(expected - position) > 0.25
    ) {
      this.stop()
      this.score = score
      this.generation = scene.generation
      this.looping = scene.looping
      const duration = score.durationMs / 1000
      const offset = scene.looping
        ? position % duration
        : Math.min(position, duration)
      this.cycle = scene.looping ? Math.floor(position / duration) : 0
      this.anchor = this.context.currentTime - position
      this.state = new ScoreState()
      this.index = 0
      while (this.index < score.events.length) {
        const event = score.events[this.index]
        if (!event || event.tick / 140 > offset) break
        this.state.apply(event)
        this.index++
      }
      for (const note of this.state.notes.values())
        this.start(note, this.context.currentTime, true)
      this.schedule()
      this.timer = setInterval(() => {
        try {
          this.schedule()
        } catch (error) {
          this.failed(error)
        }
      }, 25)
    }
    this.gain.gain.setValueAtTime(scene.volume / 127, this.context.currentTime)
  }

  private schedule() {
    const score = this.score
    if (!score) return
    const horizon = this.context.currentTime + lookaheadSeconds
    const duration = score.durationMs / 1000
    let budget = 1024
    while (budget-- > 0) {
      const event = score.events[this.index]
      if (!event) {
        const boundary = this.anchor + (this.cycle + 1) * duration
        if (boundary > horizon) return
        for (const voice of this.held.values()) this.release(voice, boundary)
        this.held.clear()
        if (!this.looping) {
          if (this.timer) clearInterval(this.timer)
          this.timer = null
          return
        }
        this.cycle++
        this.index = 0
        this.state = new ScoreState()
        continue
      }
      const when = this.anchor + this.cycle * duration + event.tick / 140
      if (when > horizon) return
      this.index++
      const change = this.state.apply(event)
      switch (change.kind) {
        case 'start':
          this.start(change.note, Math.max(this.context.currentTime, when))
          break
        case 'kill':
        case 'release':
          for (const id of change.ids) {
            const voice = this.held.get(id)
            if (voice)
              this.release(
                voice,
                Math.max(this.context.currentTime, when),
                change.kind === 'kill',
              )
          }
          if (event.kind === 'control' && event.control === 14)
            this.parameters(event.channel, when)
          break
        case 'parameters':
          this.parameters(
            change.channel,
            Math.max(this.context.currentTime, when),
          )
          break
        case 'none':
          break
        default: {
          const unreachable: never = change
          void unreachable
        }
      }
    }
    throw new Error('Doom music exceeded its scheduling budget.')
  }

  private start(note: Note, when: number, restored = false) {
    const replaced = this.held.get(note.id)
    if (replaced) this.release(replaced, when, true)
    while (this.voices.size >= musicVoiceLimit) {
      const victim =
        [...this.voices].find((voice) => voice.released) ??
        this.voices.values().next().value
      if (!victim) break
      this.destroy(victim)
    }
    const instrument =
      this.bank.instruments[
        note.channel === 15
          ? 128 + Math.max(0, Math.min(46, note.key - 35))
          : note.program
      ]
    if (!instrument) throw new Error('Doom music instrument is unavailable.')
    const key = (instrument.fixedKey ?? note.key) + instrument.transpose
    const frequency = Math.max(
      20,
      Math.min(12000, 440 * 2 ** ((key - 69) / 12)),
    )
    const context = this.context
    const carrier = context.createOscillator()
    const modulator = context.createOscillator()
    const depth = context.createGain()
    const envelope = context.createGain()
    const level = context.createGain()
    const pan = context.createStereoPanner()
    const voice: SynthVoice = {
      note,
      carrier,
      modulator,
      depth,
      envelope,
      level,
      pan,
      instrument,
      frequency,
      carrierStarted: false,
      modulatorStarted: false,
      released: false,
    }
    this.voices.add(voice)
    this.held.set(note.id, voice)
    carrier.type = instrument.waveform
    carrier.frequency.value = frequency
    modulator.frequency.value = frequency * instrument.multiplier
    modulator.connect(depth)
    depth.connect(carrier.frequency)
    carrier.connect(envelope)
    envelope.connect(level)
    level.connect(pan)
    pan.connect(this.gain)
    this.voiceParameters(voice, when)
    const percussion = note.channel === 15
    envelope.gain.setValueAtTime(restored ? instrument.sustain : 0, when)
    if (!restored) {
      envelope.gain.linearRampToValueAtTime(1, when + instrument.attack)
      envelope.gain.exponentialRampToValueAtTime(
        Math.max(0.001, percussion ? 0.001 : instrument.sustain),
        when + instrument.attack + (percussion ? 0.16 : 0.1),
      )
    }
    carrier.onended = () => this.destroy(voice)
    carrier.start(when)
    voice.carrierStarted = true
    modulator.start(when)
    voice.modulatorStarted = true
    if (percussion) this.release(voice, when + 0.22)
  }

  private voiceParameters(voice: SynthVoice, when: number) {
    const channel = this.state.channels[voice.note.channel]
    if (!channel) throw new Error('Doom music channel is unavailable.')
    voice.level.gain.setValueAtTime(
      ((((((0.12 * voice.note.velocity) / 127) * channel.volume) / 127) *
        channel.expression) /
        127) *
        (channel.soft ? 0.7 : 1),
      when,
    )
    voice.pan.pan.setValueAtTime((channel.pan - 64) / 64, when)
    voice.carrier.detune.setValueAtTime(channel.bend * 100, when)
    voice.modulator.detune.setValueAtTime(channel.bend * 100, when)
    voice.depth.gain.setValueAtTime(
      voice.frequency *
        voice.instrument.modulation *
        (0.15 + (channel.modulation / 127) * 0.5),
      when,
    )
  }
  private parameters(channel: number, when: number) {
    for (const voice of this.voices)
      if (voice.note.channel === channel) this.voiceParameters(voice, when)
  }

  private release(voice: SynthVoice, when: number, immediate = false) {
    if (voice.released && !immediate) return
    voice.released = true
    if (this.held.get(voice.note.id) === voice) this.held.delete(voice.note.id)
    voice.envelope.gain.cancelAndHoldAtTime(when)
    voice.envelope.gain.linearRampToValueAtTime(
      0,
      when + (immediate ? 0.005 : voice.instrument.release),
    )
    voice.carrier.stop(
      when + (immediate ? 0.006 : voice.instrument.release + 0.01),
    )
    voice.modulator.stop(
      when + (immediate ? 0.006 : voice.instrument.release + 0.01),
    )
  }
  private destroy(voice: SynthVoice) {
    if (!this.voices.delete(voice)) return
    if (this.held.get(voice.note.id) === voice) this.held.delete(voice.note.id)
    voice.carrier.onended = null
    if (voice.carrierStarted) voice.carrier.stop()
    if (voice.modulatorStarted) voice.modulator.stop()
    for (const node of [
      voice.carrier,
      voice.modulator,
      voice.depth,
      voice.envelope,
      voice.level,
      voice.pan,
    ])
      node.disconnect()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const voice of this.voices) this.destroy(voice)
    this.held.clear()
    this.score = null
    this.generation = null
  }
  dispose() {
    this.stop()
    this.gain.disconnect()
  }
}
