// doom:bundle
var bundle_default = { schema: 2, engine: { bytes: 456566, sha256: "9f49010fb7ea8111346f315a6261806268f4fc70dd9b3d951b9a8eca3f3fbf82", chunks: [{ path: "assets/engine/000.json", jsonBytes: 608769, decodedBytes: 456566, sha256: "9f49010fb7ea8111346f315a6261806268f4fc70dd9b3d951b9a8eca3f3fbf82" }], abi: "doomgeneric-wasi-v1" }, iwad: { bytes: 4196020, sha256: "1d7d43be501e67d927e415e0b8f3e29c3bf33075e859721816f652a526cac771", edition: "doom-1.9-shareware", license: "LicenseRef-DOOM-shareware", feed: { url: "https://gist.githubusercontent.com/ralphbibera/1a077d178d8544746423ddd84a2ca1ef/raw/8a5669e288bfa19ba9d08aaa0ba8be34f02113ef/manifest.json", bytes: 1715, sha256: "90215e77c9623360d404489c88826a5310fd2c5f566cb23e09184a0246ae56e1" } }, source: { bytes: 3120915, sha256: "bead285f8452cbb68744c154a851a03576b5caebd7b228db35b3b3e544076a00", chunks: [{ path: "assets/source/000.json", jsonBytes: 4161233, decodedBytes: 3120915, sha256: "bead285f8452cbb68744c154a851a03576b5caebd7b228db35b3b3e544076a00" }], archive: "tar.gz", exportName: "hibi-doom-0.3.0-source.tar.gz" }, notices: { path: "LICENSES.md", bytes: 122467, sha256: "1a0cb17f087f0848fba5b7e2d6b4240e3cd76883dd2c86368c1c17b2fea7b020" } };

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
var hashPattern = /^[0-9a-f]{64}$/;
function record(value, fields2) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Doom bundle metadata.");
  const object2 = value;
  if (Object.keys(object2).length !== fields2.length || fields2.some((field) => !Object.hasOwn(object2, field)))
    throw new Error("Unexpected Doom bundle fields.");
  return object2;
}
function size(value, max) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > max)
    throw new Error("Invalid Doom bundle size.");
  return value;
}
function hash(value) {
  if (typeof value !== "string" || !hashPattern.test(value))
    throw new Error("Invalid Doom bundle digest.");
  return value;
}
function artifact(input, role) {
  const extra = role === "engine" ? ["abi"] : ["archive", "exportName"];
  const value = record(input, ["bytes", "sha256", "chunks", ...extra]);
  const bytes = size(value.bytes, maxArtifact);
  if (!Array.isArray(value.chunks) || value.chunks.length === 0 || value.chunks.length > 6)
    throw new Error("Invalid Doom bundle chunks.");
  const chunks = value.chunks.map((input2, index) => {
    const chunk = record(input2, ["path", "jsonBytes", "decodedBytes", "sha256"]);
    const decodedBytes = size(chunk.decodedBytes, maxChunk);
    const jsonBytes = size(chunk.jsonBytes, 5 * 1024 * 1024);
    if (chunk.path !== `assets/${role}/${String(index).padStart(3, "0")}.json` || jsonBytes !== 4 * Math.ceil(decodedBytes / 3) + 13)
      throw new Error("Invalid Doom chunk path or encoded size.");
    return Object.freeze({
      path: chunk.path,
      jsonBytes,
      decodedBytes,
      sha256: hash(chunk.sha256)
    });
  });
  if (chunks.reduce((sum, chunk) => sum + chunk.decodedBytes, 0) !== bytes)
    throw new Error("Doom chunk sizes do not match the artifact.");
  return {
    bytes,
    sha256: hash(value.sha256),
    chunks: Object.freeze(chunks),
    value
  };
}
function parseBundle(input) {
  const value = record(input, ["schema", "engine", "iwad", "source", "notices"]);
  const engine = artifact(value.engine, "engine");
  const iwad = record(value.iwad, [
    "bytes",
    "sha256",
    "edition",
    "license",
    "feed"
  ]);
  const feed = record(iwad.feed, ["url", "bytes", "sha256"]);
  const source = artifact(value.source, "source");
  const notices = record(value.notices, ["path", "bytes", "sha256"]);
  if (value.schema !== 2 || engine.value.abi !== "doomgeneric-wasi-v1" || engine.bytes > 1024 * 1024 || iwad.edition !== pins_default.iwad.edition || iwad.bytes !== pins_default.iwad.bytes || iwad.sha256 !== pins_default.iwad.sha256 || iwad.license !== pins_default.iwad.license || feed.url !== pins_default.iwad.feed.url || feed.bytes !== pins_default.iwad.feed.bytes || feed.sha256 !== pins_default.iwad.feed.sha256 || source.value.archive !== "tar.gz" || source.value.exportName !== "hibi-doom-0.3.0-source.tar.gz" || notices.path !== "LICENSES.md")
    throw new Error("Unsupported Doom bundle.");
  const common = ({ bytes, sha256: sha2562, chunks }) => ({
    bytes,
    sha256: sha2562,
    chunks
  });
  return Object.freeze({
    schema: 2,
    engine: Object.freeze({ ...common(engine), abi: "doomgeneric-wasi-v1" }),
    iwad: Object.freeze({
      ...pins_default.iwad,
      feed: Object.freeze({ ...pins_default.iwad.feed })
    }),
    source: Object.freeze({
      ...common(source),
      archive: "tar.gz",
      exportName: "hibi-doom-0.3.0-source.tar.gz"
    }),
    notices: Object.freeze({
      path: "LICENSES.md",
      bytes: size(notices.bytes, 512 * 1024),
      sha256: hash(notices.sha256)
    })
  });
}
async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function readPackageFile(path, expectedBytes, base, signal, fetchFile = fetch) {
  signal.throwIfAborted();
  const url = new URL(path, base);
  const directory = new URL(".", base);
  if (!/^(assets\/(engine|source)\/\d{3}\.json|LICENSES\.md)$/.test(path) || url.protocol !== directory.protocol || url.host !== directory.host || !url.pathname.startsWith(directory.pathname))
    throw new Error("Doom resource is outside its installed package.");
  const response = await fetchFile(url, {
    signal,
    credentials: "omit",
    redirect: "error"
  });
  if (!response.ok || !response.body)
    throw new Error(
      "The installed Doom package is incomplete. Reinstall the addon."
    );
  const length = response.headers.get("content-length");
  if (length !== null && Number(length) !== expectedBytes) {
    await response.body.cancel().catch(() => {
    });
    throw new Error("Doom package resource size does not match.");
  }
  const reader = response.body.getReader();
  const result = new Uint8Array(expectedBytes);
  let offset = 0;
  const abort = () => {
    void reader.cancel().catch(() => {
    });
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      if (chunk.value.byteLength > expectedBytes - offset)
        throw new Error("Doom package resource exceeds its size limit.");
      result.set(chunk.value, offset);
      offset += chunk.value.byteLength;
    }
    if (offset !== expectedBytes)
      throw new Error("Doom package resource is truncated.");
    return result;
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {
    });
    reader.releaseLock();
  }
}
async function loadArtifact(artifact2, base, signal, fetchFile = fetch) {
  const output = new Uint8Array(artifact2.bytes);
  let offset = 0;
  for (const chunk of artifact2.chunks) {
    const raw = await readPackageFile(
      chunk.path,
      chunk.jsonBytes,
      base,
      signal,
      fetchFile
    );
    const value = record(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)),
      ["base64"]
    );
    const encoded = value.base64;
    if (typeof encoded !== "string" || encoded.length !== 4 * Math.ceil(chunk.decodedBytes / 3) || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
      throw new Error("Invalid Doom resource encoding.");
    const decoded = atob(encoded);
    if (decoded.length !== chunk.decodedBytes || btoa(decoded) !== encoded)
      throw new Error("Noncanonical Doom resource encoding.");
    const bytes = Uint8Array.from(
      decoded,
      (character) => character.charCodeAt(0)
    );
    if (await sha256(bytes) !== chunk.sha256)
      throw new Error("Doom resource chunk digest does not match.");
    signal.throwIfAborted();
    output.set(bytes, offset);
    offset += bytes.byteLength;
  }
  if (await sha256(output) !== artifact2.sha256)
    throw new Error("Doom artifact digest does not match.");
  signal.throwIfAborted();
  return output;
}

// src/input.ts
var keys = {
  KeyW: "forward",
  ArrowUp: "forward",
  KeyS: "backward",
  ArrowDown: "backward",
  KeyA: "turnLeft",
  ArrowLeft: "turnLeft",
  KeyD: "turnRight",
  ArrowRight: "turnRight",
  Comma: "strafeLeft",
  Period: "strafeRight",
  KeyF: "fire",
  Space: "use",
  ShiftLeft: "run",
  ShiftRight: "run",
  Enter: "enter",
  Escape: "escape",
  Tab: "map"
};
var GameInput = class {
  codes = /* @__PURE__ */ new Set();
  taps = /* @__PURE__ */ new Set();
  epoch = 0;
  press(code, repeat) {
    const action = keys[code];
    if (!action || repeat || this.codes.has(code)) return;
    const alreadyHeld = [...this.codes].some((key) => keys[key] === action);
    this.codes.add(code);
    if (!alreadyHeld) this.taps.add(action);
  }
  release(code) {
    return this.codes.delete(code);
  }
  clear() {
    this.codes.clear();
    this.taps.clear();
    this.epoch++;
  }
  take() {
    const held = [...new Set([...this.codes].map((code) => keys[code]))].filter(
      (action) => action !== void 0
    );
    const taps = [...this.taps];
    this.taps.clear();
    return { held, taps };
  }
};

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
  const engine = Uint8Array.from(parseEngineBytes(engineInput));
  const iwad = Uint8Array.from(parseIwadBytes(iwadInput));
  if (await sha256(engine) !== pins_default.engine.sha256 || await sha256(iwad) !== pins_default.iwad.sha256)
    throw new Error(
      "The installed Doom artifacts do not match. Reinstall the addon."
    );
  return { engine, iwad };
}

// src/iwad.ts
var maxTextBytes = 1024 * 1024;
var partBytes = 516096;
var partCount = 9;
var hashPattern2 = /^[0-9a-f]{64}$/;
var manifestUrl = new URL(pins_default.iwad.feed.url);
var baseUrl = new URL(".", manifestUrl);
function record2(value, fields2) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Doom shareware feed.");
  const object2 = value;
  if (Object.keys(object2).length !== fields2.length || fields2.some((field) => !Object.hasOwn(object2, field)))
    throw new Error("Unexpected Doom shareware feed fields.");
  return object2;
}
function parseIwadManifest(input) {
  const value = record2(input, [
    "schema",
    "edition",
    "bytes",
    "sha256",
    "encoding",
    "license",
    "parts",
    "terms"
  ]);
  if (value.schema !== 1 || value.edition !== pins_default.iwad.edition || value.bytes !== pins_default.iwad.bytes || value.sha256 !== pins_default.iwad.sha256 || value.encoding !== "base64" || value.license !== pins_default.iwad.license || !Array.isArray(value.parts) || value.parts.length !== partCount || !Array.isArray(value.terms) || value.terms.length !== 2 || value.terms[0] !== "shareware-debian-terms.txt" || value.terms[1] !== "shareware-netbsd-terms.txt")
    throw new Error("Unsupported Doom shareware feed.");
  return Object.freeze(
    value.parts.map((input2, index) => {
      const part = record2(input2, ["path", "bytes", "sha256"]);
      const expectedBytes = Math.min(
        partBytes,
        pins_default.iwad.bytes - index * partBytes
      );
      if (part.path !== `doom1-part-${String(index).padStart(2, "0")}.json` || part.bytes !== expectedBytes || typeof part.sha256 !== "string" || !hashPattern2.test(part.sha256))
        throw new Error("Invalid Doom shareware part path, size, or digest.");
      return Object.freeze({
        path: part.path,
        bytes: expectedBytes,
        sha256: part.sha256
      });
    })
  );
}
function decodeBase64(encoded, expectedBytes) {
  if (typeof encoded !== "string" || encoded.length !== 4 * Math.ceil(expectedBytes / 3) || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
    throw new Error("Invalid Doom shareware encoding.");
  const decoded = atob(encoded);
  if (decoded.length !== expectedBytes || btoa(decoded) !== encoded)
    throw new Error("Noncanonical Doom shareware encoding.");
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}
async function verifiedIwad(encoded) {
  const bytes = decodeBase64(encoded, pins_default.iwad.bytes);
  if (await sha256(bytes) !== pins_default.iwad.sha256)
    throw new Error("Doom shareware data digest does not match.");
  parseIwadBytes(bytes);
  return bytes;
}
function validResponseUrl(input, path) {
  const url = new URL(input);
  const expected = new URL(path, baseUrl);
  const prefix = baseUrl.pathname.replace(/[^/]+\/$/, "");
  const remainder = url.pathname.slice(prefix.length).split("/");
  return url.origin === expected.origin && url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && url.pathname.startsWith(prefix) && remainder.length === 2 && /^[0-9a-f]{40}$/.test(remainder[0] ?? "") && remainder[1] === path;
}
async function downloadIwad({
  network,
  signal,
  progress = () => {
  },
  current = () => {
  }
}) {
  const check = () => {
    signal.throwIfAborted();
    current();
  };
  const text = async (path, expectedBytes) => {
    check();
    const result = await network.getText({ url: new URL(path, baseUrl).href });
    check();
    if (!result.ok)
      throw new Error(
        `Doom could not download its shareware data (${result.code}). Check your connection, then close and reopen the game.`
      );
    const response = result.value;
    if (response.status !== 200 || !validResponseUrl(response.url, path) || response.text.includes("\0") || expectedBytes > maxTextBytes || new TextEncoder().encode(response.text).byteLength !== expectedBytes)
      throw new Error(
        "Doom shareware response exceeds its bounds or has an unexpected address or status."
      );
    return response.text;
  };
  const manifest = await text("manifest.json", pins_default.iwad.feed.bytes);
  if (await sha256(new TextEncoder().encode(manifest)) !== pins_default.iwad.feed.sha256)
    throw new Error("Doom shareware manifest digest does not match.");
  check();
  const parts = parseIwadManifest(JSON.parse(manifest));
  const output = new Uint8Array(pins_default.iwad.bytes);
  const encodedParts = [];
  let offset = 0;
  progress({
    kind: "downloading",
    completedBytes: 0,
    totalBytes: pins_default.iwad.bytes
  });
  for (const part of parts) {
    const raw = await text(part.path, 4 * Math.ceil(part.bytes / 3) + 14);
    const value = record2(JSON.parse(raw), ["base64"]);
    const bytes = decodeBase64(value.base64, part.bytes);
    if (await sha256(bytes) !== part.sha256)
      throw new Error("Doom shareware part digest does not match.");
    check();
    output.set(bytes, offset);
    offset += bytes.byteLength;
    if (typeof value.base64 !== "string")
      throw new Error("Invalid shareware encoding.");
    encodedParts.push(value.base64);
    progress({
      kind: "downloading",
      completedBytes: offset,
      totalBytes: pins_default.iwad.bytes
    });
  }
  progress({ kind: "verifying" });
  if (offset !== pins_default.iwad.bytes || await sha256(output) !== pins_default.iwad.sha256)
    throw new Error("Doom shareware data digest does not match.");
  parseIwadBytes(output);
  check();
  return { bytes: output, base64: encodedParts.join("") };
}
var IwadCache = class {
  generation = 0;
  handle = null;
  pendingWrite = Promise.resolve();
  storage;
  network;
  constructor(context) {
    this.storage = context.storage;
    this.network = context.host.network;
  }
  open() {
    this.handle ??= this.storage.global("iwad-cache", 1);
    return this.handle;
  }
  write(handle, value, current) {
    const writing = this.pendingWrite.catch(() => {
    }).then(() => {
      current();
      return handle.set(value);
    });
    this.pendingWrite = writing;
    return writing;
  }
  async load(signal, progress) {
    const generation = this.generation;
    const current = () => {
      signal.throwIfAborted();
      if (generation !== this.generation)
        throw new Error(
          "Cached game data was cleared. Close and reopen the game."
        );
    };
    progress({ kind: "checking" });
    let handle = null;
    try {
      handle = await this.open();
    } catch {
    }
    current();
    let snapshot = null;
    try {
      snapshot = handle?.snapshot() ?? null;
    } catch {
    }
    if (snapshot?.status === "ready" && snapshot.value !== null) {
      try {
        const cache = record2(snapshot.value, [
          "schema",
          "bytes",
          "sha256",
          "base64"
        ]);
        if (cache.schema !== 1 || cache.bytes !== pins_default.iwad.bytes || cache.sha256 !== pins_default.iwad.sha256)
          throw new Error("Cached Doom shareware metadata does not match.");
        const bytes = await verifiedIwad(cache.base64);
        current();
        return { bytes, source: "cache", persistent: true };
      } catch (error) {
        current();
        if (!(error instanceof Error)) throw error;
      }
    }
    const game = await downloadIwad({
      network: this.network,
      signal,
      progress,
      current
    });
    current();
    let persistent = false;
    if (handle && (snapshot?.status === "ready" || snapshot?.status === "missing")) {
      try {
        persistent = (await this.write(
          handle,
          {
            schema: 1,
            bytes: pins_default.iwad.bytes,
            sha256: pins_default.iwad.sha256,
            base64: game.base64
          },
          current
        )).status === "saved";
      } catch {
      }
    }
    current();
    return { bytes: game.bytes, source: "download", persistent };
  }
  async clear() {
    this.generation++;
    const handle = await this.open();
    const result = await this.write(handle, null, () => {
    });
    if (result.status !== "saved")
      throw new Error(
        "Hibi could not clear cached game data. Close the game and try again."
      );
  }
};

// src/model.ts
var width = 640;
var height = 400;
var frameBytes = width * height * 4;
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
function parseFrameUpdate(input) {
  const value = object(input);
  const sequence = integer(value.sequence);
  const elapsedMs = integer(value.elapsedMs);
  if (value.kind === "unchanged" || value.kind === "paused") {
    fields(value, ["kind", "sequence", "elapsedMs"]);
    return { kind: value.kind, sequence, elapsedMs };
  }
  fields(value, ["kind", "sequence", "elapsedMs", "width", "height", "pixels"]);
  if (value.kind !== "frame" || value.width !== width || value.height !== height || !(value.pixels instanceof Uint8Array) || value.pixels.byteLength !== frameBytes)
    throw new Error("Invalid Doom RGBA frame.");
  return {
    kind: "frame",
    sequence,
    elapsedMs,
    width,
    height,
    pixels: value.pixels
  };
}
function parseWorkerReply(input) {
  const value = object(input);
  const id = requestId(value.id);
  switch (value.kind) {
    case "ready":
      fields(value, ["id", "kind", "engine"]);
      if (value.engine !== "doom")
        throw new Error("Invalid Doom worker readiness.");
      return { id, kind: "ready", engine: "doom" };
    case "activity":
      fields(value, ["id", "kind", "activity"]);
      return { id, kind: "activity", activity: activity(value.activity) };
    case "update":
      fields(value, ["id", "kind", "update"]);
      return { id, kind: "update", update: parseFrameUpdate(value.update) };
    case "error":
      fields(value, ["id", "kind", "message"]);
      if (typeof value.message !== "string" || value.message.length === 0 || value.message.length > 500)
        throw new Error("Invalid Doom worker failure.");
      return { id, kind: "error", message: value.message };
    default:
      throw new Error("Invalid Doom worker reply.");
  }
}

// src/session.ts
var GameSession = class {
  worker;
  nextId = 0;
  pending = /* @__PURE__ */ new Map();
  failure = null;
  timeoutMs;
  constructor(worker, timeoutMs = 15e3) {
    this.worker = worker;
    this.timeoutMs = timeoutMs;
    worker.addEventListener("message", this.receive);
    worker.addEventListener("error", this.workerError);
    worker.addEventListener("messageerror", this.workerError);
  }
  get disposed() {
    return this.worker === null;
  }
  request(input, transfer = []) {
    const worker = this.worker;
    if (!worker)
      return Promise.reject(
        this.failure ?? new Error("Doom session ended. Close and reopen the game.")
      );
    if (this.pending.size >= 2 || [...this.pending.values()].some((entry) => entry.kind === input.kind))
      return Promise.reject(new Error("Doom already has a pending request."));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.dispose(
          new Error("Doom stopped responding. Close and reopen the game.")
        );
      }, this.timeoutMs);
      this.pending.set(id, { kind: input.kind, resolve, reject, timer });
      try {
        worker.postMessage({ id, ...input }, transfer);
      } catch (error) {
        this.dispose(
          error instanceof Error ? error : new Error("Hibi could not send Doom input.")
        );
      }
    });
  }
  dispose(error = new Error("Doom session ended.")) {
    const worker = this.worker;
    if (!worker) return;
    this.worker = null;
    this.failure = error;
    worker.removeEventListener("message", this.receive);
    worker.removeEventListener("error", this.workerError);
    worker.removeEventListener("messageerror", this.workerError);
    worker.terminate();
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }
  workerError = () => {
    this.dispose(
      new Error("The Doom worker failed. Close and reopen the game.")
    );
  };
  receive = (event) => {
    try {
      const reply = parseWorkerReply(event.data);
      const entry = this.pending.get(reply.id);
      if (!entry) throw new Error("Doom returned an unexpected request ID.");
      if (reply.kind === "error") {
        this.dispose(new Error(reply.message));
        return;
      }
      if (entry.kind === "startup" && reply.kind !== "ready" || entry.kind === "activity" && reply.kind !== "activity" || entry.kind === "frame" && reply.kind !== "update")
        throw new Error("Doom returned an unexpected response.");
      this.pending.delete(reply.id);
      clearTimeout(entry.timer);
      entry.resolve(reply);
    } catch (error) {
      this.dispose(
        error instanceof Error ? error : new Error("Invalid Doom worker response.")
      );
    }
  };
};

// src/source-export.ts
var SourceExport = class {
  state = { kind: "idle" };
  io;
  source;
  base;
  changed;
  fetchFile;
  constructor(io, source, base, changed, fetchFile = fetch) {
    this.io = io;
    this.source = source;
    this.base = base;
    this.changed = changed;
    this.fetchFile = fetchFile;
  }
  set(state) {
    this.state = state;
    this.changed(state);
  }
  get disposed() {
    return this.state.kind === "disposed";
  }
  dispose() {
    if (this.state.kind === "disposed") return;
    if (this.state.kind === "loading") this.state.abort.abort();
    if (this.state.kind === "writing" || this.state.kind === "cleanup")
      void this.io.cancel(this.state.handle).catch(() => {
      });
    this.state = { kind: "disposed" };
  }
  async save() {
    if (!["idle", "saved", "failed"].includes(this.state.kind)) return;
    const abort = new AbortController();
    this.set({ kind: "loading", abort });
    let handle = null;
    let terminal = { kind: "idle" };
    try {
      const bytes = await loadArtifact(
        this.source,
        this.base,
        abort.signal,
        this.fetchFile
      );
      if (this.disposed) return;
      this.set({ kind: "choosing" });
      const selected = await this.io.selectExport({
        suggestedName: "hibi-doom-0.3.0-source.tar.gz",
        extension: "gz"
      });
      if (selected.ok && selected.value) handle = selected.value.handle;
      if (this.disposed) return;
      if (!selected.ok)
        throw new Error(
          selected.code === "busy" ? "Finish the current file operation, then save the source again." : selected.code === "conflict" ? "A file already exists at this destination. Choose another name." : "Hibi could not choose a source destination. Try again."
        );
      if (!selected.value) return;
      this.set({ kind: "writing", handle: selected.value.handle });
      const written = await this.io.writeExport(selected.value.handle, bytes);
      if (this.disposed) return;
      if (!written.ok)
        throw new Error(
          written.code === "conflict" ? "A file already exists at this destination. Choose another name." : written.code === "busy" ? "Finish the current file operation, then save the source again." : "Hibi could not save the source. Choose another destination."
        );
      terminal = { kind: "saved" };
    } catch (error) {
      terminal = {
        kind: "failed",
        message: error instanceof Error ? error.message : "The source could not be saved."
      };
    } finally {
      if (handle) {
        if (!this.disposed) this.set({ kind: "cleanup", handle });
        await this.io.cancel(handle).catch(() => {
        });
      }
      if (!this.disposed) this.set(terminal);
    }
  }
};

// src/style.css
var style_default = ".hibi-doom {\n  height: 100%;\n  min-height: 0;\n  display: flex;\n  flex-direction: column;\n  color: var(--ink);\n  background: var(--background);\n}\n.hibi-doom-controls {\n  padding: 8px 12px;\n  flex: 0 0 auto;\n}\n.hibi-doom-legal {\n  flex: 0 0 auto;\n  padding: 4px 12px;\n  font-size: var(--text-sm);\n  color: var(--muted);\n}\n.hibi-doom-legal span {\n  flex: 1;\n}\n.hibi-doom-cache-warning {\n  margin: 0;\n  padding: 4px 12px;\n  font-size: var(--text-sm);\n}\n.hibi-doom-controls span {\n  flex: 1;\n  font-size: var(--text-sm);\n  color: var(--muted);\n}\n.hibi-doom-screen {\n  flex: 1;\n  min-height: 0;\n  position: relative;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  overflow: hidden;\n  background: #000;\n}\n.hibi-doom-screen canvas {\n  display: block;\n  width: 100%;\n  height: 100%;\n  object-fit: contain;\n  image-rendering: pixelated;\n}\n.hibi-doom-screen canvas:focus-visible {\n  outline: 2px solid var(--accent);\n  outline-offset: -2px;\n}\n.hibi-doom-message {\n  position: absolute;\n  inset: 0;\n  display: flex;\n  flex-direction: column;\n  align-items: center;\n  justify-content: center;\n  gap: 12px;\n  padding: 24px;\n  background: var(--background);\n  color: var(--ink);\n  text-align: center;\n}\n.hibi-doom-message p {\n  max-width: 48rem;\n}\n.hibi-doom-paused {\n  position: absolute;\n  bottom: 16px;\n  padding: 8px 12px;\n  background: var(--surface);\n  color: var(--ink);\n  border-radius: var(--radius-control);\n  pointer-events: none;\n}\n.hibi-doom-licenses {\n  height: 100%;\n  overflow: auto;\n  padding: 16px;\n  color: var(--ink);\n}\n.hibi-doom-notices {\n  white-space: pre-wrap;\n  overflow-wrap: anywhere;\n  font-family: var(--font-mono);\n  font-size: var(--text-sm);\n}\n";

// src/index.tsx
var disposed = (owner) => owner.state.kind === "disposed";
var bundle = parseBundle(bundle_default);
var packageBase = new URL(import.meta.url);
var create = (sdk) => {
  const React = sdk.React;
  const ui = sdk.ui;
  if (!React || !ui) throw new Error("Doom requires Hibi's UI capability.");
  const { useEffect, useRef, useState } = React;
  const { Button, ControlRow, Panel, PanelMessage } = ui;
  const cleanups = /* @__PURE__ */ new Set();
  function DoomTab({
    openLicenses,
    visible,
    close,
    cache
  }) {
    const canvas = useRef(null);
    const input = useRef(new GameInput());
    const lifetime = useRef(null);
    const wake = useRef(() => {
    });
    const [display, setDisplay] = useState({
      kind: "loading",
      abort: new AbortController(),
      progress: { kind: "checking" }
    });
    const [paused, setPaused] = useState(false);
    const [canvasFocused, setCanvasFocused] = useState(false);
    const [focused, setFocused] = useState(document.hasFocus());
    const [documentVisible, setDocumentVisible] = useState(
      document.visibilityState === "visible"
    );
    const desired = display.kind === "ready" && visible && focused && documentVisible && canvasFocused && !paused ? "running" : "paused";
    const activity2 = useRef(desired);
    activity2.current = desired;
    function releaseInput() {
      input.current.clear();
      activity2.current = "paused";
      wake.current();
    }
    useEffect(() => {
      const owner = {
        state: {
          kind: "loading",
          abort: new AbortController(),
          progress: { kind: "checking" }
        }
      };
      lifetime.current = owner;
      setDisplay(owner.state);
      const blur = () => {
        releaseInput();
        setFocused(false);
      };
      const focus = () => setFocused(true);
      const visibility = () => {
        const shown = document.visibilityState === "visible";
        if (!shown) releaseInput();
        setDocumentVisible(shown);
      };
      const dispose = () => {
        if (disposed(owner)) return;
        releaseInput();
        if (owner.state.kind === "loading") owner.state.abort.abort();
        if (owner.state.kind === "starting" || owner.state.kind === "ready")
          owner.state.session.dispose();
        owner.state = { kind: "disposed" };
        window.removeEventListener("blur", blur);
        window.removeEventListener("focus", focus);
        document.removeEventListener("visibilitychange", visibility);
        cleanups.delete(dispose);
      };
      cleanups.add(dispose);
      window.addEventListener("blur", blur);
      window.addEventListener("focus", focus);
      document.addEventListener("visibilitychange", visibility);
      void startGame(owner);
      return dispose;
    }, []);
    useEffect(() => {
      if (visible && display.kind === "ready" && document.visibilityState === "visible")
        canvas.current?.focus();
    }, [visible, display.kind]);
    useEffect(() => {
      if (desired === "paused") input.current.clear();
      wake.current();
    }, [desired]);
    useEffect(() => {
      if (display.kind !== "ready") return;
      const session = display.session;
      let canceled = false;
      let timer;
      let releaseWait;
      let acknowledged = {
        activity: "paused",
        epoch: input.current.epoch
      };
      let after = 0;
      const wait = (milliseconds) => new Promise((resolve) => {
        releaseWait = resolve;
        if (milliseconds !== void 0)
          timer = setTimeout(resolve, milliseconds);
      });
      const wakeLoop = () => {
        clearTimeout(timer);
        timer = void 0;
        const release = releaseWait;
        releaseWait = void 0;
        release?.();
      };
      wake.current = wakeLoop;
      const run = async () => {
        try {
          while (!canceled && !session.disposed) {
            const desiredActivity = activity2.current;
            if (acknowledged.activity !== desiredActivity || acknowledged.epoch !== input.current.epoch) {
              const epoch2 = input.current.epoch;
              const reply2 = await session.request({
                kind: "activity",
                activity: desiredActivity
              });
              if (canceled) break;
              if (reply2.kind !== "activity" || reply2.activity !== desiredActivity)
                throw new Error(
                  "Doom could not change activity. Close and reopen the game."
                );
              acknowledged = { activity: desiredActivity, epoch: epoch2 };
              continue;
            }
            if (desiredActivity === "paused") {
              await wait();
              continue;
            }
            const startedAt = performance.now();
            const epoch = input.current.epoch;
            const reply = await session.request({
              kind: "frame",
              activity: "running",
              ...input.current.take(),
              after
            });
            if (canceled) break;
            if (epoch !== input.current.epoch || activity2.current !== "running")
              continue;
            if (reply.kind !== "update")
              throw new Error(
                "Doom returned an invalid frame. Close and reopen the game."
              );
            const update = reply.update;
            if (update.kind === "frame") {
              const element = canvas.current;
              const drawing = element?.getContext("2d", { alpha: false });
              if (!element || !drawing)
                throw new Error(
                  "Hibi could not display the game. Close and reopen the game."
                );
              drawing.putImageData(
                new ImageData(
                  new Uint8ClampedArray(update.pixels),
                  width,
                  height
                ),
                0,
                0
              );
              after = update.sequence;
              element.dataset.sequence = String(update.sequence);
              element.dataset.gameTime = String(update.elapsedMs);
            }
            await wait(Math.max(0, 16 - (performance.now() - startedAt)));
          }
        } catch (error) {
          if (!canceled && lifetime.current?.state.kind !== "disposed")
            setDisplay({
              kind: "failed",
              message: error instanceof Error ? error.message : "Doom could not run. Close and reopen the game."
            });
        } finally {
          session.dispose();
        }
      };
      void run();
      return () => {
        canceled = true;
        input.current.clear();
        wakeLoop();
        session.dispose();
      };
    }, [display]);
    async function startGame(owner) {
      if (owner.state.kind !== "loading") return;
      const abort = owner.state.abort;
      try {
        const engineBytes = await loadArtifact(
          bundle.engine,
          packageBase,
          abort.signal
        );
        const data = await cache.load(abort.signal, (progress) => {
          if (owner.state.kind !== "loading" || abort.signal.aborted) return;
          owner.state = { kind: "loading", abort, progress };
          setDisplay(owner.state);
        });
        const { engine, iwad } = await validateGame(engineBytes, data.bytes);
        abort.signal.throwIfAborted();
        if (disposed(owner)) return;
        const session = new GameSession(
          new Worker(new URL("./doom.worker.js", import.meta.url), {
            type: "module"
          })
        );
        owner.state = { kind: "starting", session };
        setDisplay(owner.state);
        const reply = await session.request({ kind: "startup", engine, iwad }, [
          engine.buffer,
          iwad.buffer
        ]);
        if (disposed(owner)) return;
        if (reply.kind !== "ready")
          throw new Error("Doom could not start. Close and reopen the game.");
        setPaused(false);
        owner.state = {
          kind: "ready",
          session,
          dataSource: data.source,
          persistent: data.persistent
        };
        setDisplay(owner.state);
      } catch (error) {
        if (owner.state.kind === "starting" || owner.state.kind === "ready")
          owner.state.session.dispose();
        if (!disposed(owner)) {
          owner.state = {
            kind: "failed",
            message: error instanceof Error ? error.message : "Doom could not start. Close and reopen the game."
          };
          setDisplay(owner.state);
        }
      }
    }
    function keyboard(event, down) {
      if (!down && input.current.release(event.code)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.code === "Tab" && event.shiftKey) return;
      if (!keys[event.code] || event.metaKey || event.altKey || activity2.current !== "running")
        return;
      event.preventDefault();
      event.stopPropagation();
      if (down) input.current.press(event.code, event.repeat);
    }
    return /* @__PURE__ */ React.createElement(
      "section",
      {
        className: "hibi-doom",
        "aria-label": "Doom game",
        "data-state": display.kind,
        "data-data-source": display.kind === "ready" ? display.dataSource : void 0,
        "data-cache-persistent": display.kind === "ready" ? String(display.persistent) : void 0
      },
      /* @__PURE__ */ React.createElement(ControlRow, { className: "hibi-doom-controls" }, /* @__PURE__ */ React.createElement(
        Button,
        {
          disabled: display.kind !== "ready",
          onClick: () => {
            if (paused) {
              setPaused(false);
              canvas.current?.focus();
            } else {
              releaseInput();
              setPaused(true);
            }
          }
        },
        paused ? "Resume" : "Pause"
      ), /* @__PURE__ */ React.createElement("span", null, "Click the game to play. Arrows or WASD move, F fires, Space uses, and Enter selects. Shift+Tab leaves the game."), /* @__PURE__ */ React.createElement(Button, { variant: "ghost", onClick: close }, "Close game")),
      /* @__PURE__ */ React.createElement("div", { className: "hibi-doom-screen" }, /* @__PURE__ */ React.createElement(
        "canvas",
        {
          ref: canvas,
          width,
          height,
          tabIndex: display.kind === "ready" ? 0 : -1,
          "aria-label": "Doom canvas",
          onFocus: () => setCanvasFocused(true),
          onBlur: () => {
            releaseInput();
            setCanvasFocused(false);
          },
          onClick: () => {
            setPaused(false);
            canvas.current?.focus();
          },
          onKeyDown: (event) => keyboard(event, true),
          onKeyUp: (event) => keyboard(event, false)
        }
      ), display.kind !== "ready" && /* @__PURE__ */ React.createElement("div", { className: "hibi-doom-message" }, /* @__PURE__ */ React.createElement(
        PanelMessage,
        {
          icon: "",
          title: display.kind === "failed" ? "Could not play Doom" : display.kind === "starting" ? "Starting Doom..." : display.kind === "loading" && display.progress.kind === "downloading" ? "Downloading Doom shareware..." : display.kind === "loading" && display.progress.kind === "verifying" ? "Verifying Doom shareware..." : "Loading Doom...",
          role: display.kind === "failed" ? "alert" : "status",
          loading: display.kind === "starting" || display.kind === "loading"
        },
        display.kind === "failed" ? display.message : display.kind === "loading" && display.progress.kind === "downloading" ? `${Math.floor(display.progress.completedBytes / display.progress.totalBytes * 100)}% downloaded. The unchanged shareware episode is saved for offline play.` : "The first Play downloads the shareware episode automatically. Later games use verified cached data."
      )), display.kind === "ready" && desired === "paused" && visible && /* @__PURE__ */ React.createElement("div", { className: "hibi-doom-paused", "aria-live": "polite" }, "Paused. Click the game to resume.")),
      display.kind === "ready" && !display.persistent && /* @__PURE__ */ React.createElement("p", { className: "hibi-doom-cache-warning", role: "status" }, "The game is ready, but Hibi could not save its data. Connect again next time."),
      /* @__PURE__ */ React.createElement(ControlRow, { className: "hibi-doom-legal" }, /* @__PURE__ */ React.createElement("span", null, "Doom engine. Copyright id Software, Simon Howard, and contributors. GNU GPL version 3 only. No warranty. Redistribution permitted under GPL."), /* @__PURE__ */ React.createElement(Button, { variant: "ghost", onClick: openLicenses }, "License and source"))
    );
  }
  function LicensesTab({
    context,
    close,
    cache
  }) {
    const [notices, setNotices] = useState(null);
    const [noticeFailure, setNoticeFailure] = useState(null);
    const [exportState, setExportState] = useState({
      kind: "idle"
    });
    const exporter = useRef(null);
    const [cacheState, setCacheState] = useState("idle");
    const mounted = useRef(false);
    useEffect(() => {
      const abort = new AbortController();
      mounted.current = true;
      const source = new SourceExport(
        context.host.selectedIo,
        bundle.source,
        packageBase,
        setExportState
      );
      exporter.current = source;
      const dispose = () => {
        abort.abort();
        mounted.current = false;
        source.dispose();
        exporter.current = null;
        cleanups.delete(dispose);
      };
      cleanups.add(dispose);
      void (async () => {
        try {
          const bytes = await readPackageFile(
            bundle.notices.path,
            bundle.notices.bytes,
            packageBase,
            abort.signal
          );
          if (await sha256(bytes) !== bundle.notices.sha256)
            throw new Error("The installed license notices do not match.");
          abort.signal.throwIfAborted();
          setNotices(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        } catch (error) {
          if (!abort.signal.aborted)
            setNoticeFailure(
              error instanceof Error ? error.message : "The license notices could not be read."
            );
        }
      })();
      return dispose;
    }, [context]);
    const busy = exportState.kind === "loading" || exportState.kind === "choosing" || exportState.kind === "writing" || exportState.kind === "cleanup";
    return /* @__PURE__ */ React.createElement(
      "section",
      {
        className: "hibi-doom-licenses",
        "aria-label": "Doom license and source"
      },
      /* @__PURE__ */ React.createElement(Panel, null, /* @__PURE__ */ React.createElement("h2", null, "Doom license and source"), /* @__PURE__ */ React.createElement("p", null, "The Doom engine is copyright id Software, Simon Howard, and contributors. Hibi Doom project code and the bundled engine use GNU GPL version 3 only and come with absolutely no warranty. You may redistribute them under that license."), /* @__PURE__ */ React.createElement("p", null, "Doom 1.9 shareware data is downloaded from a separate public feed on first Play. Its separate id Software terms require unchanged data and free distribution."), /* @__PURE__ */ React.createElement("p", null, "The complete corresponding source and dependency notices are included in this addon. Save the archive to inspect or rebuild this version without repository access."), /* @__PURE__ */ React.createElement("p", null, "The source archive contains code and build inputs. It contains no shareware data. Cached game data stays on this device after removal of the addon. Clear it here to require a download on the next Play."), /* @__PURE__ */ React.createElement(ControlRow, null, /* @__PURE__ */ React.createElement(
        Button,
        {
          disabled: busy,
          onClick: () => void exporter.current?.save()
        },
        "Save corresponding source"
      ), /* @__PURE__ */ React.createElement(Button, { variant: "ghost", onClick: close }, "Close license")), /* @__PURE__ */ React.createElement("p", { role: exportState.kind === "failed" ? "alert" : "status" }, exportState.kind === "failed" ? exportState.message : exportState.kind === "saved" ? "The corresponding source was saved." : busy ? "Preparing or saving corresponding source..." : "Source export creates a new file."), /* @__PURE__ */ React.createElement(ControlRow, null, /* @__PURE__ */ React.createElement(
        Button,
        {
          disabled: cacheState === "clearing",
          onClick: () => {
            setCacheState("clearing");
            void cache.clear().then(
              () => {
                if (mounted.current) setCacheState("cleared");
              },
              () => {
                if (mounted.current) setCacheState("failed");
              }
            );
          }
        },
        "Clear cached game data"
      ), /* @__PURE__ */ React.createElement("span", { role: cacheState === "failed" ? "alert" : "status" }, cacheState === "cleared" ? "Cached game data was cleared. Close and reopen the game to download it again." : cacheState === "failed" ? "Hibi could not clear cached game data. Close the game and try again." : cacheState === "clearing" ? "Clearing cached game data..." : "Clearing cached data does not end a running game.")), noticeFailure ? /* @__PURE__ */ React.createElement(PanelMessage, { icon: "", title: "Could not read notices", role: "alert" }, noticeFailure) : notices ? /* @__PURE__ */ React.createElement("section", { "aria-label": "Complete license notices" }, /* @__PURE__ */ React.createElement("pre", { className: "hibi-doom-notices" }, notices)) : /* @__PURE__ */ React.createElement(PanelMessage, { icon: "", title: "Loading notices...", loading: true }))
    );
  }
  return {
    start(context) {
      const cache = new IwadCache(context);
      context.styles.register("game", style_default);
      const licenses = context.views.register({
        id: "licenses",
        label: "Doom license and source",
        location: "tab",
        lifetime: "session",
        Content: (props) => /* @__PURE__ */ React.createElement(LicensesTab, { context, cache, ...props })
      });
      const openLicenses = () => {
        licenses.open({ id: "licenses", focus: true });
      };
      const view = context.views.register({
        id: "game",
        label: "Doom",
        location: "tab",
        lifetime: "session",
        Content: (props) => /* @__PURE__ */ React.createElement(DoomTab, { openLicenses, cache, ...props })
      });
      context.commands.register({
        id: "licenses",
        label: "Doom license and source",
        menu: { location: "app" },
        run: openLicenses
      });
      context.commands.register({
        id: "play",
        label: "Play Doom",
        menu: { location: "app" },
        run: () => {
          view.open({ id: "game", focus: true });
        }
      });
    },
    stop() {
      for (const dispose of [...cleanups]) dispose();
    }
  };
};
var src_default = create;
export {
  src_default as default
};
