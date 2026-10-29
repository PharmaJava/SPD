import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// La interfaz vive en src/interfaz y se compila a dist/interfaz (rutas relativas: se carga con file://).
export default defineConfig({
  root: 'src/interfaz',
  base: './',
  plugins: [svelte()],
  build: { outDir: '../../dist/interfaz', emptyOutDir: true, target: 'chrome140', sourcemap: true },
  server: { port: 5173, strictPort: true, proxy: { '^/api/': 'http://127.0.0.1:5174' } },
});
