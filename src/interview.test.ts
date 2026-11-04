import { describe, expect, it } from 'vitest'
import { buildReport } from './interview'

describe('fixed interview rules', () => {
  it('builds the Miss Wu report template', () => {
    expect(buildReport('teacher', ['English', 'fun', 'Chinese'])).toEqual([
      'Hello, everyone.',
      "Miss Wu's favorite subject is English.",
      "She likes it because it's fun.",
      'And she also likes Chinese.',
    ])
  })
})
