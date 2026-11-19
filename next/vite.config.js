import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Served by Caddy from ~/matrix-spike/app/next next to the old app, on the same origin and session.
export default defineConfig({
  base: '/next/',
  plugins: [svelte(), tailwindcss()],
  build: { outDir: 'dist', emptyOutDir: true },
});
