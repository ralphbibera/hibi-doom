import { DoomEngine } from './engine.ts'
import { parseWorkerCommand, type WorkerReply } from './model.ts'

declare const self: {
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<unknown>) => void,
  ): void
  postMessage(reply: WorkerReply, transfer: Transferable[]): void
}

const engine = new DoomEngine()
self.addEventListener('message', (event) => {
  void respond(event.data)
})

async function respond(raw: unknown) {
  let id = 1
  try {
    const input = parseWorkerCommand(raw)
    id = input.id
    const reply = await engine.handle(input)
    const transfer: Transferable[] = []
    if (reply.kind === 'update' && reply.update.kind === 'frame') {
      const buffer = reply.update.pixels.buffer
      if (!(buffer instanceof ArrayBuffer))
        throw new Error('Invalid Doom frame storage.')
      transfer.push(buffer)
    }
    self.postMessage(reply, transfer)
  } catch (error) {
    self.postMessage(
      {
        id,
        kind: 'error',
        message:
          error instanceof Error
            ? error.message.slice(0, 500)
            : 'Doom could not run. Close and reopen the game.',
      },
      [],
    )
  }
}
