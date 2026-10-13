# Build-only gzip encoder

This directory contains the preferred TypeScript source for [fflate 0.8.2](https://github.com/101arrowz/fflate/tree/d3243651cb142e3e04f3e4bc037b9e985878f444), pinned to upstream commit `d3243651cb142e3e04f3e4bc037b9e985878f444`.

`index.ts` and `node-worker.ts` come from the upstream `src/` directory. On 2026-10-13, the relative worker import in `index.ts` gained the explicit `.ts` extension required by Node.js. The only other changes are final newline normalization.

The [MIT notice](../../licenses/fflate.txt) is copied verbatim from that revision. `scripts/archive.mjs` uses only `gzipSync` with level 9 and `mtime: 0`. This fixes the encoder, timestamp, and gzip OS header across supported Node.js versions and platforms. No encoder code runs in the addon.

The offline corresponding-source archive includes both preferred source files, this provenance record, and the notice. No npm dependency or generated codec is required to rebuild it.
