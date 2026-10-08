/** Event-sourced relay-loop domain. @module @deepseek-ai/dsh-loop */
export const name = 'loop'

// The pure payload outlet (./types.ts, ONE home of the `loop` projection-key
// declaration) re-exported onto the package root keeps the module edge in
// the emitted index.d.ts, so aggregate programs consuming the declarations
// still receive the SessionProjectionStateMap and SessionProjectionMap merges.
export type * from './types.ts'
