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
    this.exit = new Promise((resolve) => this.worker.once('exit', resolve))
    this.termination = null
  }

  postMessage(message, transfer) {
    this.worker.postMessage(message, transfer)
  }

  terminate() {
    this.termination ??= this.worker.terminate()
  }

  async exited(timeout = 5000) {
    let timer
    try {
      await Promise.race([
        this.exit,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('The Doom test worker did not exit.')),
            timeout,
          )
        }),
      ])
      return this.worker.threadId
    } finally {
      clearTimeout(timer)
    }
  }
}
