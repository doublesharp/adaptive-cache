import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/types.d.ts', 'src/types.ts'], // Exclude types from coverage
    },
    testTimeout: 30000, // Increase timeout for container startup
    hookTimeout: 30000,
  },
})
