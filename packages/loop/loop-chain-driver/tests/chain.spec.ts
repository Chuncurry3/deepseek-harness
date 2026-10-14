import { describe, expect, it } from 'vitest'
import { parseChainDocument, defaultChain } from '../src/chain.ts'

describe('parseChainDocument', () => {
  it('parses a two-node chain with inputs, carryOver, and evaluator override', () => {
    const chain = parseChainDocument('objective: 迭代工具\ncheckpoint: none\nnodes:\n  - role: direct\n    cwd: /w\n    inputs:\n      - session: s-1\n    carryOver: [experiment]\n    prompt: |\n      规划\n  - role: experiment\n    prompt: |\n      试验\nevaluator:\n  prompt: |\n    裁决\n')
    expect(chain.nodes).toHaveLength(2)
    expect(chain.nodes[0]?.inputs?.[0]?.session).toBe('s-1')
    expect(chain.nodes[0]?.carryOver).toEqual(['experiment'])
    expect(chain.evaluatorPrompt).toContain('裁决')
  })

  it('rejects duplicate roles, empty nodes, and unknown keys — loud', () => {
    expect(() => parseChainDocument('nodes:\n  - role: a\n    prompt: p\n  - role: a\n    prompt: q')).toThrow(/role/)
    expect(() => parseChainDocument('nodes: []')).toThrow(/nodes/)
    expect(() => parseChainDocument('objective: o\nnodes:\n  - role: a\n    prompt: p\n    bogus: 1')).toThrow(/bogus/)
  })

  it('applies the checkpoint default and rejects malformed YAML and non-mapping documents', () => {
    expect(parseChainDocument('objective: o\nnodes:\n  - role: a\n    prompt: p\n').checkpoint).toBe('none')
    expect(() => parseChainDocument('objective: o\nnodes: [')).toThrow(/YAML/)
    expect(() => parseChainDocument('- a\n- b')).toThrow(/document/)
  })

  it('validates node output overrides against the object-rooted JSON Schema subset', () => {
    const chain = parseChainDocument('objective: o\nnodes:\n  - role: a\n    prompt: p\n    output:\n      type: object\n      properties:\n        done:\n          type: boolean\n      required: [done]\n      additionalProperties: false\n')
    expect(chain.nodes[0]?.output).toEqual({
      type: 'object',
      properties: { done: { type: 'boolean' } },
      required: ['done'],
      additionalProperties: false,
    })
    expect(() => parseChainDocument('objective: o\nnodes:\n  - role: a\n    prompt: p\n    output:\n      type: string\n')).toThrow(/output/)
  })

  it('rejects carryOver naming an unknown role', () => {
    expect(() => parseChainDocument('objective: o\nnodes:\n  - role: a\n    prompt: p\n    carryOver: [ghost]\n')).toThrow(/carryOver/)
  })

  it('rejects blank strings in the fields the durable fold normalizes', () => {
    expect(() => parseChainDocument('objective: o\nnodes:\n  - role: a\n    prompt: " "\n')).toThrow(/prompt/)
    expect(() => parseChainDocument('objective: " "\nnodes:\n  - role: a\n    prompt: p\n')).toThrow(/objective/)
    expect(() => parseChainDocument('objective: " o "\nnodes:\n  - role: a\n    prompt: p\n')).toThrow(/objective/)
  })
})

describe('defaultChain', () => {
  it('the default chain is one worker node with the default prompt', () => {
    const chain = defaultChain('优化工具')
    expect(chain.nodes).toHaveLength(1)
    expect(chain.nodes[0]?.role).toBe('iterate')
    expect(chain.nodes[0]?.output).toBeUndefined()
    expect(chain.evaluatorPrompt).toBeUndefined()
  })

  it('a blank or padded objective fails loud, like a parsed document', () => {
    expect(() => defaultChain('')).toThrow(/objective/)
    expect(() => defaultChain('  padded  ')).toThrow(/objective/)
  })
})
