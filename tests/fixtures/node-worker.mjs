import { Worker } from 'node:worker_threads'

export class BrowserWorker extends EventTarget {
  constructor(options = {}) {
    super()
    this.worker = new Worker(new URL('./browser-worker.mjs', import.meta.url), {
      workerData: {
        entry: new URL('../../addon/doom.worker.js', import.meta.url).href,
        ...options,
      },
    })
    this.worker.on('message', (data) =>
      this.dispatchEvent(new MessageEvent('message', { data })),
    )
    this.worker.on('error', () => this.dispatchEvent(new Event('error')))
    this.termination = null
  }

  postMessage(message, transfer) {
    this.worker.postMessage(message, transfer)
  }

  terminate() {
    this.termination ??= this.worker.terminate()
  }

  async exited() {
    this.terminate()
    await this.termination
    return this.worker.threadId
  }
}
