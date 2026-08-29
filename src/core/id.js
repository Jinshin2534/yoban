// ULID 風の識別子。先頭に時刻を置くので、辞書順がそのまま生成順になる。
import { randomInt } from 'node:crypto'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' // Crockford Base32（紛らわしい I L O U を除く）
const TIME_LENGTH = 10
const RANDOM_LENGTH = 16

function encode(value, length) {
  let out = ''
  let v = value
  for (let i = 0; i < length; i++) {
    out = ALPHABET[v % 32] + out
    v = Math.floor(v / 32)
  }
  return out
}

export function newId(now = Date.now()) {
  let random = ''
  for (let i = 0; i < RANDOM_LENGTH; i++) random += ALPHABET[randomInt(32)]
  return encode(now, TIME_LENGTH) + random
}
