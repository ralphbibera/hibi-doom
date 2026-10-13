// Copyright (C) 2026 Ralph Bibera. SPDX-License-Identifier: GPL-3.0-only
import type { AudioBank } from './audio-bank.ts'

export interface SoundVoice {
  channel: number
  generation: number
  sample: number
  startedAt: number
  endsAt: number
  volume: number
  separation: number
}
export type MusicScene =
  | { kind: 'stopped' }
  | {
      kind: 'playing' | 'paused'
      generation: number
      score: number
      anchorAt: number
      offsetMs: number
      looping: boolean
      volume: number
    }
export interface AudioScene {
  epoch: number
  revision: number
  at: number
  voices: (SoundVoice | null)[]
  music: MusicScene
}
export const audioNotificationBudget = 256

function record(
  raw: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(raw, field))
  )
    throw new Error('Invalid Doom audio scene fields.')
  return raw as Record<string, unknown>
}
function number(
  raw: unknown,
  limit = Number.MAX_SAFE_INTEGER,
  integral = true,
): number {
  if (
    typeof raw !== 'number' ||
    !Number.isFinite(raw) ||
    raw < 0 ||
    raw > limit ||
    (integral && !Number.isSafeInteger(raw))
  )
    throw new Error('Invalid Doom audio scene value.')
  return raw
}
export function parseAudioScene(raw: unknown): AudioScene {
  const value = record(raw, ['epoch', 'revision', 'at', 'voices', 'music'])
  const epoch = number(value.epoch)
  const revision = number(value.revision)
  const at = number(value.at, Number.MAX_SAFE_INTEGER, false)
  if (!Array.isArray(value.voices) || value.voices.length !== 8)
    throw new Error('Invalid Doom sound channels.')
  const voices = value.voices.map((raw: unknown, channel) => {
    if (raw === null) return null
    const voice = record(raw, [
      'channel',
      'generation',
      'sample',
      'startedAt',
      'endsAt',
      'volume',
      'separation',
    ])
    if (voice.channel !== channel)
      throw new Error('Invalid Doom sound channel order.')
    const startedAt = number(voice.startedAt, Number.MAX_SAFE_INTEGER, false)
    const endsAt = number(voice.endsAt, Number.MAX_SAFE_INTEGER, false)
    const generation = number(voice.generation)
    if (
      generation === 0 ||
      endsAt <= startedAt ||
      endsAt - startedAt > 60000 ||
      startedAt > at
    )
      throw new Error('Invalid Doom sound deadline.')
    return {
      channel,
      generation,
      sample: number(voice.sample, 4095),
      startedAt,
      endsAt,
      volume: number(voice.volume, 127),
      separation: number(voice.separation, 254),
    }
  })
  let music: MusicScene
  if (
    value.music &&
    typeof value.music === 'object' &&
    'kind' in value.music &&
    value.music.kind === 'stopped'
  ) {
    record(value.music, ['kind'])
    music = { kind: 'stopped' }
  } else {
    const state = record(value.music, [
      'kind',
      'generation',
      'score',
      'anchorAt',
      'offsetMs',
      'looping',
      'volume',
    ])
    if (
      (state.kind !== 'playing' && state.kind !== 'paused') ||
      typeof state.looping !== 'boolean'
    )
      throw new Error('Invalid Doom music activity.')
    const generation = number(state.generation)
    const anchorAt = number(state.anchorAt, Number.MAX_SAFE_INTEGER, false)
    if (generation === 0 || anchorAt > at)
      throw new Error('Invalid Doom music anchor.')
    music = {
      kind: state.kind,
      generation,
      score: number(state.score, 4095),
      anchorAt,
      offsetMs: number(state.offsetMs, Number.MAX_SAFE_INTEGER, false),
      looping: state.looping,
      volume: number(state.volume, 127),
    }
  }
  return { epoch, revision, at, voices, music }
}

export function musicPosition(
  music: Exclude<MusicScene, { kind: 'stopped' }>,
  at: number,
) {
  return (
    music.offsetMs +
    (music.kind === 'playing' ? Math.max(0, at - music.anchorAt) : 0)
  )
}

export class GameSound {
  private voices: (SoundVoice | null)[] = Array.from({ length: 8 }, () => null)
  private music: MusicScene = { kind: 'stopped' }
  private registered = new Map<number, number>()
  private revision = 0
  private generation = 0
  private epoch = 0
  private musicVolume = 127
  private publications = 0
  private bank: AudioBank
  private clock: () => number
  private notify: (scene: AudioScene) => void

  constructor(
    bank: AudioBank,
    clock: () => number,
    notify: (scene: AudioScene) => void,
  ) {
    this.bank = bank
    this.clock = clock
    this.notify = notify
  }

  beginStep() {
    this.publications = 0
  }
  setEpoch(epoch: number) {
    this.epoch = epoch
  }

  private publish() {
    if (++this.publications > audioNotificationBudget)
      throw new Error('Doom exceeded its sound notification budget.')
    this.notify(this.scene())
  }

  scene(): AudioScene {
    const at = this.clock()
    for (let channel = 0; channel < 8; channel++) {
      const voice = this.voices[channel]
      if (voice && voice.endsAt <= at) {
        this.voices[channel] = null
        this.revision++
      }
    }
    const music = this.music
    if (music.kind === 'playing' && !music.looping) {
      const score = this.bank.scores.get(music.score)
      if (score && musicPosition(music, at) >= score.durationMs) {
        this.music = { kind: 'stopped' }
        this.revision++
      }
    }
    return {
      epoch: this.epoch,
      revision: this.revision,
      at,
      voices: this.voices.map((voice) => (voice ? { ...voice } : null)),
      music: { ...this.music },
    }
  }

  private channel(channel: number) {
    if (!Number.isInteger(channel) || channel < 0 || channel >= 8)
      throw new Error('Invalid Doom sound channel.')
  }
  private parameters(volume: number, separation: number) {
    if (
      !Number.isInteger(volume) ||
      volume < 0 ||
      volume > 127 ||
      !Number.isInteger(separation) ||
      separation < 0 ||
      separation > 254
    )
      throw new Error('Invalid Doom sound parameters.')
  }

  start(channel: number, sample: number, volume: number, separation: number) {
    this.channel(channel)
    this.parameters(volume, separation)
    const data = this.bank.samples.get(sample)
    if (!data) throw new Error('Doom requested an unknown PCM sample.')
    const at = this.clock()
    this.voices[channel] = {
      channel,
      generation: ++this.generation,
      sample,
      startedAt: at,
      endsAt: at + data.durationMs,
      volume,
      separation,
    }
    this.revision++
    this.publish()
    return channel
  }

  stop(channel: number) {
    this.channel(channel)
    if (!this.voices[channel]) return
    this.voices[channel] = null
    this.revision++
    this.publish()
  }

  update(channel: number, volume: number, separation: number) {
    this.channel(channel)
    this.parameters(volume, separation)
    const voice = this.voices[channel]
    if (voice && (voice.volume !== volume || voice.separation !== separation)) {
      voice.volume = volume
      voice.separation = separation
      this.revision++
    }
  }

  playing(channel: number) {
    this.channel(channel)
    const voice = this.voices[channel]
    return voice && voice.endsAt > this.clock() ? 1 : 0
  }

  register(bytes: Uint8Array) {
    for (const [score, data] of this.bank.scores) {
      if (
        data.bytes.length === bytes.length &&
        data.bytes.every((byte, index) => byte === bytes[index])
      ) {
        const handle = score + 1
        this.registered.set(handle, score)
        return handle
      }
    }
    throw new Error('Doom registered an unknown MUS score.')
  }

  unregister(handle: number) {
    const score = this.registered.get(handle)
    if (score === undefined) throw new Error('Invalid Doom music registration.')
    if (this.music.kind !== 'stopped' && this.music.score === score)
      this.stopMusic()
    this.registered.delete(handle)
  }

  playMusic(handle: number, looping: number) {
    const score = this.registered.get(handle)
    if (score === undefined || (looping !== 0 && looping !== 1))
      throw new Error('Invalid Doom music playback.')
    this.music = {
      kind: 'playing',
      generation: ++this.generation,
      score,
      anchorAt: this.clock(),
      offsetMs: 0,
      looping: looping === 1,
      volume: this.musicVolume,
    }
    this.revision++
    this.publish()
  }

  stopMusic() {
    if (this.music.kind === 'stopped') return
    this.music = { kind: 'stopped' }
    this.revision++
    this.publish()
  }

  pauseMusic() {
    if (this.music.kind !== 'playing') return
    const at = this.clock()
    this.music = {
      ...this.music,
      kind: 'paused',
      offsetMs: musicPosition(this.music, at),
      anchorAt: at,
    }
    this.revision++
    this.publish()
  }

  resumeMusic() {
    if (this.music.kind !== 'paused') return
    this.music = { ...this.music, kind: 'playing', anchorAt: this.clock() }
    this.revision++
    this.publish()
  }

  volume(volume: number) {
    this.parameters(volume, 127)
    this.musicVolume = volume
    if (this.music.kind !== 'stopped' && this.music.volume !== volume) {
      this.music = { ...this.music, volume }
      this.revision++
    }
  }

  musicPlaying() {
    return this.scene().music.kind === 'stopped' ? 0 : 1
  }
}
