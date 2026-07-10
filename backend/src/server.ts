import fs from 'node:fs'
import { createApp } from './app.js'
import { config, SERVICE_NAME, SERVICE_VERSION } from './config/index.js'

const app = createApp()

const server = app.listen(config.port, config.host, () => {
  const vaultState = fs.existsSync(config.vaultPath) ? 'found' : 'MISSING'
  console.log(`[${SERVICE_NAME}] v${SERVICE_VERSION} listening on http://${config.host}:${config.port}`)
  console.log(`[${SERVICE_NAME}] vault: ${config.vaultPath} (${vaultState})`)
})

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `[${SERVICE_NAME}] port ${config.port} is already in use on ${config.host}. ` +
        'Stop the other process or change PORT in .env.',
    )
  } else {
    console.error(`[${SERVICE_NAME}] server error:`, err)
  }
  process.exit(1)
})

function shutdown(signal: string): void {
  console.log(`[${SERVICE_NAME}] ${signal} received, shutting down`)
  server.close(() => process.exit(0))
  // Do not hang forever if a connection refuses to close.
  setTimeout(() => process.exit(1), 5_000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
