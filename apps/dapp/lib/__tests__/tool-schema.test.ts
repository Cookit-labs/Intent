import { describe, expect, it } from 'vitest'

import { SUBMIT_PROPOSAL_TOOL, proposalToolSchema } from '../agents/tool-schema'

/**
 * Structural tests for the tool definition.
 *
 * Strict mode has rules that are easy to break by adding a field and forgetting
 * to list it as required — and the failure arrives as a 400 from the provider
 * at runtime, not at compile time. These catch it locally instead.
 */
describe('submit_proposal tool schema', () => {
  const params = SUBMIT_PROPOSAL_TOOL.function.parameters
  const propertyNames = Object.keys(params.properties)

  it('is marked strict', () => {
    expect(SUBMIT_PROPOSAL_TOOL.function.strict).toBe(true)
  })

  it('forbids additional properties', () => {
    expect(params.additionalProperties).toBe(false)
  })

  it('lists every property as required, as strict mode demands', () => {
    expect([...params.required].sort()).toEqual([...propertyNames].sort())
  })

  it('avoids the keywords strict mode rejects', () => {
    // minLength/maxLength/minItems/maxItems are unsupported; ranges are
    // enforced by the Zod schema after the response arrives instead.
    const serialised = JSON.stringify(params)
    for (const banned of ['minLength', 'maxLength', 'minItems', 'maxItems']) {
      expect(serialised).not.toContain(banned)
    }
  })

  it('describes every property, so the model knows what each one means', () => {
    for (const [name, prop] of Object.entries(params.properties)) {
      expect((prop as { description?: string }).description, name).toBeTruthy()
    }
  })

  it('stays in step with the Zod validator', () => {
    // Drift here means the provider accepts a field the app then discards, or
    // the app expects one the provider was never asked for.
    const zodKeys = Object.keys(proposalToolSchema.shape)
    expect(zodKeys.sort()).toEqual([...propertyNames].sort())
  })
})
