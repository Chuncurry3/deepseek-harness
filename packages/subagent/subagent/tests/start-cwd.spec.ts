/**
 * Coverage for the per-start child workspace seam: the cwdOverride capability
 * flag, the capability-gated cwd request field, and the assertUsableCwd
 * validation the service applies before provider dispatch.
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NO_START_CAPABILITIES } from '@deepseek-ai/dsh-subagent'
import { baseRequest, service, StubProvider } from './helpers.ts'

describe('per-start request cwd', () => {
  it('start rejects cwd on a provider without cwdOverride', async () => {
    const { subagents } = await service()
    const provider = new StubProvider('oop', NO_START_CAPABILITIES)
    subagents.registerProvider(provider)
    await expect(subagents.start('oop', baseRequest({ cwd: tmpdir() })))
      .rejects.toThrow(/cwdOverride/)
    expect(provider.startCount).toBe(0)
  })

  it('start validates the request cwd with the assertUsableCwd discipline', async () => {
    const { subagents } = await service()
    const provider = new StubProvider('capable')
    subagents.registerProvider(provider)
    await expect(subagents.start('capable', baseRequest({ cwd: 'relative/path' })))
      .rejects.toThrow('must be an absolute path')
    await expect(subagents.start('capable', baseRequest({ cwd: join(tmpdir(), 'dsh-no-such-dir-xyz') })))
      .rejects.toThrow('not an accessible directory')
    expect(provider.startCount).toBe(0)
  })

  it('start accepts an absolute enterable cwd and passes it to the provider', async () => {
    const { subagents } = await service()
    const provider = new StubProvider('capable')
    subagents.registerProvider(provider)
    const run = await subagents.start('capable', baseRequest({ cwd: tmpdir() }))
    await expect(run.result).resolves.toMatchObject({ stopReason: 'completed' })
    expect(provider.startCount).toBe(1)
    expect(provider.lastRequest?.cwd).toBe(tmpdir())
  })
})
