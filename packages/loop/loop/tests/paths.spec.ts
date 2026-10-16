/** Scope normalization of the loop domain's shared path helper. */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { normalizeScopePath } from '../src/paths.ts'

let root: string | undefined

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
})

/** One disposable temp workspace. */
function workspace(): string {
  root = mkdtempSync(join(tmpdir(), 'dsh-loop-paths-'))
  return root
}

describe('normalizeScopePath', () => {
  it('resolves a relative input against the process working directory', () => {
    expect(normalizeScopePath('.')).toBe(normalizeScopePath(process.cwd()))
  })

  it('normalizes two symlinked paths to one canonical scope', () => {
    const base = workspace()
    const target = join(base, 'target')
    mkdirSync(target)
    const link = join(base, 'link')
    // Windows hosts without symlink privilege accept junctions; both reparse forms resolve through realpath.
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    expect(normalizeScopePath(link)).toBe(normalizeScopePath(target))
  })

  it.skipIf(process.platform !== 'win32')('case-folds drive letters and path case on win32', () => {
    const base = workspace()
    expect(normalizeScopePath(base.toUpperCase())).toBe(normalizeScopePath(base.toLowerCase()))
  })

  it('throws on a non-existent path', () => {
    const base = workspace()
    expect(() => normalizeScopePath(join(base, 'missing'))).toThrow(/ENOENT/)
  })
})
