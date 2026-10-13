import {
  parseWorkerReply,
  type WorkerReply,
  type WorkerRequest,
} from './model.ts'

export interface GameWorker {
  postMessage(message: unknown, transfer: Transferable[]): void
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<unknown>) => void,
  ): void
  addEventListener(
    type: 'error' | 'messageerror',
    listener: (event: Event) => void,
  ): void
  removeEventListener(
    type: 'message',
    listener: (event: MessageEvent<unknown>) => void,
  ): void
  removeEventListener(
    type: 'error' | 'messageerror',
    listener: (event: Event) => void,
  ): void
  terminate(): void
}

interface Pending {
  kind: WorkerRequest['kind']
  resolve(reply: WorkerReply): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

export class GameSession {
  private worker: GameWorker | null
  private nextId = 0
  private pending = new Map<number, Pending>()
  private failure: Error | null = null
  private timeoutMs: number

  constructor(worker: GameWorker, timeoutMs = 15000) {
    this.worker = worker
    this.timeoutMs = timeoutMs
    worker.addEventListener('message', this.receive)
    worker.addEventListener('error', this.workerError)
    worker.addEventListener('messageerror', this.workerError)
  }

  get disposed() {
    return this.worker === null
  }

  request(
    input: WorkerRequest,
    transfer: Transferable[] = [],
  ): Promise<WorkerReply> {
    const worker = this.worker
    if (!worker)
      return Promise.reject(
        this.failure ??
          new Error('Doom session ended. Close and reopen the game.'),
      )
    if (
      this.pending.size >= 2 ||
      [...this.pending.values()].some((entry) => entry.kind === input.kind)
    )
      return Promise.reject(new Error('Doom already has a pending request.'))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.dispose(
          new Error('Doom stopped responding. Close and reopen the game.'),
        )
      }, this.timeoutMs)
      this.pending.set(id, { kind: input.kind, resolve, reject, timer })
      try {
        worker.postMessage({ id, ...input }, transfer)
      } catch (error) {
        this.dispose(
          error instanceof Error
            ? error
            : new Error('Hibi could not send Doom input.'),
        )
      }
    })
  }

  dispose(error = new Error('Doom session ended.')) {
    const worker = this.worker
    if (!worker) return
    this.worker = null
    this.failure = error
    worker.removeEventListener('message', this.receive)
    worker.removeEventListener('error', this.workerError)
    worker.removeEventListener('messageerror', this.workerError)
    worker.terminate()
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }

  private workerError = () => {
    this.dispose(
      new Error('The Doom worker failed. Close and reopen the game.'),
    )
  }

  private receive = (event: MessageEvent<unknown>) => {
    try {
      const reply = parseWorkerReply(event.data)
      const entry = this.pending.get(reply.id)
      if (!entry) throw new Error('Doom returned an unexpected request ID.')
      if (reply.kind === 'error') {
        this.dispose(new Error(reply.message))
        return
      }
      if (
        (entry.kind === 'startup' && reply.kind !== 'ready') ||
        (entry.kind === 'activity' && reply.kind !== 'activity') ||
        (entry.kind === 'frame' && reply.kind !== 'update')
      )
        throw new Error('Doom returned an unexpected response.')
      this.pending.delete(reply.id)
      clearTimeout(entry.timer)
      entry.resolve(reply)
    } catch (error) {
      this.dispose(
        error instanceof Error
          ? error
          : new Error('Invalid Doom worker response.'),
      )
    }
  }
}
