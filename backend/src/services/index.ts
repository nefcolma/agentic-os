import { RunManager } from './run-manager.js'
import { RUN_DEFINITIONS, RUN_MANAGER_LIMITS } from './run-definitions.js'
import { redactSecrets } from '../utils/redact.js'

/** Singleton RunManager wired to the fixed definition registry and the real-env redactor. */
export const runManager = new RunManager({
  definitions: RUN_DEFINITIONS,
  redactor: redactSecrets,
  ...RUN_MANAGER_LIMITS,
})
