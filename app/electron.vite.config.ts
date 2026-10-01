import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const root = __dirname;
const shared = resolve(root, 'src/shared');

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': shared } },
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: {
          // Main process.
          index: resolve(root, 'src/main/index.ts'),
          // LLM engine: runs inside an Electron utilityProcess (see src/main/engine/host.ts).
          engineWorker: resolve(root, 'src/main/engine/worker.ts')
        }
      }
    }
  },
  preload: {
    resolve: { alias: { '@shared': shared } },
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: { index: resolve(root, 'src/preload/index.ts') },
        // Sandboxed preload scripts must be CommonJS.
        output: { format: 'cjs', entryFileNames: '[name].js' }
      }
    }
  },
  renderer: {
    root: resolve(root, 'src/renderer'),
    plugins: [react()],
    resolve: {
      alias: {
        '@': resolve(root, 'src/renderer'),
        '@shared': shared,
        '@resources': resolve(root, 'resources')
      }
    },
    server: {
      // The renderer root is src/renderer, but fonts/icons live in app/resources.
      fs: { allow: [root] }
    },
    build: {
      outDir: 'out/renderer',
      emptyOutDir: true,
      rollupOptions: { input: resolve(root, 'src/renderer/index.html') }
    }
  }
});
