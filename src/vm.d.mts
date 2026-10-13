interface Signature {
  parameters: number[]
  results: number[]
}
interface GuestModule {
  functions: {
    imported?: boolean
    namespace?: string
    name?: string
    signature: Signature
  }[]
  memories: { initial: number; maximum: number | null }[]
  tables: { initial: number; maximum: number | null }[]
  exports: Map<string, { kind: number; index: number }>
  start: number | null
}
export function parse(bytes: Uint8Array): GuestModule
export class Machine {
  constructor(
    module: GuestModule,
    imports: object,
    initialPages: number,
    maxPages: number,
  )
  readonly buffer: ArrayBuffer
  callExport(
    name: string,
    parameters?: (number | bigint)[],
  ): (number | bigint)[]
}
