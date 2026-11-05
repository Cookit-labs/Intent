/** Browser-safe, since wallet code has no Buffer to rely on. */
export function bytesFromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function base64FromBytes(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
