import pins from '../engine/pins.json' with { type: 'json' }
import { sha256 } from './bundle.ts'

export function parseEngineBytes(input: unknown): Uint8Array {
  if (
    !(input instanceof Uint8Array) ||
    input.byteLength !== pins.engine.bytes ||
    ![0, 97, 115, 109, 1, 0, 0, 0].every((byte, index) => input[index] === byte)
  )
    throw new Error('Invalid bundled Doom engine.')
  return input
}

export function parseIwadBytes(input: unknown): Uint8Array {
  if (
    !(input instanceof Uint8Array) ||
    input.byteLength !== pins.iwad.bytes ||
    new TextDecoder().decode(input.subarray(0, 4)) !== 'IWAD'
  )
    throw new Error('Invalid Doom shareware data.')
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength)
  const count = view.getInt32(4, true)
  const directory = view.getInt32(8, true)
  if (
    count !== 1264 ||
    directory < 12 ||
    directory > input.byteLength - count * 16
  )
    throw new Error('Invalid Doom IWAD directory.')
  const maps: string[] = []
  for (let index = 0; index < count; index++) {
    const offset = directory + index * 16
    const start = view.getInt32(offset, true)
    const bytes = view.getInt32(offset + 4, true)
    if (start < 0 || bytes < 0 || start > input.byteLength - bytes)
      throw new Error('Doom IWAD lump is outside its resource.')
    const name = new TextDecoder()
      .decode(input.subarray(offset + 8, offset + 16))
      .replace(/\0.*$/, '')
    if (/^E\dM\d$/.test(name)) maps.push(name)
  }
  if (maps.join(',') !== 'E1M1,E1M2,E1M3,E1M4,E1M5,E1M6,E1M7,E1M8,E1M9')
    throw new Error('Unsupported Doom shareware episode.')
  return input
}

export async function validateGame(engineInput: unknown, iwadInput: unknown) {
  const engine = Uint8Array.from(parseEngineBytes(engineInput))
  const iwad = Uint8Array.from(parseIwadBytes(iwadInput))
  if (
    (await sha256(engine)) !== pins.engine.sha256 ||
    (await sha256(iwad)) !== pins.iwad.sha256
  )
    throw new Error(
      'The installed Doom artifacts do not match. Reinstall the addon.',
    )
  return { engine, iwad }
}
