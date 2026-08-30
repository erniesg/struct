import { readFile } from 'node:fs/promises'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  createAggregateAcceptance,
  loadAggregateAcceptance,
  type AcceptanceError,
  type AggregateAcceptance,
  type AggregateAcceptanceContext,
  type AggregateContractIdentity,
  type TrustedHoldoutAuthorization,
  type TrustedHoldoutClaim,
  type TrustedHoldoutState,
} from './aggregate-acceptance'

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

type Category = (typeof categories)[number]
type JsonObject = Record<string, any>

let acceptance: AggregateAcceptance
let protocol: JsonObject
let reportSchema: JsonObject

beforeAll(async () => {
  acceptance = await loadAggregateAcceptance()
  protocol = acceptance.protocol
  reportSchema = acceptance.reportSchema
})

function syntheticReport(): JsonObject {
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
    evaluation: { gate: 'development' },
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
    categories: Object.fromEntries(
      categories.map((category) => [
        category,
        { status: 'reported', numerator: 5, denominator: 5, rate: 1 },
      ]),
    ),
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function categoryPopulations(population = 5): Record<Category, number> {
  return Object.fromEntries(
    categories.map((category) => [category, population]),
  ) as Record<Category, number>
}

function context(
  populations: Readonly<Record<string, number>> = categoryPopulations(),
  holdoutAuthorization?: TrustedHoldoutAuthorization,
): AggregateAcceptanceContext {
  return { categoryPopulations: populations, holdoutAuthorization }
}

function expectValid(
  report: JsonObject,
  acceptanceContext = context(),
  evaluator = acceptance,
): void {
  expect(evaluator.acceptForPublicEmission(report, acceptanceContext)).toEqual({
    accepted: true,
    errors: [],
  })
}

function expectInvalid(
  report: JsonObject,
  expectedError?: AcceptanceError,
  acceptanceContext = context(),
  evaluator = acceptance,
): void {
  const result = evaluator.acceptForPublicEmission(report, acceptanceContext)
  expect(result.accepted).toBe(false)
  if (expectedError !== undefined) expect(result.errors).toContain(expectedError)
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

function contractIdentity(report: JsonObject): AggregateContractIdentity {
  return {
    schemaVersion: report.schemaVersion,
    versions: clone(report.versions),
    publicArtifact: clone(report.publicArtifact),
  }
}

function futureFrozenAcceptance(): AggregateAcceptance {
  const frozenProtocol = clone(protocol)
  frozenProtocol.protocolVersion = '1.1.0'
  frozenProtocol.protocolState = 'frozen'
  frozenProtocol.aggregateReportSchemaVersion = '1.1.0'
  const frozenSchema = clone(reportSchema)
  frozenSchema.properties.schemaVersion.const = '1.1.0'
  frozenSchema.$defs.evaluation.properties.gate = {
    enum: ['development', 'holdout'],
  }
  return createAggregateAcceptance(frozenProtocol, frozenSchema)
}

function futureHoldoutReport(): JsonObject {
  const candidate = clone(syntheticReport())
  candidate.schemaVersion = '1.1.0'
  candidate.versions.protocolVersion = '1.1.0'
  candidate.evaluation = { gate: 'holdout' }
  return candidate
}

class AtomicSingleUseState implements TrustedHoldoutState {
  calls = 0
  claims: TrustedHoldoutClaim[] = []
  private consumed = false

  constructor(
    private readonly matches: (claim: TrustedHoldoutClaim) => boolean = () =>
      true,
  ) {}

  async consultAndConsume(claim: TrustedHoldoutClaim): Promise<boolean> {
    this.calls += 1
    this.claims.push(claim)
    if (!this.matches(claim) || this.consumed) return false
    this.consumed = true
    return true
  }
}

describe('layout EPUB evaluation protocol', () => {
  it('parses and compiles the actual declared Draft 2020-12 schema with pinned Ajv', async () => {
    expect(reportSchema.$schema).toBe(
      'https://json-schema.org/draft/2020-12/schema',
    )
    const packageJson = JSON.parse(await readFile('package.json', 'utf8'))
    expect(packageJson.devDependencies.ajv).toBe('8.20.0')
    expectValid(syntheticReport())
  })

  it('freezes the exact categories, outcomes, versions, formulas, and gates', () => {
    expect(protocol.categories).toEqual(categories)
    expect(protocol.outcomes).toEqual(outcomes)
    expect(protocol.versionAxes).toEqual(versionAxes)
    expect(new Set(protocol.versionAxes).size).toBe(versionAxes.length)
    expect(reportSchema.$defs.versions.required).toEqual(versionAxes)
    expect(reportSchema.$defs.outcomes.required).toEqual(outcomes)
    expect(reportSchema.$defs.categories.required).toEqual(categories)
    expect(reportSchema.$defs.evaluation.properties.gate).toEqual({
      const: 'development',
    })
    expect(protocol).toMatchObject({
      protocolVersion: '1.0.0',
      protocolState: 'development-open',
      aggregateReportSchemaVersion: '1.0.0',
      reporting: {
        minimumPopulation: 5,
        maximumCount: 1_000_000,
        rateDecimalPlaces: 6,
        rateRounding: 'half-up',
        rateInputPolicy: 'trusted-aggregator-derived-only',
        gateInputPolicy: 'exact-counter-ratio-before-rounding',
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
      ownerPrivateHoldoutState: {
        storage: 'outside-struct',
        freezeTiming: 'before-holdout-input-open',
        authorizationOperation: 'atomic-consult-and-consume',
        authorizationTiming: 'before-holdout-input-open',
        authorizationEvidenceInReport: 'forbidden',
        requiredBindings: [
          'exactFrozenProtocolArtifact',
          'protocolState',
          'protocolVersion',
          'aggregateReportSchemaVersion',
          'fixtureVersion',
          'rendererVersion',
          'profileVersion',
          'bridgeVersion',
          'cohortVersion',
          'publicArtifact',
          'maximumQualifyingTransactions',
        ],
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

describe('aggregate report schema and privacy boundary', () => {
  it('closes every report object schema and rejects unknown fields at every level', () => {
    expectClosedObjectSchemas(reportSchema)
    for (const location of [
      'versions',
      'publicArtifact',
      'evaluation',
      'outcomes',
      'counts',
      'rates',
      'zeroTolerance',
      'categories',
    ]) {
      const candidate = clone(syntheticReport())
      candidate[location].unknown = true
      expectInvalid(candidate, 'schema-invalid')
    }
    const categoryCandidate = clone(syntheticReport())
    categoryCandidate.categories.paragraph.unknown = true
    expectInvalid(categoryCandidate, 'schema-invalid')
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
    'ledgerId',
    'authorization',
    'receipt',
  ])('rejects the forbidden field %s', (field) => {
    const candidate = clone(syntheticReport())
    candidate[field] = true
    expectInvalid(candidate, 'schema-invalid')
  })

  it('does not admit private fields through public artifact or evaluation objects', () => {
    for (const field of [
      'documentId',
      'path',
      'filename',
      'url',
      'sourceHash',
      'outputHash',
      'timestamp',
      'metadata',
      'ledgerId',
    ]) {
      const candidate = clone(syntheticReport())
      candidate.publicArtifact[field] = true
      expectInvalid(candidate, 'schema-invalid')
    }
    for (const field of [
      'protocolState',
      'qualifyingTransactionCount',
      'authorization',
      'receipt',
    ]) {
      const candidate = clone(syntheticReport())
      candidate.evaluation[field] = true
      expectInvalid(candidate, 'schema-invalid')
    }
  })

  it.each([
    '1.0.0',
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-0.3.7',
    '1.0.0-x.7.z.92',
    '1.0.0+build.1',
    '1.0.0-rc.1+build.1',
    `1.0.0+${'a'.repeat(58)}`,
  ])('accepts the bounded SemVer 2.0 version %s', (version) => {
    const candidate = clone(syntheticReport())
    candidate.versions.rendererVersion = version
    expectValid(candidate)
  })

  it.each([
    '01.0.0',
    '1.01.0',
    '1.0.01',
    '1.0',
    '1.0.0-',
    '1.0.0-01',
    '1.0.0-alpha..1',
    '1.0.0+build_1',
    `1.0.0+${'a'.repeat(59)}`,
  ])('rejects the non-SemVer or over-bound version %s', (version) => {
    const candidate = clone(syntheticReport())
    candidate.versions.rendererVersion = version
    expectInvalid(candidate, 'schema-invalid')
  })
})

describe('required aggregate acceptance algorithm', () => {
  it('accepts a complete content-free synthetic aggregate', () => {
    expectValid(syntheticReport())
  })

  it('rejects a missing or caller-shaped trusted category population map', () => {
    const candidate = syntheticReport()
    expectInvalid(
      candidate,
      'trusted-category-populations-invalid',
      {} as AggregateAcceptanceContext,
    )
    const missing = categoryPopulations()
    delete (missing as Partial<Record<Category, number>>).paragraph
    expectInvalid(
      candidate,
      'trusted-category-populations-invalid',
      context(missing),
    )
    expectInvalid(
      candidate,
      'trusted-category-populations-invalid',
      context({ ...categoryPopulations(), unknown: 1 }),
    )
  })

  it('requires suppression below the minimum and reporting at the minimum', () => {
    for (const category of categories) {
      const suppressed = clone(syntheticReport())
      suppressed.categories[category] = { status: 'suppressed' }
      const belowMinimum = categoryPopulations()
      belowMinimum[category] = 4
      expectValid(suppressed, context(belowMinimum))
      expectInvalid(
        suppressed,
        'suppression-ineligible',
        context(categoryPopulations()),
      )
      expectInvalid(
        syntheticReport(),
        'suppression-required',
        context(belowMinimum),
      )
    }
  })

  it('binds each reported denominator to the trusted pre-suppression population', () => {
    for (const category of categories) {
      const populations = categoryPopulations()
      populations[category] = 6
      expectInvalid(
        syntheticReport(),
        'category-population-mismatch',
        context(populations),
      )
    }
  })

  it('omits every counter and rate from a suppressed category cell', () => {
    const populations = categoryPopulations()
    populations.paragraph = 4
    const suppressed = clone(syntheticReport())
    suppressed.categories.paragraph = { status: 'suppressed' }
    expectValid(suppressed, context(populations))
    for (const field of ['numerator', 'denominator', 'rate']) {
      const candidate = clone(suppressed)
      candidate.categories.paragraph[field] = 0
      expectInvalid(candidate, 'schema-invalid', context(populations))
    }
  })

  it('rejects every overall rate that differs from its counters', () => {
    for (const rate of Object.keys(syntheticReport().rates)) {
      const candidate = clone(syntheticReport())
      candidate.rates[rate] = 0.5
      expectInvalid(candidate, 'rate-not-derived')
    }
    for (const invalidRate of [-0, -0.1, 1.1, 0.1234567]) {
      const candidate = clone(syntheticReport())
      candidate.rates.assignedCompletion = invalidRate
      expectInvalid(candidate)
    }
  })

  it('rejects every category rate that differs from its counters', () => {
    for (const category of categories) {
      const candidate = clone(syntheticReport())
      candidate.categories[category].rate = 0.8
      expectInvalid(candidate, 'rate-not-derived')
    }
  })

  it('rejects numerator overflow and zero denominator mutations', () => {
    for (const formula of Object.values(
      protocol.metrics.overall,
    ) as JsonObject[]) {
      const overflow = clone(syntheticReport())
      overflow.counts[formula.numeratorCounter] =
        overflow.counts[formula.denominatorCounter] + 1
      expectInvalid(overflow)
      const zero = clone(syntheticReport())
      zero.counts[formula.denominatorCounter] = 0
      expectInvalid(zero, 'schema-invalid')
    }
    for (const category of categories) {
      const overflow = clone(syntheticReport())
      overflow.categories[category].numerator = 6
      expectInvalid(overflow, 'counter-range-invalid')
      const zero = clone(syntheticReport())
      zero.categories[category] = {
        status: 'reported',
        numerator: 0,
        denominator: 0,
        rate: 0,
      }
      expectInvalid(zero, 'schema-invalid')
    }
  })

  it.each([
    {
      name: 'assigned completion',
      mutate(candidate: JsonObject) {
        candidate.counts.assigned = 21
        candidate.rates.assignedCompletion = 0.952381
      },
    },
    {
      name: 'neutral conservation',
      mutate(candidate: JsonObject) {
        candidate.counts.conservedNeutralObligations = 39
        candidate.rates.neutralConservation = 0.975
      },
    },
    {
      name: 'publication ready',
      mutate(candidate: JsonObject) {
        candidate.counts.publicationReady = 18
        candidate.rates.publicationReady = 0.9
        candidate.outcomes['rendered-ready'] = 17
        candidate.outcomes['expected-review-refusal'] = 2
      },
    },
    {
      name: 'ambiguity safety',
      mutate(candidate: JsonObject) {
        candidate.counts.ambiguitySafe = 4
        candidate.rates.ambiguitySafety = 0.8
      },
    },
  ])('rejects a correctly derived failure of the $name gate', ({ mutate }) => {
    const candidate = clone(syntheticReport())
    mutate(candidate)
    expectInvalid(candidate, 'overall-gate-failed')
  })

  it('keeps semantic coverage report-only', () => {
    const candidate = clone(syntheticReport())
    candidate.counts.renderedSemantically = 0
    candidate.rates.semanticCoverage = 0
    expectValid(candidate)
  })

  it('applies the overall threshold before display rounding', () => {
    const candidate = clone(syntheticReport())
    candidate.counts.assigned = 1_000_000
    candidate.counts.completed = 1_000_000
    candidate.counts.publicationEligible = 1_000_000
    candidate.counts.publicationReady = 949_999
    candidate.rates.publicationReady = 0.95
    candidate.outcomes['rendered-ready'] = 949_999
    candidate.outcomes['source-preserved-ready'] = 0
    candidate.outcomes['expected-review-refusal'] = 50_001
    expectInvalid(candidate, 'overall-gate-failed')
  })

  it('rejects every category-ready gate mutation', () => {
    for (const category of categories) {
      const candidate = clone(syntheticReport())
      candidate.categories[category] = {
        status: 'reported',
        numerator: 4,
        denominator: 5,
        rate: 0.8,
      }
      expectInvalid(candidate, 'category-gate-failed')
    }
  })

  it('applies category gates before display rounding', () => {
    const candidate = clone(syntheticReport())
    candidate.categories.paragraph = {
      status: 'reported',
      numerator: 899_999,
      denominator: 1_000_000,
      rate: 0.9,
    }
    const populations = categoryPopulations()
    populations.paragraph = 1_000_000
    expectInvalid(candidate, 'category-gate-failed', context(populations))
  })

  it('rejects every nonzero zero-tolerance gate mutation', () => {
    for (const counter of Object.keys(syntheticReport().zeroTolerance)) {
      const candidate = clone(syntheticReport())
      candidate.zeroTolerance[counter] = 1
      expectInvalid(candidate, 'zero-tolerance-gate-failed')
    }
  })

  it('never permits a zero-tolerance counter to be suppressed', () => {
    for (const counter of Object.keys(syntheticReport().zeroTolerance)) {
      const candidate = clone(syntheticReport())
      candidate.zeroTolerance[counter] = { status: 'suppressed' }
      expectInvalid(candidate, 'schema-invalid')
    }
  })

  it('rejects both outcome conservation mutations', () => {
    const completion = clone(syntheticReport())
    completion.outcomes['expected-review-refusal'] = 0
    expectInvalid(completion, 'outcome-conservation-failed')
    const ready = clone(syntheticReport())
    ready.outcomes['rendered-ready'] = 17
    ready.outcomes['expected-review-refusal'] = 2
    expectInvalid(ready, 'outcome-conservation-failed')
  })

  it('rejects the independent review combined gate counterexample', () => {
    const candidate = clone(syntheticReport())
    candidate.counts.publicationReady = 18
    candidate.rates.publicationReady = 0.9
    candidate.outcomes['rendered-ready'] = 17
    candidate.outcomes['expected-review-refusal'] = 2
    candidate.zeroTolerance.falseLinkCount = 1
    candidate.categories.paragraph = {
      status: 'reported',
      numerator: 4,
      denominator: 5,
      rate: 0.8,
    }
    const result = acceptance.acceptForPublicEmission(candidate, context())
    expect(result).toMatchObject({ accepted: false })
    expect(result.errors).toEqual(
      expect.arrayContaining([
        'overall-gate-failed',
        'category-gate-failed',
        'zero-tolerance-gate-failed',
      ]),
    )
  })

  it('rejects report protocol-version mismatch', () => {
    const candidate = clone(syntheticReport())
    candidate.versions.protocolVersion = '2.0.0'
    expectInvalid(candidate, 'report-version-mismatch')
  })
})

describe('owner-private holdout state contract', () => {
  it(
    'rejects holdout at the committed development-open head without consulting state',
    async () => {
      const candidate = clone(syntheticReport())
      candidate.evaluation = { gate: 'holdout' }
      expectInvalid(candidate, 'schema-invalid')
      const permissiveSchema = clone(reportSchema)
      permissiveSchema.$defs.evaluation.properties.gate = {
        enum: ['development', 'holdout'],
      }
      const permissiveAcceptance = createAggregateAcceptance(
        protocol,
        permissiveSchema,
      )
      expectInvalid(
        candidate,
        'evaluation-state-ineligible',
        context(),
        permissiveAcceptance,
      )
      const state = new AtomicSingleUseState()
      const authorization = await acceptance.authorizeHoldoutBeforeInputOpen(
        contractIdentity(candidate),
        state,
      )
      expect(authorization).toEqual({
        authorized: false,
        error: 'holdout-protocol-ineligible',
      })
      expect(state.calls).toBe(0)
    },
  )

  it('rejects caller-supplied holdout state and count fields as schema violations', () => {
    const candidate = clone(syntheticReport())
    candidate.evaluation = {
      gate: 'holdout',
      protocolState: 'frozen',
      qualifyingTransactionCount: 1,
    }
    expectInvalid(candidate, 'schema-invalid')
  })

  it(
    'requires injected trusted state and atomically rejects a second identical frozen claim',
    async () => {
      const frozenAcceptance = futureFrozenAcceptance()
      const candidate = futureHoldoutReport()
      expectInvalid(
        candidate,
        'holdout-authorization-required',
        context(),
        frozenAcceptance,
      )
      expectInvalid(
        candidate,
        'holdout-authorization-mismatch',
        context(categoryPopulations(), {} as TrustedHoldoutAuthorization),
        frozenAcceptance,
      )
      const claim = contractIdentity(candidate)
      const expectedClaim: TrustedHoldoutClaim = {
        exactFrozenProtocolArtifact: frozenAcceptance.protocol,
        protocolState: 'frozen',
        maximumQualifyingTransactions: 1,
        ...claim,
      }
      const state = new AtomicSingleUseState(
        (candidateClaim) =>
          JSON.stringify(candidateClaim) === JSON.stringify(expectedClaim),
      )
      const [first, second] = await Promise.all([
        frozenAcceptance.authorizeHoldoutBeforeInputOpen(claim, state),
        frozenAcceptance.authorizeHoldoutBeforeInputOpen(claim, state),
      ])
      expect(first.authorized).toBe(true)
      expect(second).toEqual({
        authorized: false,
        error: 'holdout-claim-rejected',
      })
      expect(state.calls).toBe(2)
      expect(state.claims[0]).toEqual(expectedClaim)
      expect(state.claims[1]).toEqual(state.claims[0])
      if (!first.authorized) throw new Error('expected-test-authorization')
      expectValid(
        candidate,
        context(categoryPopulations(), first.authorization),
        frozenAcceptance,
      )
      expectInvalid(
        candidate,
        'holdout-authorization-consumed',
        context(categoryPopulations(), first.authorization),
        frozenAcceptance,
      )
    },
  )

  it('binds a frozen authorization to every report identity axis', async () => {
    const frozenAcceptance = futureFrozenAcceptance()
    const candidate = futureHoldoutReport()
    const state = new AtomicSingleUseState()
    const authorization = await frozenAcceptance.authorizeHoldoutBeforeInputOpen(
      contractIdentity(candidate),
      state,
    )
    if (!authorization.authorized)
      throw new Error('expected-test-authorization')
    for (const axis of versionAxes) {
      if (axis === 'protocolVersion') continue
      const mutation = clone(candidate)
      mutation.versions[axis] = '1.0.1'
      expectInvalid(
        mutation,
        'holdout-authorization-mismatch',
        context(categoryPopulations(), authorization.authorization),
        frozenAcceptance,
      )
    }
    for (const field of [
      'packageVersion',
      'gitCommit',
      'packedArtifactSha256',
    ]) {
      const mutation = clone(candidate)
      mutation.publicArtifact[field] =
        field === 'packageVersion'
          ? '0.0.1'
          : field === 'gitCommit'
            ? 'c'.repeat(40)
            : 'd'.repeat(64)
      expectInvalid(
        mutation,
        'holdout-authorization-mismatch',
        context(categoryPopulations(), authorization.authorization),
        frozenAcceptance,
      )
    }
  })
})
