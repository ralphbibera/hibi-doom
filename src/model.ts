export const width = 640
export const height = 400
export const frameBytes = width * height * 4
export const actions = [
  'forward',
  'backward',
  'turnLeft',
  'turnRight',
  'strafeLeft',
  'strafeRight',
  'fire',
  'use',
  'run',
  'enter',
  'escape',
  'map',
] as const
export type Action = (typeof actions)[number]
export type Activity = 'running' | 'paused'
type FrameState = {
  sequence: number
  elapsedMs: number
  gameTics: number
  audio: AudioScene
}
export type FrameUpdate = FrameState &
  (
    | {
        kind: 'frame'
        width: 640
        height: 400
        pixels: Uint8Array
      }
    | { kind: 'unchanged' | 'paused' }
  )
export type WorkerCommand =
  | { id: number; kind: 'startup'; engine: Uint8Array; iwad: Uint8Array }
  | { id: number; kind: 'activity'; activity: Activity; epoch: number }
  | {
      id: number
      kind: 'frame'
      activity: Activity
      epoch: number
      turn: number
      held: Action[]
      taps: Action[]
      after: number
    }
export type WorkerRequest =
  | { kind: 'startup'; engine: Uint8Array; iwad: Uint8Array }
  | { kind: 'activity'; activity: Activity; epoch: number }
  | {
      kind: 'frame'
      activity: Activity
      epoch: number
      turn: number
      held: Action[]
      taps: Action[]
      after: number
    }
export type WorkerReply =
  | { id: number; kind: 'ready'; engine: 'doom' }
  | { id: number; kind: 'activity'; activity: Activity; epoch: number }
  | { id: number; kind: 'update'; update: FrameUpdate }
  | { id: number; kind: 'error'; message: string }
export interface AudioNotice {
  kind: 'audio'
  audio: AudioScene
}
export type WorkerMessage = WorkerReply | AudioNotice

function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid Doom payload.')
  return input as Record<string, unknown>
}
function fields(value: Record<string, unknown>, names: string[]) {
  if (
    Object.keys(value).length !== names.length ||
    names.some((name) => !Object.hasOwn(value, name))
  )
    throw new Error('Unexpected Doom payload fields.')
}
function integer(input: unknown): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0)
    throw new Error('Invalid Doom frame cursor.')
  return input
}
function requestId(input: unknown): number {
  const id = integer(input)
  if (id === 0) throw new Error('Invalid Doom worker request.')
  return id
}
function activity(input: unknown): Activity {
  if (input !== 'running' && input !== 'paused')
    throw new Error('Invalid Doom activity.')
  return input
}
function actionList(input: unknown): Action[] {
  if (
    !Array.isArray(input) ||
    input.length > actions.length ||
    new Set(input).size !== input.length
  )
    throw new Error('Invalid Doom actions.')
  return input.map((action: unknown) => {
    const found = actions.find((known) => known === action)
    if (!found) throw new Error('Unknown Doom action.')
    return found
  })
}
export function parseFrameUpdate(input: unknown): FrameUpdate {
  const value = object(input)
  const sequence = integer(value.sequence)
  const elapsedMs = integer(value.elapsedMs)
  const gameTics = integer(value.gameTics)
  const audio = parseAudioScene(value.audio)
  if (value.kind === 'unchanged' || value.kind === 'paused') {
    fields(value, ['kind', 'sequence', 'elapsedMs', 'gameTics', 'audio'])
    return { kind: value.kind, sequence, elapsedMs, gameTics, audio }
  }
  fields(value, [
    'kind',
    'sequence',
    'elapsedMs',
    'gameTics',
    'audio',
    'width',
    'height',
    'pixels',
  ])
  if (
    value.kind !== 'frame' ||
    value.width !== width ||
    value.height !== height ||
    !(value.pixels instanceof Uint8Array) ||
    value.pixels.byteLength !== frameBytes
  )
    throw new Error('Invalid Doom RGBA frame.')
  return {
    kind: 'frame',
    sequence,
    elapsedMs,
    gameTics,
    audio,
    width,
    height,
    pixels: value.pixels,
  }
}
export function parseWorkerCommand(input: unknown): WorkerCommand {
  const value = object(input)
  const id = requestId(value.id)
  switch (value.kind) {
    case 'startup':
      fields(value, ['id', 'kind', 'engine', 'iwad'])
      if (
        !(value.engine instanceof Uint8Array) ||
        value.engine.byteLength > 1024 * 1024 ||
        !(value.iwad instanceof Uint8Array) ||
        value.iwad.byteLength !== 4196020
      )
        throw new Error('Invalid bundled Doom startup bytes.')
      return { id, kind: 'startup', engine: value.engine, iwad: value.iwad }
    case 'activity':
      fields(value, ['id', 'kind', 'activity', 'epoch'])
      return {
        id,
        kind: 'activity',
        activity: activity(value.activity),
        epoch: integer(value.epoch),
      }
    case 'frame':
      fields(value, [
        'id',
        'kind',
        'activity',
        'held',
        'taps',
        'after',
        'epoch',
        'turn',
      ])
      if (
        typeof value.turn !== 'number' ||
        !Number.isInteger(value.turn) ||
        Math.abs(value.turn) > 2048
      )
        throw new Error('Invalid Doom mouse motion.')
      return {
        id,
        kind: 'frame',
        activity: activity(value.activity),
        epoch: integer(value.epoch),
        turn: value.turn,
        held: actionList(value.held),
        taps: actionList(value.taps),
        after: integer(value.after),
      }
    default:
      throw new Error('Unknown Doom worker operation.')
  }
}
export function parseWorkerReply(input: unknown): WorkerReply {
  const value = object(input)
  const id = requestId(value.id)
  switch (value.kind) {
    case 'ready':
      fields(value, ['id', 'kind', 'engine'])
      if (value.engine !== 'doom')
        throw new Error('Invalid Doom worker readiness.')
      return { id, kind: 'ready', engine: 'doom' }
    case 'activity':
      fields(value, ['id', 'kind', 'activity', 'epoch'])
      return {
        id,
        kind: 'activity',
        activity: activity(value.activity),
        epoch: integer(value.epoch),
      }
    case 'update':
      fields(value, ['id', 'kind', 'update'])
      return { id, kind: 'update', update: parseFrameUpdate(value.update) }
    case 'error':
      fields(value, ['id', 'kind', 'message'])
      if (
        typeof value.message !== 'string' ||
        value.message.length === 0 ||
        value.message.length > 500
      )
        throw new Error('Invalid Doom worker failure.')
      return { id, kind: 'error', message: value.message }
    default:
      throw new Error('Invalid Doom worker reply.')
  }
}

export function parseAudioNotice(input: unknown): AudioNotice | null {
  if (
    !input ||
    typeof input !== 'object' ||
    !('kind' in input) ||
    input.kind !== 'audio'
  )
    return null
  const value = object(input)
  fields(value, ['kind', 'audio'])
  return { kind: 'audio', audio: parseAudioScene(value.audio) }
}

import { type AudioScene, parseAudioScene } from './audio-scene.ts'
