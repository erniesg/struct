/**
 * Return canonical padding length, or undefined for a noncanonical base64
 * spelling. This scan uses constant stack space for every permitted payload.
 * Callers enforce their own byte and field limits before calling it.
 */
export function canonicalBase64Padding(value: string): 0 | 1 | 2 | undefined {
  if (value.length % 4 !== 0) return undefined
  let padding: 0 | 1 | 2 = 0
  for (let index = 0; index < value.length; index += 4) {
    const first = digit(value.charCodeAt(index))
    const second = digit(value.charCodeAt(index + 1))
    if (first < 0 || second < 0) return undefined
    const thirdCode = value.charCodeAt(index + 2)
    const fourthCode = value.charCodeAt(index + 3)
    const lastQuartet = index + 4 === value.length
    if (thirdCode === 61) {
      if (!lastQuartet || fourthCode !== 61 || (second & 15) !== 0)
        return undefined
      padding = 2
      continue
    }
    const third = digit(thirdCode)
    if (third < 0) return undefined
    if (fourthCode === 61) {
      if (!lastQuartet || (third & 3) !== 0) return undefined
      padding = 1
      continue
    }
    if (digit(fourthCode) < 0) return undefined
  }
  return padding
}

function digit(code: number): number {
  if (code >= 65 && code <= 90) return code - 65
  if (code >= 97 && code <= 122) return code - 97 + 26
  if (code >= 48 && code <= 57) return code - 48 + 52
  if (code === 43) return 62
  if (code === 47) return 63
  return -1
}
