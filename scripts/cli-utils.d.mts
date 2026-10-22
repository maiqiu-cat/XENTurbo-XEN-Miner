export function isMainModule(moduleUrl: string, entrypoint?: string): boolean
export function cliValue(argv: readonly string[], index: number, flag: string): string
export function normalizeProbeUrl(value: string, allowLoopbackHttp?: boolean): string
export function safeLogText(value: unknown): string
export function diagnosticError(error: unknown): string
