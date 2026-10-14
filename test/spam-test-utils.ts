// Test-only helpers for the spam guard tests. Never import from app code.

import { solveChallenge } from 'altcha-lib'
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2'
import type { Challenge } from 'altcha-lib/types'

/** Solve a challenge the way the browser does and encode it as the `altcha` field value. */
export async function solvePayload(challenge: Challenge): Promise<string> {
  const solution = await solveChallenge({ challenge, deriveKey })
  if (!solution) throw new Error('test challenge could not be solved')
  return btoa(JSON.stringify({ challenge: { parameters: challenge.parameters, signature: challenge.signature }, solution }))
}

/** A 64-hex test secret. */
export const TEST_SECRET = 'a'.repeat(64)
