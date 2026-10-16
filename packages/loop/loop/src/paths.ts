/**
 * Path normalization shared by the `/loop` command's start grants and the
 * loop-scoped query tools' scope comparison: one canonical realpath form per
 * granted workspace. @module @deepseek-ai/dsh-loop/paths
 */

import { realpathSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'

/**
 * realpath-normalize one granted scope: resolve symlinks, normalize
 * separators, and case-fold on Windows.
 *
 * A relative input resolves against the process working directory. The
 * result is the only form the frozen `readScopes` and `writeScopes`
 * compare against.
 * @param raw - granted scope path.
 * @returns the normalized absolute scope path with `/` separators, lowercased on win32.
 * @throws When the path does not exist (`realpathSync` ENOENT); the command surfaces it as a direct error.
 */
export function normalizeScopePath(raw: string): string {
  const absolute = isAbsolute(raw) ? raw : resolve(raw)
  const real = realpathSync(absolute) // throws ENOENT -> the command surfaces a direct error
  const unified = real.split(sep).join('/')
  /* v8 ignore next -- the win32 case-fold lane runs only on Windows hosts; POSIX tests exercise the separator pass. */
  return process.platform === 'win32' ? unified.toLowerCase() : unified
}
