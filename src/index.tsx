import type { AddonContext, AddonViewProps } from '@hibi/addon-sdk/api'
import type { CapabilityFactory } from '@hibi/addon-sdk/sdk-loader'
import type { KeyboardEvent } from 'react'
import metadata from '../addon/bundle.json' with { type: 'json' }
import { loadArtifact, parseBundle, readPackageFile, sha256 } from './bundle.ts'
import { GameInput, keys } from './input.ts'
import { IwadCache, type IwadProgress } from './iwad.ts'
import { type Activity, height, width } from './model.ts'
import { validateGame } from './runtime.ts'
import { GameSession } from './session.ts'
import { type ExportState, SourceExport } from './source-export.ts'
import css from './style.css'

type Display =
  | { kind: 'loading'; abort: AbortController; progress: IwadProgress }
  | { kind: 'starting'; session: GameSession }
  | {
      kind: 'ready'
      session: GameSession
      dataSource: 'cache' | 'download'
      persistent: boolean
    }
  | { kind: 'failed'; message: string }
  | { kind: 'disposed' }

interface Lifetime {
  state: Display
}
const disposed = (owner: Lifetime) => owner.state.kind === 'disposed'

const bundle = parseBundle(metadata)
const packageBase = new URL(import.meta.url)

const create: CapabilityFactory = (sdk) => {
  const React = sdk.React
  const ui = sdk.ui
  if (!React || !ui) throw new Error("Doom requires Hibi's UI capability.")
  const { useEffect, useRef, useState } = React
  const { Button, ControlRow, Panel, PanelMessage } = ui
  const cleanups = new Set<() => void>()

  function DoomTab({
    openLicenses,
    visible,
    close,
    cache,
  }: AddonViewProps & { openLicenses: () => void; cache: IwadCache }) {
    const canvas = useRef<HTMLCanvasElement>(null)
    const input = useRef(new GameInput())
    const lifetime = useRef<Lifetime | null>(null)
    const wake = useRef<() => void>(() => {})
    const [display, setDisplay] = useState<Display>({
      kind: 'loading',
      abort: new AbortController(),
      progress: { kind: 'checking' },
    })
    const [paused, setPaused] = useState(false)
    const [canvasFocused, setCanvasFocused] = useState(false)
    const [focused, setFocused] = useState(document.hasFocus())
    const [documentVisible, setDocumentVisible] = useState(
      document.visibilityState === 'visible',
    )
    const desired: Activity =
      display.kind === 'ready' &&
      visible &&
      focused &&
      documentVisible &&
      canvasFocused &&
      !paused
        ? 'running'
        : 'paused'
    const activity = useRef(desired)
    activity.current = desired

    function releaseInput() {
      input.current.clear()
      activity.current = 'paused'
      wake.current()
    }

    useEffect(() => {
      const owner: Lifetime = {
        state: {
          kind: 'loading',
          abort: new AbortController(),
          progress: { kind: 'checking' },
        },
      }
      lifetime.current = owner
      setDisplay(owner.state)
      const blur = () => {
        releaseInput()
        setFocused(false)
      }
      const focus = () => setFocused(true)
      const visibility = () => {
        const shown = document.visibilityState === 'visible'
        if (!shown) releaseInput()
        setDocumentVisible(shown)
      }
      const dispose = () => {
        if (disposed(owner)) return
        releaseInput()
        if (owner.state.kind === 'loading') owner.state.abort.abort()
        if (owner.state.kind === 'starting' || owner.state.kind === 'ready')
          owner.state.session.dispose()
        owner.state = { kind: 'disposed' }
        window.removeEventListener('blur', blur)
        window.removeEventListener('focus', focus)
        document.removeEventListener('visibilitychange', visibility)
        cleanups.delete(dispose)
      }
      cleanups.add(dispose)
      window.addEventListener('blur', blur)
      window.addEventListener('focus', focus)
      document.addEventListener('visibilitychange', visibility)
      void startGame(owner)
      return dispose
    }, [])

    useEffect(() => {
      if (
        visible &&
        display.kind === 'ready' &&
        document.visibilityState === 'visible'
      )
        canvas.current?.focus()
    }, [visible, display.kind])

    useEffect(() => {
      if (desired === 'paused') input.current.clear()
      wake.current()
    }, [desired])

    useEffect(() => {
      if (display.kind !== 'ready') return
      const session = display.session
      let canceled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let releaseWait: (() => void) | undefined
      let acknowledged: { activity: Activity; epoch: number } = {
        activity: 'paused',
        epoch: input.current.epoch,
      }
      let after = 0
      const wait = (milliseconds?: number) =>
        new Promise<void>((resolve) => {
          releaseWait = resolve
          if (milliseconds !== undefined)
            timer = setTimeout(resolve, milliseconds)
        })
      const wakeLoop = () => {
        clearTimeout(timer)
        timer = undefined
        const release = releaseWait
        releaseWait = undefined
        release?.()
      }
      wake.current = wakeLoop
      const run = async () => {
        try {
          while (!canceled && !session.disposed) {
            const desiredActivity = activity.current
            if (
              acknowledged.activity !== desiredActivity ||
              acknowledged.epoch !== input.current.epoch
            ) {
              const epoch = input.current.epoch
              const reply = await session.request({
                kind: 'activity',
                activity: desiredActivity,
              })
              if (canceled) break
              if (
                reply.kind !== 'activity' ||
                reply.activity !== desiredActivity
              )
                throw new Error(
                  'Doom could not change activity. Close and reopen the game.',
                )
              acknowledged = { activity: desiredActivity, epoch }
              continue
            }
            if (desiredActivity === 'paused') {
              await wait()
              continue
            }
            const startedAt = performance.now()
            const epoch = input.current.epoch
            const reply = await session.request({
              kind: 'frame',
              activity: 'running',
              ...input.current.take(),
              after,
            })
            if (canceled) break
            if (epoch !== input.current.epoch || activity.current !== 'running')
              continue
            if (reply.kind !== 'update')
              throw new Error(
                'Doom returned an invalid frame. Close and reopen the game.',
              )
            const update = reply.update
            if (update.kind === 'frame') {
              const element = canvas.current
              const drawing = element?.getContext('2d', { alpha: false })
              if (!element || !drawing)
                throw new Error(
                  'Hibi could not display the game. Close and reopen the game.',
                )
              drawing.putImageData(
                new ImageData(
                  new Uint8ClampedArray(update.pixels),
                  width,
                  height,
                ),
                0,
                0,
              )
              after = update.sequence
              element.dataset.sequence = String(update.sequence)
              element.dataset.gameTime = String(update.elapsedMs)
            }
            await wait(Math.max(0, 16 - (performance.now() - startedAt)))
          }
        } catch (error) {
          if (!canceled && lifetime.current?.state.kind !== 'disposed')
            setDisplay({
              kind: 'failed',
              message:
                error instanceof Error
                  ? error.message
                  : 'Doom could not run. Close and reopen the game.',
            })
        } finally {
          session.dispose()
        }
      }
      void run()
      return () => {
        canceled = true
        input.current.clear()
        wakeLoop()
        session.dispose()
      }
    }, [display])

    async function startGame(owner: Lifetime) {
      if (owner.state.kind !== 'loading') return
      const abort = owner.state.abort
      try {
        const engineBytes = await loadArtifact(
          bundle.engine,
          packageBase,
          abort.signal,
        )
        const data = await cache.load(abort.signal, (progress) => {
          if (owner.state.kind !== 'loading' || abort.signal.aborted) return
          owner.state = { kind: 'loading', abort, progress }
          setDisplay(owner.state)
        })
        const { engine, iwad } = await validateGame(engineBytes, data.bytes)
        abort.signal.throwIfAborted()
        if (disposed(owner)) return
        const session = new GameSession(
          new Worker(new URL('./doom.worker.js', import.meta.url), {
            type: 'module',
          }),
        )
        owner.state = { kind: 'starting', session }
        setDisplay(owner.state)
        const reply = await session.request({ kind: 'startup', engine, iwad }, [
          engine.buffer,
          iwad.buffer,
        ])
        if (disposed(owner)) return
        if (reply.kind !== 'ready')
          throw new Error('Doom could not start. Close and reopen the game.')
        setPaused(false)
        owner.state = {
          kind: 'ready',
          session,
          dataSource: data.source,
          persistent: data.persistent,
        }
        setDisplay(owner.state)
      } catch (error) {
        if (owner.state.kind === 'starting' || owner.state.kind === 'ready')
          owner.state.session.dispose()
        if (!disposed(owner)) {
          owner.state = {
            kind: 'failed',
            message:
              error instanceof Error
                ? error.message
                : 'Doom could not start. Close and reopen the game.',
          }
          setDisplay(owner.state)
        }
      }
    }

    function keyboard(event: KeyboardEvent<HTMLCanvasElement>, down: boolean) {
      if (!down && input.current.release(event.code)) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
      if (event.code === 'Tab' && event.shiftKey) return
      if (
        !keys[event.code] ||
        event.metaKey ||
        event.altKey ||
        activity.current !== 'running'
      )
        return
      event.preventDefault()
      event.stopPropagation()
      if (down) input.current.press(event.code, event.repeat)
    }

    return (
      <section
        className="hibi-doom"
        aria-label="Doom game"
        data-state={display.kind}
        data-data-source={
          display.kind === 'ready' ? display.dataSource : undefined
        }
        data-cache-persistent={
          display.kind === 'ready' ? String(display.persistent) : undefined
        }
      >
        <ControlRow className="hibi-doom-controls">
          <Button
            disabled={display.kind !== 'ready'}
            onClick={() => {
              if (paused) {
                setPaused(false)
                canvas.current?.focus()
              } else {
                releaseInput()
                setPaused(true)
              }
            }}
          >
            {paused ? 'Resume' : 'Pause'}
          </Button>
          <span>
            Click the game to play. Arrows or WASD move, F fires, Space uses,
            and Enter selects. Shift+Tab leaves the game.
          </span>
          <Button variant="ghost" onClick={close}>
            Close game
          </Button>
        </ControlRow>
        <div className="hibi-doom-screen">
          <canvas
            ref={canvas}
            width={width}
            height={height}
            tabIndex={display.kind === 'ready' ? 0 : -1}
            aria-label="Doom canvas"
            onFocus={() => setCanvasFocused(true)}
            onBlur={() => {
              releaseInput()
              setCanvasFocused(false)
            }}
            onClick={() => {
              setPaused(false)
              canvas.current?.focus()
            }}
            onKeyDown={(event) => keyboard(event, true)}
            onKeyUp={(event) => keyboard(event, false)}
          />
          {display.kind !== 'ready' && (
            <div className="hibi-doom-message">
              <PanelMessage
                icon=""
                title={
                  display.kind === 'failed'
                    ? 'Could not play Doom'
                    : display.kind === 'starting'
                      ? 'Starting Doom...'
                      : display.kind === 'loading' &&
                          display.progress.kind === 'downloading'
                        ? 'Downloading Doom shareware...'
                        : display.kind === 'loading' &&
                            display.progress.kind === 'verifying'
                          ? 'Verifying Doom shareware...'
                          : 'Loading Doom...'
                }
                role={display.kind === 'failed' ? 'alert' : 'status'}
                loading={
                  display.kind === 'starting' || display.kind === 'loading'
                }
              >
                {display.kind === 'failed'
                  ? display.message
                  : display.kind === 'loading' &&
                      display.progress.kind === 'downloading'
                    ? `${Math.floor((display.progress.completedBytes / display.progress.totalBytes) * 100)}% downloaded. The unchanged shareware episode is saved for offline play.`
                    : 'The first Play downloads the shareware episode automatically. Later games use verified cached data.'}
              </PanelMessage>
            </div>
          )}
          {display.kind === 'ready' && desired === 'paused' && visible && (
            <div className="hibi-doom-paused" aria-live="polite">
              Paused. Click the game to resume.
            </div>
          )}
        </div>
        {display.kind === 'ready' && !display.persistent && (
          <p className="hibi-doom-cache-warning" role="status">
            The game is ready, but Hibi could not save its data. Connect again
            next time.
          </p>
        )}
        <ControlRow className="hibi-doom-legal">
          <span>
            Doom engine. Copyright id Software, Simon Howard, and contributors.
            GNU GPL version 3 only. No warranty. Redistribution permitted under
            GPL.
          </span>
          <Button variant="ghost" onClick={openLicenses}>
            License and source
          </Button>
        </ControlRow>
      </section>
    )
  }

  function LicensesTab({
    context,
    close,
    cache,
  }: AddonViewProps & { context: AddonContext; cache: IwadCache }) {
    const [notices, setNotices] = useState<string | null>(null)
    const [noticeFailure, setNoticeFailure] = useState<string | null>(null)
    const [exportState, setExportState] = useState<ExportState>({
      kind: 'idle',
    })
    const exporter = useRef<SourceExport | null>(null)
    const [cacheState, setCacheState] = useState<
      'idle' | 'clearing' | 'cleared' | 'failed'
    >('idle')
    const mounted = useRef(false)
    useEffect(() => {
      const abort = new AbortController()
      mounted.current = true
      const source = new SourceExport(
        context.host.selectedIo,
        bundle.source,
        packageBase,
        setExportState,
      )
      exporter.current = source
      const dispose = () => {
        abort.abort()
        mounted.current = false
        source.dispose()
        exporter.current = null
        cleanups.delete(dispose)
      }
      cleanups.add(dispose)
      void (async () => {
        try {
          const bytes = await readPackageFile(
            bundle.notices.path,
            bundle.notices.bytes,
            packageBase,
            abort.signal,
          )
          if ((await sha256(bytes)) !== bundle.notices.sha256)
            throw new Error('The installed license notices do not match.')
          abort.signal.throwIfAborted()
          setNotices(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
        } catch (error) {
          if (!abort.signal.aborted)
            setNoticeFailure(
              error instanceof Error
                ? error.message
                : 'The license notices could not be read.',
            )
        }
      })()
      return dispose
    }, [context])
    const busy =
      exportState.kind === 'loading' ||
      exportState.kind === 'choosing' ||
      exportState.kind === 'writing' ||
      exportState.kind === 'cleanup'
    return (
      <section
        className="hibi-doom-licenses"
        aria-label="Doom license and source"
      >
        <Panel>
          <h2>Doom license and source</h2>
          <p>
            The Doom engine is copyright id Software, Simon Howard, and
            contributors. Hibi Doom project code and the bundled engine use GNU
            GPL version 3 only and come with absolutely no warranty. You may
            redistribute them under that license.
          </p>
          <p>
            Doom 1.9 shareware data is downloaded from a separate public feed on
            first Play. Its separate id Software terms require unchanged data
            and free distribution.
          </p>
          <p>
            The complete corresponding source and dependency notices are
            included in this addon. Save the archive to inspect or rebuild this
            version without repository access.
          </p>
          <p>
            The source archive contains code and build inputs. It contains no
            shareware data. Cached game data stays on this device after removal
            of the addon. Clear it here to require a download on the next Play.
          </p>
          <ControlRow>
            <Button
              disabled={busy}
              onClick={() => void exporter.current?.save()}
            >
              Save corresponding source
            </Button>
            <Button variant="ghost" onClick={close}>
              Close license
            </Button>
          </ControlRow>
          <p role={exportState.kind === 'failed' ? 'alert' : 'status'}>
            {exportState.kind === 'failed'
              ? exportState.message
              : exportState.kind === 'saved'
                ? 'The corresponding source was saved.'
                : busy
                  ? 'Preparing or saving corresponding source...'
                  : 'Source export creates a new file.'}
          </p>
          <ControlRow>
            <Button
              disabled={cacheState === 'clearing'}
              onClick={() => {
                setCacheState('clearing')
                void cache.clear().then(
                  () => {
                    if (mounted.current) setCacheState('cleared')
                  },
                  () => {
                    if (mounted.current) setCacheState('failed')
                  },
                )
              }}
            >
              Clear cached game data
            </Button>
            <span role={cacheState === 'failed' ? 'alert' : 'status'}>
              {cacheState === 'cleared'
                ? 'Cached game data was cleared. Close and reopen the game to download it again.'
                : cacheState === 'failed'
                  ? 'Hibi could not clear cached game data. Close the game and try again.'
                  : cacheState === 'clearing'
                    ? 'Clearing cached game data...'
                    : 'Clearing cached data does not end a running game.'}
            </span>
          </ControlRow>
          {noticeFailure ? (
            <PanelMessage icon="" title="Could not read notices" role="alert">
              {noticeFailure}
            </PanelMessage>
          ) : notices ? (
            <section aria-label="Complete license notices">
              <pre className="hibi-doom-notices">{notices}</pre>
            </section>
          ) : (
            <PanelMessage icon="" title="Loading notices..." loading />
          )}
        </Panel>
      </section>
    )
  }

  return {
    start(context) {
      const cache = new IwadCache(context)
      context.styles.register('game', css)
      const licenses = context.views.register({
        id: 'licenses',
        label: 'Doom license and source',
        location: 'tab',
        lifetime: 'session',
        Content: (props) => (
          <LicensesTab context={context} cache={cache} {...props} />
        ),
      })
      const openLicenses = () => {
        licenses.open({ id: 'licenses', focus: true })
      }
      const view = context.views.register({
        id: 'game',
        label: 'Doom',
        location: 'tab',
        lifetime: 'session',
        Content: (props) => (
          <DoomTab openLicenses={openLicenses} cache={cache} {...props} />
        ),
      })
      context.commands.register({
        id: 'licenses',
        label: 'Doom license and source',
        menu: { location: 'app' },
        run: openLicenses,
      })
      context.commands.register({
        id: 'play',
        label: 'Play Doom',
        menu: { location: 'app' },
        run: () => {
          view.open({ id: 'game', focus: true })
        },
      })
    },
    stop() {
      for (const dispose of [...cleanups]) dispose()
    },
  }
}

export default create
