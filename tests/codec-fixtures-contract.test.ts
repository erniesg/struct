import { describe, expect, it } from 'vitest'
import { decodeStructDocument } from '../src/document/index'
import { validDocument } from './codec-fixtures'

describe('codec fixture contract', () => {
  it('provides a canonical document accepted by the runtime codec', () => {
    expect(() => decodeStructDocument(validDocument())).not.toThrow()
  })
})
