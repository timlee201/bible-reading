import crypto from 'node:crypto';

let rememberedRefreshToken = '';

function key() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error('SESSION_SECRET is not set');
  }
  return crypto.createHash('sha256').update(secret, 'utf8').digest();
}

export function seal(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64url');
}

export function unseal(sealed) {
  const buf = Buffer.from(String(sealed), 'base64url');
  if (buf.length < 12 + 16 + 1) {
    throw new Error('bad seal');
  }
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function createFileToken(refreshToken) {
  const nonce = crypto.randomBytes(16).toString('base64url');
  return seal(JSON.stringify({ r: refreshToken, n: nonce }));
}

export function refreshTokenFromFileToken(fileToken) {
  const parsed = JSON.parse(unseal(fileToken));
  if (!parsed || typeof parsed.r !== 'string' || !parsed.r) {
    throw new Error('bad file token');
  }
  return parsed.r;
}

export function rememberRefreshToken(token) {
  if (typeof token === 'string' && token) {
    rememberedRefreshToken = token;
  }
}

export function fallbackRefreshToken() {
  return process.env.GOOGLE_REFRESH_TOKEN || rememberedRefreshToken || '';
}
