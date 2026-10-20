// The dashboard builds into one HTML file (scripts and styles inlined), which the Worker and
// `huddle server` serve as src/dashboard.html. `npm run dev` proxies the API to a local huddle server.
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { viteSingleFile } from 'vite-plugin-singlefile';

const target = process.env.HUDDLE_DEV_SERVER || 'http://127.0.0.1:7777';
export default defineConfig({
  plugins: [svelte(), viteSingleFile()],
  base: '/app/',
  server: { proxy: { '/api': { target, ws: true }, '/auth': target, '/status': target } },
  build: { target: 'es2020', assetsInlineLimit: 100000000, cssCodeSplit: false },
});
