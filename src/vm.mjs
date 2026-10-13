// Copyright (C) 2026 Ralph Bibera. SPDX-License-Identifier: GPL-3.0-only
const PAGE = 65536
const VALUE_TYPES = new Set([0x7f, 0x7e, 0x7d, 0x7c, 0x70])

class Reader {
  constructor(bytes, begin = 0, end = bytes.length) {
    this.bytes = bytes
    this.at = begin
    this.end = end
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  byte() {
    if (this.at >= this.end) throw new Error('Truncated WASM binary')
    return this.bytes[this.at++]
  }
  u32() {
    let value = 0,
      shift = 0
    for (let i = 0; i < 5; i++) {
      const b = this.byte()
      value += (b & 127) * 2 ** shift
      if (!(b & 128)) {
        if (value > 0xffffffff) throw new Error('Invalid u32 LEB')
        return value
      }
      shift += 7
    }
    throw new Error('Oversize u32 LEB')
  }
  signed(bits) {
    let value = 0n,
      shift = 0n,
      b
    do {
      b = this.byte()
      value |= BigInt(b & 127) << shift
      shift += 7n
      if (shift > BigInt(bits + 6)) throw new Error('Oversize signed LEB')
    } while (b & 128)
    if (b & 64) value -= 1n << shift
    return bits === 64
      ? BigInt.asIntN(64, value)
      : Number(BigInt.asIntN(bits, value))
  }
  bytesOf(n) {
    if (n > this.end - this.at) throw new Error('Truncated WASM extent')
    const value = this.bytes.subarray(this.at, this.at + n)
    this.at += n
    return value
  }
  name() {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      this.bytesOf(this.u32()),
    )
  }
  f32() {
    const at = this.at
    this.bytesOf(4)
    return this.view.getFloat32(at, true)
  }
  f64() {
    const at = this.at
    this.bytesOf(8)
    return this.view.getFloat64(at, true)
  }
}

function valueType(r) {
  const type = r.byte()
  if (!VALUE_TYPES.has(type))
    throw new Error(`Unsupported value type 0x${type.toString(16)}`)
  return type
}
function vector(r, read) {
  const n = r.u32()
  if (n > 1000000) throw new Error('WASM vector too large')
  return Array.from({ length: n }, () => read(r))
}
function limits(r) {
  const flags = r.u32()
  if (flags > 1) throw new Error('Shared/memory64 limits unsupported')
  const initial = r.u32()
  return { initial, maximum: flags ? r.u32() : null }
}
function initializer(r, globals) {
  let value
  switch (r.byte()) {
    case 0x41:
      value = r.signed(32)
      break
    case 0x42:
      value = r.signed(64)
      break
    case 0x43:
      value = r.f32()
      break
    case 0x44:
      value = r.f64()
      break
    case 0x23:
      value = globals[r.u32()]?.value
      if (value === undefined) throw new Error('Unknown initializer global')
      break
    case 0xd0:
      valueType(r)
      value = null
      break
    case 0xd2:
      value = r.u32()
      break
    default:
      throw new Error('Unsupported initializer expression')
  }
  if (r.byte() !== 0x0b) throw new Error('Extended initializer unsupported')
  return value
}

function decodeFunction(r, signature, types, functionIndex, counts) {
  const localTypes = []
  for (const group of vector(r, (r) => ({ n: r.u32(), type: valueType(r) }))) {
    if (group.n > 1000000 - localTypes.length)
      throw new Error('Too many locals')
    for (let i = 0; i < group.n; i++) localTypes.push(group.type)
  }
  const opcodes = [],
    immediates = []
  const labels = [
    {
      id: 0,
      kind: 0,
      entry: -1,
      exit: -1,
      inputs: 0,
      outputs: signature.results.length,
    },
  ]
  const active = [labels[0]]
  function target(depth) {
    const label = active[active.length - 1 - depth]
    if (!label) throw new Error('Invalid branch depth')
    return label
  }
  while (r.at < r.end) {
    const byteOffset = r.at,
      op = r.byte(),
      pc = opcodes.length
    opcodes.push(op)
    immediates.push(0)
    counts[op] = (counts[op] || 0) + 1
    let immediate = 0
    switch (op) {
      case 0x02:
      case 0x03:
      case 0x04: {
        const first = r.bytes[r.at]
        let inputs = 0,
          outputs = 0
        if (first === 0x40) r.byte()
        else if (VALUE_TYPES.has(first)) {
          valueType(r)
          outputs = 1
        } else {
          const type = types[r.signed(33)]
          if (!type) throw new Error('Unknown block type')
          inputs = type.parameters.length
          outputs = type.results.length
        }
        const label = {
          id: labels.length,
          kind: op,
          entry: pc,
          exit: -1,
          otherwise: -1,
          inputs,
          outputs,
        }
        labels.push(label)
        active.push(label)
        immediate = label
        break
      }
      case 0x05: {
        const label = active.at(-1)
        if (label.kind !== 0x04 || label.otherwise !== -1)
          throw new Error('Invalid else')
        label.otherwise = pc
        immediate = label
        break
      }
      case 0x0b: {
        const label = active.pop()
        if (!label) throw new Error('Unexpected end')
        label.exit = pc
        immediate = label
        if (!active.length && r.at !== r.end)
          throw new Error('Trailing function instructions')
        break
      }
      case 0x0c:
      case 0x0d:
        immediate = target(r.u32())
        break
      case 0x0e:
        immediate = {
          cases: vector(r, (r) => target(r.u32())),
          fallback: target(r.u32()),
        }
        break
      case 0x10:
      case 0x20:
      case 0x21:
      case 0x22:
      case 0x23:
      case 0x24:
      case 0x25:
      case 0x26:
      case 0xd2:
        immediate = r.u32()
        break
      case 0x11:
        immediate = { type: r.u32(), table: r.u32() }
        break
      case 0x1c:
        immediate = vector(r, valueType)
        break
      case 0x28:
      case 0x29:
      case 0x2a:
      case 0x2b:
      case 0x2c:
      case 0x2d:
      case 0x2e:
      case 0x2f:
      case 0x30:
      case 0x31:
      case 0x32:
      case 0x33:
      case 0x34:
      case 0x35:
      case 0x36:
      case 0x37:
      case 0x38:
      case 0x39:
      case 0x3a:
      case 0x3b:
      case 0x3c:
      case 0x3d:
      case 0x3e:
        r.u32()
        immediate = r.u32()
        break
      case 0x3f:
      case 0x40:
        immediate = r.u32()
        if (immediate !== 0) throw new Error('Multiple memories unsupported')
        break
      case 0x41:
        immediate = r.signed(32)
        break
      case 0x42:
        immediate = r.signed(64)
        break
      case 0x43:
        immediate = r.f32()
        break
      case 0x44:
        immediate = r.f64()
        break
      case 0xd0:
        immediate = valueType(r)
        break
      case 0xfc: {
        const sub = r.u32()
        immediate = { sub }
        if (sub === 8) {
          immediate.data = r.u32()
          immediate.memory = r.u32()
        } else if (sub === 9) immediate.data = r.u32()
        else if (sub === 10) {
          immediate.destination = r.u32()
          immediate.source = r.u32()
        } else if (sub === 11) immediate.memory = r.u32()
        else if (sub > 7)
          throw new Error(
            `Unsupported prefixed opcode 0xfc/${sub} in function ${functionIndex} at ${byteOffset}`,
          )
        break
      }
      case 0x00:
      case 0x01:
      case 0x0f:
      case 0x1a:
      case 0x1b:
      case 0xd1:
        break
      default:
        if (op < 0x45 || op > 0xc4)
          throw new Error(
            `Unsupported opcode 0x${op.toString(16)} in function ${functionIndex} at ${byteOffset}`,
          )
    }
    immediates[pc] = immediate
  }
  if (active.length) throw new Error('Unclosed function labels')
  return {
    signature,
    localTypes,
    opcodes: Uint16Array.from(opcodes),
    immediates,
    labels,
  }
}

export function parse(bytes) {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length < 8 ||
    bytes.length > 16 * 1024 * 1024
  )
    throw new Error('Invalid runtime byte extent')
  const r = new Reader(bytes)
  if (
    r.byte() !== 0 ||
    r.byte() !== 0x61 ||
    r.byte() !== 0x73 ||
    r.byte() !== 0x6d ||
    r.byte() !== 1 ||
    r.byte() !== 0 ||
    r.byte() !== 0 ||
    r.byte() !== 0
  )
    throw new Error('Invalid WASM header')
  const module = {
    types: [],
    functions: [],
    memories: [],
    tables: [],
    globals: [],
    exports: new Map(),
    elements: [],
    data: [],
    start: null,
    opcodeCounts: {},
  }
  let declared = [],
    defined = 0
  while (r.at < r.end) {
    const id = r.byte(),
      size = r.u32(),
      content = new Reader(bytes, r.at, r.at + size)
    if (size > r.end - r.at) throw new Error('Invalid WASM section extent')
    r.at += size
    switch (id) {
      case 0:
        content.at = content.end
        break
      case 1:
        module.types = vector(content, (r) => {
          if (r.byte() !== 0x60) throw new Error('Unsupported signature')
          return {
            parameters: vector(r, valueType),
            results: vector(r, valueType),
          }
        })
        break
      case 2:
        vector(content, (r) => {
          const namespace = r.name(),
            name = r.name(),
            kind = r.byte()
          if (kind === 0) {
            const typeIndex = r.u32(),
              signature = module.types[typeIndex]
            if (!signature) throw new Error('Unknown import signature')
            module.functions.push({
              namespace,
              name,
              signature,
              imported: true,
            })
          } else if (kind === 1)
            module.tables.push({
              namespace,
              name,
              element: valueType(r),
              ...limits(r),
            })
          else if (kind === 2)
            module.memories.push({ namespace, name, ...limits(r) })
          else if (kind === 3) throw new Error('Imported globals unsupported')
          else throw new Error('Invalid WASM import')
        })
        break
      case 3:
        declared = vector(content, (r) => r.u32())
        break
      case 4:
        module.tables.push(
          ...vector(content, (r) => ({ element: valueType(r), ...limits(r) })),
        )
        break
      case 5:
        module.memories.push(...vector(content, limits))
        break
      case 6:
        vector(content, (r) => {
          const type = valueType(r),
            mutable = r.byte()
          if (mutable > 1) throw new Error('Invalid global mutability')
          const value = initializer(r, module.globals)
          module.globals.push({ type, mutable, value })
        })
        break
      case 7:
        vector(content, (r) => {
          const name = r.name(),
            kind = r.byte(),
            index = r.u32()
          if (module.exports.has(name)) throw new Error('Duplicate export')
          module.exports.set(name, { kind, index })
        })
        break
      case 8:
        module.start = content.u32()
        break
      case 9:
        vector(content, (r) => {
          const flags = r.u32()
          if (flags !== 0 && flags !== 2)
            throw new Error(`Unsupported element segment mode ${flags}`)
          const table = flags === 2 ? r.u32() : 0,
            offset = initializer(r, module.globals)
          if (flags === 2 && r.byte() !== 0)
            throw new Error('Unsupported element kind')
          module.elements.push({
            table,
            offset,
            functions: vector(r, (r) => r.u32()),
          })
        })
        break
      case 10: {
        const count = content.u32()
        if (count !== declared.length)
          throw new Error('Function/code count mismatch')
        for (let i = 0; i < count; i++) {
          const extent = content.u32(),
            body = new Reader(bytes, content.at, content.at + extent)
          if (extent > content.end - content.at)
            throw new Error('Invalid function extent')
          content.at += extent
          const signature = module.types[declared[i]]
          if (!signature) throw new Error('Unknown function signature')
          module.functions.push(
            decodeFunction(
              body,
              signature,
              module.types,
              module.functions.length,
              module.opcodeCounts,
            ),
          )
          defined++
        }
        break
      }
      case 11:
        vector(content, (r) => {
          const flags = r.u32()
          if (flags > 2)
            throw new Error(`Unsupported data segment mode ${flags}`)
          const memory = flags === 2 ? r.u32() : 0,
            offset = flags === 1 ? null : initializer(r, module.globals),
            data = r.bytesOf(r.u32())
          module.data.push({ memory, offset, bytes: data })
        })
        break
      case 12:
        content.u32()
        break
      default:
        throw new Error(`Unsupported section ${id}`)
    }
    if (content.at !== content.end)
      throw new Error(`Trailing section ${id} bytes`)
  }
  if (defined !== declared.length || module.memories.length !== 1)
    throw new Error('Unsupported memory/function shape')
  return module
}

function nearest(value) {
  if (!Number.isFinite(value) || value === 0) return value
  const lower = Math.floor(value),
    fraction = value - lower
  const rounded =
    fraction < 0.5
      ? lower
      : fraction > 0.5
        ? lower + 1
        : lower % 2 === 0
          ? lower
          : lower + 1
  return rounded === 0 && value < 0 ? -0 : rounded
}
function truncInteger(value, bits, unsigned, saturating = false) {
  const n = Math.trunc(value),
    lower = unsigned ? 0 : -(2 ** (bits - 1)),
    upper = unsigned ? 2 ** bits : 2 ** (bits - 1)
  if (Number.isNaN(n) || n < lower || n >= upper) {
    if (!saturating) throw new Error('WASM invalid float-to-integer conversion')
    if (Number.isNaN(n)) return bits === 64 ? 0n : 0
    if (bits === 64)
      return n < lower
        ? unsigned
          ? 0n
          : -(1n << 63n)
        : unsigned
          ? -1n
          : (1n << 63n) - 1n
    return n < lower ? (unsigned ? 0 : -2147483648) : unsigned ? -1 : 2147483647
  }
  return bits === 64 ? BigInt.asIntN(64, BigInt(n)) : n | 0
}
function population(value) {
  value -= (value >>> 1) & 0x55555555
  value = (value & 0x33333333) + ((value >>> 2) & 0x33333333)
  return (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
}
function trailing32(value) {
  return value === 0 ? 32 : 31 - Math.clz32((value & -value) >>> 0)
}
function count64(value, mode) {
  let n = BigInt.asUintN(64, value)
  if (!n) return mode === 2 ? 0n : 64n
  if (mode === 0) return BigInt(64 - n.toString(2).length)
  let count = 0n
  if (mode === 1)
    while (!(n & 1n)) {
      count++
      n >>= 1n
    }
  else
    while (n) {
      count++
      n &= n - 1n
    }
  return count
}

export class Machine {
  constructor(module, imports, initialPages, maxPages) {
    this.module = module
    this.imports = imports
    this.maximum = maxPages
    const limits = module.memories[0]
    if (
      limits.initial > initialPages ||
      (limits.maximum !== null && initialPages > limits.maximum)
    )
      throw new Error('Imported memory limits mismatch')
    this.buffer = new ArrayBuffer(initialPages * PAGE)
    this.refreshViews()
    this.tables = module.tables.map((table) => {
      if (table.namespace || table.element !== 0x70 || table.initial > 1000000)
        throw new Error('Unsupported table shape')
      return new Array(table.initial).fill(null)
    })
    for (const element of module.elements) {
      const table = this.tables[element.table]
      if (
        !table ||
        element.offset < 0 ||
        element.offset + element.functions.length > table.length
      )
        throw new Error('Element extent out of bounds')
      for (let i = 0; i < element.functions.length; i++)
        table[element.offset + i] = element.functions[i]
    }
    for (const data of module.data)
      if (data.offset !== null) {
        if (
          data.memory !== 0 ||
          data.offset < 0 ||
          data.offset + data.bytes.length > this.bytes.length
        )
          throw new Error('Data extent out of bounds')
        this.bytes.set(data.bytes, data.offset)
      }
    for (const fn of module.functions)
      if (fn.imported && typeof imports[fn.namespace]?.[fn.name] !== 'function')
        throw new Error(`Missing import ${fn.namespace}.${fn.name}`)
    this.operand = []
    this.frames = []
    this.framePool = []
    this.instructions = 0
    this.calls = 0
    this.maxDepth = 0
    this.reinterpret = new DataView(new ArrayBuffer(8))
  }
  refreshViews() {
    this.bytes = new Uint8Array(this.buffer)
    this.view = new DataView(this.buffer)
  }
  callExport(name, parameters = []) {
    const exported = this.module.exports.get(name)
    if (exported?.kind !== 0) throw new Error(`Missing function export ${name}`)
    return this.execute(exported.index, parameters)
  }
  execute(index, parameters) {
    if (this.frames.length) throw new Error('Reentrant interpreter invocation')
    const functions = this.module.functions,
      stack = this.operand,
      frames = this.frames,
      globals = this.module.globals
    let sp = 0,
      frame,
      code,
      args,
      locals,
      pc = 0,
      instructions = 0
    const enter = (index, parameterBase) => {
      const fn = functions[index]
      if (!fn) throw new Error(`Unknown function ${index}`)
      this.calls++
      if (fn.imported) {
        const values = stack.slice(parameterBase, sp)
        sp = parameterBase
        const result = this.imports[fn.namespace][fn.name](...values)
        if (fn.signature.results.length === 1)
          stack[sp++] = fn.signature.results[0] === 0x7f ? result | 0 : result
        else if (fn.signature.results.length > 1)
          for (const value of result) stack[sp++] = value
        return false
      }
      const depth = frames.length
      let next = this.framePool[depth]
      if (!next) {
        next = { locals: [], labelBases: [] }
        this.framePool[depth] = next
      }
      next.fn = fn
      next.index = index
      next.pc = 0
      next.base = parameterBase
      for (let i = 0; i < fn.signature.parameters.length; i++)
        next.locals[i] = stack[parameterBase + i]
      for (let i = 0; i < fn.localTypes.length; i++)
        next.locals[fn.signature.parameters.length + i] =
          fn.localTypes[i] === 0x7e ? 0n : fn.localTypes[i] === 0x70 ? null : 0
      next.labelBases[0] = parameterBase
      sp = parameterBase
      frames.push(next)
      frame = next
      code = fn.opcodes
      args = fn.immediates
      locals = next.locals
      pc = 0
      if (frames.length > this.maxDepth) this.maxDepth = frames.length
      return true
    }
    const leave = () => {
      const count = frame.fn.signature.results.length,
        base = frame.base
      for (let i = 0; i < count; i++) stack[base + i] = stack[sp - count + i]
      sp = base + count
      frames.pop()
      frame = frames.at(-1)
      if (frame) {
        code = frame.fn.opcodes
        args = frame.fn.immediates
        locals = frame.locals
        pc = frame.pc
      }
    }
    const branch = (label) => {
      const count = label.kind === 0x03 ? label.inputs : label.outputs,
        base = frame.labelBases[label.id]
      for (let i = 0; i < count; i++) stack[base + i] = stack[sp - count + i]
      sp = base + count
      pc =
        label.kind === 0x03
          ? label.entry
          : label.id === 0
            ? label.exit
            : label.exit + 1
    }
    for (const value of parameters) stack[sp++] = value
    const entry = functions[index]
    if (!entry || parameters.length !== entry.signature.parameters.length)
      throw new Error('Invocation arity mismatch')
    try {
      enter(index, 0)
      while (frames.length) {
        const op = code[pc],
          immediate = args[pc++]
        instructions++
        let a, b, c, address, target
        switch (op) {
          case 0x00:
            throw new Error(
              `WASM unreachable in function ${frame.index} at ${pc - 1}`,
            )
          case 0x01:
            break
          case 0x02:
          case 0x03:
            frame.labelBases[immediate.id] = sp - immediate.inputs
            break
          case 0x04:
            c = stack[--sp]
            frame.labelBases[immediate.id] = sp - immediate.inputs
            if (!c)
              pc =
                immediate.otherwise < 0
                  ? immediate.exit
                  : immediate.otherwise + 1
            break
          case 0x05:
            pc = immediate.exit
            break
          case 0x0b:
            if (immediate.id === 0) leave()
            else {
              c = immediate.outputs
              a = frame.labelBases[immediate.id]
              for (let i = 0; i < c; i++) stack[a + i] = stack[sp - c + i]
              sp = a + c
            }
            break
          case 0x0c:
            branch(immediate)
            break
          case 0x0d:
            if (stack[--sp]) branch(immediate)
            break
          case 0x0e:
            a = stack[--sp] >>> 0
            branch(immediate.cases[a] || immediate.fallback)
            break
          case 0x0f:
            leave()
            break
          case 0x10:
            frame.pc = pc
            enter(
              immediate,
              sp - functions[immediate].signature.parameters.length,
            )
            break
          case 0x11: {
            a = stack[--sp] >>> 0
            target = this.tables[immediate.table]?.[a]
            if (target === null || target === undefined)
              throw new Error('WASM null/out-of-bounds indirect call')
            const actual = functions[target].signature,
              expected = this.module.types[immediate.type]
            if (
              !expected ||
              actual.parameters.length !== expected.parameters.length ||
              actual.results.length !== expected.results.length ||
              actual.parameters.some(
                (type, i) => type !== expected.parameters[i],
              ) ||
              actual.results.some((type, i) => type !== expected.results[i])
            )
              throw new Error('WASM indirect call signature mismatch')
            frame.pc = pc
            enter(target, sp - actual.parameters.length)
            break
          }
          case 0x1a:
            sp--
            break
          case 0x1b:
          case 0x1c:
            c = stack[--sp]
            b = stack[--sp]
            if (!c) stack[sp - 1] = b
            break
          case 0x20:
            stack[sp++] = locals[immediate]
            break
          case 0x21:
            locals[immediate] = stack[--sp]
            break
          case 0x22:
            locals[immediate] = stack[sp - 1]
            break
          case 0x23:
            stack[sp++] = globals[immediate].value
            break
          case 0x24:
            globals[immediate].value = stack[--sp]
            break
          case 0x25:
            a = stack[--sp] >>> 0
            if (a >= this.tables[immediate].length)
              throw new Error('Table index out of bounds')
            stack[sp++] = this.tables[immediate][a]
            break
          case 0x26:
            b = stack[--sp]
            a = stack[--sp] >>> 0
            if (a >= this.tables[immediate].length)
              throw new Error('Table index out of bounds')
            this.tables[immediate][a] = b
            break
          case 0x28:
            address = (stack[sp - 1] >>> 0) + immediate
            stack[sp - 1] = this.view.getInt32(address, true)
            break
          case 0x29:
            address = (stack[sp - 1] >>> 0) + immediate
            stack[sp - 1] = this.view.getBigInt64(address, true)
            break
          case 0x2a:
            address = (stack[sp - 1] >>> 0) + immediate
            stack[sp - 1] = this.view.getFloat32(address, true)
            break
          case 0x2b:
            address = (stack[sp - 1] >>> 0) + immediate
            stack[sp - 1] = this.view.getFloat64(address, true)
            break
          case 0x2c:
            address = (stack[sp - 1] >>> 0) + immediate
            stack[sp - 1] = this.view.getInt8(address)
            break
          case 0x2d:
            address = (stack[sp - 1] >>> 0) + immediate
            stack[sp - 1] = this.view.getUint8(address)
            break
          case 0x2e:
            address = (stack[sp - 1] >>> 0) + immediate
            stack[sp - 1] = this.view.getInt16(address, true)
            break
          case 0x2f:
            address = (stack[sp - 1] >>> 0) + immediate
            stack[sp - 1] = this.view.getUint16(address, true)
            break
          case 0x30:
            address = (stack[sp - 1] >>> 0) + immediate
            stack[sp - 1] = BigInt(this.view.getInt8(address))
            break
          case 0x31:
            address = (stack[sp - 1] >>> 0) + immediate
            stack[sp - 1] = BigInt(this.view.getUint8(address))
            break
          case 0x32:
            address = (stack[sp - 1] >>> 0) + immediate
            stack[sp - 1] = BigInt(this.view.getInt16(address, true))
            break
          case 0x33:
            address = (stack[sp - 1] >>> 0) + immediate
            stack[sp - 1] = BigInt(this.view.getUint16(address, true))
            break
          case 0x34:
            address = (stack[sp - 1] >>> 0) + immediate
            stack[sp - 1] = BigInt(this.view.getInt32(address, true))
            break
          case 0x35:
            address = (stack[sp - 1] >>> 0) + immediate
            stack[sp - 1] = BigInt(this.view.getUint32(address, true))
            break
          case 0x36:
            b = stack[--sp]
            address = (stack[--sp] >>> 0) + immediate
            this.view.setInt32(address, b, true)
            break
          case 0x37:
            b = stack[--sp]
            address = (stack[--sp] >>> 0) + immediate
            this.view.setBigInt64(address, b, true)
            break
          case 0x38:
            b = stack[--sp]
            address = (stack[--sp] >>> 0) + immediate
            this.view.setFloat32(address, b, true)
            break
          case 0x39:
            b = stack[--sp]
            address = (stack[--sp] >>> 0) + immediate
            this.view.setFloat64(address, b, true)
            break
          case 0x3a:
            b = stack[--sp]
            address = (stack[--sp] >>> 0) + immediate
            this.view.setInt8(address, b)
            break
          case 0x3b:
            b = stack[--sp]
            address = (stack[--sp] >>> 0) + immediate
            this.view.setInt16(address, b, true)
            break
          case 0x3c:
            b = stack[--sp]
            address = (stack[--sp] >>> 0) + immediate
            this.view.setInt8(address, Number(BigInt.asIntN(8, b)))
            break
          case 0x3d:
            b = stack[--sp]
            address = (stack[--sp] >>> 0) + immediate
            this.view.setInt16(address, Number(BigInt.asIntN(16, b)), true)
            break
          case 0x3e:
            b = stack[--sp]
            address = (stack[--sp] >>> 0) + immediate
            this.view.setInt32(address, Number(BigInt.asIntN(32, b)), true)
            break
          case 0x3f:
            stack[sp++] = this.buffer.byteLength / PAGE
            break
          case 0x40: {
            a = stack[sp - 1] >>> 0
            b = this.buffer.byteLength / PAGE
            if (a > this.maximum - b) stack[sp - 1] = -1
            else {
              const previous = this.bytes
              try {
                this.buffer = new ArrayBuffer((b + a) * PAGE)
                this.refreshViews()
                this.bytes.set(previous)
                stack[sp - 1] = b
              } catch {
                stack[sp - 1] = -1
              }
            }
            break
          }
          case 0x41:
          case 0x42:
          case 0x43:
          case 0x44:
            stack[sp++] = immediate
            break
          case 0x45:
            stack[sp - 1] = +(stack[sp - 1] === 0)
            break
          case 0x46:
            b = stack[--sp]
            stack[sp - 1] = +(stack[sp - 1] === b)
            break
          case 0x47:
            b = stack[--sp]
            stack[sp - 1] = +(stack[sp - 1] !== b)
            break
          case 0x48:
            b = stack[--sp]
            stack[sp - 1] = +(stack[sp - 1] < b)
            break
          case 0x49:
            b = stack[--sp] >>> 0
            stack[sp - 1] = +(stack[sp - 1] >>> 0 < b)
            break
          case 0x4a:
            b = stack[--sp]
            stack[sp - 1] = +(stack[sp - 1] > b)
            break
          case 0x4b:
            b = stack[--sp] >>> 0
            stack[sp - 1] = +(stack[sp - 1] >>> 0 > b)
            break
          case 0x4c:
            b = stack[--sp]
            stack[sp - 1] = +(stack[sp - 1] <= b)
            break
          case 0x4d:
            b = stack[--sp] >>> 0
            stack[sp - 1] = +(stack[sp - 1] >>> 0 <= b)
            break
          case 0x4e:
            b = stack[--sp]
            stack[sp - 1] = +(stack[sp - 1] >= b)
            break
          case 0x4f:
            b = stack[--sp] >>> 0
            stack[sp - 1] = +(stack[sp - 1] >>> 0 >= b)
            break
          case 0x50:
            stack[sp - 1] = +(stack[sp - 1] === 0n)
            break
          case 0x51:
            b = stack[--sp]
            stack[sp - 1] = +(stack[sp - 1] === b)
            break
          case 0x52:
            b = stack[--sp]
            stack[sp - 1] = +(stack[sp - 1] !== b)
            break
          case 0x53:
            b = stack[--sp]
            stack[sp - 1] = +(stack[sp - 1] < b)
            break
          case 0x54:
            b = BigInt.asUintN(64, stack[--sp])
            stack[sp - 1] = +(BigInt.asUintN(64, stack[sp - 1]) < b)
            break
          case 0x55:
            b = stack[--sp]
            stack[sp - 1] = +(stack[sp - 1] > b)
            break
          case 0x56:
            b = BigInt.asUintN(64, stack[--sp])
            stack[sp - 1] = +(BigInt.asUintN(64, stack[sp - 1]) > b)
            break
          case 0x57:
            b = stack[--sp]
            stack[sp - 1] = +(stack[sp - 1] <= b)
            break
          case 0x58:
            b = BigInt.asUintN(64, stack[--sp])
            stack[sp - 1] = +(BigInt.asUintN(64, stack[sp - 1]) <= b)
            break
          case 0x59:
            b = stack[--sp]
            stack[sp - 1] = +(stack[sp - 1] >= b)
            break
          case 0x5a:
            b = BigInt.asUintN(64, stack[--sp])
            stack[sp - 1] = +(BigInt.asUintN(64, stack[sp - 1]) >= b)
            break
          case 0x5b:
          case 0x61:
            b = stack[--sp]
            stack[sp - 1] = +(stack[sp - 1] === b)
            break
          case 0x5c:
          case 0x62:
            b = stack[--sp]
            stack[sp - 1] = +(stack[sp - 1] !== b)
            break
          case 0x5d:
          case 0x63:
            b = stack[--sp]
            stack[sp - 1] = +(stack[sp - 1] < b)
            break
          case 0x5e:
          case 0x64:
            b = stack[--sp]
            stack[sp - 1] = +(stack[sp - 1] > b)
            break
          case 0x5f:
          case 0x65:
            b = stack[--sp]
            stack[sp - 1] = +(stack[sp - 1] <= b)
            break
          case 0x60:
          case 0x66:
            b = stack[--sp]
            stack[sp - 1] = +(stack[sp - 1] >= b)
            break
          case 0x67:
            stack[sp - 1] = Math.clz32(stack[sp - 1])
            break
          case 0x68:
            stack[sp - 1] = trailing32(stack[sp - 1])
            break
          case 0x69:
            stack[sp - 1] = population(stack[sp - 1])
            break
          case 0x6a:
            b = stack[--sp]
            stack[sp - 1] = (stack[sp - 1] + b) | 0
            break
          case 0x6b:
            b = stack[--sp]
            stack[sp - 1] = (stack[sp - 1] - b) | 0
            break
          case 0x6c:
            b = stack[--sp]
            stack[sp - 1] = Math.imul(stack[sp - 1], b)
            break
          case 0x6d:
            b = stack[--sp]
            a = stack[sp - 1]
            if (!b || (a === -2147483648 && b === -1))
              throw new Error('WASM integer division trap')
            stack[sp - 1] = (a / b) | 0
            break
          case 0x6e:
            b = stack[--sp] >>> 0
            if (!b) throw new Error('WASM divide by zero')
            stack[sp - 1] = ((stack[sp - 1] >>> 0) / b) | 0
            break
          case 0x6f:
            b = stack[--sp]
            if (!b) throw new Error('WASM remainder by zero')
            stack[sp - 1] = (stack[sp - 1] % b) | 0
            break
          case 0x70:
            b = stack[--sp] >>> 0
            if (!b) throw new Error('WASM remainder by zero')
            stack[sp - 1] = ((stack[sp - 1] >>> 0) % b) | 0
            break
          case 0x71:
            b = stack[--sp]
            stack[sp - 1] &= b
            break
          case 0x72:
            b = stack[--sp]
            stack[sp - 1] |= b
            break
          case 0x73:
            b = stack[--sp]
            stack[sp - 1] ^= b
            break
          case 0x74:
            b = stack[--sp]
            stack[sp - 1] <<= b
            break
          case 0x75:
            b = stack[--sp]
            stack[sp - 1] >>= b
            break
          case 0x76:
            b = stack[--sp]
            stack[sp - 1] = (stack[sp - 1] >>> b) | 0
            break
          case 0x77:
            b = stack[--sp]
            a = stack[sp - 1]
            stack[sp - 1] = (a << b) | (a >>> (32 - (b & 31)))
            break
          case 0x78:
            b = stack[--sp]
            a = stack[sp - 1]
            stack[sp - 1] = (a >>> b) | (a << (32 - (b & 31)))
            break
          case 0x79:
          case 0x7a:
          case 0x7b:
            stack[sp - 1] = count64(stack[sp - 1], op - 0x79)
            break
          case 0x7c:
            b = stack[--sp]
            stack[sp - 1] = BigInt.asIntN(64, stack[sp - 1] + b)
            break
          case 0x7d:
            b = stack[--sp]
            stack[sp - 1] = BigInt.asIntN(64, stack[sp - 1] - b)
            break
          case 0x7e:
            b = stack[--sp]
            stack[sp - 1] = BigInt.asIntN(64, stack[sp - 1] * b)
            break
          case 0x7f:
            b = stack[--sp]
            a = stack[sp - 1]
            if (!b || (a === -(1n << 63n) && b === -1n))
              throw new Error('WASM integer division trap')
            stack[sp - 1] = a / b
            break
          case 0x80:
            b = BigInt.asUintN(64, stack[--sp])
            if (!b) throw new Error('WASM divide by zero')
            stack[sp - 1] = BigInt.asIntN(
              64,
              BigInt.asUintN(64, stack[sp - 1]) / b,
            )
            break
          case 0x81:
            b = stack[--sp]
            if (!b) throw new Error('WASM remainder by zero')
            stack[sp - 1] %= b
            break
          case 0x82:
            b = BigInt.asUintN(64, stack[--sp])
            if (!b) throw new Error('WASM remainder by zero')
            stack[sp - 1] = BigInt.asIntN(
              64,
              BigInt.asUintN(64, stack[sp - 1]) % b,
            )
            break
          case 0x83:
            b = stack[--sp]
            stack[sp - 1] &= b
            break
          case 0x84:
            b = stack[--sp]
            stack[sp - 1] |= b
            break
          case 0x85:
            b = stack[--sp]
            stack[sp - 1] ^= b
            break
          case 0x86:
            b = stack[--sp] & 63n
            stack[sp - 1] = BigInt.asIntN(64, stack[sp - 1] << b)
            break
          case 0x87:
            b = stack[--sp] & 63n
            stack[sp - 1] >>= b
            break
          case 0x88:
            b = stack[--sp] & 63n
            stack[sp - 1] = BigInt.asIntN(
              64,
              BigInt.asUintN(64, stack[sp - 1]) >> b,
            )
            break
          case 0x89:
            b = stack[--sp] & 63n
            a = BigInt.asUintN(64, stack[sp - 1])
            stack[sp - 1] = BigInt.asIntN(64, (a << b) | (a >> (64n - b)))
            break
          case 0x8a:
            b = stack[--sp] & 63n
            a = BigInt.asUintN(64, stack[sp - 1])
            stack[sp - 1] = BigInt.asIntN(64, (a >> b) | (a << (64n - b)))
            break
          case 0x8b:
            stack[sp - 1] = Math.abs(stack[sp - 1])
            break
          case 0x8c:
            stack[sp - 1] = -stack[sp - 1]
            break
          case 0x8d:
            stack[sp - 1] = Math.fround(Math.ceil(stack[sp - 1]))
            break
          case 0x8e:
            stack[sp - 1] = Math.fround(Math.floor(stack[sp - 1]))
            break
          case 0x8f:
            stack[sp - 1] = Math.fround(Math.trunc(stack[sp - 1]))
            break
          case 0x90:
            stack[sp - 1] = Math.fround(nearest(stack[sp - 1]))
            break
          case 0x91:
            stack[sp - 1] = Math.fround(Math.sqrt(stack[sp - 1]))
            break
          case 0x92:
            b = stack[--sp]
            stack[sp - 1] = Math.fround(stack[sp - 1] + b)
            break
          case 0x93:
            b = stack[--sp]
            stack[sp - 1] = Math.fround(stack[sp - 1] - b)
            break
          case 0x94:
            b = stack[--sp]
            stack[sp - 1] = Math.fround(stack[sp - 1] * b)
            break
          case 0x95:
            b = stack[--sp]
            stack[sp - 1] = Math.fround(stack[sp - 1] / b)
            break
          case 0x96:
            b = stack[--sp]
            stack[sp - 1] = Math.min(stack[sp - 1], b)
            break
          case 0x97:
            b = stack[--sp]
            stack[sp - 1] = Math.max(stack[sp - 1], b)
            break
          case 0x98:
            b = stack[--sp]
            a = Math.abs(stack[sp - 1])
            stack[sp - 1] = b < 0 || Object.is(b, -0) ? -a : a
            break
          case 0x99:
            stack[sp - 1] = Math.abs(stack[sp - 1])
            break
          case 0x9a:
            stack[sp - 1] = -stack[sp - 1]
            break
          case 0x9b:
            stack[sp - 1] = Math.ceil(stack[sp - 1])
            break
          case 0x9c:
            stack[sp - 1] = Math.floor(stack[sp - 1])
            break
          case 0x9d:
            stack[sp - 1] = Math.trunc(stack[sp - 1])
            break
          case 0x9e:
            stack[sp - 1] = nearest(stack[sp - 1])
            break
          case 0x9f:
            stack[sp - 1] = Math.sqrt(stack[sp - 1])
            break
          case 0xa0:
            b = stack[--sp]
            stack[sp - 1] += b
            break
          case 0xa1:
            b = stack[--sp]
            stack[sp - 1] -= b
            break
          case 0xa2:
            b = stack[--sp]
            stack[sp - 1] *= b
            break
          case 0xa3:
            b = stack[--sp]
            stack[sp - 1] /= b
            break
          case 0xa4:
            b = stack[--sp]
            stack[sp - 1] = Math.min(stack[sp - 1], b)
            break
          case 0xa5:
            b = stack[--sp]
            stack[sp - 1] = Math.max(stack[sp - 1], b)
            break
          case 0xa6:
            b = stack[--sp]
            a = Math.abs(stack[sp - 1])
            stack[sp - 1] = b < 0 || Object.is(b, -0) ? -a : a
            break
          case 0xa7:
            stack[sp - 1] = Number(BigInt.asIntN(32, stack[sp - 1]))
            break
          case 0xa8:
          case 0xaa:
            stack[sp - 1] = truncInteger(stack[sp - 1], 32, false)
            break
          case 0xa9:
          case 0xab:
            stack[sp - 1] = truncInteger(stack[sp - 1], 32, true)
            break
          case 0xac:
            stack[sp - 1] = BigInt(stack[sp - 1])
            break
          case 0xad:
            stack[sp - 1] = BigInt(stack[sp - 1] >>> 0)
            break
          case 0xae:
          case 0xb0:
            stack[sp - 1] = truncInteger(stack[sp - 1], 64, false)
            break
          case 0xaf:
          case 0xb1:
            stack[sp - 1] = truncInteger(stack[sp - 1], 64, true)
            break
          case 0xb2:
            stack[sp - 1] = Math.fround(stack[sp - 1])
            break
          case 0xb3:
            stack[sp - 1] = Math.fround(stack[sp - 1] >>> 0)
            break
          case 0xb4:
            stack[sp - 1] = Math.fround(Number(stack[sp - 1]))
            break
          case 0xb5:
            stack[sp - 1] = Math.fround(
              Number(BigInt.asUintN(64, stack[sp - 1])),
            )
            break
          case 0xb6:
            stack[sp - 1] = Math.fround(stack[sp - 1])
            break
          case 0xb7:
            break
          case 0xb8:
            stack[sp - 1] >>>= 0
            break
          case 0xb9:
            stack[sp - 1] = Number(stack[sp - 1])
            break
          case 0xba:
            stack[sp - 1] = Number(BigInt.asUintN(64, stack[sp - 1]))
            break
          case 0xbb:
            break
          case 0xbc:
            this.reinterpret.setFloat32(0, stack[sp - 1], true)
            stack[sp - 1] = this.reinterpret.getInt32(0, true)
            break
          case 0xbd:
            this.reinterpret.setFloat64(0, stack[sp - 1], true)
            stack[sp - 1] = this.reinterpret.getBigInt64(0, true)
            break
          case 0xbe:
            this.reinterpret.setInt32(0, stack[sp - 1], true)
            stack[sp - 1] = this.reinterpret.getFloat32(0, true)
            break
          case 0xbf:
            this.reinterpret.setBigInt64(0, stack[sp - 1], true)
            stack[sp - 1] = this.reinterpret.getFloat64(0, true)
            break
          case 0xc0:
            stack[sp - 1] = (stack[sp - 1] << 24) >> 24
            break
          case 0xc1:
            stack[sp - 1] = (stack[sp - 1] << 16) >> 16
            break
          case 0xc2:
            stack[sp - 1] = BigInt.asIntN(8, stack[sp - 1])
            break
          case 0xc3:
            stack[sp - 1] = BigInt.asIntN(16, stack[sp - 1])
            break
          case 0xc4:
            stack[sp - 1] = BigInt.asIntN(32, stack[sp - 1])
            break
          case 0xd0:
            stack[sp++] = null
            break
          case 0xd1:
            stack[sp - 1] = +(stack[sp - 1] === null)
            break
          case 0xd2:
            stack[sp++] = immediate
            break
          case 0xfc: {
            if (immediate.sub <= 7) {
              stack[sp - 1] = truncInteger(
                stack[sp - 1],
                immediate.sub < 4 ? 32 : 64,
                !!(immediate.sub & 1),
                true,
              )
              break
            }
            if (immediate.sub === 9) {
              this.module.data[immediate.data].bytes = new Uint8Array()
              break
            }
            c = stack[--sp] >>> 0
            b = stack[--sp] >>> 0
            a = stack[--sp] >>> 0
            if (a + c > this.bytes.length)
              throw new Error('WASM bulk destination out of bounds')
            if (immediate.sub === 8) {
              const data = this.module.data[immediate.data].bytes
              if (immediate.memory !== 0 || b + c > data.length)
                throw new Error('WASM bulk data out of bounds')
              this.bytes.set(data.subarray(b, b + c), a)
            } else if (immediate.sub === 10) {
              if (
                immediate.destination !== 0 ||
                immediate.source !== 0 ||
                b + c > this.bytes.length
              )
                throw new Error('WASM bulk source out of bounds')
              this.bytes.copyWithin(a, b, b + c)
            } else {
              if (immediate.memory !== 0)
                throw new Error('Multiple memories unsupported')
              this.bytes.fill(b & 255, a, a + c)
            }
            break
          }
          default:
            throw new Error(
              `Unsupported execution opcode ${op} at ${frame.index}/${pc - 1}`,
            )
        }
      }
      return entry.signature.results.length ? stack.slice(0, sp) : []
    } catch (error) {
      const context = frame
        ? ` [function ${frame.index}, instruction ${pc - 1}, depth ${frames.length}]`
        : ''
      throw new Error(`${error.message}${context}`, { cause: error })
    } finally {
      this.instructions += instructions
      frames.length = 0
      stack.length = 0
    }
  }
}
