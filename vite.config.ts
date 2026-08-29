import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'

// Pure static SPA. No server, no proxy, no SSR.
// The sqlite3-wasm package ships worker + wasm assets; we copy them to /public
// via the optimizeDeps.exclude + an explicit public copy below.
export default defineConfig({
  plugins: [preact()],
  server: {
    port: 9737,
    headers: {
      // Required for SharedArrayBuffer in case we ever enable it for the VFS
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    port: 4173,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsInlineLimit: 0,
  },
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: ['@sqlite.org/sqlite-wasm'],
  },
})
