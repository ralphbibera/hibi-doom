import type { AddonContext } from '@hibi/addon-sdk/api'
import { type DoomBundle, loadArtifact } from './bundle.ts'

export type ExportState =
  | { kind: 'idle' | 'choosing' | 'saved' | 'disposed' }
  | { kind: 'loading'; abort: AbortController }
  | { kind: 'writing' | 'cleanup'; handle: string }
  | { kind: 'failed'; message: string }

export class SourceExport {
  private state: ExportState = { kind: 'idle' }
  private io: AddonContext['host']['selectedIo']
  private source: DoomBundle['source']
  private base: URL
  private changed: (state: ExportState) => void
  private fetchFile: typeof fetch
  constructor(
    io: AddonContext['host']['selectedIo'],
    source: DoomBundle['source'],
    base: URL,
    changed: (state: ExportState) => void,
    fetchFile: typeof fetch = fetch,
  ) {
    this.io = io
    this.source = source
    this.base = base
    this.changed = changed
    this.fetchFile = fetchFile
  }

  private set(state: ExportState) {
    this.state = state
    this.changed(state)
  }
  private get disposed() {
    return this.state.kind === 'disposed'
  }

  dispose() {
    if (this.state.kind === 'disposed') return
    if (this.state.kind === 'loading') this.state.abort.abort()
    if (this.state.kind === 'writing' || this.state.kind === 'cleanup')
      void this.io.cancel(this.state.handle).catch(() => {})
    this.state = { kind: 'disposed' }
  }

  async save() {
    if (!['idle', 'saved', 'failed'].includes(this.state.kind)) return
    const abort = new AbortController()
    this.set({ kind: 'loading', abort })
    let handle: string | null = null
    let terminal: ExportState = { kind: 'idle' }
    try {
      const bytes = await loadArtifact(
        this.source,
        this.base,
        abort.signal,
        this.fetchFile,
      )
      if (this.disposed) return
      this.set({ kind: 'choosing' })
      const selected = await this.io.selectExport({
        suggestedName: this.source.exportName,
        extension: 'gz',
      })
      if (selected.ok && selected.value) handle = selected.value.handle
      if (this.disposed) return
      if (!selected.ok)
        throw new Error(
          selected.code === 'busy'
            ? 'Finish the current file operation, then save the source again.'
            : selected.code === 'conflict'
              ? 'A file already exists at this destination. Choose another name.'
              : 'Hibi could not choose a source destination. Try again.',
        )
      if (!selected.value) return
      this.set({ kind: 'writing', handle: selected.value.handle })
      const written = await this.io.writeExport(selected.value.handle, bytes)
      if (this.disposed) return
      if (!written.ok)
        throw new Error(
          written.code === 'conflict'
            ? 'A file already exists at this destination. Choose another name.'
            : written.code === 'busy'
              ? 'Finish the current file operation, then save the source again.'
              : 'Hibi could not save the source. Choose another destination.',
        )
      terminal = { kind: 'saved' }
    } catch (error) {
      terminal = {
        kind: 'failed',
        message:
          error instanceof Error
            ? error.message
            : 'The source could not be saved.',
      }
    } finally {
      if (handle) {
        if (!this.disposed) this.set({ kind: 'cleanup', handle })
        await this.io.cancel(handle).catch(() => {})
      }
      if (!this.disposed) this.set(terminal)
    }
  }
}
