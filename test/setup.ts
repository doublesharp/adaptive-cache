import { beforeEach, expect } from 'vitest'

// A request completing or a mock running is not an assertion about behavior.
beforeEach(() => expect.hasAssertions())
