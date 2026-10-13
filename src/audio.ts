// Copyright (C) 2026 Ralph Bibera. SPDX-License-Identifier: GPL-3.0-only
import type { AudioBank } from './audio-bank.ts'
import type { AudioScene, SoundVoice } from './audio-scene.ts'
import type { Activity } from './model.ts'
import { MusicOutput } from './music.ts'

export type AudioAvailability =
  | { kind: 'waiting' }
  | { kind: 'enabled' | 'muted' }
  | { kind: 'unavailable'; message: string }
  | { kind: 'closed' }

interface Effect {
  generation: number
  started: boolean
  source: AudioBufferSourceNode
  left: GainNode
  right: GainNode
  merger: ChannelMergerNode
}
interface OpenAudio {
  kind: 'open'
  context: AudioContext
  master: GainNode
  effects: Map<number, Effect>
  samples: Map<number, AudioBuffer>
  music: MusicOutput
}
type Output =
  | { kind: 'waiting' }
  | { kind: 'closed' }
  | { kind: 'unavailable'; message: string }
  | OpenAudio

export function stereoWeights(volume: number, separation: number) {
  return {
    left: Math.min(255, Math.floor(((254 - separation) * volume) / 127)) / 255,
    right: Math.min(255, Math.floor((separation * volume) / 127)) / 255,
  }
}

export class GameAudio {
  private output: Output = { kind: 'waiting' }
  private latest: AudioScene | null = null
  private activity: Activity = 'paused'
  private epoch = 0
  private generation = 0
  private muted = false
  private volume = 0.7
  private anchor: { game: number; audio: number } | null = null
  private bank: AudioBank
  private changed: (availability: AudioAvailability) => void

  constructor(
    bank: AudioBank,
    changed: (availability: AudioAvailability) => void = () => {},
  ) {
    this.bank = bank
    this.changed = changed
  }

  get availability(): AudioAvailability {
    const output = this.output
    if (output.kind === 'open')
      return { kind: this.muted || this.volume === 0 ? 'muted' : 'enabled' }
    return output
  }

  setActivity(activity: Activity, epoch: number) {
    if (this.activity === activity && this.epoch === epoch) return
    this.activity = activity
    this.epoch = epoch
    this.generation++
    this.latest = null
    this.silence()
    if (activity === 'running' && this.output.kind === 'open') this.activate()
    else this.suspend()
  }

  activate() {
    let output = this.output
    if (output.kind === 'closed' || output.kind === 'unavailable') return
    try {
      if (output.kind === 'waiting') {
        if (!navigator.userActivation.isActive) return
        const context = new AudioContext({ latencyHint: 'interactive' })
        try {
          const master = context.createGain()
          master.gain.value = this.muted ? 0 : this.volume
          master.connect(context.destination)
          const music = new MusicOutput(context, master, this.bank, (error) =>
            this.fail(error),
          )
          output = {
            kind: 'open',
            context,
            master,
            music,
            effects: new Map(),
            samples: new Map(),
          }
        } catch (error) {
          void context.close().catch(() => {})
          throw error
        }
        this.output = output
        const owned = output
        context.onstatechange = () => {
          if (this.output === owned && context.state === 'closed')
            this.fail(new Error('The Doom audio context closed unexpectedly.'))
        }
        this.changed(this.availability)
      }
      if (this.activity !== 'running' || this.muted || this.volume === 0) {
        this.suspend()
        return
      }
      const current = output
      const generation = this.generation
      void current.context.resume().then(
        () => {
          if (this.output !== current) {
            void current.context.close().catch(() => {})
            return
          }
          if (generation !== this.generation) {
            if (this.activity !== 'running' || this.muted || this.volume === 0)
              this.suspend()
            return
          }
          if (this.latest) {
            try {
              this.render(this.latest)
            } catch (error) {
              this.fail(error)
            }
          }
        },
        (error: unknown) => {
          if (this.output === current && generation === this.generation)
            this.fail(error)
        },
      )
    } catch (error) {
      this.fail(error)
    }
  }

  setPreference(muted: boolean, volume: number) {
    if (!Number.isFinite(volume) || volume < 0 || volume > 1)
      throw new Error('Invalid Doom audio volume.')
    const silenced = muted || volume === 0
    const wasSilenced = this.muted || this.volume === 0
    this.muted = muted
    this.volume = volume
    if (this.output.kind === 'open')
      this.output.master.gain.setValueAtTime(
        silenced ? 0 : volume,
        this.output.context.currentTime,
      )
    if (silenced !== wasSilenced) {
      this.generation++
      this.silence()
      if (silenced) this.suspend()
      else this.activate()
    }
    this.changed(this.availability)
  }

  apply(scene: AudioScene) {
    if (
      this.activity !== 'running' ||
      scene.epoch !== this.epoch ||
      this.output.kind === 'closed' ||
      this.output.kind === 'unavailable'
    )
      return
    if (
      this.latest &&
      (scene.revision < this.latest.revision || scene.at < this.latest.at)
    )
      return
    this.latest = scene
    if (
      this.output.kind === 'open' &&
      this.output.context.state === 'running' &&
      !this.muted &&
      this.volume > 0
    ) {
      try {
        this.render(scene)
      } catch (error) {
        this.fail(error)
      }
    }
  }

  private render(scene: AudioScene) {
    const output = this.output
    if (
      output.kind !== 'open' ||
      this.activity !== 'running' ||
      scene.epoch !== this.epoch ||
      this.muted ||
      this.volume === 0
    )
      return
    const now = output.context.currentTime
    const predicted = this.anchor
      ? this.anchor.game + (now - this.anchor.audio) * 1000
      : scene.at
    if (!this.anchor || Math.abs(predicted - scene.at) > 250)
      this.anchor = { game: scene.at, audio: now }
    const at = Math.max(
      scene.at,
      this.anchor.game + (now - this.anchor.audio) * 1000,
    )
    for (const [channel, effect] of output.effects) {
      const voice = scene.voices[channel]
      if (
        !voice ||
        voice.generation !== effect.generation ||
        voice.endsAt <= at
      )
        this.stopEffect(output, channel, effect)
    }
    for (const voice of scene.voices) {
      if (!voice || voice.endsAt <= at) continue
      let effect = output.effects.get(voice.channel)
      if (!effect) {
        const data = this.bank.samples.get(voice.sample)
        if (!data) throw new Error('Doom sound sample is unavailable.')
        let buffer = output.samples.get(voice.sample)
        if (!buffer) {
          buffer = output.context.createBuffer(1, data.bytes.length, data.rate)
          const pcm = buffer.getChannelData(0)
          const bytes = new DataView(
            data.bytes.buffer,
            data.bytes.byteOffset,
            data.bytes.byteLength,
          )
          for (let index = 0; index < data.bytes.length; index++)
            pcm[index] = (bytes.getUint8(index) - 128) / 128
          output.samples.set(voice.sample, buffer)
        }
        const source = output.context.createBufferSource()
        source.buffer = buffer
        const left = output.context.createGain()
        const right = output.context.createGain()
        const merger = output.context.createChannelMerger(2)
        source.connect(left)
        source.connect(right)
        left.connect(merger, 0, 0)
        right.connect(merger, 0, 1)
        merger.connect(output.master)
        effect = {
          generation: voice.generation,
          started: false,
          source,
          left,
          right,
          merger,
        }
        output.effects.set(voice.channel, effect)
        this.parameters(effect, voice, now)
        const started = effect
        source.onended = () => {
          if (output.effects.get(voice.channel) === started)
            this.stopEffect(output, voice.channel, started)
        }
        source.start(now, Math.max(0, at - voice.startedAt) / 1000)
        effect.started = true
      } else this.parameters(effect, voice, now)
    }
    output.music.reconcile(scene.music, at)
  }

  private parameters(effect: Effect, voice: SoundVoice, at: number) {
    const weights = stereoWeights(voice.volume, voice.separation)
    effect.left.gain.setValueAtTime(weights.left, at)
    effect.right.gain.setValueAtTime(weights.right, at)
  }
  private stopEffect(output: OpenAudio, channel: number, effect: Effect) {
    if (output.effects.get(channel) === effect) output.effects.delete(channel)
    effect.source.onended = null
    if (effect.started) effect.source.stop()
    effect.source.disconnect()
    effect.left.disconnect()
    effect.right.disconnect()
    effect.merger.disconnect()
  }
  private silence() {
    this.anchor = null
    const output = this.output
    if (output.kind !== 'open') return
    output.music.stop()
    for (const [channel, effect] of output.effects)
      this.stopEffect(output, channel, effect)
  }
  private suspend() {
    const output = this.output
    if (output.kind !== 'open' || output.context.state === 'closed') return
    const generation = this.generation
    void output.context.suspend().catch((error: unknown) => {
      if (this.output === output && generation === this.generation)
        this.fail(error)
    })
  }
  private fail(error: unknown) {
    if (this.output.kind === 'closed' || this.output.kind === 'unavailable')
      return
    const message =
      error instanceof Error
        ? error.message.slice(0, 200)
        : 'Hibi could not play Doom sound.'
    this.closeOutput()
    this.output = { kind: 'unavailable', message }
    this.changed(this.availability)
  }
  private closeOutput() {
    this.generation++
    this.latest = null
    this.silence()
    const output = this.output
    if (output.kind === 'open') {
      output.context.onstatechange = null
      output.music.dispose()
      output.master.disconnect()
      output.samples.clear()
      void output.context.close().catch(() => {})
    }
  }
  dispose() {
    if (this.output.kind === 'closed') return
    this.closeOutput()
    this.output = { kind: 'closed' }
  }
}
