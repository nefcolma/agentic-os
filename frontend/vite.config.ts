import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The repo root holds the single .env (backend PORT lives there); pointing
// envDir at it keeps configuration in one place. Only VITE_-prefixed vars
// are ever exposed to client code — credentials never carry that prefix.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '..', '')
  const backendPort = env.BACKEND_PORT ?? '8790'

  return {
    plugins: [react(), tailwindcss()],
    envDir: '..',
    server: {
      host: '127.0.0.1',
      proxy: {
        '/api': `http://127.0.0.1:${backendPort}`,
      },
    },
  }
})
