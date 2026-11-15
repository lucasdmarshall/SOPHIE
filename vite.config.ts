import { defineConfig } from 'vite';

export default defineConfig({
  clearScreen: false,
  build: { rollupOptions: { input: { main: 'index.html', dwell: 'dwell.html', holo: 'holo.html' } } },
  server: {
    port: 1420,
    strictPort: true,
    host: '127.0.0.1',
    watch: { ignored: ['**/src-tauri/target/**'] },
  },
});
