import { describe, expectTypeOf, it } from 'vitest'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionProjectionMap, SessionProjectionStateMap } from '@deepseek-ai/dsh-session-projection/types'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type {
  LoopActivation,
  LoopBlockReason,
  LoopChainNodeDef,
  LoopId,
  LoopLedgerEntry,
  LoopPhase,
  LoopProjection,
  LoopProjectionState,
  LoopRef,
  LoopSnapshot,
  LoopVerdict,
  LoopView,
} from '../src/types.ts'

describe('loop domain pure types', () => {
  it('brands the loop identity so bare strings do not pass as LoopId', () => {
    expectTypeOf<LoopId>().toEqualTypeOf<Branded<'LoopId'>>()
    expectTypeOf<LoopId>().not.toEqualTypeOf<string>()
  })

  it('fixes the durable phase and process-local activation vocabularies', () => {
    expectTypeOf<LoopPhase>().toEqualTypeOf<'active' | 'awaiting-human' | 'paused' | 'blocked' | 'complete'>()
    expectTypeOf<LoopActivation>().toEqualTypeOf<'armed' | 'disarmed'>()
  })

  it('closes the blocked-reason code union', () => {
    expectTypeOf<LoopBlockReason['code']>().toEqualTypeOf<
      'node-failed' | 'round-limit' | 'evaluator-blocked' | 'checkpoint-provider-missing' | 'durability-failed' | 'report-budget'
    >()
  })

  it('carries the compare-and-set ref on every snapshot and view', () => {
    expectTypeOf<LoopSnapshot>().toExtend<LoopRef>()
    expectTypeOf<LoopView['loop']>().toEqualTypeOf<LoopSnapshot>()
    expectTypeOf<LoopView['activation']>().toEqualTypeOf<LoopActivation>()
  })

  it('discriminates ledger entries by kind', () => {
    expectTypeOf<LoopLedgerEntry['kind']>().toEqualTypeOf<'node-started' | 'attempt' | 'settlement'>()
  })

  it('types a node output override as the shared object schema subset', () => {
    expectTypeOf<LoopChainNodeDef['output']>().toEqualTypeOf<ObjectJsonSchema | undefined>()
  })

  it('fixes the evaluator verdict decision union', () => {
    expectTypeOf<LoopVerdict['decision']>().toEqualTypeOf<'continue' | 'complete' | 'blocked'>()
  })

  it('declares the loop key on both session projection tables', () => {
    expectTypeOf<SessionProjectionMap['loop']>().toEqualTypeOf<LoopProjection | null>()
    expectTypeOf<SessionProjectionStateMap['loop']>().toEqualTypeOf<LoopProjectionState>()
  })
})
