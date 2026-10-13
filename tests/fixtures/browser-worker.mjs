import { parentPort, workerData } from 'node:worker_threads'

if (!parentPort) throw new Error('The test worker requires a parent port.')
const port = parentPort
if (workerData.mode === 'silent') {
  port.on('message', () => {})
} else if (workerData.mode === 'malformed') {
  port.on('message', (input) =>
    port.postMessage({ id: input.id, kind: 'update', update: null }),
  )
} else {
  globalThis.WebAssembly = undefined
  globalThis.self = {
    addEventListener(type, listener) {
      if (type !== 'message')
        throw new Error('Unsupported test worker listener.')
      port.on('message', (data) => listener({ data }))
    },
    postMessage(reply, transfer) {
      port.postMessage(reply, transfer)
    },
  }
  await import(workerData.entry)
}
