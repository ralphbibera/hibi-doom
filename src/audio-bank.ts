// Copyright (C) 2026 Ralph Bibera. SPDX-License-Identifier: GPL-3.0-only
export interface PcmSample {
  name: string
  rate: number
  bytes: Uint8Array
  durationMs: number
}

export type MusEvent =
  | { kind: 'on'; tick: number; channel: number; key: number; velocity: number }
  | { kind: 'off'; tick: number; channel: number; key: number }
  | { kind: 'pitch'; tick: number; channel: number; bend: number }
  | {
      kind: 'control'
      tick: number
      channel: number
      control: number
      value: number
    }

export interface MusicScore {
  name: string
  bytes: Uint8Array
  events: MusEvent[]
  durationTicks: number
  durationMs: number
}

export interface Instrument {
  fixedKey: number | null
  transpose: number
  waveform: OscillatorType
  modulation: number
  multiplier: number
  attack: number
  sustain: number
  release: number
}

export interface AudioBank {
  samples: ReadonlyMap<number, PcmSample>
  scores: ReadonlyMap<number, MusicScore>
  instruments: readonly Instrument[]
}

export function parsePcm(bytes: Uint8Array, name = 'sound'): PcmSample {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 8 || data.getUint16(0, true) !== 3)
    throw new Error('Invalid Doom PCM header.')
  const rate = data.getUint16(2, true)
  const length = data.getUint32(4, true)
  if (
    (rate !== 11025 && rate !== 22050) ||
    length <= 48 ||
    length > bytes.length - 8
  )
    throw new Error('Invalid Doom PCM extent or rate.')
  const samples = bytes.slice(24, 8 + length - 16)
  return {
    name,
    rate,
    bytes: samples,
    durationMs: (samples.length * 1000) / rate,
  }
}

export function parseMus(bytes: Uint8Array, name = 'music'): MusicScore {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 16 || data.getUint32(0, true) !== 0x1a53554d)
    throw new Error('Invalid Doom MUS header.')
  const length = data.getUint16(4, true)
  const start = data.getUint16(6, true)
  const channels = data.getUint16(8, true)
  const instruments = data.getUint16(12, true)
  if (
    bytes.length > 65536 ||
    channels > 15 ||
    instruments > 256 ||
    start < 16 + instruments * 2 ||
    length === 0 ||
    start > bytes.length - length
  )
    throw new Error('Invalid Doom MUS extent.')
  let position = start
  let tick = 0
  const end = start + length
  const velocities = new Uint8Array(16).fill(127)
  const events: MusEvent[] = []
  const read = () => {
    if (position >= end) throw new Error('Truncated Doom MUS event.')
    return data.getUint8(position++)
  }
  while (position < end) {
    if (events.length >= 32768)
      throw new Error('Doom MUS exceeds its event limit.')
    const descriptor = read()
    const channel = descriptor & 15
    const kind = (descriptor >> 4) & 7
    switch (kind) {
      case 0:
        events.push({ kind: 'off', tick, channel, key: read() & 127 })
        break
      case 1: {
        const key = read()
        if (key & 128) velocities[channel] = read() & 127
        events.push({
          kind: 'on',
          tick,
          channel,
          key: key & 127,
          velocity: velocities.at(channel) ?? 127,
        })
        break
      }
      case 2:
        events.push({ kind: 'pitch', tick, channel, bend: (read() - 128) / 64 })
        break
      case 3: {
        const control = read()
        if (control < 10 || control > 14)
          throw new Error('Invalid Doom MUS system event.')
        events.push({ kind: 'control', tick, channel, control, value: 0 })
        break
      }
      case 4: {
        const control = read()
        const value = Math.min(127, read())
        if (control > 9) throw new Error('Invalid Doom MUS controller.')
        events.push({ kind: 'control', tick, channel, control, value })
        break
      }
      case 6:
        if (tick <= 0) throw new Error('Doom MUS has no positive duration.')
        return {
          name,
          bytes: bytes.slice(),
          events,
          durationTicks: tick,
          durationMs: (tick * 1000) / 140,
        }
      default:
        throw new Error('Unknown Doom MUS event.')
    }
    if (descriptor & 128) {
      let delay = 0
      for (let count = 0; ; count++) {
        if (count >= 4) throw new Error('Doom MUS delay exceeds its limit.')
        const byte = read()
        delay = delay * 128 + (byte & 127)
        if (!(byte & 128)) break
      }
      tick += delay
      if (tick > 140 * 60 * 10)
        throw new Error('Doom MUS exceeds its duration limit.')
    }
  }
  throw new Error('Doom MUS has no score-end event.')
}

function parseInstruments(bytes: Uint8Array): Instrument[] {
  if (
    bytes.length !== 11908 ||
    new TextDecoder().decode(bytes.subarray(0, 8)) !== '#OPL_II#'
  )
    throw new Error('Invalid Doom GENMIDI bank.')
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const waveforms: readonly OscillatorType[] = [
    'sine',
    'triangle',
    'sawtooth',
    'square',
  ]
  return Array.from({ length: 175 }, (_, index) => {
    const at = 8 + index * 36
    const modulator = at + 4
    const carrier = at + 11
    const attack = data.getUint8(carrier + 1) >> 4
    const envelope = data.getUint8(carrier + 2)
    const multiplier = data.getUint8(modulator) & 15
    return {
      fixedKey:
        data.getUint16(at, true) & 1 ? data.getUint8(at + 3) & 127 : null,
      transpose: data.getInt16(at + 18, true),
      waveform: waveforms[data.getUint8(carrier + 3) & 3] ?? 'sine',
      modulation: (63 - (data.getUint8(modulator + 5) & 63)) / 63,
      multiplier: multiplier === 0 ? 0.5 : Math.min(8, multiplier),
      attack: 0.003 + (15 - attack) * 0.003,
      sustain: Math.max(0.06, 1 - (envelope >> 4) / 15),
      release: 0.04 + (15 - (envelope & 15)) * 0.008,
    }
  })
}

export function parseAudioBank(iwad: Uint8Array): AudioBank {
  const data = new DataView(iwad.buffer, iwad.byteOffset, iwad.byteLength)
  if (iwad.length < 12 || data.getUint32(0, true) !== 0x44415749)
    throw new Error('Invalid Doom audio IWAD.')
  const count = data.getUint32(4, true)
  const directory = data.getUint32(8, true)
  if (count > 4096 || directory > iwad.length - count * 16)
    throw new Error('Invalid Doom audio lump directory.')
  const samples = new Map<number, PcmSample>()
  const scores = new Map<number, MusicScore>()
  let instruments: Instrument[] | null = null
  const text = new TextDecoder('ascii', { fatal: true })
  for (let lump = 0; lump < count; lump++) {
    const at = directory + lump * 16
    const offset = data.getUint32(at, true)
    const length = data.getUint32(at + 4, true)
    if (offset > iwad.length - length)
      throw new Error('Doom audio lump is outside its IWAD.')
    const name = text
      .decode(iwad.subarray(at + 8, at + 16))
      .replace(/\0.*$/, '')
      .toUpperCase()
    const bytes = iwad.subarray(offset, offset + length)
    if (name.startsWith('DS')) samples.set(lump, parsePcm(bytes, name))
    else if (name.startsWith('D_')) scores.set(lump, parseMus(bytes, name))
    else if (name === 'GENMIDI') instruments = parseInstruments(bytes)
  }
  if (samples.size !== 55 || scores.size !== 13 || !instruments)
    throw new Error('Doom audio bank is incomplete.')
  return { samples, scores, instruments }
}
