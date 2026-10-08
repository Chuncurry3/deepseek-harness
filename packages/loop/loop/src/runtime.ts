/** Runtime constructors and protocol constants for the loop domain. */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { LoopErrorCode } from './domain.ts'
import type { LoopId as LoopIdType } from './types.ts'

/** Version of the `loop/change` payloads in the durable session log. */
export const LOOP_CHANGE_VERSION = 1

/** Version of the node-ledger event payloads (`loop/node-started`, `loop/attempt`, `loop/node`). */
export const LOOP_LEDGER_VERSION = 1

/**
 * Brand a string as a loop id.
 * @param id - raw loop identifier.
 * @returns the same string with the compile-time brand.
 */
export function LoopId(id: string): LoopIdType {
  return id as LoopIdType
}

/** Error returned by the loop domain boundary. */
export class LoopError extends HarnessError {
  /**
   * @param message - human-readable rejection reason.
   * @param code - stable machine-routable classification.
   */
  // Keep the constructor to narrow HarnessError's string code at this boundary.
  // oxlint-disable-next-line typescript/no-useless-constructor -- type-only narrowing
  constructor(message: string, code: LoopErrorCode) {
    super(message, code)
  }
}
