// crypto.js — 数据包的 AES-GCM 加解密（WebCrypto，浏览器与 Node 共用）。
//
// 格式：data.enc 是一个 JSON 信封：
//   { v: 1, kdf: "PBKDF2", hash: "SHA-256", iterations: 210000,
//     salt: <base64, 16 字节随机>, iv: <base64, 12 字节随机>,
//     data: <base64, 密文（含 GCM 认证标签)> }
// 密钥由口令经 PBKDF2-HMAC-SHA256（210,000 次迭代）派生，AES-GCM-256。
// 口令错误时 subtle.decrypt 会因认证失败抛错，界面据此提示「口令不正确」。

export const PACK_ITERATIONS = 210000;

const subtle = globalThis.crypto && globalThis.crypto.subtle;
if (!subtle) throw new Error('当前环境不支持 WebCrypto');

export function base64Encode(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function base64Decode(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function deriveKey(passphrase, salt, iterations, usages) {
  const baseKey = await subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    usages,
  );
}

export async function encryptBundle(plainBytes, passphrase, iterations = PACK_ITERATIONS) {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, iterations, ['encrypt']);
  const cipher = await subtle.encrypt({ name: 'AES-GCM', iv }, key, plainBytes);
  return {
    v: 1,
    kdf: 'PBKDF2',
    hash: 'SHA-256',
    iterations,
    salt: base64Encode(salt),
    iv: base64Encode(iv),
    data: base64Encode(new Uint8Array(cipher)),
  };
}

export async function decryptBundle(envelope, passphrase) {
  const salt = base64Decode(envelope.salt);
  const iv = base64Decode(envelope.iv);
  const key = await deriveKey(passphrase, salt, envelope.iterations, ['decrypt']);
  const plain = await subtle.decrypt({ name: 'AES-GCM', iv }, key, base64Decode(envelope.data));
  return new Uint8Array(plain);
}
