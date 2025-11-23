import { defineConfig } from 'tsup'
import fs from 'fs'
import path from 'path'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  shims: true,
  onSuccess: async () => {
    // Copy Lua scripts to dist
    const srcDir = path.resolve(__dirname, 'src/redis-lua')
    const destDir = path.resolve(__dirname, 'dist/redis-lua')

    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true })
    }

    const files = fs.readdirSync(srcDir)
    for (const file of files) {
      if (file.endsWith('.lua')) {
        fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file))
      }
    }
  },
})
