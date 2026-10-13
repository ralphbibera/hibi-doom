// Copyright (C) 2026 Ralph Bibera. SPDX-License-Identifier: GPL-3.0-only

import { parseAudioBank } from './audio-bank.ts'
import { type AudioScene, GameSound } from './audio-scene.ts'
import { frameBytes } from './model.ts'

type Descriptor =
  | { kind: 'log' | 'directory' }
  | { kind: 'iwad'; position: number }
const fileRights = (1n << 1n) | (1n << 2n) | (1n << 5n) | (1n << 21n)
const pathRights = 1n << 13n
const errno = {
  badf: 8,
  inval: 28,
  mfile: 33,
  noent: 44,
  notcapable: 76,
} as const

export function createWasiHost(
  iwad: Uint8Array,
  buffer: () => ArrayBuffer,
  clock: () => number,
  notify: (scene: AudioScene) => void = () => {},
) {
  const readClock = () => {
    const at = clock()
    if (!Number.isFinite(at) || at < 0)
      throw new Error('Invalid Doom active clock.')
    return at
  }
  const sound = new GameSound(parseAudioBank(iwad), readClock, notify)
  const descriptors = new Map<number, Descriptor>([
    [1, { kind: 'log' }],
    [2, { kind: 'log' }],
    [3, { kind: 'directory' }],
  ])
  const utf8 = new TextDecoder('utf-8', { fatal: true })
  let captured = false
  const indices = new Uint8Array(320 * 200)
  const palette = new Uint8Array(256 * 3)
  let sequence = 0
  let log = ''
  const bytes = () => new Uint8Array(buffer())
  const view = () => new DataView(buffer())
  const extent = (address: number, length: number) => {
    if (
      !Number.isInteger(address) ||
      !Number.isInteger(length) ||
      address < 0 ||
      length < 0 ||
      address > buffer().byteLength - length
    )
      throw new Error('Doom host-call extent is outside guest memory.')
    return bytes().subarray(address, address + length)
  }
  const u32 = (address: number, value: number) => {
    extent(address, 4)
    view().setUint32(address, value, true)
  }
  const u64 = (address: number, value: bigint) => {
    extent(address, 8)
    view().setBigUint64(address, value, true)
  }
  const vectors = (address: number, count: number) => {
    if (!Number.isInteger(count) || count < 0 || count > 64)
      throw new Error('Invalid Doom I/O vector count.')
    extent(address, count * 8)
    let total = 0
    const result: Uint8Array[] = []
    for (let index = 0; index < count; index++) {
      const start = view().getUint32(address + index * 8, true)
      const length = view().getUint32(address + index * 8 + 4, true)
      total += length
      if (total > 4 * 1024 * 1024)
        throw new Error('Doom I/O vectors exceed their byte limit.')
      result.push(extent(start, length))
    }
    return result
  }
  const deny = () => errno.notcapable
  const imports = {
    hibi: {
      clock_ms: () => {
        return readClock() | 0
      },
      sleep_ms: (milliseconds: number) => {
        if (
          !Number.isInteger(milliseconds) ||
          milliseconds < 0 ||
          milliseconds > 1000
        )
          throw new Error('Invalid Doom sleep duration.')
      },
      draw_indexed: (address: number, paletteAddress: number) => {
        const pixels = extent(address, indices.length)
        const colors = extent(paletteAddress, palette.length)
        indices.set(pixels)
        palette.set(colors)
        captured = true
        sequence++
      },
      sfx_start: (
        channel: number,
        sample: number,
        volume: number,
        separation: number,
      ) => sound.start(channel, sample, volume, separation),
      sfx_stop: (channel: number) => sound.stop(channel),
      sfx_params: (channel: number, volume: number, separation: number) =>
        sound.update(channel, volume, separation),
      sfx_playing: (channel: number) => sound.playing(channel),
      music_register: (address: number, length: number) => {
        if (length < 16 || length > 65536)
          throw new Error('Invalid Doom music registration extent.')
        return sound.register(extent(address, length))
      },
      music_unregister: (handle: number) => sound.unregister(handle),
      music_play: (handle: number, looping: number) =>
        sound.playMusic(handle, looping),
      music_stop: () => sound.stopMusic(),
      music_pause: () => sound.pauseMusic(),
      music_resume: () => sound.resumeMusic(),
      music_volume: (volume: number) => sound.volume(volume),
      music_playing: () => sound.musicPlaying(),
    },
    wasi_snapshot_preview1: {
      fd_close: (fd: number) => {
        if (descriptors.get(fd)?.kind !== 'iwad') return errno.badf
        descriptors.delete(fd)
        return 0
      },
      fd_fdstat_get: (fd: number, address: number) => {
        const descriptor = descriptors.get(fd)
        if (!descriptor) return errno.badf
        extent(address, 24).fill(0)
        bytes()[address] =
          descriptor.kind === 'directory'
            ? 3
            : descriptor.kind === 'iwad'
              ? 4
              : 2
        u64(
          address + 8,
          descriptor.kind === 'directory'
            ? pathRights
            : descriptor.kind === 'iwad'
              ? fileRights
              : 1n << 6n,
        )
        u64(address + 16, descriptor.kind === 'directory' ? fileRights : 0n)
        return 0
      },
      fd_fdstat_set_flags: (fd: number, flags: number) =>
        descriptors.has(fd) && flags === 0 ? 0 : errno.notcapable,
      fd_prestat_get: (fd: number, address: number) => {
        if (fd !== 3) return errno.badf
        extent(address, 8).fill(0)
        u32(address + 4, 1)
        return 0
      },
      fd_prestat_dir_name: (fd: number, address: number, length: number) => {
        if (fd !== 3) return errno.badf
        if (length !== 1) return errno.inval
        extent(address, 1)[0] = 47
        return 0
      },
      path_open: (
        fd: number,
        lookup: number,
        address: number,
        length: number,
        oflags: number,
        rights: bigint,
        inheriting: bigint,
        flags: number,
        result: number,
      ) => {
        if (!Number.isInteger(length) || length < 0 || length > 128)
          throw new Error('Doom path exceeds its byte limit.')
        const name = utf8.decode(extent(address, length))
        if (fd !== 3 || name !== 'doom1.wad') return errno.noent
        if (
          oflags !== 0 ||
          flags !== 0 ||
          (lookup !== 0 && lookup !== 1) ||
          (rights & ~fileRights) !== 0n ||
          (inheriting & ~fileRights) !== 0n
        )
          return errno.notcapable
        extent(result, 4)
        for (let next = 4; next <= 31; next++) {
          if (descriptors.has(next)) continue
          u32(result, next)
          descriptors.set(next, { kind: 'iwad', position: 0 })
          return 0
        }
        return errno.mfile
      },
      fd_read: (fd: number, address: number, count: number, result: number) => {
        const descriptor = descriptors.get(fd)
        if (descriptor?.kind !== 'iwad') return errno.badf
        const destinations = vectors(address, count)
        extent(result, 4)
        let read = 0
        for (const destination of destinations) {
          const length = Math.min(
            destination.length,
            iwad.length - descriptor.position,
          )
          destination.set(
            iwad.subarray(descriptor.position, descriptor.position + length),
          )
          descriptor.position += length
          read += length
        }
        u32(result, read)
        return 0
      },
      fd_seek: (fd: number, offset: bigint, whence: number, result: number) => {
        const descriptor = descriptors.get(fd)
        if (descriptor?.kind !== 'iwad') return errno.badf
        if (whence < 0 || whence > 2) return errno.inval
        const start =
          whence === 0 ? 0 : whence === 1 ? descriptor.position : iwad.length
        const next = BigInt(start) + offset
        if (next < 0n || next > BigInt(iwad.length)) return errno.inval
        u64(result, next)
        descriptor.position = Number(next)
        return 0
      },
      fd_write: (
        fd: number,
        address: number,
        count: number,
        result: number,
      ) => {
        if (descriptors.get(fd)?.kind !== 'log') return errno.notcapable
        const sources = vectors(address, count)
        extent(result, 4)
        let written = 0
        for (const source of sources) {
          if (source.length > 65536)
            throw new Error('Doom log entry exceeds its byte limit.')
          if (log.length < 65536)
            log = (log + utf8.decode(source)).slice(0, 65536)
          written += source.length
        }
        u32(result, written)
        return 0
      },
      path_create_directory: deny,
      path_remove_directory: deny,
      path_rename: deny,
      path_unlink_file: deny,
      proc_exit: (code: number): never => {
        throw new Error(`Doom exited with status ${code}.`)
      },
    },
  }
  return {
    imports,
    sound,
    get sequence() {
      return sequence
    },
    get log() {
      return log
    },
    frame(after = 0) {
      if (!Number.isSafeInteger(after) || after < 0 || after > sequence)
        throw new Error('Invalid Doom frame cursor.')
      if (!captured || after === sequence) return null
      const pixels = new Uint8Array(frameBytes)
      const indexView = new DataView(indices.buffer)
      const colorView = new DataView(palette.buffer)
      for (let y = 0; y < 200; y++) {
        let output = y * 2 * 640 * 4
        for (let x = 0; x < 320; x++) {
          const color = indexView.getUint8(y * 320 + x) * 3
          for (let duplicate = 0; duplicate < 2; duplicate++) {
            pixels[output++] = colorView.getUint8(color)
            pixels[output++] = colorView.getUint8(color + 1)
            pixels[output++] = colorView.getUint8(color + 2)
            pixels[output++] = 255
          }
        }
        pixels.copyWithin(output, output - 640 * 4, output)
      }
      return { sequence, width: 640 as const, height: 400 as const, pixels }
    },
  }
}
