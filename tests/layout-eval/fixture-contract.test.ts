import { readFile } from 'node:fs/promises'
import { beforeAll, describe, expect, it } from 'vitest'

const categories = [
  'paragraph',
  'hierarchy',
  'tables',
  'figures',
  'citations',
  'notes',
  'multicolumn',
  'rtl',
  'navigation',
  'assets',
  'metadata',
  'malformed',
  'bounds',
  'ambiguity',
] as const

const outcomes = [
  'rendered-ready',
  'source-preserved-ready',
  'expected-review-refusal',
  'invalid-bridge-document',
  'unexpected-renderer-refusal',
  'conformance-failure',
] as const

const versionAxes = [
  'protocolVersion',
  'fixtureVersion',
  'rendererVersion',
  'profileVersion',
  'bridgeVersion',
  'cohortVersion',
] as const

type JsonObject = Record<string, any>

let protocol: JsonObject
let reportSchema: JsonObject

beforeAll(async () => {
  const loaded = await Promise.all([
    readJson('evaluation/layout-epub-v1/protocol.json'),
    readJson('evaluation/layout-epub-v1/aggregate-report.schema.json'),
  ])
  protocol = loaded[0]
  reportSchema = loaded[1]
})

async function readJson(path: string): Promise<JsonObject> {
  return JSON.parse(await readFile(path, 'utf8'))
}

function syntheticReport(): JsonObject {
  const categoryCells = Object.fromEntries(
    categories.map((category) => [
      category,
      { status: 'reported', numerator: 5, denominator: 5, rate: 1 },
    ]),
  )
  return {
    schemaVersion: '1.0.0',
    versions: {
      protocolVersion: '1.0.0',
      fixtureVersion: '1.0.0',
      rendererVersion: '1.0.0',
      profileVersion: '1.0.0',
      bridgeVersion: '1.0.0',
      cohortVersion: '1.0.0',
    },
    publicArtifact: {
      packageName: '@erniesg/struct',
      packageVersion: '0.0.0',
      gitCommit: 'a'.repeat(40),
      packedArtifactSha256: 'b'.repeat(64),
    },
    evaluation: {
      gate: 'development',
      protocolState: 'development-open',
      qualifyingTransactionCount: 1,
    },
    outcomes: {
      'rendered-ready': 18,
      'source-preserved-ready': 1,
      'expected-review-refusal': 1,
      'invalid-bridge-document': 0,
      'unexpected-renderer-refusal': 0,
      'conformance-failure': 0,
    },
    counts: {
      assigned: 20,
      completed: 20,
      neutralObligations: 40,
      conservedNeutralObligations: 40,
      publicationEligible: 20,
      publicationReady: 19,
      ambiguityEligible: 5,
      ambiguitySafe: 5,
      semanticEligible: 19,
      renderedSemantically: 18,
    },
    rates: {
      assignedCompletion: 1,
      neutralConservation: 1,
      publicationReady: 0.95,
      ambiguitySafety: 1,
      semanticCoverage: 0.947368,
    },
    zeroTolerance: {
      privacySanitizerFailureCount: 0,
      falseLinkCount: 0,
      falseVerifiedTableCount: 0,
      inventedVisibleTextCount: 0,
      digestMismatchCount: 0,
      danglingReferenceCount: 0,
      unsafePathCount: 0,
      xmlFailureCount: 0,
      idFailureCount: 0,
      linkFailureCount: 0,
      manifestFailureCount: 0,
      spineFailureCount: 0,
      containerFailureCount: 0,
      metadataFailureCount: 0,
      accessibilityFailureCount: 0,
      boundsFailureCount: 0,
      xhtmlByteMismatchCount: 0,
      epubByteMismatchCount: 0,
    },
    categories: categoryCells,
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function resolveReference(root: JsonObject, reference: string): JsonObject {
  if (!reference.startsWith('#/')) throw new Error('unsupported-schema-reference')
  return reference
    .slice(2)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce<JsonObject>((value, segment) => value[segment], root)
}

function schemaErrors(
  schema: JsonObject,
  value: unknown,
  root: JsonObject = schema,
  location = '$',
): string[] {
  if (typeof schema.$ref === 'string')
    return schemaErrors(resolveReference(root, schema.$ref), value, root, location)

  const errors: string[] = []
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter(
      (candidate: JsonObject) =>
        schemaErrors(candidate, value, root, location).length === 0,
    )
    if (matches.length !== 1) errors.push(`${location}:oneOf`)
  }
  if ('const' in schema && !Object.is(value, schema.const))
    errors.push(`${location}:const`)
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((candidate: unknown) => Object.is(candidate, value))
  )
    errors.push(`${location}:enum`)

  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      return [...errors, `${location}:type`]
    const record = value as JsonObject
    const properties = (schema.properties ?? {}) as JsonObject
    for (const required of (schema.required ?? []) as string[])
      if (!Object.hasOwn(record, required))
        errors.push(`${location}.${required}:required`)
    if (schema.additionalProperties === false)
      for (const key of Object.keys(record))
        if (!Object.hasOwn(properties, key))
          errors.push(`${location}.${key}:closed`)
    for (const [key, propertySchema] of Object.entries(properties))
      if (Object.hasOwn(record, key))
        errors.push(
          ...schemaErrors(
            propertySchema as JsonObject,
            record[key],
            root,
            `${location}.${key}`,
          ),
        )
  }

  if (schema.type === 'array') {
    if (!Array.isArray(value)) return [...errors, `${location}:type`]
    if (typeof schema.minItems === 'number' && value.length < schema.minItems)
      errors.push(`${location}:minItems`)
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems)
      errors.push(`${location}:maxItems`)
    if (schema.uniqueItems === true && new Set(value).size !== value.length)
      errors.push(`${location}:uniqueItems`)
    if (schema.items)
      value.forEach((item, index) =>
        errors.push(
          ...schemaErrors(
            schema.items as JsonObject,
            item,
            root,
            `${location}[${index}]`,
          ),
        ),
      )
  }

  if (schema.type === 'string') {
    if (typeof value !== 'string') return [...errors, `${location}:type`]
    if (typeof schema.minLength === 'number' && value.length < schema.minLength)
      errors.push(`${location}:minLength`)
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength)
      errors.push(`${location}:maxLength`)
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value))
      errors.push(`${location}:pattern`)
  }

  if (schema.type === 'integer' || schema.type === 'number') {
    const validNumber =
      typeof value === 'number' &&
      Number.isFinite(value) &&
      (schema.type !== 'integer' || Number.isInteger(value))
    if (!validNumber) return [...errors, `${location}:type`]
    if (typeof schema.minimum === 'number' && value < schema.minimum)
      errors.push(`${location}:minimum`)
    if (typeof schema.maximum === 'number' && value > schema.maximum)
      errors.push(`${location}:maximum`)
    if (typeof schema.multipleOf === 'number') {
      const quotient = value / schema.multipleOf
      if (Math.abs(quotient - Math.round(quotient)) > 1e-9)
        errors.push(`${location}:multipleOf`)
    }
  }

  if (schema.type === 'boolean' && typeof value !== 'boolean')
    errors.push(`${location}:type`)
  return errors
}

function roundedRate(numerator: number, denominator: number): number {
  const scale = 1_000_000
  return (
    Math.floor((2 * numerator * scale + denominator) / (2 * denominator)) /
    scale
  )
}

function aggregateErrors(report: JsonObject): string[] {
  const errors = schemaErrors(reportSchema, report)
  if (errors.length > 0) return errors

  for (const [rateName, formula] of Object.entries(
    protocol.metrics.overall as JsonObject,
  )) {
    const { numeratorCounter, denominatorCounter } = formula as JsonObject
    const numerator = report.counts[numeratorCounter]
    const denominator = report.counts[denominatorCounter]
    if (numerator > denominator) errors.push(`counts.${rateName}:range`)
    if (
      Object.is(report.rates[rateName], -0) ||
      report.rates[rateName] !== roundedRate(numerator, denominator)
    )
      errors.push(`rates.${rateName}:derived`)
  }

  for (const category of categories) {
    const cell = report.categories[category]
    if (cell.status !== 'reported') continue
    if (cell.numerator > cell.denominator)
      errors.push(`categories.${category}:range`)
    if (
      Object.is(cell.rate, -0) ||
      cell.rate !== roundedRate(cell.numerator, cell.denominator)
    )
      errors.push(`categories.${category}.rate:derived`)
  }

  const completedFromOutcomes = outcomes.reduce(
    (sum, outcome) => sum + report.outcomes[outcome],
    0,
  )
  if (completedFromOutcomes !== report.counts.completed)
    errors.push('outcomes:completion-conservation')
  if (
    report.outcomes['rendered-ready'] +
      report.outcomes['source-preserved-ready'] !==
    report.counts.publicationReady
  )
    errors.push('outcomes:ready-conservation')
  return errors
}

function expectValid(report: JsonObject): void {
  expect(aggregateErrors(report)).toEqual([])
}

function expectInvalid(report: JsonObject): void {
  expect(aggregateErrors(report).length).toBeGreaterThan(0)
}

function expectClosedObjectSchemas(schema: JsonObject): void {
  if (schema.type === 'object') expect(schema.additionalProperties).toBe(false)
  for (const keyword of ['$defs', 'properties'])
    for (const child of Object.values((schema[keyword] ?? {}) as JsonObject))
      expectClosedObjectSchemas(child as JsonObject)
  for (const keyword of ['oneOf', 'allOf', 'anyOf'])
    for (const child of (schema[keyword] ?? []) as JsonObject[])
      expectClosedObjectSchemas(child)
  if (schema.items && typeof schema.items === 'object')
    expectClosedObjectSchemas(schema.items as JsonObject)
}

describe('layout EPUB evaluation protocol', () => {
  it('freezes the exact categories, outcomes, versions, formulas, and gates', () => {
    expect(protocol.categories).toEqual(categories)
    expect(protocol.outcomes).toEqual(outcomes)
    expect(protocol.versionAxes).toEqual(versionAxes)
    expect(new Set(protocol.versionAxes).size).toBe(versionAxes.length)
    expect(reportSchema.$defs.versions.required).toEqual(versionAxes)
    expect(reportSchema.$defs.outcomes.required).toEqual(outcomes)
    expect(reportSchema.$defs.categories.required).toEqual(categories)
    expect(protocol).toMatchObject({
      protocolVersion: '1.0.0',
      protocolState: 'development-open',
      aggregateReportSchemaVersion: '1.0.0',
      reporting: {
        minimumPopulation: 5,
        maximumCount: 1_000_000,
        rateDecimalPlaces: 6,
        rateInputPolicy: 'trusted-aggregator-derived-only',
        suppressedFields: ['numerator', 'denominator', 'rate'],
        zeroToleranceSuppression: 'forbidden',
      },
      determinism: {
        runsPerInput: 2,
        mismatchCounters: [
          'xhtmlByteMismatchCount',
          'epubByteMismatchCount',
        ],
      },
      execution: {
        development: {
          allowedProtocolStates: ['development-open', 'frozen'],
          qualifyingTransactionPolicy: 'repeatable',
        },
        holdout: {
          requiredProtocolState: 'frozen',
          maximumQualifyingTransactions: 1,
          retryPolicy: 'infrastructure-only-without-semantic-counters',
        },
      },
    })
    expect(protocol.metrics).toMatchObject({
      overall: {
        assignedCompletion: {
          numeratorCounter: 'completed',
          denominatorCounter: 'assigned',
          gate: { operator: 'equal', value: 1 },
        },
        neutralConservation: {
          numeratorCounter: 'conservedNeutralObligations',
          denominatorCounter: 'neutralObligations',
          gate: { operator: 'equal', value: 1 },
        },
        publicationReady: {
          numeratorCounter: 'publicationReady',
          denominatorCounter: 'publicationEligible',
          gate: { operator: 'at-least', value: 0.95 },
        },
        ambiguitySafety: {
          numeratorCounter: 'ambiguitySafe',
          denominatorCounter: 'ambiguityEligible',
          gate: { operator: 'equal', value: 1 },
        },
        semanticCoverage: {
          numeratorCounter: 'renderedSemantically',
          denominatorCounter: 'semanticEligible',
          gate: { operator: 'report-only' },
        },
      },
      categoryReady: {
        numeratorField: 'numerator',
        denominatorField: 'denominator',
        rateField: 'rate',
        gate: { operator: 'at-least', value: 0.9 },
      },
      zeroTolerance: { gate: { operator: 'equal', value: 0 } },
    })
    expect(Object.keys(protocol.metrics.overall)).toEqual([
      'assignedCompletion',
      'neutralConservation',
      'publicationReady',
      'ambiguitySafety',
      'semanticCoverage',
    ])
    const zeroToleranceCounters = [
      ...protocol.metrics.zeroTolerance.safetyCounters,
      ...protocol.metrics.zeroTolerance.conformanceCounters,
      ...protocol.metrics.zeroTolerance.reproducibilityCounters,
    ]
    expect(zeroToleranceCounters).toEqual(
      Object.keys(syntheticReport().zeroTolerance),
    )
    expect(reportSchema.$defs.zeroTolerance.required).toEqual(
      zeroToleranceCounters,
    )
  })
})

describe('aggregate report contract', () => {
  it('accepts a complete content-free synthetic aggregate', () => {
    expectValid(syntheticReport())
  })

  it('closes every report object schema and rejects unknown fields at every level', () => {
    expectClosedObjectSchemas(reportSchema)
    const objectLocations = [
      'versions',
      'publicArtifact',
      'evaluation',
      'outcomes',
      'counts',
      'rates',
      'zeroTolerance',
      'categories',
    ]
    for (const location of objectLocations) {
      const candidate = clone(syntheticReport())
      candidate[location].unknown = true
      expectInvalid(candidate)
    }
    const categoryCandidate = clone(syntheticReport())
    categoryCandidate.categories.paragraph.unknown = true
    expectInvalid(categoryCandidate)
  })

  it.each([
    'documents',
    'documentRows',
    'errors',
    'path',
    'filename',
    'url',
    'sourceHash',
    'outputHash',
    'timestamp',
    'text',
    'geometry',
    'metadata',
  ])('rejects the forbidden field %s', (field) => {
    const candidate = clone(syntheticReport())
    candidate[field] = true
    expectInvalid(candidate)
  })

  it('does not admit private fields through the public artifact identity', () => {
    for (const field of [
      'documentId',
      'path',
      'filename',
      'url',
      'sourceHash',
      'outputHash',
      'timestamp',
      'metadata',
    ]) {
      const candidate = clone(syntheticReport())
      candidate.publicArtifact[field] = true
      expectInvalid(candidate)
    }
  })

  it('omits all counts and rates from suppressed category cells', () => {
    const suppressed = clone(syntheticReport())
    suppressed.categories.paragraph = { status: 'suppressed' }
    expectValid(suppressed)

    for (const field of ['numerator', 'denominator', 'rate']) {
      const candidate = clone(suppressed)
      candidate.categories.paragraph[field] = 0
      expectInvalid(candidate)
    }

    const belowMinimum = clone(syntheticReport())
    belowMinimum.categories.paragraph = {
      status: 'reported',
      numerator: 4,
      denominator: 4,
      rate: 1,
    }
    expectInvalid(belowMinimum)
  })

  it('rejects submitted rates that differ from their integer counters', () => {
    for (const rate of Object.keys(syntheticReport().rates)) {
      const candidate = clone(syntheticReport())
      candidate.rates[rate] = 0.5
      expectInvalid(candidate)
    }
    const categoryCandidate = clone(syntheticReport())
    categoryCandidate.categories.tables.rate = 0.5
    expectInvalid(categoryCandidate)

    for (const invalidRate of [-0, -0.1, 1.1, 0.1234567]) {
      const candidate = clone(syntheticReport())
      candidate.rates.assignedCompletion = invalidRate
      expectInvalid(candidate)
    }
  })

  it('never permits a zero-tolerance counter to be suppressed', () => {
    for (const counter of Object.keys(syntheticReport().zeroTolerance)) {
      const candidate = clone(syntheticReport())
      candidate.zeroTolerance[counter] = { status: 'suppressed' }
      expectInvalid(candidate)
    }
  })

  it('accepts one frozen holdout transaction and rejects unfrozen or repeated reports', () => {
    const holdout = clone(syntheticReport())
    holdout.evaluation = {
      gate: 'holdout',
      protocolState: 'frozen',
      qualifyingTransactionCount: 1,
    }
    expectValid(holdout)

    for (const protocolState of ['development-open', 'closed']) {
      const candidate = clone(holdout)
      candidate.evaluation.protocolState = protocolState
      expectInvalid(candidate)
    }
    const repeated = clone(holdout)
    repeated.evaluation.qualifyingTransactionCount = 2
    expectInvalid(repeated)

    const repeatedDevelopment = clone(syntheticReport())
    repeatedDevelopment.evaluation.qualifyingTransactionCount = 2
    expectValid(repeatedDevelopment)
  })
})
