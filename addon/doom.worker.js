// src/clock.ts
var ActiveClock = class {
  elapsed = 0;
  activeAt = null;
  now;
  constructor(now = () => performance.now()) {
    this.now = now;
  }
  read = () => this.elapsed + (this.activeAt === null ? 0 : Math.max(0, this.now() - this.activeAt));
  set(activity2) {
    if (activity2 === "running") {
      if (this.activeAt === null) this.activeAt = this.now();
    } else if (this.activeAt !== null) {
      this.elapsed = this.read();
      this.activeAt = null;
    }
  }
};

// src/vm.mjs
var PAGE = 65536;
var VALUE_TYPES = /* @__PURE__ */ new Set([127, 126, 125, 124, 112]);
var Reader = class {
  constructor(bytes, begin = 0, end = bytes.length) {
    this.bytes = bytes;
    this.at = begin;
    this.end = end;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  byte() {
    if (this.at >= this.end) throw new Error("Truncated WASM binary");
    return this.bytes[this.at++];
  }
  u32() {
    let value = 0, shift = 0;
    for (let i = 0; i < 5; i++) {
      const b = this.byte();
      value += (b & 127) * 2 ** shift;
      if (!(b & 128)) {
        if (value > 4294967295) throw new Error("Invalid u32 LEB");
        return value;
      }
      shift += 7;
    }
    throw new Error("Oversize u32 LEB");
  }
  signed(bits) {
    let value = 0n, shift = 0n, b;
    do {
      b = this.byte();
      value |= BigInt(b & 127) << shift;
      shift += 7n;
      if (shift > BigInt(bits + 6)) throw new Error("Oversize signed LEB");
    } while (b & 128);
    if (b & 64) value -= 1n << shift;
    return bits === 64 ? BigInt.asIntN(64, value) : Number(BigInt.asIntN(bits, value));
  }
  bytesOf(n) {
    if (n > this.end - this.at) throw new Error("Truncated WASM extent");
    const value = this.bytes.subarray(this.at, this.at + n);
    this.at += n;
    return value;
  }
  name() {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      this.bytesOf(this.u32())
    );
  }
  f32() {
    const at = this.at;
    this.bytesOf(4);
    return this.view.getFloat32(at, true);
  }
  f64() {
    const at = this.at;
    this.bytesOf(8);
    return this.view.getFloat64(at, true);
  }
};
function valueType(r) {
  const type = r.byte();
  if (!VALUE_TYPES.has(type))
    throw new Error(`Unsupported value type 0x${type.toString(16)}`);
  return type;
}
function vector(r, read) {
  const n = r.u32();
  if (n > 1e6) throw new Error("WASM vector too large");
  return Array.from({ length: n }, () => read(r));
}
function limits(r) {
  const flags = r.u32();
  if (flags > 1) throw new Error("Shared/memory64 limits unsupported");
  const initial = r.u32();
  return { initial, maximum: flags ? r.u32() : null };
}
function initializer(r, globals) {
  let value;
  switch (r.byte()) {
    case 65:
      value = r.signed(32);
      break;
    case 66:
      value = r.signed(64);
      break;
    case 67:
      value = r.f32();
      break;
    case 68:
      value = r.f64();
      break;
    case 35:
      value = globals[r.u32()]?.value;
      if (value === void 0) throw new Error("Unknown initializer global");
      break;
    case 208:
      valueType(r);
      value = null;
      break;
    case 210:
      value = r.u32();
      break;
    default:
      throw new Error("Unsupported initializer expression");
  }
  if (r.byte() !== 11) throw new Error("Extended initializer unsupported");
  return value;
}
function decodeFunction(r, signature, types, functionIndex, counts) {
  const localTypes = [];
  for (const group of vector(r, (r2) => ({ n: r2.u32(), type: valueType(r2) }))) {
    if (group.n > 1e6 - localTypes.length)
      throw new Error("Too many locals");
    for (let i = 0; i < group.n; i++) localTypes.push(group.type);
  }
  const opcodes = [], immediates = [];
  const labels = [
    {
      id: 0,
      kind: 0,
      entry: -1,
      exit: -1,
      inputs: 0,
      outputs: signature.results.length
    }
  ];
  const active = [labels[0]];
  function target(depth) {
    const label = active[active.length - 1 - depth];
    if (!label) throw new Error("Invalid branch depth");
    return label;
  }
  while (r.at < r.end) {
    const byteOffset = r.at, op = r.byte(), pc = opcodes.length;
    opcodes.push(op);
    immediates.push(0);
    counts[op] = (counts[op] || 0) + 1;
    let immediate = 0;
    switch (op) {
      case 2:
      case 3:
      case 4: {
        const first = r.bytes[r.at];
        let inputs = 0, outputs = 0;
        if (first === 64) r.byte();
        else if (VALUE_TYPES.has(first)) {
          valueType(r);
          outputs = 1;
        } else {
          const type = types[r.signed(33)];
          if (!type) throw new Error("Unknown block type");
          inputs = type.parameters.length;
          outputs = type.results.length;
        }
        const label = {
          id: labels.length,
          kind: op,
          entry: pc,
          exit: -1,
          otherwise: -1,
          inputs,
          outputs
        };
        labels.push(label);
        active.push(label);
        immediate = label;
        break;
      }
      case 5: {
        const label = active.at(-1);
        if (label.kind !== 4 || label.otherwise !== -1)
          throw new Error("Invalid else");
        label.otherwise = pc;
        immediate = label;
        break;
      }
      case 11: {
        const label = active.pop();
        if (!label) throw new Error("Unexpected end");
        label.exit = pc;
        immediate = label;
        if (!active.length && r.at !== r.end)
          throw new Error("Trailing function instructions");
        break;
      }
      case 12:
      case 13:
        immediate = target(r.u32());
        break;
      case 14:
        immediate = {
          cases: vector(r, (r2) => target(r2.u32())),
          fallback: target(r.u32())
        };
        break;
      case 16:
      case 32:
      case 33:
      case 34:
      case 35:
      case 36:
      case 37:
      case 38:
      case 210:
        immediate = r.u32();
        break;
      case 17:
        immediate = { type: r.u32(), table: r.u32() };
        break;
      case 28:
        immediate = vector(r, valueType);
        break;
      case 40:
      case 41:
      case 42:
      case 43:
      case 44:
      case 45:
      case 46:
      case 47:
      case 48:
      case 49:
      case 50:
      case 51:
      case 52:
      case 53:
      case 54:
      case 55:
      case 56:
      case 57:
      case 58:
      case 59:
      case 60:
      case 61:
      case 62:
        r.u32();
        immediate = r.u32();
        break;
      case 63:
      case 64:
        immediate = r.u32();
        if (immediate !== 0) throw new Error("Multiple memories unsupported");
        break;
      case 65:
        immediate = r.signed(32);
        break;
      case 66:
        immediate = r.signed(64);
        break;
      case 67:
        immediate = r.f32();
        break;
      case 68:
        immediate = r.f64();
        break;
      case 208:
        immediate = valueType(r);
        break;
      case 252: {
        const sub = r.u32();
        immediate = { sub };
        if (sub === 8) {
          immediate.data = r.u32();
          immediate.memory = r.u32();
        } else if (sub === 9) immediate.data = r.u32();
        else if (sub === 10) {
          immediate.destination = r.u32();
          immediate.source = r.u32();
        } else if (sub === 11) immediate.memory = r.u32();
        else if (sub > 7)
          throw new Error(
            `Unsupported prefixed opcode 0xfc/${sub} in function ${functionIndex} at ${byteOffset}`
          );
        break;
      }
      case 0:
      case 1:
      case 15:
      case 26:
      case 27:
      case 209:
        break;
      default:
        if (op < 69 || op > 196)
          throw new Error(
            `Unsupported opcode 0x${op.toString(16)} in function ${functionIndex} at ${byteOffset}`
          );
    }
    immediates[pc] = immediate;
  }
  if (active.length) throw new Error("Unclosed function labels");
  return {
    signature,
    localTypes,
    opcodes: Uint16Array.from(opcodes),
    immediates,
    labels
  };
}
function parse(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 8 || bytes.length > 16 * 1024 * 1024)
    throw new Error("Invalid runtime byte extent");
  const r = new Reader(bytes);
  if (r.byte() !== 0 || r.byte() !== 97 || r.byte() !== 115 || r.byte() !== 109 || r.byte() !== 1 || r.byte() !== 0 || r.byte() !== 0 || r.byte() !== 0)
    throw new Error("Invalid WASM header");
  const module = {
    types: [],
    functions: [],
    memories: [],
    tables: [],
    globals: [],
    exports: /* @__PURE__ */ new Map(),
    elements: [],
    data: [],
    start: null,
    opcodeCounts: {}
  };
  let declared = [], defined = 0;
  while (r.at < r.end) {
    const id = r.byte(), size = r.u32(), content = new Reader(bytes, r.at, r.at + size);
    if (size > r.end - r.at) throw new Error("Invalid WASM section extent");
    r.at += size;
    switch (id) {
      case 0:
        content.at = content.end;
        break;
      case 1:
        module.types = vector(content, (r2) => {
          if (r2.byte() !== 96) throw new Error("Unsupported signature");
          return {
            parameters: vector(r2, valueType),
            results: vector(r2, valueType)
          };
        });
        break;
      case 2:
        vector(content, (r2) => {
          const namespace = r2.name(), name = r2.name(), kind = r2.byte();
          if (kind === 0) {
            const typeIndex = r2.u32(), signature = module.types[typeIndex];
            if (!signature) throw new Error("Unknown import signature");
            module.functions.push({
              namespace,
              name,
              signature,
              imported: true
            });
          } else if (kind === 1)
            module.tables.push({
              namespace,
              name,
              element: valueType(r2),
              ...limits(r2)
            });
          else if (kind === 2)
            module.memories.push({ namespace, name, ...limits(r2) });
          else if (kind === 3) throw new Error("Imported globals unsupported");
          else throw new Error("Invalid WASM import");
        });
        break;
      case 3:
        declared = vector(content, (r2) => r2.u32());
        break;
      case 4:
        module.tables.push(
          ...vector(content, (r2) => ({ element: valueType(r2), ...limits(r2) }))
        );
        break;
      case 5:
        module.memories.push(...vector(content, limits));
        break;
      case 6:
        vector(content, (r2) => {
          const type = valueType(r2), mutable = r2.byte();
          if (mutable > 1) throw new Error("Invalid global mutability");
          const value = initializer(r2, module.globals);
          module.globals.push({ type, mutable, value });
        });
        break;
      case 7:
        vector(content, (r2) => {
          const name = r2.name(), kind = r2.byte(), index = r2.u32();
          if (module.exports.has(name)) throw new Error("Duplicate export");
          module.exports.set(name, { kind, index });
        });
        break;
      case 8:
        module.start = content.u32();
        break;
      case 9:
        vector(content, (r2) => {
          const flags = r2.u32();
          if (flags !== 0 && flags !== 2)
            throw new Error(`Unsupported element segment mode ${flags}`);
          const table = flags === 2 ? r2.u32() : 0, offset = initializer(r2, module.globals);
          if (flags === 2 && r2.byte() !== 0)
            throw new Error("Unsupported element kind");
          module.elements.push({
            table,
            offset,
            functions: vector(r2, (r3) => r3.u32())
          });
        });
        break;
      case 10: {
        const count = content.u32();
        if (count !== declared.length)
          throw new Error("Function/code count mismatch");
        for (let i = 0; i < count; i++) {
          const extent = content.u32(), body = new Reader(bytes, content.at, content.at + extent);
          if (extent > content.end - content.at)
            throw new Error("Invalid function extent");
          content.at += extent;
          const signature = module.types[declared[i]];
          if (!signature) throw new Error("Unknown function signature");
          module.functions.push(
            decodeFunction(
              body,
              signature,
              module.types,
              module.functions.length,
              module.opcodeCounts
            )
          );
          defined++;
        }
        break;
      }
      case 11:
        vector(content, (r2) => {
          const flags = r2.u32();
          if (flags > 2)
            throw new Error(`Unsupported data segment mode ${flags}`);
          const memory = flags === 2 ? r2.u32() : 0, offset = flags === 1 ? null : initializer(r2, module.globals), data = r2.bytesOf(r2.u32());
          module.data.push({ memory, offset, bytes: data });
        });
        break;
      case 12:
        content.u32();
        break;
      default:
        throw new Error(`Unsupported section ${id}`);
    }
    if (content.at !== content.end)
      throw new Error(`Trailing section ${id} bytes`);
  }
  if (defined !== declared.length || module.memories.length !== 1)
    throw new Error("Unsupported memory/function shape");
  return module;
}
function nearest(value) {
  if (!Number.isFinite(value) || value === 0) return value;
  const lower = Math.floor(value), fraction = value - lower;
  const rounded = fraction < 0.5 ? lower : fraction > 0.5 ? lower + 1 : lower % 2 === 0 ? lower : lower + 1;
  return rounded === 0 && value < 0 ? -0 : rounded;
}
function truncInteger(value, bits, unsigned, saturating = false) {
  const n = Math.trunc(value), lower = unsigned ? 0 : -(2 ** (bits - 1)), upper = unsigned ? 2 ** bits : 2 ** (bits - 1);
  if (Number.isNaN(n) || n < lower || n >= upper) {
    if (!saturating) throw new Error("WASM invalid float-to-integer conversion");
    if (Number.isNaN(n)) return bits === 64 ? 0n : 0;
    if (bits === 64)
      return n < lower ? unsigned ? 0n : -(1n << 63n) : unsigned ? -1n : (1n << 63n) - 1n;
    return n < lower ? unsigned ? 0 : -2147483648 : unsigned ? -1 : 2147483647;
  }
  return bits === 64 ? BigInt.asIntN(64, BigInt(n)) : n | 0;
}
function population(value) {
  value -= value >>> 1 & 1431655765;
  value = (value & 858993459) + (value >>> 2 & 858993459);
  return (value + (value >>> 4) & 252645135) * 16843009 >>> 24;
}
function trailing32(value) {
  return value === 0 ? 32 : 31 - Math.clz32((value & -value) >>> 0);
}
function count64(value, mode) {
  let n = BigInt.asUintN(64, value);
  if (!n) return mode === 2 ? 0n : 64n;
  if (mode === 0) return BigInt(64 - n.toString(2).length);
  let count = 0n;
  if (mode === 1)
    while (!(n & 1n)) {
      count++;
      n >>= 1n;
    }
  else
    while (n) {
      count++;
      n &= n - 1n;
    }
  return count;
}
var Machine = class {
  constructor(module, imports, initialPages, maxPages) {
    this.module = module;
    this.imports = imports;
    this.maximum = maxPages;
    const limits2 = module.memories[0];
    if (limits2.initial > initialPages || limits2.maximum !== null && initialPages > limits2.maximum)
      throw new Error("Imported memory limits mismatch");
    this.buffer = new ArrayBuffer(initialPages * PAGE);
    this.refreshViews();
    this.tables = module.tables.map((table) => {
      if (table.namespace || table.element !== 112 || table.initial > 1e6)
        throw new Error("Unsupported table shape");
      return new Array(table.initial).fill(null);
    });
    for (const element of module.elements) {
      const table = this.tables[element.table];
      if (!table || element.offset < 0 || element.offset + element.functions.length > table.length)
        throw new Error("Element extent out of bounds");
      for (let i = 0; i < element.functions.length; i++)
        table[element.offset + i] = element.functions[i];
    }
    for (const data of module.data)
      if (data.offset !== null) {
        if (data.memory !== 0 || data.offset < 0 || data.offset + data.bytes.length > this.bytes.length)
          throw new Error("Data extent out of bounds");
        this.bytes.set(data.bytes, data.offset);
      }
    for (const fn of module.functions)
      if (fn.imported && typeof imports[fn.namespace]?.[fn.name] !== "function")
        throw new Error(`Missing import ${fn.namespace}.${fn.name}`);
    this.operand = [];
    this.frames = [];
    this.framePool = [];
    this.instructions = 0;
    this.calls = 0;
    this.maxDepth = 0;
    this.reinterpret = new DataView(new ArrayBuffer(8));
  }
  refreshViews() {
    this.bytes = new Uint8Array(this.buffer);
    this.view = new DataView(this.buffer);
  }
  callExport(name, parameters = []) {
    const exported = this.module.exports.get(name);
    if (exported?.kind !== 0) throw new Error(`Missing function export ${name}`);
    return this.execute(exported.index, parameters);
  }
  execute(index, parameters) {
    if (this.frames.length) throw new Error("Reentrant interpreter invocation");
    const functions = this.module.functions, stack = this.operand, frames = this.frames, globals = this.module.globals;
    let sp = 0, frame, code, args, locals, pc = 0, instructions = 0;
    const enter = (index2, parameterBase) => {
      const fn = functions[index2];
      if (!fn) throw new Error(`Unknown function ${index2}`);
      this.calls++;
      if (fn.imported) {
        const values = stack.slice(parameterBase, sp);
        sp = parameterBase;
        const result = this.imports[fn.namespace][fn.name](...values);
        if (fn.signature.results.length === 1)
          stack[sp++] = fn.signature.results[0] === 127 ? result | 0 : result;
        else if (fn.signature.results.length > 1)
          for (const value of result) stack[sp++] = value;
        return false;
      }
      const depth = frames.length;
      let next = this.framePool[depth];
      if (!next) {
        next = { locals: [], labelBases: [] };
        this.framePool[depth] = next;
      }
      next.fn = fn;
      next.index = index2;
      next.pc = 0;
      next.base = parameterBase;
      for (let i = 0; i < fn.signature.parameters.length; i++)
        next.locals[i] = stack[parameterBase + i];
      for (let i = 0; i < fn.localTypes.length; i++)
        next.locals[fn.signature.parameters.length + i] = fn.localTypes[i] === 126 ? 0n : fn.localTypes[i] === 112 ? null : 0;
      next.labelBases[0] = parameterBase;
      sp = parameterBase;
      frames.push(next);
      frame = next;
      code = fn.opcodes;
      args = fn.immediates;
      locals = next.locals;
      pc = 0;
      if (frames.length > this.maxDepth) this.maxDepth = frames.length;
      return true;
    };
    const leave = () => {
      const count = frame.fn.signature.results.length, base = frame.base;
      for (let i = 0; i < count; i++) stack[base + i] = stack[sp - count + i];
      sp = base + count;
      frames.pop();
      frame = frames.at(-1);
      if (frame) {
        code = frame.fn.opcodes;
        args = frame.fn.immediates;
        locals = frame.locals;
        pc = frame.pc;
      }
    };
    const branch = (label) => {
      const count = label.kind === 3 ? label.inputs : label.outputs, base = frame.labelBases[label.id];
      for (let i = 0; i < count; i++) stack[base + i] = stack[sp - count + i];
      sp = base + count;
      pc = label.kind === 3 ? label.entry : label.id === 0 ? label.exit : label.exit + 1;
    };
    for (const value of parameters) stack[sp++] = value;
    const entry = functions[index];
    if (!entry || parameters.length !== entry.signature.parameters.length)
      throw new Error("Invocation arity mismatch");
    try {
      enter(index, 0);
      while (frames.length) {
        const op = code[pc], immediate = args[pc++];
        instructions++;
        let a, b, c, address, target;
        switch (op) {
          case 0:
            throw new Error(
              `WASM unreachable in function ${frame.index} at ${pc - 1}`
            );
          case 1:
            break;
          case 2:
          case 3:
            frame.labelBases[immediate.id] = sp - immediate.inputs;
            break;
          case 4:
            c = stack[--sp];
            frame.labelBases[immediate.id] = sp - immediate.inputs;
            if (!c)
              pc = immediate.otherwise < 0 ? immediate.exit : immediate.otherwise + 1;
            break;
          case 5:
            pc = immediate.exit;
            break;
          case 11:
            if (immediate.id === 0) leave();
            else {
              c = immediate.outputs;
              a = frame.labelBases[immediate.id];
              for (let i = 0; i < c; i++) stack[a + i] = stack[sp - c + i];
              sp = a + c;
            }
            break;
          case 12:
            branch(immediate);
            break;
          case 13:
            if (stack[--sp]) branch(immediate);
            break;
          case 14:
            a = stack[--sp] >>> 0;
            branch(immediate.cases[a] || immediate.fallback);
            break;
          case 15:
            leave();
            break;
          case 16:
            frame.pc = pc;
            enter(
              immediate,
              sp - functions[immediate].signature.parameters.length
            );
            break;
          case 17: {
            a = stack[--sp] >>> 0;
            target = this.tables[immediate.table]?.[a];
            if (target === null || target === void 0)
              throw new Error("WASM null/out-of-bounds indirect call");
            const actual = functions[target].signature, expected = this.module.types[immediate.type];
            if (!expected || actual.parameters.length !== expected.parameters.length || actual.results.length !== expected.results.length || actual.parameters.some(
              (type, i) => type !== expected.parameters[i]
            ) || actual.results.some((type, i) => type !== expected.results[i]))
              throw new Error("WASM indirect call signature mismatch");
            frame.pc = pc;
            enter(target, sp - actual.parameters.length);
            break;
          }
          case 26:
            sp--;
            break;
          case 27:
          case 28:
            c = stack[--sp];
            b = stack[--sp];
            if (!c) stack[sp - 1] = b;
            break;
          case 32:
            stack[sp++] = locals[immediate];
            break;
          case 33:
            locals[immediate] = stack[--sp];
            break;
          case 34:
            locals[immediate] = stack[sp - 1];
            break;
          case 35:
            stack[sp++] = globals[immediate].value;
            break;
          case 36:
            globals[immediate].value = stack[--sp];
            break;
          case 37:
            a = stack[--sp] >>> 0;
            if (a >= this.tables[immediate].length)
              throw new Error("Table index out of bounds");
            stack[sp++] = this.tables[immediate][a];
            break;
          case 38:
            b = stack[--sp];
            a = stack[--sp] >>> 0;
            if (a >= this.tables[immediate].length)
              throw new Error("Table index out of bounds");
            this.tables[immediate][a] = b;
            break;
          case 40:
            address = (stack[sp - 1] >>> 0) + immediate;
            stack[sp - 1] = this.view.getInt32(address, true);
            break;
          case 41:
            address = (stack[sp - 1] >>> 0) + immediate;
            stack[sp - 1] = this.view.getBigInt64(address, true);
            break;
          case 42:
            address = (stack[sp - 1] >>> 0) + immediate;
            stack[sp - 1] = this.view.getFloat32(address, true);
            break;
          case 43:
            address = (stack[sp - 1] >>> 0) + immediate;
            stack[sp - 1] = this.view.getFloat64(address, true);
            break;
          case 44:
            address = (stack[sp - 1] >>> 0) + immediate;
            stack[sp - 1] = this.view.getInt8(address);
            break;
          case 45:
            address = (stack[sp - 1] >>> 0) + immediate;
            stack[sp - 1] = this.view.getUint8(address);
            break;
          case 46:
            address = (stack[sp - 1] >>> 0) + immediate;
            stack[sp - 1] = this.view.getInt16(address, true);
            break;
          case 47:
            address = (stack[sp - 1] >>> 0) + immediate;
            stack[sp - 1] = this.view.getUint16(address, true);
            break;
          case 48:
            address = (stack[sp - 1] >>> 0) + immediate;
            stack[sp - 1] = BigInt(this.view.getInt8(address));
            break;
          case 49:
            address = (stack[sp - 1] >>> 0) + immediate;
            stack[sp - 1] = BigInt(this.view.getUint8(address));
            break;
          case 50:
            address = (stack[sp - 1] >>> 0) + immediate;
            stack[sp - 1] = BigInt(this.view.getInt16(address, true));
            break;
          case 51:
            address = (stack[sp - 1] >>> 0) + immediate;
            stack[sp - 1] = BigInt(this.view.getUint16(address, true));
            break;
          case 52:
            address = (stack[sp - 1] >>> 0) + immediate;
            stack[sp - 1] = BigInt(this.view.getInt32(address, true));
            break;
          case 53:
            address = (stack[sp - 1] >>> 0) + immediate;
            stack[sp - 1] = BigInt(this.view.getUint32(address, true));
            break;
          case 54:
            b = stack[--sp];
            address = (stack[--sp] >>> 0) + immediate;
            this.view.setInt32(address, b, true);
            break;
          case 55:
            b = stack[--sp];
            address = (stack[--sp] >>> 0) + immediate;
            this.view.setBigInt64(address, b, true);
            break;
          case 56:
            b = stack[--sp];
            address = (stack[--sp] >>> 0) + immediate;
            this.view.setFloat32(address, b, true);
            break;
          case 57:
            b = stack[--sp];
            address = (stack[--sp] >>> 0) + immediate;
            this.view.setFloat64(address, b, true);
            break;
          case 58:
            b = stack[--sp];
            address = (stack[--sp] >>> 0) + immediate;
            this.view.setInt8(address, b);
            break;
          case 59:
            b = stack[--sp];
            address = (stack[--sp] >>> 0) + immediate;
            this.view.setInt16(address, b, true);
            break;
          case 60:
            b = stack[--sp];
            address = (stack[--sp] >>> 0) + immediate;
            this.view.setInt8(address, Number(BigInt.asIntN(8, b)));
            break;
          case 61:
            b = stack[--sp];
            address = (stack[--sp] >>> 0) + immediate;
            this.view.setInt16(address, Number(BigInt.asIntN(16, b)), true);
            break;
          case 62:
            b = stack[--sp];
            address = (stack[--sp] >>> 0) + immediate;
            this.view.setInt32(address, Number(BigInt.asIntN(32, b)), true);
            break;
          case 63:
            stack[sp++] = this.buffer.byteLength / PAGE;
            break;
          case 64: {
            a = stack[sp - 1] >>> 0;
            b = this.buffer.byteLength / PAGE;
            if (a > this.maximum - b) stack[sp - 1] = -1;
            else {
              const previous = this.bytes;
              try {
                this.buffer = new ArrayBuffer((b + a) * PAGE);
                this.refreshViews();
                this.bytes.set(previous);
                stack[sp - 1] = b;
              } catch {
                stack[sp - 1] = -1;
              }
            }
            break;
          }
          case 65:
          case 66:
          case 67:
          case 68:
            stack[sp++] = immediate;
            break;
          case 69:
            stack[sp - 1] = +(stack[sp - 1] === 0);
            break;
          case 70:
            b = stack[--sp];
            stack[sp - 1] = +(stack[sp - 1] === b);
            break;
          case 71:
            b = stack[--sp];
            stack[sp - 1] = +(stack[sp - 1] !== b);
            break;
          case 72:
            b = stack[--sp];
            stack[sp - 1] = +(stack[sp - 1] < b);
            break;
          case 73:
            b = stack[--sp] >>> 0;
            stack[sp - 1] = +(stack[sp - 1] >>> 0 < b);
            break;
          case 74:
            b = stack[--sp];
            stack[sp - 1] = +(stack[sp - 1] > b);
            break;
          case 75:
            b = stack[--sp] >>> 0;
            stack[sp - 1] = +(stack[sp - 1] >>> 0 > b);
            break;
          case 76:
            b = stack[--sp];
            stack[sp - 1] = +(stack[sp - 1] <= b);
            break;
          case 77:
            b = stack[--sp] >>> 0;
            stack[sp - 1] = +(stack[sp - 1] >>> 0 <= b);
            break;
          case 78:
            b = stack[--sp];
            stack[sp - 1] = +(stack[sp - 1] >= b);
            break;
          case 79:
            b = stack[--sp] >>> 0;
            stack[sp - 1] = +(stack[sp - 1] >>> 0 >= b);
            break;
          case 80:
            stack[sp - 1] = +(stack[sp - 1] === 0n);
            break;
          case 81:
            b = stack[--sp];
            stack[sp - 1] = +(stack[sp - 1] === b);
            break;
          case 82:
            b = stack[--sp];
            stack[sp - 1] = +(stack[sp - 1] !== b);
            break;
          case 83:
            b = stack[--sp];
            stack[sp - 1] = +(stack[sp - 1] < b);
            break;
          case 84:
            b = BigInt.asUintN(64, stack[--sp]);
            stack[sp - 1] = +(BigInt.asUintN(64, stack[sp - 1]) < b);
            break;
          case 85:
            b = stack[--sp];
            stack[sp - 1] = +(stack[sp - 1] > b);
            break;
          case 86:
            b = BigInt.asUintN(64, stack[--sp]);
            stack[sp - 1] = +(BigInt.asUintN(64, stack[sp - 1]) > b);
            break;
          case 87:
            b = stack[--sp];
            stack[sp - 1] = +(stack[sp - 1] <= b);
            break;
          case 88:
            b = BigInt.asUintN(64, stack[--sp]);
            stack[sp - 1] = +(BigInt.asUintN(64, stack[sp - 1]) <= b);
            break;
          case 89:
            b = stack[--sp];
            stack[sp - 1] = +(stack[sp - 1] >= b);
            break;
          case 90:
            b = BigInt.asUintN(64, stack[--sp]);
            stack[sp - 1] = +(BigInt.asUintN(64, stack[sp - 1]) >= b);
            break;
          case 91:
          case 97:
            b = stack[--sp];
            stack[sp - 1] = +(stack[sp - 1] === b);
            break;
          case 92:
          case 98:
            b = stack[--sp];
            stack[sp - 1] = +(stack[sp - 1] !== b);
            break;
          case 93:
          case 99:
            b = stack[--sp];
            stack[sp - 1] = +(stack[sp - 1] < b);
            break;
          case 94:
          case 100:
            b = stack[--sp];
            stack[sp - 1] = +(stack[sp - 1] > b);
            break;
          case 95:
          case 101:
            b = stack[--sp];
            stack[sp - 1] = +(stack[sp - 1] <= b);
            break;
          case 96:
          case 102:
            b = stack[--sp];
            stack[sp - 1] = +(stack[sp - 1] >= b);
            break;
          case 103:
            stack[sp - 1] = Math.clz32(stack[sp - 1]);
            break;
          case 104:
            stack[sp - 1] = trailing32(stack[sp - 1]);
            break;
          case 105:
            stack[sp - 1] = population(stack[sp - 1]);
            break;
          case 106:
            b = stack[--sp];
            stack[sp - 1] = stack[sp - 1] + b | 0;
            break;
          case 107:
            b = stack[--sp];
            stack[sp - 1] = stack[sp - 1] - b | 0;
            break;
          case 108:
            b = stack[--sp];
            stack[sp - 1] = Math.imul(stack[sp - 1], b);
            break;
          case 109:
            b = stack[--sp];
            a = stack[sp - 1];
            if (!b || a === -2147483648 && b === -1)
              throw new Error("WASM integer division trap");
            stack[sp - 1] = a / b | 0;
            break;
          case 110:
            b = stack[--sp] >>> 0;
            if (!b) throw new Error("WASM divide by zero");
            stack[sp - 1] = (stack[sp - 1] >>> 0) / b | 0;
            break;
          case 111:
            b = stack[--sp];
            if (!b) throw new Error("WASM remainder by zero");
            stack[sp - 1] = stack[sp - 1] % b | 0;
            break;
          case 112:
            b = stack[--sp] >>> 0;
            if (!b) throw new Error("WASM remainder by zero");
            stack[sp - 1] = (stack[sp - 1] >>> 0) % b | 0;
            break;
          case 113:
            b = stack[--sp];
            stack[sp - 1] &= b;
            break;
          case 114:
            b = stack[--sp];
            stack[sp - 1] |= b;
            break;
          case 115:
            b = stack[--sp];
            stack[sp - 1] ^= b;
            break;
          case 116:
            b = stack[--sp];
            stack[sp - 1] <<= b;
            break;
          case 117:
            b = stack[--sp];
            stack[sp - 1] >>= b;
            break;
          case 118:
            b = stack[--sp];
            stack[sp - 1] = stack[sp - 1] >>> b | 0;
            break;
          case 119:
            b = stack[--sp];
            a = stack[sp - 1];
            stack[sp - 1] = a << b | a >>> 32 - (b & 31);
            break;
          case 120:
            b = stack[--sp];
            a = stack[sp - 1];
            stack[sp - 1] = a >>> b | a << 32 - (b & 31);
            break;
          case 121:
          case 122:
          case 123:
            stack[sp - 1] = count64(stack[sp - 1], op - 121);
            break;
          case 124:
            b = stack[--sp];
            stack[sp - 1] = BigInt.asIntN(64, stack[sp - 1] + b);
            break;
          case 125:
            b = stack[--sp];
            stack[sp - 1] = BigInt.asIntN(64, stack[sp - 1] - b);
            break;
          case 126:
            b = stack[--sp];
            stack[sp - 1] = BigInt.asIntN(64, stack[sp - 1] * b);
            break;
          case 127:
            b = stack[--sp];
            a = stack[sp - 1];
            if (!b || a === -(1n << 63n) && b === -1n)
              throw new Error("WASM integer division trap");
            stack[sp - 1] = a / b;
            break;
          case 128:
            b = BigInt.asUintN(64, stack[--sp]);
            if (!b) throw new Error("WASM divide by zero");
            stack[sp - 1] = BigInt.asIntN(
              64,
              BigInt.asUintN(64, stack[sp - 1]) / b
            );
            break;
          case 129:
            b = stack[--sp];
            if (!b) throw new Error("WASM remainder by zero");
            stack[sp - 1] %= b;
            break;
          case 130:
            b = BigInt.asUintN(64, stack[--sp]);
            if (!b) throw new Error("WASM remainder by zero");
            stack[sp - 1] = BigInt.asIntN(
              64,
              BigInt.asUintN(64, stack[sp - 1]) % b
            );
            break;
          case 131:
            b = stack[--sp];
            stack[sp - 1] &= b;
            break;
          case 132:
            b = stack[--sp];
            stack[sp - 1] |= b;
            break;
          case 133:
            b = stack[--sp];
            stack[sp - 1] ^= b;
            break;
          case 134:
            b = stack[--sp] & 63n;
            stack[sp - 1] = BigInt.asIntN(64, stack[sp - 1] << b);
            break;
          case 135:
            b = stack[--sp] & 63n;
            stack[sp - 1] >>= b;
            break;
          case 136:
            b = stack[--sp] & 63n;
            stack[sp - 1] = BigInt.asIntN(
              64,
              BigInt.asUintN(64, stack[sp - 1]) >> b
            );
            break;
          case 137:
            b = stack[--sp] & 63n;
            a = BigInt.asUintN(64, stack[sp - 1]);
            stack[sp - 1] = BigInt.asIntN(64, a << b | a >> 64n - b);
            break;
          case 138:
            b = stack[--sp] & 63n;
            a = BigInt.asUintN(64, stack[sp - 1]);
            stack[sp - 1] = BigInt.asIntN(64, a >> b | a << 64n - b);
            break;
          case 139:
            stack[sp - 1] = Math.abs(stack[sp - 1]);
            break;
          case 140:
            stack[sp - 1] = -stack[sp - 1];
            break;
          case 141:
            stack[sp - 1] = Math.fround(Math.ceil(stack[sp - 1]));
            break;
          case 142:
            stack[sp - 1] = Math.fround(Math.floor(stack[sp - 1]));
            break;
          case 143:
            stack[sp - 1] = Math.fround(Math.trunc(stack[sp - 1]));
            break;
          case 144:
            stack[sp - 1] = Math.fround(nearest(stack[sp - 1]));
            break;
          case 145:
            stack[sp - 1] = Math.fround(Math.sqrt(stack[sp - 1]));
            break;
          case 146:
            b = stack[--sp];
            stack[sp - 1] = Math.fround(stack[sp - 1] + b);
            break;
          case 147:
            b = stack[--sp];
            stack[sp - 1] = Math.fround(stack[sp - 1] - b);
            break;
          case 148:
            b = stack[--sp];
            stack[sp - 1] = Math.fround(stack[sp - 1] * b);
            break;
          case 149:
            b = stack[--sp];
            stack[sp - 1] = Math.fround(stack[sp - 1] / b);
            break;
          case 150:
            b = stack[--sp];
            stack[sp - 1] = Math.min(stack[sp - 1], b);
            break;
          case 151:
            b = stack[--sp];
            stack[sp - 1] = Math.max(stack[sp - 1], b);
            break;
          case 152:
            b = stack[--sp];
            a = Math.abs(stack[sp - 1]);
            stack[sp - 1] = b < 0 || Object.is(b, -0) ? -a : a;
            break;
          case 153:
            stack[sp - 1] = Math.abs(stack[sp - 1]);
            break;
          case 154:
            stack[sp - 1] = -stack[sp - 1];
            break;
          case 155:
            stack[sp - 1] = Math.ceil(stack[sp - 1]);
            break;
          case 156:
            stack[sp - 1] = Math.floor(stack[sp - 1]);
            break;
          case 157:
            stack[sp - 1] = Math.trunc(stack[sp - 1]);
            break;
          case 158:
            stack[sp - 1] = nearest(stack[sp - 1]);
            break;
          case 159:
            stack[sp - 1] = Math.sqrt(stack[sp - 1]);
            break;
          case 160:
            b = stack[--sp];
            stack[sp - 1] += b;
            break;
          case 161:
            b = stack[--sp];
            stack[sp - 1] -= b;
            break;
          case 162:
            b = stack[--sp];
            stack[sp - 1] *= b;
            break;
          case 163:
            b = stack[--sp];
            stack[sp - 1] /= b;
            break;
          case 164:
            b = stack[--sp];
            stack[sp - 1] = Math.min(stack[sp - 1], b);
            break;
          case 165:
            b = stack[--sp];
            stack[sp - 1] = Math.max(stack[sp - 1], b);
            break;
          case 166:
            b = stack[--sp];
            a = Math.abs(stack[sp - 1]);
            stack[sp - 1] = b < 0 || Object.is(b, -0) ? -a : a;
            break;
          case 167:
            stack[sp - 1] = Number(BigInt.asIntN(32, stack[sp - 1]));
            break;
          case 168:
          case 170:
            stack[sp - 1] = truncInteger(stack[sp - 1], 32, false);
            break;
          case 169:
          case 171:
            stack[sp - 1] = truncInteger(stack[sp - 1], 32, true);
            break;
          case 172:
            stack[sp - 1] = BigInt(stack[sp - 1]);
            break;
          case 173:
            stack[sp - 1] = BigInt(stack[sp - 1] >>> 0);
            break;
          case 174:
          case 176:
            stack[sp - 1] = truncInteger(stack[sp - 1], 64, false);
            break;
          case 175:
          case 177:
            stack[sp - 1] = truncInteger(stack[sp - 1], 64, true);
            break;
          case 178:
            stack[sp - 1] = Math.fround(stack[sp - 1]);
            break;
          case 179:
            stack[sp - 1] = Math.fround(stack[sp - 1] >>> 0);
            break;
          case 180:
            stack[sp - 1] = Math.fround(Number(stack[sp - 1]));
            break;
          case 181:
            stack[sp - 1] = Math.fround(
              Number(BigInt.asUintN(64, stack[sp - 1]))
            );
            break;
          case 182:
            stack[sp - 1] = Math.fround(stack[sp - 1]);
            break;
          case 183:
            break;
          case 184:
            stack[sp - 1] >>>= 0;
            break;
          case 185:
            stack[sp - 1] = Number(stack[sp - 1]);
            break;
          case 186:
            stack[sp - 1] = Number(BigInt.asUintN(64, stack[sp - 1]));
            break;
          case 187:
            break;
          case 188:
            this.reinterpret.setFloat32(0, stack[sp - 1], true);
            stack[sp - 1] = this.reinterpret.getInt32(0, true);
            break;
          case 189:
            this.reinterpret.setFloat64(0, stack[sp - 1], true);
            stack[sp - 1] = this.reinterpret.getBigInt64(0, true);
            break;
          case 190:
            this.reinterpret.setInt32(0, stack[sp - 1], true);
            stack[sp - 1] = this.reinterpret.getFloat32(0, true);
            break;
          case 191:
            this.reinterpret.setBigInt64(0, stack[sp - 1], true);
            stack[sp - 1] = this.reinterpret.getFloat64(0, true);
            break;
          case 192:
            stack[sp - 1] = stack[sp - 1] << 24 >> 24;
            break;
          case 193:
            stack[sp - 1] = stack[sp - 1] << 16 >> 16;
            break;
          case 194:
            stack[sp - 1] = BigInt.asIntN(8, stack[sp - 1]);
            break;
          case 195:
            stack[sp - 1] = BigInt.asIntN(16, stack[sp - 1]);
            break;
          case 196:
            stack[sp - 1] = BigInt.asIntN(32, stack[sp - 1]);
            break;
          case 208:
            stack[sp++] = null;
            break;
          case 209:
            stack[sp - 1] = +(stack[sp - 1] === null);
            break;
          case 210:
            stack[sp++] = immediate;
            break;
          case 252: {
            if (immediate.sub <= 7) {
              stack[sp - 1] = truncInteger(
                stack[sp - 1],
                immediate.sub < 4 ? 32 : 64,
                !!(immediate.sub & 1),
                true
              );
              break;
            }
            if (immediate.sub === 9) {
              this.module.data[immediate.data].bytes = new Uint8Array();
              break;
            }
            c = stack[--sp] >>> 0;
            b = stack[--sp] >>> 0;
            a = stack[--sp] >>> 0;
            if (a + c > this.bytes.length)
              throw new Error("WASM bulk destination out of bounds");
            if (immediate.sub === 8) {
              const data = this.module.data[immediate.data].bytes;
              if (immediate.memory !== 0 || b + c > data.length)
                throw new Error("WASM bulk data out of bounds");
              this.bytes.set(data.subarray(b, b + c), a);
            } else if (immediate.sub === 10) {
              if (immediate.destination !== 0 || immediate.source !== 0 || b + c > this.bytes.length)
                throw new Error("WASM bulk source out of bounds");
              this.bytes.copyWithin(a, b, b + c);
            } else {
              if (immediate.memory !== 0)
                throw new Error("Multiple memories unsupported");
              this.bytes.fill(b & 255, a, a + c);
            }
            break;
          }
          default:
            throw new Error(
              `Unsupported execution opcode ${op} at ${frame.index}/${pc - 1}`
            );
        }
      }
      return entry.signature.results.length ? stack.slice(0, sp) : [];
    } catch (error) {
      const context = frame ? ` [function ${frame.index}, instruction ${pc - 1}, depth ${frames.length}]` : "";
      throw new Error(`${error.message}${context}`, { cause: error });
    } finally {
      this.instructions += instructions;
      frames.length = 0;
      stack.length = 0;
    }
  }
};

// src/model.ts
var width = 640;
var height = 400;
var frameBytes = width * height * 4;
var actions = [
  "forward",
  "backward",
  "turnLeft",
  "turnRight",
  "strafeLeft",
  "strafeRight",
  "fire",
  "use",
  "run",
  "enter",
  "escape",
  "map"
];
function object(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid Doom payload.");
  return input;
}
function fields(value, names) {
  if (Object.keys(value).length !== names.length || names.some((name) => !Object.hasOwn(value, name)))
    throw new Error("Unexpected Doom payload fields.");
}
function integer(input) {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0)
    throw new Error("Invalid Doom frame cursor.");
  return input;
}
function requestId(input) {
  const id = integer(input);
  if (id === 0) throw new Error("Invalid Doom worker request.");
  return id;
}
function activity(input) {
  if (input !== "running" && input !== "paused")
    throw new Error("Invalid Doom activity.");
  return input;
}
function actionList(input) {
  if (!Array.isArray(input) || input.length > actions.length || new Set(input).size !== input.length)
    throw new Error("Invalid Doom actions.");
  return input.map((action) => {
    const found = actions.find((known) => known === action);
    if (!found) throw new Error("Unknown Doom action.");
    return found;
  });
}
function parseWorkerCommand(input) {
  const value = object(input);
  const id = requestId(value.id);
  switch (value.kind) {
    case "startup":
      fields(value, ["id", "kind", "engine", "iwad"]);
      if (!(value.engine instanceof Uint8Array) || value.engine.byteLength > 1024 * 1024 || !(value.iwad instanceof Uint8Array) || value.iwad.byteLength !== 4196020)
        throw new Error("Invalid bundled Doom startup bytes.");
      return { id, kind: "startup", engine: value.engine, iwad: value.iwad };
    case "activity":
      fields(value, ["id", "kind", "activity"]);
      return { id, kind: "activity", activity: activity(value.activity) };
    case "frame":
      fields(value, ["id", "kind", "activity", "held", "taps", "after"]);
      return {
        id,
        kind: "frame",
        activity: activity(value.activity),
        held: actionList(value.held),
        taps: actionList(value.taps),
        after: integer(value.after)
      };
    default:
      throw new Error("Unknown Doom worker operation.");
  }
}

// src/wasi.ts
var fileRights = 1n << 1n | 1n << 2n | 1n << 5n | 1n << 21n;
var pathRights = 1n << 13n;
var errno = {
  badf: 8,
  inval: 28,
  mfile: 33,
  noent: 44,
  notcapable: 76
};
function createWasiHost(iwad, buffer, clock) {
  const descriptors = /* @__PURE__ */ new Map([
    [1, { kind: "log" }],
    [2, { kind: "log" }],
    [3, { kind: "directory" }]
  ]);
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  let pointer = null;
  let sequence = 0;
  let log = "";
  const bytes = () => new Uint8Array(buffer());
  const view = () => new DataView(buffer());
  const extent = (address, length) => {
    if (!Number.isInteger(address) || !Number.isInteger(length) || address < 0 || length < 0 || address > buffer().byteLength - length)
      throw new Error("Doom host-call extent is outside guest memory.");
    return bytes().subarray(address, address + length);
  };
  const u32 = (address, value) => {
    extent(address, 4);
    view().setUint32(address, value, true);
  };
  const u64 = (address, value) => {
    extent(address, 8);
    view().setBigUint64(address, value, true);
  };
  const vectors = (address, count) => {
    if (!Number.isInteger(count) || count < 0 || count > 64)
      throw new Error("Invalid Doom I/O vector count.");
    extent(address, count * 8);
    let total = 0;
    const result = [];
    for (let index = 0; index < count; index++) {
      const start = view().getUint32(address + index * 8, true);
      const length = view().getUint32(address + index * 8 + 4, true);
      total += length;
      if (total > 4 * 1024 * 1024)
        throw new Error("Doom I/O vectors exceed their byte limit.");
      result.push(extent(start, length));
    }
    return result;
  };
  const deny = () => errno.notcapable;
  const imports = {
    hibi: {
      clock_ms: () => {
        const milliseconds = clock();
        if (!Number.isFinite(milliseconds) || milliseconds < 0)
          throw new Error("Invalid Doom active clock.");
        return milliseconds | 0;
      },
      sleep_ms: (milliseconds) => {
        if (!Number.isInteger(milliseconds) || milliseconds < 0 || milliseconds > 1e3)
          throw new Error("Invalid Doom sleep duration.");
      },
      draw_rgba: (address) => {
        extent(address, frameBytes);
        pointer = address;
        sequence++;
      }
    },
    wasi_snapshot_preview1: {
      fd_close: (fd) => {
        if (descriptors.get(fd)?.kind !== "iwad") return errno.badf;
        descriptors.delete(fd);
        return 0;
      },
      fd_fdstat_get: (fd, address) => {
        const descriptor = descriptors.get(fd);
        if (!descriptor) return errno.badf;
        extent(address, 24).fill(0);
        bytes()[address] = descriptor.kind === "directory" ? 3 : descriptor.kind === "iwad" ? 4 : 2;
        u64(
          address + 8,
          descriptor.kind === "directory" ? pathRights : descriptor.kind === "iwad" ? fileRights : 1n << 6n
        );
        u64(address + 16, descriptor.kind === "directory" ? fileRights : 0n);
        return 0;
      },
      fd_fdstat_set_flags: (fd, flags) => descriptors.has(fd) && flags === 0 ? 0 : errno.notcapable,
      fd_prestat_get: (fd, address) => {
        if (fd !== 3) return errno.badf;
        extent(address, 8).fill(0);
        u32(address + 4, 1);
        return 0;
      },
      fd_prestat_dir_name: (fd, address, length) => {
        if (fd !== 3) return errno.badf;
        if (length !== 1) return errno.inval;
        extent(address, 1)[0] = 47;
        return 0;
      },
      path_open: (fd, lookup, address, length, oflags, rights, inheriting, flags, result) => {
        if (!Number.isInteger(length) || length < 0 || length > 128)
          throw new Error("Doom path exceeds its byte limit.");
        const name = utf8.decode(extent(address, length));
        if (fd !== 3 || name !== "doom1.wad") return errno.noent;
        if (oflags !== 0 || flags !== 0 || lookup !== 0 && lookup !== 1 || (rights & ~fileRights) !== 0n || (inheriting & ~fileRights) !== 0n)
          return errno.notcapable;
        extent(result, 4);
        for (let next = 4; next <= 31; next++) {
          if (descriptors.has(next)) continue;
          u32(result, next);
          descriptors.set(next, { kind: "iwad", position: 0 });
          return 0;
        }
        return errno.mfile;
      },
      fd_read: (fd, address, count, result) => {
        const descriptor = descriptors.get(fd);
        if (descriptor?.kind !== "iwad") return errno.badf;
        const destinations = vectors(address, count);
        extent(result, 4);
        let read = 0;
        for (const destination of destinations) {
          const length = Math.min(
            destination.length,
            iwad.length - descriptor.position
          );
          destination.set(
            iwad.subarray(descriptor.position, descriptor.position + length)
          );
          descriptor.position += length;
          read += length;
        }
        u32(result, read);
        return 0;
      },
      fd_seek: (fd, offset, whence, result) => {
        const descriptor = descriptors.get(fd);
        if (descriptor?.kind !== "iwad") return errno.badf;
        if (whence < 0 || whence > 2) return errno.inval;
        const start = whence === 0 ? 0 : whence === 1 ? descriptor.position : iwad.length;
        const next = BigInt(start) + offset;
        if (next < 0n || next > BigInt(iwad.length)) return errno.inval;
        u64(result, next);
        descriptor.position = Number(next);
        return 0;
      },
      fd_write: (fd, address, count, result) => {
        if (descriptors.get(fd)?.kind !== "log") return errno.notcapable;
        const sources = vectors(address, count);
        extent(result, 4);
        let written = 0;
        for (const source of sources) {
          if (source.length > 65536)
            throw new Error("Doom log entry exceeds its byte limit.");
          if (log.length < 65536)
            log = (log + utf8.decode(source)).slice(0, 65536);
          written += source.length;
        }
        u32(result, written);
        return 0;
      },
      path_create_directory: deny,
      path_remove_directory: deny,
      path_rename: deny,
      path_unlink_file: deny,
      proc_exit: (code) => {
        throw new Error(`Doom exited with status ${code}.`);
      }
    }
  };
  return {
    imports,
    get sequence() {
      return sequence;
    },
    get log() {
      return log;
    },
    frame(after = 0) {
      if (!Number.isSafeInteger(after) || after < 0 || after > sequence)
        throw new Error("Invalid Doom frame cursor.");
      return pointer === null || after === sequence ? null : {
        sequence,
        width: 640,
        height: 400,
        pixels: extent(pointer, frameBytes).slice()
      };
    }
  };
}

// src/doom-vm.ts
var keyCodes = {
  forward: 173,
  backward: 175,
  turnLeft: 172,
  turnRight: 174,
  strafeLeft: 44,
  strafeRight: 46,
  fire: 157,
  use: 32,
  run: 182,
  enter: 13,
  escape: 27,
  map: 9
};
var abi = [
  ["hibi", "clock_ms", [], [127]],
  ["hibi", "sleep_ms", [127], []],
  ["hibi", "draw_rgba", [127], []],
  ["wasi_snapshot_preview1", "fd_close", [127], [127]],
  ["wasi_snapshot_preview1", "fd_fdstat_get", [127, 127], [127]],
  ["wasi_snapshot_preview1", "fd_fdstat_set_flags", [127, 127], [127]],
  ["wasi_snapshot_preview1", "fd_prestat_get", [127, 127], [127]],
  ["wasi_snapshot_preview1", "fd_prestat_dir_name", [127, 127, 127], [127]],
  ["wasi_snapshot_preview1", "fd_read", [127, 127, 127, 127], [127]],
  ["wasi_snapshot_preview1", "fd_seek", [127, 126, 127, 127], [127]],
  ["wasi_snapshot_preview1", "fd_write", [127, 127, 127, 127], [127]],
  ["wasi_snapshot_preview1", "path_create_directory", [127, 127, 127], [127]],
  [
    "wasi_snapshot_preview1",
    "path_open",
    [127, 127, 127, 127, 127, 126, 126, 127, 127],
    [127]
  ],
  ["wasi_snapshot_preview1", "path_remove_directory", [127, 127, 127], [127]],
  [
    "wasi_snapshot_preview1",
    "path_rename",
    [127, 127, 127, 127, 127, 127],
    [127]
  ],
  ["wasi_snapshot_preview1", "path_unlink_file", [127, 127, 127], [127]],
  ["wasi_snapshot_preview1", "proc_exit", [127], []]
];
function boot(engine2, iwad, clock) {
  const module = parse(engine2);
  const imported = module.functions.filter((fn) => fn.imported);
  if (JSON.stringify(
    imported.map((fn) => [
      fn.namespace,
      fn.name,
      fn.signature.parameters,
      fn.signature.results
    ])
  ) !== JSON.stringify(abi) || module.start !== null || module.memories.length !== 1 || module.memories[0]?.initial !== 512 || module.memories[0]?.maximum !== 512 || module.tables.length !== 1 || module.tables[0]?.initial !== 163 || module.tables[0]?.maximum !== 163)
    throw new Error("Unsupported Doom guest ABI.");
  for (const [name, parameters, results] of [
    ["_initialize", [], []],
    ["doom_init", [], []],
    ["doom_tick", [], []],
    ["doom_key", [127, 127], [127]],
    ["doom_snapshot", [], [127]]
  ]) {
    const exported = module.exports.get(name);
    const fn = exported?.kind === 0 ? module.functions[exported.index] : void 0;
    if (!fn || JSON.stringify(fn.signature) !== JSON.stringify({ parameters, results }))
      throw new Error(`Missing or invalid Doom export ${name}.`);
  }
  let machine;
  const host = createWasiHost(
    iwad,
    () => {
      if (!machine) throw new Error("Doom guest memory is not ready.");
      return machine.buffer;
    },
    clock
  );
  machine = new Machine(module, host.imports, 512, 512);
  machine.callExport("_initialize");
  machine.callExport("doom_init");
  const guest = machine;
  const held = /* @__PURE__ */ new Set();
  return {
    step() {
      guest.callExport("doom_tick");
    },
    key(action, pressed) {
      if (held.has(action) === pressed) return;
      const [result] = guest.callExport("doom_key", [
        pressed ? 1 : 0,
        keyCodes[action]
      ]);
      if (result !== 0) throw new Error("Doom input queue is full.");
      if (pressed) held.add(action);
      else held.delete(action);
    },
    frame: host.frame,
    snapshot() {
      const [address] = guest.callExport("doom_snapshot");
      if (typeof address !== "number" || address < 0 || address > guest.buffer.byteLength - 64 || address % 4 !== 0)
        throw new Error("Invalid Doom snapshot extent.");
      return Array.from(new Int32Array(guest.buffer, address, 16));
    },
    get statistics() {
      return { sequence: host.sequence };
    }
  };
}

// engine/pins.json
var pins_default = {
  schema: 1,
  engine: {
    bytes: 456566,
    sha256: "9f49010fb7ea8111346f315a6261806268f4fc70dd9b3d951b9a8eca3f3fbf82",
    revision: "e257a09527062bfb986b6e5e0780839b6cbd5b71",
    license: "GPL-3.0-only",
    sourceLicense: "GPL-2.0-or-later AND GPL-3.0-or-later AND GPL-3.0-only"
  },
  iwad: {
    bytes: 4196020,
    sha256: "1d7d43be501e67d927e415e0b8f3e29c3bf33075e859721816f652a526cac771",
    edition: "doom-1.9-shareware",
    license: "LicenseRef-DOOM-shareware",
    feed: {
      url: "https://gist.githubusercontent.com/ralphbibera/1a077d178d8544746423ddd84a2ca1ef/raw/8a5669e288bfa19ba9d08aaa0ba8be34f02113ef/manifest.json",
      bytes: 1715,
      sha256: "90215e77c9623360d404489c88826a5310fd2c5f566cb23e09184a0246ae56e1"
    }
  },
  sdk: {
    version: "27.0",
    compiler: "20.1.8-wasi-sdk",
    sourceRevision: "fbdec30656d4099da5c7fd7e8275e4af777ca97e",
    arm64MacArchiveSha256: "055c3dc2766772c38e71a05d353e35c322c7b2c6458a36a26a836f9808a550f8"
  },
  wasiLibcRevision: "3f7eb4c7d6ede4dde3c4bffa6ed14e8d656fe93f",
  compilerRtRevision: "87f0227cb60147a26a1eeb4fb06e3b505e9c7261"
};

// src/bundle.ts
var maxChunk = 3 * 1024 * 1024;
var maxArtifact = 16 * 1024 * 1024;
async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// src/runtime.ts
function parseEngineBytes(input) {
  if (!(input instanceof Uint8Array) || input.byteLength !== pins_default.engine.bytes || ![0, 97, 115, 109, 1, 0, 0, 0].every((byte, index) => input[index] === byte))
    throw new Error("Invalid bundled Doom engine.");
  return input;
}
function parseIwadBytes(input) {
  if (!(input instanceof Uint8Array) || input.byteLength !== pins_default.iwad.bytes || new TextDecoder().decode(input.subarray(0, 4)) !== "IWAD")
    throw new Error("Invalid Doom shareware data.");
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const count = view.getInt32(4, true);
  const directory = view.getInt32(8, true);
  if (count !== 1264 || directory < 12 || directory > input.byteLength - count * 16)
    throw new Error("Invalid Doom IWAD directory.");
  const maps = [];
  for (let index = 0; index < count; index++) {
    const offset = directory + index * 16;
    const start = view.getInt32(offset, true);
    const bytes = view.getInt32(offset + 4, true);
    if (start < 0 || bytes < 0 || start > input.byteLength - bytes)
      throw new Error("Doom IWAD lump is outside its resource.");
    const name = new TextDecoder().decode(input.subarray(offset + 8, offset + 16)).replace(/\0.*$/, "");
    if (/^E\dM\d$/.test(name)) maps.push(name);
  }
  if (maps.join(",") !== "E1M1,E1M2,E1M3,E1M4,E1M5,E1M6,E1M7,E1M8,E1M9")
    throw new Error("Unsupported Doom shareware episode.");
  return input;
}
async function validateGame(engineInput, iwadInput) {
  const engine2 = Uint8Array.from(parseEngineBytes(engineInput));
  const iwad = Uint8Array.from(parseIwadBytes(iwadInput));
  if (await sha256(engine2) !== pins_default.engine.sha256 || await sha256(iwad) !== pins_default.iwad.sha256)
    throw new Error(
      "The installed Doom artifacts do not match. Reinstall the addon."
    );
  return { engine: engine2, iwad };
}

// src/engine.ts
var DoomEngine = class {
  state = { kind: "empty" };
  held = /* @__PURE__ */ new Set();
  taps = /* @__PURE__ */ new Map();
  clock;
  constructor(clock = new ActiveClock()) {
    this.clock = clock;
  }
  async handle(input) {
    if (input.kind === "startup") {
      if (this.state.kind !== "empty")
        throw new Error("Doom has already started.");
      this.state = { kind: "starting" };
      try {
        const { engine: engine2, iwad } = await validateGame(input.engine, input.iwad);
        this.clock.set("running");
        const vm = boot(engine2, iwad, this.clock.read);
        this.clock.set("paused");
        this.state = { kind: "ready", vm, activity: "paused" };
        return { id: input.id, kind: "ready", engine: "doom" };
      } catch (error) {
        this.clock.set("paused");
        this.state = { kind: "failed" };
        throw error;
      }
    }
    const state = this.state;
    if (state.kind !== "ready") throw new Error("Doom is not ready.");
    if (input.kind === "activity") {
      for (const action of this.held) state.vm.key(action, false);
      this.held.clear();
      this.taps.clear();
      this.clock.set(input.activity);
      state.activity = input.activity;
      return { id: input.id, kind: "activity", activity: input.activity };
    }
    if (input.after > state.vm.statistics.sequence)
      throw new Error("Doom frame cursor is ahead of the engine.");
    if (state.activity === "paused" || input.activity === "paused")
      return {
        id: input.id,
        kind: "update",
        update: {
          kind: "paused",
          sequence: state.vm.statistics.sequence,
          elapsedMs: Math.floor(this.clock.read())
        }
      };
    const next = new Set(input.held);
    const startedAt = this.clock.read();
    for (const action of input.taps) this.taps.set(action, startedAt + 30);
    const latched = new Set(this.taps.keys());
    for (const action of this.held)
      if (!next.has(action) && !latched.has(action)) state.vm.key(action, false);
    for (const action of /* @__PURE__ */ new Set([...next, ...latched])) {
      if (!this.held.has(action) || input.taps.includes(action)) {
        if (this.held.has(action)) state.vm.key(action, false);
        state.vm.key(action, true);
      }
    }
    this.held = /* @__PURE__ */ new Set([...next, ...latched]);
    state.vm.step();
    for (const [action, releaseAfter] of this.taps)
      if (startedAt >= releaseAfter) {
        if (!next.has(action)) {
          state.vm.key(action, false);
          this.held.delete(action);
        }
        this.taps.delete(action);
      }
    const frame = state.vm.frame(input.after);
    const common = {
      sequence: state.vm.statistics.sequence,
      elapsedMs: Math.floor(this.clock.read())
    };
    return {
      id: input.id,
      kind: "update",
      update: frame ? { kind: "frame", ...frame, elapsedMs: common.elapsedMs } : { kind: "unchanged", ...common }
    };
  }
};

// src/doom.worker.ts
var engine = new DoomEngine();
self.addEventListener("message", (event) => {
  void respond(event.data);
});
async function respond(raw) {
  let id = 1;
  try {
    const input = parseWorkerCommand(raw);
    id = input.id;
    const reply = await engine.handle(input);
    const transfer = [];
    if (reply.kind === "update" && reply.update.kind === "frame") {
      const buffer = reply.update.pixels.buffer;
      if (!(buffer instanceof ArrayBuffer))
        throw new Error("Invalid Doom frame storage.");
      transfer.push(buffer);
    }
    self.postMessage(reply, transfer);
  } catch (error) {
    self.postMessage(
      {
        id,
        kind: "error",
        message: error instanceof Error ? error.message.slice(0, 500) : "Doom could not run. Close and reopen the game."
      },
      []
    );
  }
}
