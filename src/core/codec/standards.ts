import { fail, stringValue } from './primitives'

const MEDIA_TYPE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u
const BCP47_LANGUAGE =
  /^(?:(?:[A-Za-z]{2,3}(?:-[A-Za-z]{3}){0,3}|[A-Za-z]{4}|[A-Za-z]{5,8})(?:-[A-Za-z]{4})?(?:-(?:[A-Za-z]{2}|\d{3}))?(?:-(?:[A-Za-z0-9]{5,8}|\d[A-Za-z0-9]{3}))*(?:-[0-9A-WY-Za-wy-z](?:-[A-Za-z0-9]{2,8})+)*(?:-x(?:-[A-Za-z0-9]{1,8})+)?|x(?:-[A-Za-z0-9]{1,8})+)$/u
const BCP47_GRANDFATHERED =
  /^(?:art-lojban|cel-gaulish|en-GB-oed|i-ami|i-bnn|i-default|i-enochian|i-hak|i-klingon|i-lux|i-mingo|i-navajo|i-pwn|i-tao|i-tay|i-tsu|no-bok|no-nyn|sgn-BE-FR|sgn-BE-NL|sgn-CH-DE|zh-guoyu|zh-hakka|zh-min|zh-min-nan|zh-xiang)$/iu
const RFC3339_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u
const RFC3339_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u

export function bcp47Language(value: unknown, path: string) {
  const parsed = stringValue(value, path)
  const grandfathered = BCP47_GRANDFATHERED.test(parsed)
  if (!grandfathered && !BCP47_LANGUAGE.test(parsed))
    fail('LANGUAGE', path, 'language must be a valid BCP-47 tag')

  if (!grandfathered && !/^x-/iu.test(parsed)) {
    const subtags = parsed.split('-')
    const languageLength = subtags[0]?.length ?? 0
    let index = 1
    if (languageLength >= 2 && languageLength <= 3) {
      let extlangs = 0
      while (
        extlangs < 3 &&
        index < subtags.length &&
        /^[A-Za-z]{3}$/u.test(subtags[index]!)
      ) {
        extlangs += 1
        index += 1
      }
    }
    if (/^[A-Za-z]{4}$/u.test(subtags[index] ?? '')) index += 1
    if (/^(?:[A-Za-z]{2}|\d{3})$/u.test(subtags[index] ?? '')) index += 1
    const variants = new Set<string>()
    while (
      /^(?:[A-Za-z0-9]{5,8}|\d[A-Za-z0-9]{3})$/u.test(subtags[index] ?? '')
    ) {
      const variant = subtags[index]!.toLowerCase()
      if (variants.has(variant))
        fail('LANGUAGE', path, 'language must not repeat a BCP-47 variant')
      variants.add(variant)
      index += 1
    }
  }

  const extensionSingletons = new Set<string>()
  for (const subtag of parsed.split('-')) {
    if (subtag.length !== 1 || subtag.toLowerCase() === 'x') continue
    const singleton = subtag.toLowerCase()
    if (extensionSingletons.has(singleton))
      fail(
        'LANGUAGE',
        path,
        'language must not repeat a BCP-47 extension singleton',
      )
    extensionSingletons.add(singleton)
  }
  return parsed
}

export function rfc3339Date(value: unknown, path: string) {
  const parsed = stringValue(value, path)
  const match = RFC3339_DATE.exec(parsed)
  if (!match) fail('DATE', path, 'date must be an RFC-3339 full-date')
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    fail('DATE', path, 'date must be a real calendar date')
  return parsed
}

export function rfc3339DateTime(value: unknown, path: string) {
  const parsed = stringValue(value, path)
  if (
    !RFC3339_DATE_TIME.test(parsed) ||
    !/T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u.test(
      parsed,
    )
  )
    fail('DATE_TIME', path, 'timestamp must be an RFC-3339 date-time')
  rfc3339Date(parsed.slice(0, 10), path)
  if (Number.isNaN(Date.parse(parsed)))
    fail('DATE_TIME', path, 'timestamp must be a real RFC-3339 date-time')
  return parsed
}

export function mediaType(value: unknown, path: string) {
  const parsed = stringValue(value, path)
  if (parsed.includes('*') || !MEDIA_TYPE.test(parsed))
    fail('MIME', path, 'media type must be a strict type/subtype MIME value')
  return parsed
}
