// Add test-only exports to retained named functions. Guest instruction bodies stay unchanged.
import { parse } from '../../src/vm.mjs'

function reader(bytes, start = 0, end = bytes.length) {
  let at = start
  return {
    get at() {
      return at
    },
    byte() {
      if (at >= end) throw new Error('Truncated diagnostic WASM section.')
      return bytes[at++]
    },
    u32() {
      let value = 0
      for (let shift = 0; shift <= 28; shift += 7) {
        const byte = this.byte()
        value += (byte & 127) * 2 ** shift
        if (!(byte & 128)) return value
      }
      throw new Error('Invalid diagnostic WASM integer.')
    },
    name() {
      const length = this.u32()
      if (at > end - length) throw new Error('Truncated diagnostic WASM name.')
      const name = new TextDecoder().decode(bytes.subarray(at, at + length))
      at += length
      return name
    },
  }
}
function u32(value) {
  const bytes = []
  do {
    const next = value & 127
    value = Math.floor(value / 128)
    bytes.push(next | (value ? 128 : 0))
  } while (value)
  return bytes
}
function name(value) {
  const bytes = new TextEncoder().encode(value)
  return [...u32(bytes.length), ...bytes]
}

export function guestFunctions(engine, requested) {
  const sections = []
  const functions = new Map()
  const bytes = reader(engine, 8)
  while (bytes.at < engine.length) {
    const id = bytes.byte()
    const length = bytes.u32()
    const at = bytes.at
    if (at > engine.length - length)
      throw new Error('Truncated diagnostic WASM binary.')
    const data = engine.subarray(at, at + length)
    sections.push({ id, data })
    if (id === 0) {
      const custom = reader(data)
      if (custom.name() === 'name') {
        while (custom.at < data.length) {
          const kind = custom.byte()
          const size = custom.u32()
          const start = custom.at
          if (kind === 1) {
            const names = reader(data, start, start + size)
            const count = names.u32()
            for (let index = 0; index < count; index++) {
              const functionIndex = names.u32()
              functions.set(names.name(), functionIndex)
            }
          }
          for (let index = 0; index < size; index++) custom.byte()
        }
      }
    }
    for (let index = 0; index < length; index++) bytes.byte()
  }
  const aliases = new Map()
  const module = parse(engine)
  for (const original of requested) {
    const index = functions.get(original)
    if (index === undefined || !module.functions[index])
      throw new Error(`Missing diagnostic guest function ${original}.`)
    aliases.set(`test_${original}`, { kind: 0, index })
  }
  const result = [engine.subarray(0, 8)]
  for (const section of sections) {
    let data = section.data
    if (section.id === 7) {
      const existing = reader(data)
      const count = existing.u32()
      const entries = []
      for (const [alias, value] of aliases)
        entries.push(...name(alias), 0, ...u32(value.index))
      data = new Uint8Array([
        ...u32(count + aliases.size),
        ...data.subarray(existing.at),
        ...entries,
      ])
    }
    result.push(new Uint8Array([section.id, ...u32(data.length)]), data)
  }
  const length = result.reduce((total, bytes) => total + bytes.length, 0)
  const exported = new Uint8Array(length)
  let position = 0
  for (const bytes of result) {
    exported.set(bytes, position)
    position += bytes.length
  }
  return {
    exported,
    install(machine) {
      for (const [name, value] of aliases)
        machine.module.exports.set(name, value)
    },
  }
}
