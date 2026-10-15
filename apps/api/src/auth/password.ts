import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'

const COST = 1 << 15
const BLOCK_SIZE = 8
const PARALLELIZATION = 1
const KEY_LENGTH = 64
const MAX_MEMORY = 64 * 1024 * 1024

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, KEY_LENGTH, {
      N: COST,
      r: BLOCK_SIZE,
      p: PARALLELIZATION,
      maxmem: MAX_MEMORY,
    }, (error, derivedKey) => {
      if (error) reject(error)
      else resolve(derivedKey as Buffer)
    })
  })
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const derivedKey = await deriveKey(password, salt)
  return `scrypt$${COST}$${BLOCK_SIZE}$${PARALLELIZATION}$${salt.toString('base64url')}$${derivedKey.toString('base64url')}`
}

export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  const [algorithm, cost, blockSize, parallelization, saltText, keyText, extra] = encodedHash.split('$')
  if (algorithm !== 'scrypt' || cost !== String(COST) || blockSize !== String(BLOCK_SIZE)
    || parallelization !== String(PARALLELIZATION) || !saltText || !keyText || extra !== undefined) {
    return false
  }

  try {
    const salt = Buffer.from(saltText, 'base64url')
    const expectedKey = Buffer.from(keyText, 'base64url')
    if (salt.length !== 16 || expectedKey.length !== KEY_LENGTH) return false
    const actualKey = await deriveKey(password, salt)
    return timingSafeEqual(actualKey, expectedKey)
  } catch {
    return false
  }
}
