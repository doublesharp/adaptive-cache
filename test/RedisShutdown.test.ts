import { execFile } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Redis shutdown process lifetime', () => {
  it.each(['redis', 'l1-redis'])('exits naturally with %s and unreachable Redis', async (backend) => {
    const result = await new Promise<{ error: Error | null; stdout: string; stderr: string }>((resolve) => {
      execFile(
        process.execPath,
        [path.resolve('test/fixtures/redis-shutdown.cjs'), backend],
        { timeout: 5000, killSignal: 'SIGKILL' },
        (error, stdout, stderr) => resolve({ error, stdout, stderr }),
      )
    })

    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('Redis refused connection')
    expect(result.stdout).toContain('Shutdown rejected')
    expect(result.error, JSON.stringify(result)).toBeNull()
  })
})
