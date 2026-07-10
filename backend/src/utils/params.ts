/** Query-parameter validation helpers. Invalid input raises BadRequestError → HTTP 400. */

export class BadRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadRequestError'
  }
}

/**
 * Parses an integer query param with bounds. `undefined`/empty → fallback.
 * Anything non-numeric, out of bounds, or repeated (array) → BadRequestError.
 */
export function parseBoundedInt(
  name: string,
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value === '') return fallback
  if (typeof value !== 'string') {
    throw new BadRequestError(`Query param "${name}" must be a single value`)
  }
  if (!/^-?\d+$/.test(value.trim())) {
    throw new BadRequestError(`Query param "${name}" must be an integer`)
  }
  const parsed = Number.parseInt(value, 10)
  if (parsed < min || parsed > max) {
    throw new BadRequestError(`Query param "${name}" must be between ${min} and ${max}`)
  }
  return parsed
}
