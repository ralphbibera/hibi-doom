import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:https'
import { availableParallelism, cpus, loadavg, platform, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readTarGz } from '../scripts/archive.mjs'
import { parseBundle, sourceExportName } from '../src/bundle.ts'
import { canvasEvidence } from './pixels.mjs'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const initialAmmoSha256 =
  '97379d2f3f1342b74993fad1b6b051091f8b6ecd333d1060ada9d754fdad38e9'
const hostRevision = '7a137cfe9d6c6bc0fbb78cb4169bd71ccd09ca0b'
const ioChannels = [
  'host-selected-io:select-import',
  'host-selected-io:read-import',
  'host-selected-io:select-export',
  'host-selected-io:write-export',
  'host-selected-io:cancel',
]
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const failureRecord = (error) => ({
  name: error.name,
  message: error.message,
  stack: error.stack,
})

async function eventually(read, predicate, message, timeout = 15000) {
  const deadline = performance.now() + timeout
  let last
  do {
    last = await read()
    if (predicate(last)) return last
    await delay(40)
  } while (performance.now() < deadline)
  throw new Error(
    `${message}. Last observation ${JSON.stringify(last).slice(0, 2000)}`,
  )
}

async function packageFiles(folder, relative = '') {
  const files = []
  for (const name of (await readdir(join(folder, relative))).sort()) {
    const path = relative ? `${relative}/${name}` : name
    const info = await lstat(join(folder, path))
    assert.equal(
      info.isSymbolicLink(),
      false,
      `Prepared package contains a symlink at ${path}`,
    )
    if (info.isDirectory()) files.push(...(await packageFiles(folder, path)))
    else {
      assert(info.isFile(), `Prepared package contains a non-file at ${path}`)
      const bytes = await readFile(join(folder, path))
      files.push({ path, bytes, size: bytes.length, sha256: digest(bytes) })
    }
  }
  return files
}

function observeRenderer({ addonId }) {
  const state = {
    epoch: crypto.randomUUID(),
    created: 0,
    terminated: 0,
    active: 0,
    records: [],
    messages: [],
    errors: [],
    canvasFrames: 0,
    canvasFrameTimes: [],
    packageFetches: [],
    deferResource: null,
    pendingResource: false,
  }
  globalThis.__doomAcceptance = state
  const selected = (url) =>
    String(url).includes(`/installed-addons/${addonId}/`)
  const summarize = (data, depth = 0) => {
    if (!data || typeof data !== 'object') return { valueType: typeof data }
    const result = {}
    for (const key of [
      'kind',
      'type',
      'id',
      'activity',
      'key',
      'code',
      'down',
      'pressed',
      'sequence',
      'elapsedMs',
      'gameTime',
    ])
      if (['string', 'number', 'boolean'].includes(typeof data[key]))
        result[key] = data[key]
    for (const key of ['held', 'taps', 'keys', 'actions'])
      if (Array.isArray(data[key])) result[key] = data[key].slice(0, 32)
    if (depth < 2)
      for (const key of ['input', 'payload', 'update'])
        if (data[key] && typeof data[key] === 'object')
          result[key] = summarize(data[key], depth + 1)
    for (const key of ['engine', 'iwad', 'pixels'])
      if (typeof data[key]?.byteLength === 'number')
        result[`${key}ByteLength`] = data[key].byteLength
    return result
  }
  const NativeWorker = globalThis.Worker
  globalThis.Worker = new Proxy(NativeWorker, {
    construct(Target, args, newTarget) {
      const worker = Reflect.construct(Target, args, newTarget)
      if (!selected(args[0])) return worker
      const record = {
        id: ++state.created,
        url: String(args[0]),
        type: args[1]?.type ?? 'classic',
        createdAt: performance.now(),
        terminatedAt: null,
      }
      state.records.push(record)
      state.active++
      const send = worker.postMessage.bind(worker)
      worker.postMessage = (...args) => {
        state.messages.push({
          workerId: record.id,
          direction: 'sent',
          at: performance.now(),
          data: summarize(args[0]),
        })
        if (state.messages.length > 4000) state.messages.splice(0, 1000)
        return send(...args)
      }
      const terminate = worker.terminate.bind(worker)
      worker.terminate = (...args) => {
        if (record.terminatedAt === null) {
          record.terminatedAt = performance.now()
          state.terminated++
          state.active--
        }
        return terminate(...args)
      }
      worker.addEventListener('message', (event) => {
        state.messages.push({
          workerId: record.id,
          direction: 'received',
          at: performance.now(),
          data: summarize(event.data),
        })
        if (state.messages.length > 4000) state.messages.splice(0, 1000)
      })
      worker.addEventListener('error', (event) =>
        state.errors.push({
          workerId: record.id,
          message: event.message,
          filename: event.filename,
        }),
      )
      return worker
    },
  })
  const nativeFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    if (!selected(url)) return nativeFetch(url, options)
    const record = {
      url: String(url),
      at: performance.now(),
      bytes: null,
      sha256: null,
      outcome: 'pending',
    }
    state.packageFetches.push(record)
    if (
      state.deferResource &&
      record.url.includes(`/assets/${state.deferResource}/`)
    ) {
      state.deferResource = null
      state.pendingResource = true
      await new Promise((resolve, reject) => {
        const abort = () => {
          state.pendingResource = false
          record.outcome = 'aborted'
          reject(new DOMException('Closed resource load', 'AbortError'))
        }
        options.signal.addEventListener('abort', abort, { once: true })
        globalThis.__releaseDoomResource = () => {
          options.signal.removeEventListener('abort', abort)
          state.pendingResource = false
          resolve()
        }
      })
    }
    const response = await nativeFetch(url, options)
    const bytes = new Uint8Array(await response.clone().arrayBuffer())
    record.bytes = bytes.length
    record.sha256 = [
      ...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    ]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
    record.outcome = 'read'
    return response
  }
  new MutationObserver((records) => {
    for (const record of records) {
      if (
        record.type !== 'attributes' ||
        record.attributeName !== 'data-sequence'
      )
        continue
      if (!record.target.matches('canvas[aria-label="Doom canvas"]')) continue
      if (!(Number(record.target.dataset.sequence) > 0)) continue
      state.canvasFrames++
      state.canvasFrameTimes.push(performance.now())
      if (state.canvasFrameTimes.length > 1000) state.canvasFrameTimes.shift()
    }
  }).observe(document, {
    subtree: true,
    attributes: true,
    attributeFilter: ['data-sequence'],
  })
}

async function observeMain(application, config) {
  await application.evaluate(
    ({ dialog, ipcMain, session, BrowserWindow }, config) => {
      const { createHash } = process.getBuiltinModule('node:crypto')
      const https = process.getBuiltinModule('node:https')
      const { syncBuiltinESMExports } = process.getBuiltinModule('node:module')
      const originalRequest = https.request
      const originalOpen = dialog.showOpenDialog
      const originalSave = dialog.showSaveDialog
      const originalMessage = dialog.showMessageBox
      const originalIo = new Map()
      const grants = new Set()
      const state = {
        dialogs: [],
        responses: [],
        io: [],
        inFlight: 0,
        quit: { name: null, response: 2 },
        rendererEvents: [],
        exportChoices: 0,
        exportQueue: [],
        pendingExportChoice: false,
        network: [],
        storage: [],
        http: [],
        networkOffline: false,
        holdSharewareBody: false,
        pendingSharewareBody: false,
      }
      globalThis.__doomAcceptanceMain = state
      globalThis.__doomAcceptanceSnapshot = () => ({
        dialogs: state.dialogs,
        responses: state.responses,
        io: state.io,
        inFlight: state.inFlight,
        outstandingGrants: grants.size,
        exportChoices: state.exportChoices,
        pendingExportChoice: state.pendingExportChoice,
        rendererEvents: state.rendererEvents,
        network: state.network,
        storage: state.storage,
        http: state.http,
        networkOffline: state.networkOffline,
        pendingSharewareBody: state.pendingSharewareBody,
      })
      const sharewareUrl = (url) => {
        try {
          const value = new URL(String(url))
          return (
            value.origin === 'https://gist.githubusercontent.com' &&
            value.pathname.startsWith(
              new URL(config.bundle.iwad.feed.url).pathname.replace(
                /[^/]+$/,
                '',
              ),
            )
          )
        } catch {
          return false
        }
      }
      https.request = function (...args) {
        if (!sharewareUrl(args[0]))
          return Reflect.apply(originalRequest, this, args)
        const record = {
          url: String(args[0]),
          beganAt: Date.now(),
          responseAt: null,
          endedAt: null,
          closedAt: null,
          complete: false,
          aborted: false,
          signalAborted: false,
        }
        state.http.push(record)
        const callback = args.at(-1)
        args[args.length - 1] = (response) => {
          record.responseAt = Date.now()
          response.once('end', () => {
            record.endedAt = Date.now()
            record.complete = response.complete
          })
          response.once('aborted', () => {
            record.aborted = true
            record.abortedAt = Date.now()
          })
          if (
            state.holdSharewareBody &&
            record.url.endsWith('/doom1-part-00.json')
          ) {
            state.holdSharewareBody = false
            state.pendingSharewareBody = true
            record.held = true
            record.responseCompleteAtHold = response.complete
            globalThis.__releaseDoomSharewareBody = () => {
              state.pendingSharewareBody = false
              record.releasedAt = Date.now()
              callback(response)
            }
          } else callback(response)
        }
        const request = Reflect.apply(originalRequest, this, args)
        args[1].signal?.addEventListener(
          'abort',
          () => {
            record.signalAborted = true
            record.signalAbortedAt = Date.now()
          },
          { once: true },
        )
        if (state.networkOffline) {
          record.offlineControl = true
          request.destroy(new Error('Offline acceptance transport.'))
        }
        request.once('error', (error) => {
          record.error = { name: error.name, code: error.code }
          if (error.name === 'AbortError' || error.code === 'ABORT_ERR')
            record.aborted = true
        })
        request.once('close', () => {
          record.closedAt = Date.now()
          record.destroyed = request.destroyed
          if (record.held && !record.releasedAt)
            state.pendingSharewareBody = false
        })
        return request
      }
      syncBuiltinESMExports()
      for (const channel of [
        'host-network:get-text',
        'addon-storage:read',
        'addon-storage:write',
      ]) {
        const handler = ipcMain._invokeHandlers.get(channel)
        if (typeof handler !== 'function')
          throw new Error(`Actual SDK handler unavailable at ${channel}`)
        originalIo.set(channel, handler)
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, async function (event, ...args) {
          const networkCall = channel === 'host-network:get-text'
          const owned = networkCall
            ? args[0] === config.manifest.id
            : args[0]?.owner === config.manifest.id
          if (!owned) return Reflect.apply(handler, this, [event, ...args])
          const input = networkCall ? args[1] : args[0]
          const record = { channel, beganAt: Date.now(), completedAt: null }
          if (networkCall) record.url = input.url
          else {
            record.key = input.key
            record.scope = input.scope.kind
            record.version = input.version
            if (channel.endsWith(':write')) {
              record.cleared = input.value === null
              if (typeof input.value?.base64 === 'string') {
                const bytes = Buffer.from(input.value.base64, 'base64')
                record.bytes = bytes.length
                record.sha256 = createHash('sha256').update(bytes).digest('hex')
              }
            }
          }
          ;(networkCall ? state.network : state.storage).push(record)
          try {
            const result = await Reflect.apply(handler, this, [event, ...args])
            if (networkCall) {
              record.ok = result.ok
              if (result.ok) {
                record.responseUrl = result.value.url
                record.status = result.value.status
                record.bytes = Buffer.byteLength(result.value.text)
                record.sha256 = createHash('sha256')
                  .update(result.value.text)
                  .digest('hex')
              } else record.code = result.code
            } else {
              record.status = result.status
              record.revision = result.revision ?? result.current?.revision
            }
            return result
          } catch (error) {
            record.error = error.message
            throw error
          } finally {
            record.completedAt = Date.now()
          }
        })
      }
      dialog.showOpenDialog = async (...args) => {
        const options = args.at(-1)
        if (options?.title === 'Import file')
          throw new Error(
            'Automatic Doom startup must not select an import file.',
          )
        if (
          options?.properties?.includes('openFile') &&
          options.title !== 'Import file'
        ) {
          state.dialogs.push({
            kind: 'note',
            options,
            returnedPath: config.notePath,
            at: Date.now(),
          })
          return { canceled: false, filePaths: [config.notePath] }
        }
        return Reflect.apply(originalOpen, dialog, args)
      }
      dialog.showSaveDialog = async (...args) => {
        const options = args.at(-1)
        if (options?.title !== 'Export file')
          return Reflect.apply(originalSave, dialog, args)
        state.exportChoices++
        const choice = state.exportQueue.shift() ?? {
          kind: 'path',
          path: config.sourcePath,
        }
        const record = {
          kind: 'source',
          options,
          returnedPath: choice.path ?? config.sourcePath,
          canceled: choice.kind === 'cancel',
          deferred: choice.kind === 'deferred',
          at: Date.now(),
        }
        state.dialogs.push(record)
        if (choice.kind === 'deferred') {
          state.pendingExportChoice = true
          return new Promise((done) => {
            globalThis.__releaseDoomAcceptanceChooser = () => {
              state.pendingExportChoice = false
              record.releasedAt = Date.now()
              done({ canceled: false, filePath: record.returnedPath })
            }
          })
        }
        return {
          canceled: record.canceled,
          filePath: record.canceled ? undefined : record.returnedPath,
        }
      }
      dialog.showMessageBox = async (...args) => {
        const options = args.at(-1)
        if (
          options?.message ===
          `Install ${config.manifest.name} ${config.manifest.version}?`
        ) {
          state.dialogs.push({
            kind: 'review',
            options,
            returnedResponse: 1,
            at: Date.now(),
          })
          return { response: 1, checkboxChecked: false }
        }
        if (
          options?.message === `Save changes to ${state.quit.name}?` &&
          options.cancelId === 2 &&
          JSON.stringify(options.buttons) ===
            JSON.stringify(['Save', 'Don’t save', 'Cancel'])
        ) {
          state.dialogs.push({
            kind: 'quit',
            options,
            returnedResponse: state.quit.response,
            at: Date.now(),
          })
          return { response: state.quit.response, checkboxChecked: false }
        }
        return Reflect.apply(originalMessage, dialog, args)
      }
      for (const channel of config.ioChannels) {
        const handler = ipcMain._invokeHandlers.get(channel)
        if (typeof handler !== 'function')
          throw new Error(
            `Actual selected-I/O handler unavailable at ${channel}`,
          )
        originalIo.set(channel, handler)
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, async function (event, ...args) {
          if (args[0] !== config.manifest.id)
            return Reflect.apply(handler, this, [event, ...args])
          const record = { channel, beganAt: Date.now(), completedAt: null }
          state.io.push(record)
          state.inFlight++
          try {
            const result = await Reflect.apply(handler, this, [event, ...args])
            record.ok = result.ok
            if (
              result.ok &&
              (channel.endsWith(':select-import') ||
                channel.endsWith(':select-export'))
            ) {
              record.name = result.value?.name ?? null
              if (result.value) grants.add(result.value.handle)
            }
            if (channel.endsWith(':read-import')) {
              if (result.ok) {
                record.bytes = result.value.byteLength
                record.sha256 = createHash('sha256')
                  .update(result.value)
                  .digest('hex')
              }
              if (result.ok || result.code !== 'busy') grants.delete(args[1])
            }
            if (channel.endsWith(':write-export')) {
              if (result.ok) {
                record.bytes = args[2].byteLength
                record.sha256 = createHash('sha256')
                  .update(args[2])
                  .digest('hex')
              }
              if (result.ok || result.code !== 'busy') grants.delete(args[1])
            }
            if (result.ok && channel.endsWith(':cancel')) grants.delete(args[1])
            if (!result.ok) record.code = result.code
            return result
          } catch (error) {
            record.error = String(error.message)
            throw error
          } finally {
            record.completedAt = Date.now()
            state.inFlight--
          }
        })
      }
      session.defaultSession.webRequest.onResponseStarted((details) => {
        if (
          details.url !== 'app://hibi/' &&
          !details.url.includes(`/installed-addons/${config.manifest.id}/`)
        )
          return
        state.responses.push({
          url: details.url,
          statusCode: details.statusCode,
          resourceType: details.resourceType,
          responseHeaders: details.responseHeaders,
          fromCache: details.fromCache,
        })
      })
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.webContents.getURL() !== 'app://hibi/') continue
        const contents = window.webContents
        contents.on('render-process-gone', (_event, details) =>
          state.rendererEvents.push({
            kind: 'render-process-gone',
            at: Date.now(),
            details,
          }),
        )
        contents.on(
          'did-start-navigation',
          (_event, url, _inPlace, isMainFrame) => {
            if (isMainFrame)
              state.rendererEvents.push({
                kind: 'navigation',
                url,
                at: Date.now(),
              })
          },
        )
        contents.on('destroyed', () =>
          state.rendererEvents.push({ kind: 'destroyed', at: Date.now() }),
        )
      }
      globalThis.__doomAcceptanceRestore = () => {
        dialog.showOpenDialog = originalOpen
        dialog.showSaveDialog = originalSave
        dialog.showMessageBox = originalMessage
        https.request = originalRequest
        syncBuiltinESMExports()
        delete globalThis.__releaseDoomSharewareBody
        for (const [channel, handler] of originalIo) {
          ipcMain.removeHandler(channel)
          ipcMain.handle(channel, handler)
        }
        session.defaultSession.webRequest.onResponseStarted(null)
      }
    },
    config,
  )
}

export async function runUrlInstallAcceptance(options = {}) {
  const checkout = resolve(
    options.checkout ?? process.env.HIBI_ROOT ?? '../hibi',
  )
  const prepared = resolve(
    options.packagePath ??
      process.env.HIBI_DOOM_PACKAGE_DIR ??
      join(repository, 'addon'),
  )
  assert.notEqual(
    process.env.NODE_TLS_REJECT_UNAUTHORIZED,
    '0',
    'Acceptance requires TLS verification',
  )
  const artifactRoot = resolve(
    options.artifactRoot ?? process.env.HIBI_DOOM_ARTIFACT_ROOT ?? tmpdir(),
  )
  await mkdir(artifactRoot, { recursive: true })
  const run = await mkdtemp(join(artifactRoot, 'hibi-doom-url-'))
  const fixture = join(run, 'fixture')
  const profile = join(fixture, 'profile')
  const notePath = join(fixture, 'verification.md')
  const sourcePath = join(fixture, sourceExportName)
  const conflictPath = join(fixture, 'existing-source.tar.gz')
  const lateSourcePath = join(fixture, 'late-source.tar.gz')
  const cachedSourcePath = join(fixture, 'cached-source.tar.gz')
  const cert = join(fixture, 'test-ca.pem')
  const key = join(fixture, 'test-key.pem')
  const reportPath = join(run, 'acceptance.json')
  const timeout = Number(
    options.startupTimeout ?? process.env.HIBI_DOOM_STARTUP_TIMEOUT_MS ?? 60000,
  )
  const levelTimeout = Number(
    options.levelTimeout ?? process.env.HIBI_DOOM_LEVEL_TIMEOUT_MS ?? 60000,
  )
  const perfMilliseconds = Number(
    options.perfMilliseconds ?? process.env.HIBI_DOOM_PERF_SAMPLE_MS ?? 5000,
  )
  assert(Number.isFinite(timeout) && timeout >= 1000 && timeout <= 600000)
  assert(
    Number.isFinite(levelTimeout) &&
      levelTimeout >= 1000 &&
      levelTimeout <= 600000,
  )
  assert(
    Number.isFinite(perfMilliseconds) &&
      perfMilliseconds >= 1000 &&
      perfMilliseconds <= 30000,
  )
  const observation = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    checkout,
    prepared,
    run,
    reportPath,
    checks: [],
    screenshots: [],
    epochs: [],
    workerEvents: [],
    workerResponseFetches: [],
    externalRendererRequests: [],
    downloads: [],
    controls: {
      transport:
        'Actual Settings URL installation from a real IP-SAN loopback HTTPS ZIP server.',
      trust:
        'Fresh one-day certificate trusted only in the verification Electron environment through NODE_EXTRA_CA_CERTS.',
      review:
        'Controlled native response accepting only this exact package review. Actual review options are recorded.',
      fileChooser:
        'Controlled native response selecting only the fixture note and source export destinations. Actual selected-I/O handlers run unchanged. Runtime imports are forbidden.',
      observers:
        'Native Worker construction, postMessage, terminate, frame attribute writes, response headers, and selected-I/O completion are observed without replacing the factory or engine.',
      shareware:
        'First Play calls the stock SDK network handler against the actual pinned public feed. SDK storage read and compare-and-set write results are recorded without cache payloads.',
      networkCancellation:
        'Two cancellation checks hold delivery of one actual public HTTPS response to the unchanged host transport. Close ignores the late result. Disable must revoke and abort the real request. DNS, TLS, origin grants, URL validation, and body limits remain unchanged.',
      offlineCache:
        'Cached-session checks fail a feed HTTPS request at the transport if attempted and assert that no SDK request is attempted. No successful or denied SDK result is synthesized. This control does not replace cache or game code.',
      nativeFocus:
        'Actual native focus transfer to one owned sandboxed about:blank probe. Playwright focus emulation is disabled only for native focus and hide observations, then restored and detached.',
      publication:
        'Loopback HTTPS proof does not establish anonymous public GitHub acquisition.',
    },
    cleanup: {
      appClosed: false,
      fixtureRemoved: false,
      serverClosed: false,
      removedPackage:
        'Actual Settings Remove moves the owned package to the OS Trash. The driver does not sweep or mock Trash.',
    },
  }
  let application
  let bundle
  let page
  let nativeFocusSession
  let server
  let failed
  let currentCheck
  const pageErrors = []
  const consoleMessages = []
  const ownedWorkers = new Map()
  let workerSerial = 0
  const check = async (name, work) => {
    const entry = { name, status: 'running', beganAt: new Date().toISOString() }
    observation.checks.push(entry)
    currentCheck = entry
    try {
      entry.evidence = await work()
      entry.status = 'passed'
    } catch (error) {
      entry.status = 'failed'
      entry.failure = failureRecord(error)
      throw error
    } finally {
      entry.completedAt = new Date().toISOString()
    }
  }
  const snapshotMain = () =>
    application.evaluate(() => globalThis.__doomAcceptanceSnapshot())
  const snapshotRenderer = () =>
    page.evaluate(() => globalThis.__doomAcceptance)
  const snapshotFrame = () =>
    page.locator('canvas[aria-label="Doom canvas"]').evaluate(canvasEvidence)
  const workerCount = () =>
    [...ownedWorkers.values()].filter((worker) => worker.closedAt === null)
      .length
  const waitForWorkers = (count) =>
    eventually(
      async () => workerCount(),
      (actual) => actual === count,
      `Expected ${count} live installed Doom workers`,
    )
  const screenshot = async (name) => {
    const path = join(run, `${name}.png`)
    await page.screenshot({ path, timeout: 15000 })
    observation.screenshots.push({
      name,
      path,
      sha256: digest(await readFile(path)),
    })
    return path
  }
  let manifest
  let installed
  let clickMenu
  let waitForDocumentEditor
  let waitForAsync
  let replaceRichText
  const editor = () =>
    page
      .locator('#document-editor-panel')
      .getByRole('textbox', { name: 'Document editor', exact: true })
  const canvas = () => page.locator('canvas[aria-label="Doom canvas"]')
  const focusMain = () =>
    application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(
        (window) => window.webContents.getURL() === 'app://hibi/',
      )
      if (!window) throw new Error('Hibi main window unavailable')
      window.show()
      window.focus()
    })
  const snapshotNativeFocus = async () => ({
    ...(await application.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find(
        (window) => window.webContents.getURL() === 'app://hibi/',
      )
      const probe = globalThis.__doomAcceptanceNativeFocusProbe
      return {
        mainWindowId: main?.id ?? null,
        mainFocused: main?.isFocused() ?? false,
        mainVisible: main?.isVisible() ?? false,
        probeWindowId: probe?.record.windowId ?? null,
        probeFocused:
          !!probe && !probe.window.isDestroyed() && probe.window.isFocused(),
        focusedWindowId: BrowserWindow.getFocusedWindow()?.id ?? null,
      }
    })),
    rendererFocused: await page.evaluate(() => document.hasFocus()),
  })
  const closeNativeFocusProbe = async () => {
    const record = await application.evaluate(({ BrowserWindow }) => {
      const probe = globalThis.__doomAcceptanceNativeFocusProbe
      if (!probe) return null
      if (!probe.window.isDestroyed()) probe.window.destroy()
      probe.record.closed =
        probe.window.isDestroyed() &&
        BrowserWindow.fromId(probe.record.windowId) === null
      probe.record.closedAt ??= new Date().toISOString()
      return probe.record
    })
    if (record) {
      observation.nativeFocusProbe = record
      observation.cleanup.nativeFocusProbeClosed = record.closed
      assert.equal(
        record.closed,
        true,
        'Owned native focus probe remained live',
      )
    }
  }
  const restoreNativeFocusSession = async () => {
    if (!nativeFocusSession) return
    try {
      await nativeFocusSession.send('Emulation.setFocusEmulationEnabled', {
        enabled: true,
      })
      observation.cleanup.nativeFocusEmulationRestored = true
    } finally {
      await nativeFocusSession.detach()
      nativeFocusSession = undefined
      observation.cleanup.nativeFocusSessionDetached = true
    }
  }
  const waitForScreen = async (screen) => {
    const active = page.locator(
      screen === 'settings' ? '.settings-screen' : '.editor-surface',
    )
    const inactive = page.locator(
      screen === 'settings' ? '.editor-surface' : '.settings-screen',
    )
    await page.locator(`.app[data-screen="${screen}"]`).waitFor()
    await active.waitFor()
    await inactive.waitFor({ state: 'hidden' })
    await active.evaluate((element) =>
      Promise.all(
        element.getAnimations().map((animation) => animation.finished),
      ),
    )
  }
  const openSettings = async () => {
    if ((await page.locator('.app').getAttribute('data-screen')) !== 'settings')
      await clickMenu(application, 'Settings')
    await waitForScreen('settings')
    const settings = page.getByRole('main', { name: /^settings$/i })
    await settings
      .getByRole('tab', { name: 'Addon Manager', exact: true })
      .click()
    await settings
      .getByRole('searchbox', { name: 'Filter addons', exact: true })
      .fill('')
  }
  const backToApp = async () => {
    if ((await page.locator('.app').getAttribute('data-screen')) === 'settings')
      await page
        .getByRole('button', { name: 'Back to app', exact: true })
        .click()
    await waitForScreen('editor')
  }
  const command = async (name = 'Play Doom') => {
    await backToApp()
    await clickMenu(application, 'Command palette')
    const palette = page.getByRole('dialog', { name: /^command palette$/i })
    await palette.getByRole('combobox', { name: /search commands/i }).fill(name)
    await palette
      .getByRole('option', { name: new RegExp(`^${name}`) })
      .press('Enter')
    await palette.waitFor({ state: 'hidden' })
    await page
      .getByRole('region', {
        name: name === 'Play Doom' ? 'Doom game' : 'Doom license and source',
        exact: true,
      })
      .waitFor()
  }
  const setEnabled = async (enabled) => {
    await openSettings()
    const toggle = page.locator(`[id="addon-${manifest.id}"]`)
    if ((await toggle.isChecked()) !== enabled) await toggle.click()
    await waitForAsync(
      page,
      async ({ addonId, enabled }) => {
        const state = (await window.hibi.getAddonStates()).find(
          ({ id }) => id === addonId,
        )
        const input = document.getElementById(`addon-${addonId}`)
        return (
          state?.enabled === enabled &&
          input?.checked === enabled &&
          !input.disabled
        )
      },
      { addonId: manifest.id, enabled },
    )
    if (!enabled)
      await page
        .locator('.titlebar [data-toolbar-id="hibi-doom.play"]')
        .waitFor({ state: 'detached' })
  }
  const install = async (url) => {
    await openSettings()
    await page
      .getByRole('button', { name: 'Install from URL', exact: true })
      .click()
    const prompt = page.getByRole('dialog', {
      name: 'Install from URL',
      exact: true,
    })
    await prompt.getByLabel('Addon URL', { exact: true }).fill(url)
    await prompt.getByRole('button', { name: 'Download', exact: true }).click()
    await prompt.waitFor({ state: 'hidden' })
    await waitForAsync(
      page,
      async (id) =>
        (await window.hibi.getInstalledAddons()).some(
          ({ manifest }) => manifest.id === id,
        ),
      manifest.id,
    )
    installed = await page.evaluate(
      async (id) =>
        (await window.hibi.getInstalledAddons()).find(
          ({ manifest }) => manifest.id === id,
        ),
      manifest.id,
    )
    const state = await page.evaluate(
      async (id) =>
        (await window.hibi.getAddonStates()).find((state) => state.id === id),
      manifest.id,
    )
    assert.equal(state.enabled, false)
    assert.equal(
      await page.locator(`[id="addon-${manifest.id}"]`).isChecked(),
      false,
    )
    assert.equal(installed.source, 'third-party')
    assert.equal(workerCount(), 0)
    return { descriptor: installed, state }
  }
  const startSession = async (label, expectedDataSource = 'cache') => {
    const began = performance.now()
    const before = await snapshotRenderer()
    const mainBefore = await snapshotMain()
    const selectedAt = await page.evaluate(() => performance.now())
    await backToApp()
    const play = page.locator(
      '.titlebar-actions > [data-toolbar-id="hibi-doom.play"]',
    )
    await play.click()
    await play.click()
    assert.equal(
      await page.getByRole('tab', { name: 'Doom', exact: true }).count(),
      1,
    )
    await canvas().waitFor()
    const gameRegion = page.getByRole('region', {
      name: 'Doom game',
      exact: true,
    })
    const announcement = gameRegion.getByText(
      'Doom engine. Copyright id Software, Simon Howard, and contributors. GNU GPL version 3 only. No warranty. Redistribution permitted under GPL.',
      { exact: true },
    )
    assert.equal(await announcement.isVisible(), true)
    assert.equal(
      await gameRegion
        .getByRole('button', { name: 'License and source', exact: true })
        .isVisible(),
      true,
    )
    await focusMain()
    await canvas().click()
    const frame = await eventually(
      snapshotFrame,
      (frame) =>
        frame.sequence > 1 &&
        frame.nonBlackPixels > frame.width * frame.height * 0.05 &&
        frame.colors > 16,
      `The ${label} session did not render a nonblank Doom title`,
      timeout,
    )
    await waitForWorkers(1)
    const after = await snapshotRenderer()
    assert.equal(after.active, 1)
    assert.equal(after.created, before.created + 1)
    const worker = after.records.at(-1)
    assert.equal(worker.type, 'module')
    assert(worker.url.startsWith(new URL('.', installed.url).href))
    assert.equal(worker.url.startsWith('blob:'), false)
    const io = await eventually(
      snapshotMain,
      (state) => state.inFlight === 0 && state.outstandingGrants === 0,
      'Automatic game startup must not retain selected-I/O grants',
    )
    assert.equal(
      io.io.filter((entry) => /:(select|read)-import$/.test(entry.channel))
        .length,
      0,
    )
    const startup = after.messages.find(
      (entry) =>
        entry.workerId === worker.id &&
        entry.direction === 'sent' &&
        entry.data.kind === 'startup',
    )
    assert.equal(startup.data.engineByteLength, bundle.engine.bytes)
    assert.equal(startup.data.iwadByteLength, bundle.iwad.bytes)
    const resources = after.packageFetches.filter(
      (entry) => entry.at > selectedAt,
    )
    assert.equal(resources.length, bundle.engine.chunks.length)
    for (const resource of resources) {
      const path = resource.url.slice(new URL('.', installed.url).href.length)
      const candidate = observation.candidate.files.find(
        (file) => file.path === path,
      )
      assert(candidate, `Actual resource has no package entry: ${path}`)
      assert.equal(resource.outcome, 'read')
      assert.equal(resource.bytes, candidate.size)
      assert.equal(resource.sha256, candidate.sha256)
      assert.equal(path.startsWith('assets/source/'), false)
    }
    assert.equal(
      await gameRegion.getAttribute('data-data-source'),
      expectedDataSource,
    )
    assert.equal(await gameRegion.getAttribute('data-cache-persistent'), 'true')
    const network = io.network.slice(mainBefore.network.length)
    const storage = io.storage.slice(mainBefore.storage.length)
    if (expectedDataSource === 'cache') assert.equal(network.length, 0)
    else {
      assert.equal(network.length, 10)
      assert(
        network.every(
          (entry) =>
            entry.ok && entry.status === 200 && entry.bytes < 1024 * 1024,
        ),
      )
      assert.equal(network[0].url, bundle.iwad.feed.url)
      assert.equal(network[0].bytes, bundle.iwad.feed.bytes)
      assert.equal(network[0].sha256, bundle.iwad.feed.sha256)
      const save = storage.find(
        (entry) => entry.channel.endsWith(':write') && !entry.cleared,
      )
      assert.equal(save?.status, 'saved')
      assert.equal(save?.bytes, bundle.iwad.bytes)
      assert.equal(save?.sha256, bundle.iwad.sha256)
    }
    const firstFrameAt = after.canvasFrameTimes.find((at) => at > selectedAt)
    assert(
      firstFrameAt > selectedAt,
      'The bundled engine must produce a completed canvas publication',
    )
    const titleObservedMs = performance.now() - began
    await screenshot(`${label}-title`)
    return {
      worker,
      frame,
      firstCompletedFrameMs: firstFrameAt - selectedAt,
      titleObservedMs,
      resources,
      dataSource: expectedDataSource,
      network,
      storage,
      importGrants: 0,
    }
  }
  const assertProgress = async (
    before,
    message = 'Doom did not advance after resuming',
  ) =>
    eventually(
      snapshotFrame,
      (frame) =>
        frame.sequence > before.sequence && frame.gameTime > before.gameTime,
      message,
      timeout,
    )
  const clearCachedGame = async () => {
    if (
      await page.getByRole('region', { name: 'Doom game', exact: true }).count()
    ) {
      await command()
      await page
        .getByRole('button', { name: 'Close game', exact: true })
        .click()
      await page
        .getByRole('region', { name: 'Doom game', exact: true })
        .waitFor({ state: 'detached' })
      await waitForWorkers(0)
    }
    await command('Doom license and source')
    const licenses = page.getByRole('region', {
      name: 'Doom license and source',
      exact: true,
    })
    await licenses
      .getByRole('button', { name: 'Clear cached game data', exact: true })
      .click()
    await licenses
      .getByText(
        'Cached game data was cleared. Close and reopen the game to download it again.',
        { exact: true },
      )
      .waitFor()
    const native = await snapshotMain()
    const cleared = native.storage
      .filter((entry) => entry.channel.endsWith(':write'))
      .at(-1)
    assert.equal(cleared.cleared, true)
    assert.equal(cleared.status, 'saved')
    await licenses
      .getByRole('button', { name: 'Close license', exact: true })
      .click()
    return cleared
  }
  const advance = async (milliseconds, maxWait = timeout) => {
    const before = await snapshotFrame()
    return eventually(
      snapshotFrame,
      (frame) =>
        frame.gameTime >= before.gameTime + milliseconds &&
        frame.sequence > before.sequence,
      `Doom did not execute ${milliseconds} milliseconds of game time`,
      maxWait,
    )
  }
  const freeze = async (reason) => {
    let previous = await snapshotFrame()
    let stableSince = performance.now()
    await eventually(
      snapshotFrame,
      (frame) => {
        if (
          frame.sequence !== previous.sequence ||
          frame.gameTime !== previous.gameTime
        ) {
          stableSince = performance.now()
          previous = frame
        }
        return performance.now() - stableSince >= 600
      },
      `Doom did not pause for ${reason}`,
    )
    const before = await snapshotFrame()
    await delay(1000)
    const after = await snapshotFrame()
    assert.equal(
      after.sequence,
      before.sequence,
      `${reason} must freeze completed frames`,
    )
    assert.equal(
      after.gameTime,
      before.gameTime,
      `${reason} must freeze game time`,
    )
    assert.equal(
      workerCount(),
      1,
      `${reason} must retain exactly one session worker`,
    )
    return { before, after }
  }
  const sentInputs = (state) =>
    state.messages.filter(
      (entry) =>
        entry.direction === 'sent' &&
        Array.isArray(entry.data.held) &&
        Array.isArray(entry.data.taps),
    )
  const holdForward = async () => {
    await canvas().click()
    const before = await snapshotRenderer()
    await page.keyboard.down('ArrowUp')
    const after = before.messages.at(-1)?.at ?? 0
    const state = await eventually(
      snapshotRenderer,
      (state) =>
        sentInputs(state).some(
          (entry) => entry.at > after && entry.data.held.length > 0,
        ),
      'Actual worker input did not receive the held forward key',
      timeout,
    )
    return { held: sentInputs(state).at(-1) }
  }
  const assertReleased = async (before) => {
    const state = await eventually(
      snapshotRenderer,
      (state) =>
        sentInputs(state).some(
          (entry) =>
            entry.at > before &&
            entry.data.held.length === 0 &&
            entry.data.taps.length === 0 &&
            entry.data.activity !== 'paused',
        ),
      'The resumed actual worker input still held a key or retained a tap',
      timeout,
    )
    const released = sentInputs(state).find(
      (entry) =>
        entry.at > before &&
        entry.data.held.length === 0 &&
        entry.data.taps.length === 0 &&
        entry.data.activity !== 'paused',
    )
    await page.keyboard.up('ArrowUp')
    return released
  }

  try {
    let files
    let zip
    await check('candidate and exact prepared ZIP', async () => {
      await mkdir(profile, { recursive: true })
      await writeFile(notePath, 'Original HTTPS verification note.\n')
      await writeFile(
        join(profile, 'addons.json'),
        JSON.stringify({ 'hibi-doom': false }),
      )
      await writeFile(conflictPath, 'Keep this existing source file.\n')
      bundle = parseBundle(
        JSON.parse(await readFile(join(prepared, 'bundle.json'), 'utf8')),
      )
      manifest = JSON.parse(
        await readFile(join(prepared, 'hibi-addon.json'), 'utf8'),
      )
      assert.equal(manifest.apiVersion, 3)
      assert.equal(manifest.kind, 'extension')
      assert.equal(manifest.defaultEnabled, false)
      assert.deepEqual(manifest.capabilities, ['ui'])
      assert.deepEqual(manifest.network.origins, [
        'https://gist.githubusercontent.com',
      ])
      assert.equal(manifest.native, undefined)
      assert.match(manifest.entry, /\.(?:js|mjs)$/)
      files = await packageFiles(prepared)
      assert(files.some((file) => file.path === 'README.md'))
      assert(files.some((file) => file.path === manifest.entry))
      assert.equal(
        files.some((file) => file.path.startsWith('assets/iwad/')),
        false,
      )
      assert.equal(
        files.filter((file) => file.path.endsWith('hibi-addon.json')).length,
        1,
      )
      assert(files.every((file) => file.size <= 5 * 1024 * 1024))
      assert(
        files.reduce((sum, file) => sum + file.size, 0) <= 25 * 1024 * 1024,
      )
      assert(
        files.every(
          (file) =>
            !/(?:^|\/)(?:node_modules|\.git)(?:\/|$)|\.(?:wasm|wad|tsx?|map)$/.test(
              file.path,
            ),
        ),
      )
      const { zipFiles } = await import(
        pathToFileURL(join(checkout, 'tests/zip.mjs'))
      )
      zip = zipFiles(
        files.map((file) => ({
          name: file.path,
          content: file.bytes,
          deflate: true,
        })),
      )
      const zipPath = join(run, 'doom-addon.zip')
      await writeFile(zipPath, zip)
      const packageMetadata = JSON.parse(
        await readFile(join(checkout, 'package.json'), 'utf8'),
      )
      const mainPath = resolve(checkout, packageMetadata.main)
      const revision = execFileSync(
        'git',
        ['-C', checkout, 'rev-parse', 'HEAD'],
        { encoding: 'utf8' },
      ).trim()
      assert.equal(revision, hostRevision)
      const hostContracts = [
        'src/main/index.ts',
        'src/main/security.ts',
        'src/main/sideload.ts',
        'src/main/addon-download.ts',
        'src/main/host-selected-io.ts',
        'src/main/host-network.ts',
        'src/main/addon-storage.ts',
        'src/addons/sdk-loader.ts',
        'src/renderer/src/addon-definition.ts',
        'src/renderer/src/addon-registry.ts',
      ]
      execFileSync('git', [
        '-C',
        checkout,
        'diff',
        '--quiet',
        hostRevision,
        '--',
        ...hostContracts,
      ])
      const contractFiles = await Promise.all(
        hostContracts.map(async (path) => ({
          path,
          sha256: digest(await readFile(join(checkout, path))),
        })),
      )
      observation.candidate = {
        manifest,
        files: files.map(({ bytes, ...file }) => file),
        zip: { path: zipPath, bytes: zip.length, sha256: digest(zip) },
        bundle,
        host: {
          revision,
          mainPath,
          mainSha256: digest(await readFile(mainPath)),
          unchangedContractFiles: contractFiles,
        },
        driverSha256: digest(await readFile(fileURLToPath(import.meta.url))),
      }
      return observation.candidate
    })
    await check('real process-scoped HTTPS transport', async () => {
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-days',
          '1',
          '-keyout',
          key,
          '-out',
          cert,
          '-subj',
          '/CN=127.0.0.1',
          '-addext',
          'subjectAltName=IP:127.0.0.1',
        ],
        { stdio: 'ignore' },
      )
      server = createServer(
        { key: await readFile(key), cert: await readFile(cert) },
        (request, response) => {
          const record = {
            method: request.method,
            path: request.url,
            encrypted: request.socket.encrypted,
            at: new Date().toISOString(),
            completed: false,
          }
          observation.downloads.push(record)
          if (request.method !== 'GET' || request.url !== '/doom-addon.zip') {
            response.writeHead(404)
            response.end()
            record.status = 404
            return
          }
          record.status = 200
          record.bytes = zip.length
          record.sha256 = digest(zip)
          response.writeHead(200, {
            'content-type': 'application/zip',
            'content-length': zip.length,
            'cache-control': 'no-store',
          })
          response.once('finish', () => {
            record.completed = true
          })
          response.end(zip)
        },
      )
      await new Promise((done, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', done)
      })
      observation.installUrl = `https://127.0.0.1:${server.address().port}/doom-addon.zip`
      observation.certificate = {
        subjectAltName: 'IP:127.0.0.1',
        sha256: digest(await readFile(cert)),
        trustedIn: 'Electron child environment only',
      }
      return {
        url: observation.installUrl,
        certificate: observation.certificate,
      }
    })
    await check('patched native app and observers', async () => {
      process.env.HIBI_TEST_SHOW_WINDOWS = '1'
      const hostTests = await import(
        pathToFileURL(join(checkout, 'tests/electron.mjs'))
      )
      ;({ clickMenu, replaceRichText } = await import(
        pathToFileURL(join(checkout, 'tests/keyboard.mjs'))
      ))
      ;({ waitForAsync } = await import(
        pathToFileURL(join(checkout, 'tests/poll.mjs'))
      ))
      waitForDocumentEditor = hostTests.waitForDocumentEditor
      const env = {
        ...process.env,
        NODE_EXTRA_CA_CERTS: cert,
        HIBI_TEST_SHOW_WINDOWS: '1',
      }
      delete env.ELECTRON_RUN_AS_NODE
      delete env.ELECTRON_RENDERER_URL
      application = await hostTests.electron.launch({
        args: [checkout, `--user-data-dir=${profile}`],
        cwd: checkout,
        env,
      })
      page = await application.firstWindow()
      page.setDefaultTimeout(15000)
      page.on('pageerror', (error) => pageErrors.push(failureRecord(error)))
      page.on('console', (message) => {
        if (consoleMessages.length < 500)
          consoleMessages.push({
            type: message.type(),
            text: message.text(),
            location: message.location(),
          })
      })
      page.on('worker', (worker) => {
        if (!worker.url().includes(`/installed-addons/${manifest.id}/`)) return
        const record = {
          id: ++workerSerial,
          url: worker.url(),
          createdAt: new Date().toISOString(),
          closedAt: null,
        }
        ownedWorkers.set(worker, record)
        observation.workerEvents.push(record)
        worker.on('close', () => {
          record.closedAt = new Date().toISOString()
        })
      })
      page.on('request', (request) => {
        if (/^https?:/.test(request.url()))
          observation.externalRendererRequests.push({
            url: request.url(),
            resourceType: request.resourceType(),
          })
      })
      await waitForDocumentEditor(application, page, { timeout: 30000 })
      await observeMain(application, {
        manifest,
        sourcePath,
        notePath,
        ioChannels,
        bundle,
      })
      await page.addInitScript(observeRenderer, { addonId: manifest.id })
      await page.reload()
      await waitForDocumentEditor(application, page, { timeout: 30000 })
      assert.equal(page.url(), 'app://hibi/')
      const runtime = await application.evaluate(({ app, BrowserWindow }) => ({
        appPath: app.getAppPath(),
        userData: app.getPath('userData'),
        mainPid: process.pid,
        versions: {
          electron: process.versions.electron,
          chrome: process.versions.chrome,
          node: process.versions.node,
        },
        windows: BrowserWindow.getAllWindows()
          .filter((window) => window.webContents.getURL() === 'app://hibi/')
          .map((window) => {
            const preferences = window.webContents.getLastWebPreferences()
            return {
              url: window.webContents.getURL(),
              focused: window.isFocused(),
              visible: window.isVisible(),
              sandbox: preferences.sandbox,
              contextIsolation: preferences.contextIsolation,
              nodeIntegration: preferences.nodeIntegration,
              webSecurity: preferences.webSecurity,
            }
          }),
      }))
      assert.equal(runtime.appPath, checkout)
      assert.equal(runtime.userData, profile)
      assert.equal(runtime.windows.length, 1)
      assert.equal(runtime.windows[0].sandbox, true)
      assert.equal(runtime.windows[0].contextIsolation, true)
      assert.equal(runtime.windows[0].nodeIntegration, false)
      assert.equal(runtime.windows[0].webSecurity, true)
      assert.equal(runtime.windows[0].visible, true)
      const existing = await page.evaluate(
        async (id) =>
          (await window.hibi.getAddonStates()).find(
            (state) => state.id === id,
          ) ?? null,
        manifest.id,
      )
      assert.equal(
        existing,
        null,
        'The host must not contain the compiled native Doom addon',
      )
      observation.nativeRuntime = runtime
      return { runtime, existingDoom: existing }
    })
    await check(
      'actual Settings URL install, review, disabled default, and byte identity',
      async () => {
        const result = await install(observation.installUrl)
        const native = await snapshotMain()
        const review = native.dialogs.filter((entry) => entry.kind === 'review')
        assert.equal(review.length, 1)
        assert.deepEqual(review[0].options.buttons, ['Cancel', 'Install'])
        assert.equal(review[0].options.defaultId, 0)
        assert.match(review[0].options.detail, /Downloaded from 127\.0\.0\.1:/)
        assert.match(
          review[0].options.detail,
          /stay disabled until you enable it/,
        )
        const download = observation.downloads.find(
          (entry) => entry.status === 200,
        )
        assert.equal(download?.encrypted, true)
        assert.equal(download?.completed, true)
        assert.equal(download?.bytes, zip.length)
        assert.equal(download?.sha256, digest(zip))
        const installedDirectory = join(
          profile,
          'installed-addons',
          manifest.id,
        )
        const record = JSON.parse(
          await readFile(
            join(installedDirectory, '.hibi-install.json'),
            'utf8',
          ),
        )
        assert.equal(record.source, 'third-party')
        assert.deepEqual(
          [...record.files].sort(),
          files.map((file) => file.path).sort(),
        )
        for (const file of files)
          assert.deepEqual(
            await readFile(join(installedDirectory, file.path)),
            file.bytes,
            `Installed file differs at ${file.path}`,
          )
        assert.equal(
          installed.url,
          `app://hibi/installed-addons/${manifest.id}/${record.hash}/${manifest.entry}`,
        )
        observation.installed = installed
        observation.installRecord = record
        await screenshot('installed-disabled')
        return {
          ...result,
          review,
          download,
          record,
          matchedFiles: files.map((file) => ({
            path: file.path,
            sha256: file.sha256,
          })),
        }
      },
    )
    await check(
      'enable through Settings and preserve the editable note',
      async () => {
        await setEnabled(true)
        await backToApp()
        await clickMenu(application, 'Open…')
        await waitForDocumentEditor(application, page)
        assert.equal(
          await editor().textContent(),
          'Original HTTPS verification note.',
        )
        observation.noteBefore = await page.evaluate(() =>
          window.hibi.getDocument(),
        )
        const action = page.locator(
          '.titlebar-actions > [data-toolbar-id="hibi-doom.play"]',
        )
        await action.waitFor()
        const titlebar = await action.evaluate((button) => {
          const group = button.parentElement
          const view = document.querySelector('.view-switch')
          const icon = button.querySelector('svg')
          return {
            beforeView:
              group.nextElementSibling === view &&
              button.getBoundingClientRect().right <=
                view.getBoundingClientRect().left,
            firstAction: group.firstElementChild === button,
            iconSize: icon.getAttribute('width'),
            strokeWidth: icon.getAttribute('stroke-width'),
          }
        })
        assert.deepEqual(titlebar, {
          beforeView: true,
          firstAction: true,
          iconSize: '16',
          strokeWidth: '1.5',
        })
        assert.equal(
          await page
            .locator('.editor-toolbar [data-toolbar-id="hibi-doom.play"]')
            .count(),
          0,
        )
        assert.equal(workerCount(), 0)
        return { note: observation.noteBefore, titlebar }
      },
    )
    await check(
      'offline license and source export cancellation, conflict, and verified archive',
      async () => {
        const before = await snapshotRenderer()
        const networkBefore = await snapshotMain()
        await application.evaluate(() => {
          globalThis.__doomAcceptanceMain.networkOffline = true
        })
        await command('Doom license and source')
        const licenses = page.getByRole('region', {
          name: 'Doom license and source',
          exact: true,
        })
        await licenses.waitFor()
        const notices = licenses.getByLabel('Complete license notices', {
          exact: true,
        })
        await notices.waitFor()
        const noticeText = await notices.innerText()
        assert.match(noticeText, /GNU GENERAL PUBLIC LICENSE/)
        assert.match(noticeText, /## Project license/)
        assert.match(noticeText, /GPL-3\.0-only/)
        assert.match(noticeText, /Version 3, 29 June 2007/)
        assert.match(noticeText, /## Third-party notices/)
        assert.match(
          noticeText,
          /ABSOLUTELY NO WARRANTY|absolutely no warranty/,
        )
        assert.match(
          noticeText,
          /The DOOM shareware wad is freely distributable/,
        )
        assert.match(noticeText, /LLVM Exceptions/)
        assert.equal(workerCount(), 0)
        const save = licenses.getByRole('button', {
          name: 'Save corresponding source',
          exact: true,
        })
        await application.evaluate((_, conflictPath) => {
          globalThis.__doomAcceptanceMain.exportQueue.push(
            { kind: 'cancel' },
            { kind: 'path', path: conflictPath },
          )
        }, conflictPath)
        await save.click()
        const canceled = await eventually(
          snapshotMain,
          (state) =>
            state.exportChoices === 1 &&
            state.inFlight === 0 &&
            state.outstandingGrants === 0,
          'Canceled native source selection did not finish',
        )
        assert.equal(canceled.io.at(-1).ok, true)
        assert.equal(canceled.io.at(-1).name, null)
        assert.equal(workerCount(), 0)
        await eventually(
          () => save.isEnabled(),
          Boolean,
          'Canceled export did not allow another save',
        )
        await save.click()
        await licenses.getByRole('alert').waitFor()
        const rejected = await eventually(
          snapshotMain,
          (state) =>
            state.exportChoices === 2 &&
            state.inFlight === 0 &&
            state.outstandingGrants === 0,
          'Source conflict did not finish its actual selected-I/O operation',
        )
        assert.equal(rejected.io.at(-1).code, 'conflict')
        assert.equal(
          await readFile(conflictPath, 'utf8'),
          'Keep this existing source file.\n',
        )
        assert.match(
          await licenses.getByRole('alert').innerText(),
          /already exists.*another name/,
        )
        await eventually(
          () => save.isEnabled(),
          Boolean,
          'Conflict export did not allow another destination',
        )
        await save.click()
        await licenses
          .getByText('The corresponding source was saved.', { exact: true })
          .waitFor()
        const saved = await eventually(
          snapshotMain,
          (state) => state.inFlight === 0 && state.outstandingGrants === 0,
          'Saved source retained a grant',
        )
        const written = saved.io
          .filter((entry) => entry.channel.endsWith(':write-export'))
          .at(-1)
        assert.equal(written.ok, true)
        assert.equal(written.bytes, bundle.source.bytes)
        assert.equal(written.sha256, bundle.source.sha256)
        const bytes = await readFile(sourcePath)
        assert.equal(bytes.length, bundle.source.bytes)
        assert.equal(digest(bytes), bundle.source.sha256)
        const contents = readTarGz(bytes)
        for (const path of [
          'src/index.tsx',
          'src/wasi.ts',
          'src/vm.mjs',
          'scripts/engine-build.py',
          'scripts/build.mjs',
          'engine/platform.c',
          'engine/video.c',
          'engine/audio.c',
          'engine/input.patch',
          'engine/abi.json',
          'src/audio.ts',
          'src/audio-bank.ts',
          'src/audio-scene.ts',
          'src/music.ts',
          'engine/config.h',
          'src/iwad.ts',
          'engine/vendor/doomgeneric/doomgeneric/d_main.c',
          'engine/vendor/wasi-libc/Makefile',
          'engine/vendor/llvm-project/compiler-rt/lib/builtins/multi3.c',
        ])
          assert(contents.has(path), `Exported source is missing ${path}`)
        const inventory = JSON.parse(contents.get('SOURCE-INVENTORY.json'))
        for (const [path, sha256] of Object.entries(inventory.files))
          assert.equal(digest(contents.get(path)), sha256, path)
        assert.equal(
          [...contents.keys()].some((path) =>
            path.startsWith('addon/assets/iwad/'),
          ),
          false,
        )
        assert.equal(
          [...contents.values()].some(
            (bytes) => digest(bytes) === bundle.iwad.sha256,
          ),
          false,
        )
        const after = await snapshotRenderer()
        assert.equal(after.created, before.created)
        assert.equal(after.active, 0)
        assert.equal(workerCount(), 0)
        assert.equal(saved.network.length, networkBefore.network.length)
        assert.equal(
          after.packageFetches.filter(
            (entry) =>
              entry.url.includes('/assets/engine/') ||
              entry.url.includes('/assets/iwad/'),
          ).length,
          0,
        )
        assert.equal(
          saved.io.filter((entry) =>
            /:(select|read)-import$/.test(entry.channel),
          ).length,
          0,
        )
        await screenshot('licenses-and-source')
        await licenses
          .getByRole('button', { name: 'Close license', exact: true })
          .click()
        await application.evaluate(() => {
          globalThis.__doomAcceptanceMain.networkOffline = false
        })
        return {
          canceled,
          conflict: rejected.io.at(-1),
          written,
          source: {
            bytes: bytes.length,
            sha256: digest(bytes),
            files: contents.size,
          },
          createdWorkers: after.created,
        }
      },
    )
    await check(
      'real title, menus, level, movement, and ammunition change',
      async () => {
        const startup = await startSession('initial', 'download')
        const menus = []
        for (let selection = 0; selection < 4; selection++) {
          const began = performance.now()
          await page.keyboard.press('Enter')
          await advance(selection === 3 ? 1200 : 400, levelTimeout)
          const frame =
            selection === 3
              ? await eventually(
                  snapshotFrame,
                  (frame) => frame.ammoSha256 === initialAmmoSha256,
                  'Doom did not enter the actual first level with the pinned initial ammunition',
                  levelTimeout,
                )
              : await snapshotFrame()
          const elapsedMs = performance.now() - began
          await screenshot(
            selection === 3 ? 'gameplay-start' : `menu-${selection + 1}`,
          )
          menus.push({ selection, elapsedMs, frame })
        }
        const beforeMove = await snapshotFrame()
        await page.keyboard.down('ArrowUp')
        await advance(650)
        await page.keyboard.up('ArrowUp')
        const moved = await snapshotFrame()
        assert.notEqual(
          moved.viewSha256,
          beforeMove.viewSha256,
          'Forward input must visibly change the actual level',
        )
        await screenshot('gameplay-forward')
        await page.keyboard.down('ArrowRight')
        await advance(350)
        await page.keyboard.up('ArrowRight')
        const beforeFire = await snapshotFrame()
        assert.equal(beforeFire.ammoSha256, initialAmmoSha256)
        await page.keyboard.press('f')
        const fired = await eventually(
          snapshotFrame,
          (frame) => frame.ammoSha256 !== initialAmmoSha256,
          'Fire did not change the actual level ammunition pixels',
          timeout,
        )
        assert(fired.nonBlackPixels > fired.width * fired.height * 0.05)
        await screenshot('gameplay-fired')
        const noteAfter = await page.evaluate(() => window.hibi.getDocument())
        assert.deepEqual(noteAfter, observation.noteBefore)
        return {
          startup,
          menus,
          beforeMove,
          moved,
          beforeFire,
          fired,
          noteAfter,
        }
      },
    )
    await check('one tab and worker across repeated Play Doom', async () => {
      const before = await snapshotRenderer()
      await command()
      assert.equal(
        await page.getByRole('tab', { name: 'Doom', exact: true }).count(),
        1,
      )
      assert.equal(workerCount(), 1)
      const after = await snapshotRenderer()
      assert.equal(after.created, before.created)
      const bounds = await canvas().boundingBox()
      const viewport = await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
      }))
      assert(bounds.width > viewport.width * 0.7 && bounds.height > 300)
      await canvas().click()
      return { before: before.records, after: after.records, bounds, viewport }
    })
    await check('steady completed canvas frames over wall time', async () => {
      await advance(400)
      const host = {
        platform: platform(),
        loadAverageBefore: loadavg(),
        logicalCpus: cpus().length,
        availableParallelism: availableParallelism(),
      }
      const began = performance.now()
      const first = await page.evaluate(() => ({
        completedFrames: window.__doomAcceptance.canvasFrames,
        at: performance.now(),
      }))
      const before = await snapshotFrame()
      await delay(perfMilliseconds)
      const last = await page.evaluate(() => ({
        completedFrames: window.__doomAcceptance.canvasFrames,
        at: performance.now(),
      }))
      const after = await snapshotFrame()
      const completedFrames = last.completedFrames - first.completedFrames
      const elapsedMs = last.at - first.at
      assert(completedFrames > 0)
      assert(
        after.sequence > before.sequence && after.gameTime > before.gameTime,
      )
      const renderer = await snapshotRenderer()
      assert.deepEqual(renderer.errors, [])
      assert.deepEqual(pageErrors, [])
      const measurement = {
        claim:
          'One native acceptance run counted completed canvas frame publications during this wall-time interval. This is not a comparative performance result.',
        runCount: 1,
        completedFrames,
        elapsedMs,
        wallClockFps: (completedFrames * 1000) / elapsedMs,
        controllerElapsedMs: performance.now() - began,
        before,
        after,
        host: { ...host, loadAverageAfter: loadavg() },
        frameSignal:
          'Mutation records for data-sequence written after canvas drawing. Game-time advancement is reported separately.',
        limiter:
          'Not profiled in this acceptance run. No speedup or adoption comparison is claimed.',
        errorCount: pageErrors.length + renderer.errors.length,
      }
      observation.performance = measurement
      return measurement
    })
    await check('explicit pause and resume release held input', async () => {
      const held = await holdForward()
      await page.getByRole('button', { name: 'Pause', exact: true }).click()
      const paused = await freeze('explicit pause')
      const beforeResume = await page.evaluate(() => performance.now())
      await page.getByRole('button', { name: 'Resume', exact: true }).click()
      await canvas().click()
      const release = await assertReleased(beforeResume)
      const resumed = await assertProgress(paused.after)
      return { held, paused, release, resumed }
    })
    await check(
      'hidden tab pauses, releases input, and preserves ordinary note editing',
      async () => {
        const held = await holdForward()
        await page
          .locator(`[data-tab-id="${observation.noteBefore.tabId}"]`)
          .click()
        await waitForDocumentEditor(application, page)
        const paused = await freeze('hidden game tab')
        await replaceRichText(
          page,
          editor(),
          'Saved while HTTPS-installed Doom was open.',
        )
        await clickMenu(application, 'Save')
        await eventually(
          () => readFile(notePath, 'utf8'),
          (text) => text === 'Saved while HTTPS-installed Doom was open.\n',
          'Ordinary note Save changed or lost the text',
        )
        await screenshot('note-edited-and-saved')
        const beforeResume = await page.evaluate(() => performance.now())
        await page.getByRole('tab', { name: 'Doom', exact: true }).click()
        await canvas().click()
        const release = await assertReleased(beforeResume)
        const resumed = await assertProgress(paused.after)
        assert.equal(
          await readFile(notePath, 'utf8'),
          'Saved while HTTPS-installed Doom was open.\n',
        )
        return {
          held,
          paused,
          release,
          resumed,
          savedText: await readFile(notePath, 'utf8'),
        }
      },
    )
    await check(
      'native blur and hidden window pause and release held input',
      async () => {
        await focusMain()
        nativeFocusSession = await application.context().newCDPSession(page)
        try {
          await nativeFocusSession.send('Emulation.setFocusEmulationEnabled', {
            enabled: false,
          })
          const initialFocus = await eventually(
            snapshotNativeFocus,
            (state) => state.mainFocused && state.rendererFocused,
            'Hibi did not own native focus before the transfer',
          )
          const held = await holdForward()
          observation.nativeFocusProbe = await application.evaluate(
            async ({ BrowserWindow }) => {
              if (globalThis.__doomAcceptanceNativeFocusProbe)
                throw new Error('Native focus probe already exists')
              const main = BrowserWindow.getAllWindows().find(
                (window) => window.webContents.getURL() === 'app://hibi/',
              )
              if (!main) throw new Error('Hibi main window unavailable')
              const window = new BrowserWindow({
                width: 320,
                height: 240,
                show: false,
                title: 'Doom acceptance native focus probe',
                webPreferences: {
                  sandbox: true,
                  contextIsolation: true,
                  nodeIntegration: false,
                  webSecurity: true,
                },
              })
              const record = {
                mainPid: process.pid,
                mainWindowId: main.id,
                windowId: window.id,
                createdAt: new Date().toISOString(),
                closed: false,
              }
              globalThis.__doomAcceptanceNativeFocusProbe = { window, record }
              await window.loadURL('about:blank')
              const preferences = window.webContents.getLastWebPreferences()
              record.url = window.webContents.getURL()
              record.security = {
                sandbox: preferences.sandbox,
                contextIsolation: preferences.contextIsolation,
                nodeIntegration: preferences.nodeIntegration,
                webSecurity: preferences.webSecurity,
              }
              window.show()
              window.focus()
              return record
            },
          )
          observation.cleanup.nativeFocusProbeClosed = false
          assert.equal(observation.nativeFocusProbe.url, 'about:blank')
          assert.deepEqual(observation.nativeFocusProbe.security, {
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: true,
          })
          const transferredFocus = await eventually(
            snapshotNativeFocus,
            (state) =>
              state.probeFocused &&
              state.focusedWindowId === observation.nativeFocusProbe.windowId &&
              !state.mainFocused &&
              !state.rendererFocused,
            'Native focus transfer did not reach the renderer',
          )
          const blurred = await freeze('native blur')
          const beforeResume = await page.evaluate(() => performance.now())
          await closeNativeFocusProbe()
          await focusMain()
          const returnedFocus = await eventually(
            snapshotNativeFocus,
            (state) => state.mainFocused && state.rendererFocused,
            'Hibi did not regain native focus after the transfer',
          )
          await canvas().click()
          const release = await assertReleased(beforeResume)
          await assertProgress(blurred.after)
          await application.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()
              .find((window) => window.webContents.getURL() === 'app://hibi/')
              .hide(),
          )
          const hiddenFocus = await eventually(
            snapshotNativeFocus,
            (state) =>
              !state.mainVisible &&
              !state.mainFocused &&
              !state.rendererFocused,
            'Native hidden window remained visible or focused',
          )
          const hidden = await freeze('native hidden window')
          await focusMain()
          await canvas().click()
          const resumed = await assertProgress(hidden.after)
          return {
            held,
            initialFocus,
            transferredFocus,
            probe: observation.nativeFocusProbe,
            blurred,
            returnedFocus,
            release,
            hiddenFocus,
            hidden,
            resumed,
          }
        } finally {
          try {
            await closeNativeFocusProbe()
          } finally {
            await restoreNativeFocusSession()
          }
        }
      },
    )
    await check(
      'close aborts package loading and reopens automatically with one fresh worker',
      async () => {
        const before = await snapshotRenderer()
        await page
          .getByRole('button', { name: 'Close game', exact: true })
          .click()
        await page
          .getByRole('region', { name: 'Doom game', exact: true })
          .waitFor({ state: 'detached' })
        await waitForWorkers(0)
        const closed = await snapshotRenderer()
        assert.equal(closed.active, 0)
        assert.equal(closed.terminated, before.terminated + 1)
        await page.evaluate(() => {
          globalThis.__doomAcceptance.deferResource = 'engine'
        })
        await command()
        const pending = await eventually(
          snapshotRenderer,
          (state) => state.pendingResource,
          'The installed resource fetch did not wait for its controlled response',
        )
        await page
          .getByRole('button', { name: 'Close game', exact: true })
          .click()
        await page
          .getByRole('region', { name: 'Doom game', exact: true })
          .waitFor({ state: 'detached' })
        await page.evaluate(() => globalThis.__releaseDoomResource())
        const released = await eventually(
          snapshotRenderer,
          (state) =>
            !state.pendingResource &&
            state.packageFetches.at(-1).outcome === 'aborted',
          'Closing the game did not abort its installed resource load',
        )
        await delay(300)
        const afterLate = await snapshotRenderer()
        assert.equal(afterLate.created, closed.created)
        assert.equal(afterLate.active, 0)
        assert.equal(workerCount(), 0)
        await application.evaluate(() => {
          globalThis.__doomAcceptanceMain.networkOffline = true
        })
        const reopened = await startSession('reopened-offline')
        assert.notEqual(reopened.worker.id, before.records.at(-1).id)
        const repeatedBefore = await snapshotRenderer()
        await command()
        const repeatedAfter = await snapshotRenderer()
        assert.equal(repeatedAfter.created, repeatedBefore.created)
        assert.equal(repeatedAfter.active, 1)
        await application.evaluate(() => {
          globalThis.__doomAcceptanceMain.networkOffline = false
        })
        return {
          closed: closed.records,
          pending,
          released: released.packageFetches.at(-1),
          afterLate: afterLate.records,
          reopened,
        }
      },
    )
    await check(
      'Close stops future shareware chunks and ignores a late actual HTTPS result without saving data or starting a worker',
      async () => {
        const cleared = await clearCachedGame()
        const before = await snapshotRenderer()
        const nativeBefore = await snapshotMain()
        await application.evaluate(() => {
          globalThis.__doomAcceptanceMain.holdSharewareBody = true
        })
        await command()
        const pending = await eventually(
          snapshotMain,
          (state) =>
            state.pendingSharewareBody &&
            state.network.at(-1)?.completedAt === null,
          'The actual public shareware part did not retain its response body',
          timeout,
        )
        const request = pending.network.at(-1)
        const body = pending.http.at(-1)
        assert(request.url.endsWith('/doom1-part-00.json'))
        assert.equal(body.held, true)
        assert.equal(body.responseCompleteAtHold, false)
        assert.equal(body.endedAt, null)
        assert.equal(body.signalAborted, false)
        assert.equal(workerCount(), 0)
        await page
          .getByRole('button', { name: 'Close game', exact: true })
          .click()
        await page
          .getByRole('region', { name: 'Doom game', exact: true })
          .waitFor({ state: 'detached' })
        const closed = await snapshotMain()
        assert.equal(closed.network.length, pending.network.length)
        assert.equal(closed.http.at(-1).signalAborted, false)
        assert.equal(closed.http.at(-1).endedAt, null)
        await application.evaluate(() =>
          globalThis.__releaseDoomSharewareBody(),
        )
        const late = await eventually(
          snapshotMain,
          (state) => state.network.at(-1)?.completedAt !== null,
          'The released actual HTTPS result did not finish',
          timeout,
        )
        assert.equal(late.network.at(-1).ok, true)
        assert.equal(late.network.length - nativeBefore.network.length, 2)
        assert.equal(
          late.storage.filter((entry) => entry.channel.endsWith(':write'))
            .length,
          nativeBefore.storage.filter((entry) =>
            entry.channel.endsWith(':write'),
          ).length,
        )
        const after = await snapshotRenderer()
        assert.equal(after.created, before.created)
        assert.equal(after.active, 0)
        assert.equal(workerCount(), 0)
        return {
          cleared,
          pendingRequest: request,
          heldBody: body,
          closeDidNotAbortNativeRequest: true,
          lateResult: late.network.at(-1),
          noSubsequentChunksOrCacheWrites: true,
          restarted: await startSession('after-closed-download', 'download'),
        }
      },
    )
    await check(
      'source export remains offline and contains no game data after the persistent cache is populated',
      async () => {
        const before = await snapshotMain()
        await application.evaluate((_, cachedSourcePath) => {
          globalThis.__doomAcceptanceMain.networkOffline = true
          globalThis.__doomAcceptanceMain.exportQueue.push({
            kind: 'path',
            path: cachedSourcePath,
          })
        }, cachedSourcePath)
        await command('Doom license and source')
        const licenses = page.getByRole('region', {
          name: 'Doom license and source',
          exact: true,
        })
        await licenses
          .getByRole('button', {
            name: 'Save corresponding source',
            exact: true,
          })
          .click()
        await licenses
          .getByText('The corresponding source was saved.', { exact: true })
          .waitFor()
        const bytes = await readFile(cachedSourcePath)
        assert.equal(digest(bytes), bundle.source.sha256)
        const contents = readTarGz(bytes)
        assert.equal(
          [...contents.keys()].some((path) =>
            path.startsWith('addon/assets/iwad/'),
          ),
          false,
        )
        assert.equal(
          [...contents.values()].some(
            (value) => digest(value) === bundle.iwad.sha256,
          ),
          false,
        )
        const after = await snapshotMain()
        assert.equal(after.network.length, before.network.length)
        assert.equal(after.storage.length, before.storage.length)
        await licenses
          .getByRole('button', { name: 'Close license', exact: true })
          .click()
        await application.evaluate(() => {
          globalThis.__doomAcceptanceMain.networkOffline = false
        })
        await command()
        return {
          sourceSha256: digest(bytes),
          files: contents.size,
          cacheWasExcluded: true,
          networkRequests: 0,
        }
      },
    )
    await check(
      'disable revokes the owner and aborts an actual unfinished public shareware body before any cache save or worker startup',
      async () => {
        const cleared = await clearCachedGame()
        const before = await snapshotRenderer()
        const nativeBefore = await snapshotMain()
        await application.evaluate(() => {
          globalThis.__doomAcceptanceMain.holdSharewareBody = true
        })
        await command()
        const pending = await eventually(
          snapshotMain,
          (state) =>
            state.pendingSharewareBody &&
            state.network.at(-1)?.completedAt === null,
          'The actual shareware body did not stay pending before disablement',
          timeout,
        )
        assert.equal(pending.http.at(-1).responseCompleteAtHold, false)
        assert.equal(pending.http.at(-1).endedAt, null)
        await setEnabled(false)
        const revoked = await eventually(
          snapshotMain,
          (state) => {
            const request = state.network.at(-1)
            const body = state.http.at(-1)
            return (
              request?.completedAt !== null &&
              request?.ok === false &&
              body?.signalAborted &&
              body?.aborted &&
              body?.closedAt !== null
            )
          },
          'Disablement did not revoke the stock handler and abort the actual held request',
          timeout,
        )
        assert.equal(revoked.network.at(-1).code, 'stale')
        assert.equal(revoked.http.at(-1).destroyed, true)
        assert.equal(revoked.http.at(-1).complete, false)
        assert.equal(revoked.network.length - nativeBefore.network.length, 2)
        assert.equal(
          revoked.storage.filter((entry) => entry.channel.endsWith(':write'))
            .length,
          nativeBefore.storage.filter((entry) =>
            entry.channel.endsWith(':write'),
          ).length,
        )
        assert.equal(revoked.pendingSharewareBody, false)
        const stopped = await snapshotRenderer()
        assert.equal(stopped.created, before.created)
        assert.equal(stopped.active, 0)
        await waitForWorkers(0)
        await setEnabled(true)
        await backToApp()
        return {
          cleared,
          pendingRequest: pending.network.at(-1),
          heldBody: pending.http.at(-1),
          revokedRequest: revoked.network.at(-1),
          abortedBody: revoked.http.at(-1),
          noCacheSaveOrWorkerStartup: true,
          restarted: await startSession('after-revoked-download', 'download'),
        }
      },
    )
    await check(
      'a late source destination after close is canceled without writing or replacing the game',
      async () => {
        const before = await snapshotRenderer()
        const ioBefore = await snapshotMain()
        await application.evaluate((_, lateSourcePath) => {
          globalThis.__doomAcceptanceMain.exportQueue.push({
            kind: 'deferred',
            path: lateSourcePath,
          })
        }, lateSourcePath)
        await command('Doom license and source')
        const licenses = page.getByRole('region', {
          name: 'Doom license and source',
          exact: true,
        })
        await licenses
          .getByRole('button', {
            name: 'Save corresponding source',
            exact: true,
          })
          .click()
        const pending = await eventually(
          snapshotMain,
          (state) => state.pendingExportChoice && state.inFlight === 1,
          'The source destination did not wait for its controlled native response',
        )
        await licenses
          .getByRole('button', { name: 'Close license', exact: true })
          .click()
        await application.evaluate(() =>
          globalThis.__releaseDoomAcceptanceChooser(),
        )
        const released = await eventually(
          snapshotMain,
          (state) =>
            !state.pendingExportChoice &&
            state.inFlight === 0 &&
            state.outstandingGrants === 0,
          'The closed source view retained a late export grant',
        )
        const operations = released.io.slice(ioBefore.io.length)
        assert.equal(
          operations.some((entry) => entry.channel.endsWith(':write-export')),
          false,
        )
        assert(
          operations.some(
            (entry) => entry.channel.endsWith(':cancel') && entry.ok,
          ),
        )
        await assert.rejects(stat(lateSourcePath), { code: 'ENOENT' })
        await command()
        await focusMain()
        await canvas().click()
        const after = await snapshotRenderer()
        assert.equal(after.created, before.created)
        assert.equal(workerCount(), 1)
        await assertProgress(await snapshotFrame())
        return { pending, operations, workers: after.records }
      },
    )
    await check(
      'disable aborts source loading and disposes the real worker, then enable starts fresh',
      async () => {
        const before = await snapshotRenderer()
        const ioBefore = await snapshotMain()
        await page.evaluate(() => {
          globalThis.__doomAcceptance.deferResource = 'source'
        })
        await command('Doom license and source')
        await page
          .getByRole('region', {
            name: 'Doom license and source',
            exact: true,
          })
          .getByRole('button', {
            name: 'Save corresponding source',
            exact: true,
          })
          .click()
        const pending = await eventually(
          snapshotRenderer,
          (state) => state.pendingResource,
          'The source export did not wait for its installed resource response',
        )
        const sourceFetch = pending.packageFetches.at(-1)
        assert(sourceFetch.url.includes('/assets/source/'))
        assert.equal(sourceFetch.outcome, 'pending')
        const pendingIo = await snapshotMain()
        assert.equal(pendingIo.pendingExportChoice, false)
        assert.equal(pendingIo.inFlight, 0)
        assert.equal(pendingIo.outstandingGrants, 0)
        assert.equal(pendingIo.io.length, ioBefore.io.length)
        await setEnabled(false)
        await waitForWorkers(0)
        const aborted = await eventually(
          snapshotRenderer,
          (state) =>
            !state.pendingResource &&
            state.packageFetches.find((entry) => entry.at === sourceFetch.at)
              ?.outcome === 'aborted',
          'Disabling Doom did not abort its installed source resource load',
        )
        await page.evaluate(() => globalThis.__releaseDoomResource())
        await delay(300)
        const disabled = await snapshotRenderer()
        assert.equal(disabled.active, 0)
        assert.equal(disabled.terminated, before.terminated + 1)
        assert.equal(disabled.created, before.created)
        assert.equal(disabled.pendingResource, false)
        assert.equal(
          disabled.packageFetches.find((entry) => entry.at === sourceFetch.at)
            ?.outcome,
          'aborted',
        )
        assert.equal(
          await page.getByRole('tab', { name: 'Doom', exact: true }).count(),
          0,
        )
        const io = await snapshotMain()
        assert.equal(io.pendingExportChoice, false)
        assert.equal(io.inFlight, 0)
        assert.equal(io.outstandingGrants, 0)
        assert.equal(io.exportChoices, ioBefore.exportChoices)
        assert.deepEqual(io.io.slice(ioBefore.io.length), [])
        await setEnabled(true)
        await backToApp()
        return {
          pendingSourceFetch: sourceFetch,
          abortedSourceFetch: aborted.packageFetches.find(
            (entry) => entry.at === sourceFetch.at,
          ),
          pendingIo,
          disabled: disabled.records,
          io,
          restarted: await startSession('reenabled'),
        }
      },
    )
    await check(
      'renderer reload destroys the worker and has no outstanding selected I/O',
      async () => {
        const old = await snapshotRenderer()
        const oldWorker = [...ownedWorkers.values()].find(
          (worker) => worker.closedAt === null,
        )
        const beforeIo = await snapshotMain()
        assert.equal(beforeIo.inFlight, 0)
        assert.equal(beforeIo.outstandingGrants, 0)
        observation.epochs.push(old)
        await page.reload()
        await waitForDocumentEditor(application, page, { timeout: 30000 })
        await waitForWorkers(0)
        assert(oldWorker.closedAt)
        const replacement = await snapshotRenderer()
        assert.notEqual(replacement.epoch, old.epoch)
        assert.equal(replacement.active, 0)
        const afterIo = await snapshotMain()
        assert.equal(afterIo.inFlight, 0)
        assert.equal(afterIo.outstandingGrants, 0)
        assert.equal(
          await readFile(notePath, 'utf8'),
          'Saved while HTTPS-installed Doom was open.\n',
        )
        return {
          oldEpoch: old.epoch,
          replacementEpoch: replacement.epoch,
          oldWorker,
          beforeIo,
          afterIo,
          restarted: await startSession('after-reload'),
        }
      },
    )
    await check(
      'remove disposes an active worker and exact URL reinstall remains disabled',
      async () => {
        await openSettings()
        await page
          .locator(`[data-setting-id="addon-${manifest.id}"]`)
          .getByRole('button', { name: 'Remove', exact: true })
          .click()
        await waitForAsync(
          page,
          async (id) =>
            !(await window.hibi.getInstalledAddons()).some(
              ({ manifest }) => manifest.id === id,
            ),
          manifest.id,
        )
        await waitForWorkers(0)
        const removed = await snapshotRenderer()
        assert.equal(removed.active, 0)
        assert.equal(
          await page.locator('[data-toolbar-id="hibi-doom.play"]').count(),
          0,
        )
        const io = await snapshotMain()
        assert.equal(io.inFlight, 0)
        assert.equal(io.outstandingGrants, 0)
        const reinstalled = await install(observation.installUrl)
        assert.equal(installed.url, observation.installed.url)
        assert.equal(
          observation.downloads.filter(
            (entry) => entry.status === 200 && entry.completed,
          ).length,
          2,
        )
        await setEnabled(true)
        await backToApp()
        return {
          removed: removed.records,
          io,
          reinstalled,
          restarted: await startSession('after-reinstall'),
        }
      },
    )
    await check(
      'canceled native Quit preserves unsaved note and the same game worker',
      async () => {
        await canvas().click()
        for (let selection = 0; selection < 4; selection++) {
          await page.keyboard.press('Enter')
          await advance(selection === 3 ? 1200 : 400, levelTimeout)
        }
        const level = await eventually(
          snapshotFrame,
          (frame) => frame.ammoSha256 === initialAmmoSha256,
          'The quit-cancellation session did not enter the actual first level',
          levelTimeout,
        )
        await page.getByRole('button', { name: 'Pause', exact: true }).click()
        await clickMenu(application, 'New')
        await page.getByRole('tab', { name: /untitled\.md/ }).click()
        await waitForDocumentEditor(application, page)
        await replaceRichText(
          page,
          editor(),
          'Keep this unsaved HTTPS quit-cancellation draft.',
        )
        await waitForAsync(page, async () => {
          const draft = await window.hibi.getDocument()
          return (
            draft.dirty &&
            draft.markdown ===
              'Keep this unsaved HTTPS quit-cancellation draft.'
          )
        })
        const draftBefore = await page.evaluate(() => window.hibi.getDocument())
        assert.equal(draftBefore.savedMarkdown, '')
        assert.equal(draftBefore.canAutosave, false)
        assert.equal(draftBefore.ephemeral, false)
        await page.getByRole('tab', { name: 'Doom', exact: true }).click()
        await page.getByRole('button', { name: 'Resume', exact: true }).click()
        await canvas().focus()
        const frameBefore = await advance(300)
        const workersBefore = await snapshotRenderer()
        const eventsBefore = [...ownedWorkers.values()].filter(
          (worker) => worker.closedAt === null,
        )
        await application.evaluate((_, name) => {
          globalThis.__doomAcceptanceMain.quit = { name, response: 2 }
        }, draftBefore.name)
        await application.evaluate(({ app }) => app.quit())
        const prompt = await eventually(
          snapshotMain,
          (state) =>
            state.dialogs.some(
              (entry) => entry.kind === 'quit' && entry.returnedResponse === 2,
            ),
          'Quit did not reach the real unsaved-note prompt',
        )
        await page.locator('.app[aria-busy="false"]').waitFor()
        assert.equal(application.process().exitCode, null)
        assert.equal(application.process().signalCode, null)
        const draftAfter = await page.evaluate(() => window.hibi.getDocument())
        assert.deepEqual(draftAfter, draftBefore)
        const workersAfter = await snapshotRenderer()
        assert.equal(workersAfter.epoch, workersBefore.epoch)
        assert.equal(workersAfter.created, workersBefore.created)
        assert.equal(workersAfter.terminated, workersBefore.terminated)
        assert.equal(workerCount(), 1)
        assert.deepEqual(
          [...ownedWorkers.values()].filter(
            (worker) => worker.closedAt === null,
          ),
          eventsBefore,
        )
        await page.locator(`[data-tab-id="${draftBefore.tabId}"]`).click()
        await waitForDocumentEditor(application, page)
        assert.equal(await editor().textContent(), draftBefore.markdown)
        await page.getByRole('tab', { name: 'Doom', exact: true }).click()
        await focusMain()
        await canvas().focus()
        const resumed = await assertProgress(frameBefore)
        assert.equal(resumed.ammoSha256, level.ammoSha256)
        await screenshot('quit-canceled-same-session')
        return {
          level,
          draftBefore,
          draftAfter,
          workersBefore: workersBefore.records,
          workersAfter: workersAfter.records,
          prompt: prompt.dialogs.filter((entry) => entry.kind === 'quit'),
          resumed,
        }
      },
    )
    await check(
      'actual descriptor and module worker responses retain stock CSP',
      async () => {
        const main = await snapshotMain()
        const state = await snapshotRenderer()
        assert.deepEqual(observation.externalRendererRequests, [])
        assert.equal(
          main.io.filter((entry) =>
            /:(select|read)-import$/.test(entry.channel),
          ).length,
          0,
        )
        const urls = new Set(
          observation.workerEvents.map((worker) => worker.url),
        )
        assert(urls.size > 0)
        const required = ['app://hibi/', installed.url, ...urls]
        const policies = []
        for (const url of required) {
          const response = main.responses.find(
            (entry) => entry.url === url && entry.statusCode === 200,
          )
          const responses = response
            ? [{ source: 'native-response-started', ...response }]
            : []
          if (urls.has(url)) {
            const liveWorker = [...ownedWorkers].find(
              ([, worker]) => worker.url === url && worker.closedAt === null,
            )
            assert(liveWorker, `No live installed module worker for ${url}`)
            const candidate = observation.candidate.files.find(
              (file) => new URL(file.path, installed.url).href === url,
            )
            assert(candidate, `Worker URL has no prepared package file ${url}`)
            const fetched = {
              source: 'live-worker-read-only-fetch',
              method: 'GET',
              requestUrl: url,
              workerId: liveWorker[1].id,
              nativeResponseObservedBeforeFetch: Boolean(response),
              candidate: {
                path: candidate.path,
                bytes: candidate.size,
                sha256: candidate.sha256,
              },
              beganAt: new Date().toISOString(),
            }
            observation.workerResponseFetches.push(fetched)
            Object.assign(
              fetched,
              await liveWorker[0].evaluate(async (url) => {
                const response = await fetch(url, {
                  method: 'GET',
                  cache: 'no-store',
                  redirect: 'error',
                  signal: AbortSignal.timeout(15000),
                })
                const body = await response.arrayBuffer()
                const hash = await crypto.subtle.digest('SHA-256', body)
                return {
                  contextUrl: globalThis.location.href,
                  url: response.url,
                  statusCode: response.status,
                  responseHeaders: Object.fromEntries(
                    [...response.headers].map(([name, value]) => [
                      name.toLowerCase(),
                      [value],
                    ]),
                  ),
                  bytes: body.byteLength,
                  sha256: [...new Uint8Array(hash)]
                    .map((byte) => byte.toString(16).padStart(2, '0'))
                    .join(''),
                }
              }, url),
            )
            fetched.completedAt = new Date().toISOString()
            fetched.matchesCandidate = {
              bytes: fetched.bytes === candidate.size,
              sha256: fetched.sha256 === candidate.sha256,
            }
            assert.equal(fetched.contextUrl, url)
            assert.equal(fetched.url, url)
            assert.equal(fetched.statusCode, 200)
            assert.equal(fetched.bytes, candidate.size)
            assert.equal(fetched.sha256, candidate.sha256)
            const compilation = await liveWorker[0].evaluate(async () => {
              try {
                await WebAssembly.compile(
                  new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
                )
                return { denied: false }
              } catch (error) {
                return {
                  denied: true,
                  name: error.name,
                  message: error.message,
                }
              }
            })
            assert.equal(compilation.denied, true)
            assert.match(
              compilation.message,
              /CSP|content security policy|unsafe-eval/i,
            )
            fetched.nativeCompilation = compilation
            responses.push(fetched)
          }
          assert(responses.length > 0, `No actual response observed for ${url}`)
          for (const observed of responses) {
            const policy = Object.entries(observed.responseHeaders)
              .find(
                ([name]) => name.toLowerCase() === 'content-security-policy',
              )?.[1]
              ?.join('; ')
            assert(policy, `No CSP header observed for ${url}`)
            const script = policy
              .split(';')
              .find((directive) => directive.trim().startsWith('script-src '))
            assert.equal(script.trim(), "script-src 'self' app://hibi")
            assert.doesNotMatch(policy, /wasm-unsafe-eval|unsafe-eval/)
            assert.match(policy, /worker-src 'self' app:\/\/hibi/)
            policies.push({
              url,
              policy,
              source: observed.source,
              resourceType: observed.resourceType,
            })
          }
        }
        assert(
          state.records.every(
            (worker) =>
              worker.type === 'module' &&
              worker.url.startsWith(new URL('.', installed.url).href),
          ),
        )
        assert.deepEqual(state.errors, [])
        assert.deepEqual(pageErrors, [])
        return {
          policies,
          workerRecords: state.records,
          inFlightIo: main.inFlight,
          outstandingGrants: main.outstandingGrants,
        }
      },
    )
    await check(
      'normal Quit closes the real worker and exact Electron main process',
      async () => {
        observation.epochs.push(await snapshotRenderer())
        observation.main = await snapshotMain()
        assert.equal(observation.main.inFlight, 0)
        assert.equal(observation.main.outstandingGrants, 0)
        assert.equal(workerCount(), 1)
        const child = application.process()
        const exitPath = join(run, 'electron-exit.json')
        await application.evaluate((_, path) => {
          globalThis.__doomAcceptanceMain.quit.response = 1
          const fs = process.getBuiltinModule('node:fs')
          process.once('exit', (code) =>
            fs.writeFileSync(
              path,
              JSON.stringify(
                {
                  pid: process.pid,
                  exitCode: code,
                  observation: globalThis.__doomAcceptanceSnapshot(),
                  at: new Date().toISOString(),
                },
                null,
                2,
              ),
            ),
          )
        }, exitPath)
        await application.close()
        await eventually(
          async () => ({
            exitCode: child.exitCode,
            signalCode: child.signalCode,
          }),
          (state) => state.exitCode !== null || state.signalCode !== null,
          'Owned Electron main process did not exit after normal Quit',
          5000,
        )
        observation.cleanup.appClosed = true
        observation.cleanup.mainProcess = {
          pid: child.pid,
          exitCode: child.exitCode,
          signalCode: child.signalCode,
        }
        assert.equal(child.exitCode, 0)
        assert.equal(child.signalCode, null)
        await waitForWorkers(0)
        const exit = JSON.parse(await readFile(exitPath, 'utf8'))
        assert.equal(exit.pid, child.pid)
        assert.equal(exit.exitCode, 0)
        assert.equal(exit.observation.inFlight, 0)
        assert.equal(exit.observation.outstandingGrants, 0)
        assert(
          exit.observation.dialogs.some(
            (entry) => entry.kind === 'quit' && entry.returnedResponse === 1,
          ),
        )
        assert(
          observation.workerEvents.every((worker) => worker.closedAt !== null),
        )
        assert.equal(
          await readFile(notePath, 'utf8'),
          'Saved while HTTPS-installed Doom was open.\n',
        )
        observation.exit = exit
        return { exitPath, exit, workerEvents: observation.workerEvents }
      },
    )
  } catch (error) {
    failed = error
    observation.failure = failureRecord(error)
    observation.failedCheck = currentCheck?.name
    if (page && !page.isClosed()) {
      observation.failureDom = await page
        .locator('body')
        .innerText({ timeout: 3000 })
        .catch(() => '')
      await screenshot('failure').catch(() => undefined)
      observation.epochs.push(
        await snapshotRenderer().catch(() => ({ unavailable: true })),
      )
    }
  } finally {
    observation.pageErrors = pageErrors
    observation.consoleMessages = consoleMessages
    if (application && !observation.cleanup.appClosed) {
      const child = application.process()
      try {
        await closeNativeFocusProbe()
      } catch (error) {
        observation.cleanup.nativeFocusProbeError = failureRecord(error)
        failed ??= error
      }
      try {
        await restoreNativeFocusSession()
      } catch (error) {
        observation.cleanup.nativeFocusSessionError = failureRecord(error)
        failed ??= error
      }
      try {
        observation.main = await snapshotMain()
        const document =
          page && !page.isClosed()
            ? await page
                .evaluate(() => window.hibi.getDocument())
                .catch(() => null)
            : null
        await application.evaluate((_, document) => {
          globalThis.__releaseDoomAcceptanceChooser?.()
          if (document?.dirty)
            globalThis.__doomAcceptanceMain.quit.name = document.name
          globalThis.__doomAcceptanceMain.quit.response = 1
        }, document)
      } catch (error) {
        observation.cleanup.observerError = failureRecord(error)
      }
      try {
        if (child.exitCode === null && child.signalCode === null)
          await application.close()
      } catch (error) {
        observation.cleanup.closeError = failureRecord(error)
        failed ??= error
      }
      try {
        await eventually(
          async () => ({
            exitCode: child.exitCode,
            signalCode: child.signalCode,
          }),
          (state) => state.exitCode !== null || state.signalCode !== null,
          'Owned Electron main process remained live during cleanup',
          5000,
        )
        observation.cleanup.appClosed = true
        observation.cleanup.mainProcess = {
          pid: child.pid,
          exitCode: child.exitCode,
          signalCode: child.signalCode,
        }
        await waitForWorkers(0)
      } catch (error) {
        observation.cleanup.appError = failureRecord(error)
        failed ??= error
      }
    } else if (!application) observation.cleanup.appClosed = true
    if (server) {
      try {
        await new Promise((done, reject) => {
          server.close((error) => (error ? reject(error) : done()))
          server.closeAllConnections()
        })
        observation.cleanup.serverClosed = true
      } catch (error) {
        observation.cleanup.serverError = failureRecord(error)
        failed ??= error
      }
    } else observation.cleanup.serverClosed = true
    if (application && !observation.cleanup.appClosed) {
      const error = new Error(
        'Fixture retained because the exact owned Electron main process is still live',
      )
      observation.cleanup.fixtureError = failureRecord(error)
      failed ??= error
    } else {
      try {
        await rm(fixture, { recursive: true, force: true })
        observation.cleanup.fixtureRemoved = await stat(fixture).then(
          () => false,
          (error) => error.code === 'ENOENT',
        )
        assert.equal(observation.cleanup.fixtureRemoved, true)
      } catch (error) {
        observation.cleanup.fixtureError = failureRecord(error)
        failed ??= error
      }
    }
    observation.status = failed ? 'failed' : 'passed'
    observation.completedAt = new Date().toISOString()
    await writeFile(reportPath, `${JSON.stringify(observation, null, 2)}\n`)
    console.log(
      JSON.stringify({
        status: observation.status,
        reportPath,
        run,
        cleanup: observation.cleanup,
      }),
    )
  }
  if (failed) {
    failed.message += `\nNative HTTPS acceptance report ${reportPath}`
    throw failed
  }
  return observation
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await runUrlInstallAcceptance()
