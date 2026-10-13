# Build and verify Hibi Doom

To play Doom, follow the [installation instructions](../README.md). Use this guide to change the addon or rebuild an exported source archive.

## Prepare the development tools

Use Node.js 24 or later. The compatibility target is [Hibi revision `7a137cfe9d6c6bc0fbb78cb4169bd71ccd09ca0b`](https://github.com/schmayterling/hibi/tree/7a137cfe9d6c6bc0fbb78cb4169bd71ccd09ca0b), which provides addon API version 2.

Prepare that Hibi checkout and install its development dependencies:

```sh
git clone https://github.com/schmayterling/hibi.git /path/to/hibi
git -C /path/to/hibi checkout 7a137cfe9d6c6bc0fbb78cb4169bd71ccd09ca0b
npm --prefix /path/to/hibi ci
export HIBI_ROOT=/path/to/hibi
```

Run the remaining addon commands from this checkout or an extracted source archive. The scripts use esbuild, TypeScript, and Biome from `HIBI_ROOT`. The addon has no runtime npm dependencies.

Type checking generates temporary Hibi SDK declarations and removes them afterward. The `@hibi/addon-sdk` imports supply development types. At runtime, Hibi supplies React and its UI controls.

## Build the prepared package

After changing packaged source, build inputs, notices, or documentation, regenerate the package:

```sh
npm run build
```

The command writes the compiled entry and worker, manifests, notices, readme, engine chunks, and corresponding-source chunks into `addon/`. It rebuilds the source archive from the current preferred source and pinned upstream inputs.

Review and commit the prepared files with their source changes. Hibi's URL installer reads the default branch without running a build. Keep compiler SDKs, expanded upstream trees, native objects, and dependencies outside this repository.

`scripts/resources.mjs` defines the source inputs and package resources. The archive includes contributor documentation, tests, build scripts, dependency notices, and preferred upstream source. It excludes its own chunks, generated manifests, and downloaded game data. `SOURCE-INVENTORY.json` records the hash of each other source entry.

The archive encoder uses the pinned [fflate 0.8.2 source](../vendor/fflate/README.md), deterministic TAR metadata, and a fixed gzip timestamp. It runs only during the build. Its source and MIT notice accompany the export.

## Run the local checks

Run the local checks:

```sh
npm run check
```

The checks run Biome, validate TypeScript against Hibi's SDK, compare prepared files with a fresh build, and run the tests. Package tests inspect both `addon/` and the complete repository ZIP through stock Hibi's inventory APIs.

For a narrower check, use `npm run build:check` for package freshness, `npm run typecheck` for SDK types, or `npm test` for tests alone.

Runtime tests compare interpreted pixels and game state with a native WebAssembly reference. Compiled-worker tests run with native WebAssembly disabled. Downloader tests cover response bounds, corruption, cache reuse, storage failures, cancellation, and cache races.

The tests obtain verified shareware data through `scripts/download-iwad.mjs`. The script keeps fixtures outside the checkout. Set `HIBI_DOOM_FIXTURE_DIR` to an outside directory to choose another cache location. The first test run needs a connection unless verified fixtures are already cached. Package builds need no game data or network access.

## Verify URL installation in Hibi

Build stock Hibi, then run the native test from the addon checkout:

```sh
npm --prefix "$HIBI_ROOT" run build:app
npm run test:hibi
```

Do not copy Doom into Hibi's source addon directory. The test installs the prepared package through Hibi's URL flow with a local HTTPS certificate trusted only by its Electron process. First Play uses the stock SDK and actual public feed. The test checks cached play without feed access, input, pause, note preservation, session cleanup, removal, and offline license and source export.

On Linux, use a desktop session or the headless command in [.github/workflows/check.yml](../.github/workflows/check.yml):

```sh
dbus-run-session -- xvfb-run --auto-servernum --server-args='-screen 0 1920x1080x24 -nolisten tcp' npm run test:hibi
```

## Runtime and data contracts

The C engine is a pinned WASI module. `src/vm.mjs` interprets it in the compiled worker. `src/wasi.ts` exposes an immutable `doom1.wad` file and rejects filesystem writes. Game time excludes paused time.

The game-data file, or IWAD, is absent from the code package and source export. `engine/pins.json` pins the separate shareware manifest and data. `src/iwad.ts` obtains the manifest and serial base64 parts through `context.host.network.getText`. It validates response addresses, exact sizes, encoding, hashes, and the expected episode before use.

Only completed, verified data enters `context.storage.global('iwad-cache', 1)`. Each new game verifies cached bytes again. Storage failures permit the current game with a warning. Clear invalidates older loads and waits for a started save before removing the cache. A running game keeps its in-memory data.

Close prevents subsequent download requests, new cache writes, and worker startup. The SDK cannot cancel an individual in-flight request or an already-started storage save. Close ignores late results, while disablement revokes the network owner. Source export reads only fixed package resources, never network or cache values.

## Rebuild the engine from corresponding source

Use Python 3, Make, and [WASI SDK 27.0](https://github.com/WebAssembly/wasi-sdk/releases/tag/wasi-sdk-27) with Clang `20.1.8-wasi-sdk`. Pass the SDK path explicitly. Keep the SDK and work directory outside this repository.

From a checkout or an extracted source export, run this command with a new empty work directory:

```sh
python3 scripts/engine-build.py --sdk /path/to/wasi-sdk-27.0 --work /path/to/empty-build
```

The script verifies upstream inputs against `engine/upstream-inventory.json`. A checkout supplies `engine/upstream.json`. An exported archive supplies preferred source under `engine/vendor/`. The script rebuilds WASI libc and the selected compiler-rt builtin, then links Doom with those rebuilt libraries.

Project-owned `engine/platform.c`, `engine/doomgeneric.h`, and `engine/config.h` supply startup, framebuffer interfaces, and build constants. The build applies the headers only in its disposable source tree. It excludes upstream `dummy.c` and `doomgeneric.c` from compilation and preserves their original contents in the source export.

Require the printed engine byte count and SHA-256 to match `engine/pins.json`. Compare the linked-source inventory:

```sh
cmp engine/linked.json /path/to/empty-build/linked.json
```

The work directory also contains `doom.map`, `headers.d`, `build.log`, and `build.json`. These record the selected sources, compiler dependencies, header overlays, linked libraries, and build arguments.

To reproduce an exported addon, choose **Save corresponding source** in Hibi. Extract the archive into a clean directory. Set `HIBI_ROOT` to the pinned host with its dependencies installed, then run `npm run build` there. The archive includes the engine chunks, so this command does not recompile C. It must reproduce every prepared package file, including the compiled modules, manifests, notices, and source chunks.

## Preserve the license notices

Hibi Doom project code and the bundled engine use GPL version 3 only. The selected Doom core retains its GPL version 2 or later grants. The GnuPG SHA-1 source retains the Free Software Foundation's GPL version 3 or later grant.

Preserve `LICENSE`, the original dependency and shareware notices in `licenses/`, and the original upstream source notices when distributing changes. Earlier copies of project-owned code retain their original grants. `engine/pins.json` records source grants separately from the compiled release license.
