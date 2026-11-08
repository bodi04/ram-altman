import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Relative paths so the build works under GitHub Pages' /ram-altman/ subpath.
  base: './',
})
