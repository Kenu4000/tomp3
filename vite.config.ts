import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Use a relative base so the built app works on GitHub Pages project sites
// and also when previewed from a local static file server.
export default defineConfig({
  base: './',
  plugins: [react()],
});
