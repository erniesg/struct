import { readFile } from 'node:fs/promises'
import Ajv2020 from 'ajv/dist/2020.js'
import type { ValidateFunction } from 'ajv'

const draft202012 = 'https://json-schema.org/draft/2020-12/schema'

type JsonObject = Record<string, unknown>

type Gate =
  | { operator: 'equal' | 'at-least'; value: number }
  | { operator: 'report-only' }

type OverallFormula = {
  numeratorCounter: string
  denominatorCounter: string
  gate: Gate
}

type Protocol = {
  protocolVersion: string
  protocolState: 'development-open' | 'frozen'
  aggregateReportSchemaVersion: string
  categories: string[]
  outcomes: string[]
  versionAxes: string[]
  reporting: {
    minimumPopulation: number
    maximumCount: number
    rateDecimalPlaces: number
    rateRounding: 'half-up'
  }
  execution: {
    development: {
      allowedProtocolStates: Array<'development-open' | 'frozen'>
    }
    holdout: {
      requiredProtocolState: 'frozen'
      maximumQualifyingTransactions: number
    }
  }
  metrics: {
    overall: Record<string, OverallFormula>
    categoryReady: {
      gate: Gate
    }
    zeroTolerance: {
      safetyCounters: string[]
      conformanceCounters: string[]
      reproducibilityCounters: string[]
      gate: Gate
    }
  }
}

type CategoryCell =
  | { status: 'suppressed' }
  | {
      status: 'reported'
      numerator: number
      denominator: number
      rate: number
    }

type VersionValues = Record<string, string>

type PublicArtifact = {
  packageName: string
  packageVersion: string
  gitCommit: string
  packedArtifactSha256: string
}

type AggregateReport = {
  schemaVersion: string
  versions: VersionValues
  publicArtifact: PublicArtifact
  evaluation: { gate: 'development' | 'holdout' }
  outcomes: Record<string, number>
  counts: Record<string, number>
  rates: Record<string, number>
  zeroTolerance: Record<string, number>
  categories: Record<string, CategoryCell>
}

export type AcceptanceError =
  | 'schema-invalid'
  | 'report-version-mismatch'
  | 'trusted-category-populations-invalid'
  | 'counter-range-invalid'
  | 'rate-not-derived'
  | 'overall-gate-failed'
  | 'category-population-mismatch'
  | 'suppression-required'
  | 'suppression-ineligible'
  | 'category-gate-failed'
  | 'zero-tolerance-gate-failed'
  | 'outcome-conservation-failed'
  | 'evaluation-state-ineligible'
  | 'holdout-authorization-required'
  | 'holdout-authorization-mismatch'
  | 'holdout-authorization-consumed'

export type AcceptanceResult =
  | { accepted: true; errors: readonly [] }
  | { accepted: false; errors: readonly AcceptanceError[] }

export type AggregateContractIdentity = Readonly<{
  schemaVersion: string
  versions: Readonly<VersionValues>
  publicArtifact: Readonly<PublicArtifact>
}>

export type TrustedHoldoutClaim = Readonly<{
  exactFrozenProtocolArtifact: Readonly<JsonObject>
  protocolState: 'frozen'
  maximumQualifyingTransactions: number
  schemaVersion: string
  versions: Readonly<VersionValues>
  publicArtifact: Readonly<PublicArtifact>
}>

/**
 * Owner-private implementations must perform this operation atomically before
 * any holdout input is opened. The implementation and its durable state live
 * outside Struct; this boundary carries only source-neutral contract axes.
 */
export interface TrustedHoldoutState {
  consultAndConsume(claim: TrustedHoldoutClaim): Promise<boolean>
}

declare const holdoutAuthorizationBrand: unique symbol

export interface TrustedHoldoutAuthorization {
  readonly [holdoutAuthorizationBrand]: true
}

export type HoldoutAuthorizationResult =
  | {
      authorized: true
      authorization: TrustedHoldoutAuthorization
    }
  | {
      authorized: false
      error:
        | 'holdout-protocol-ineligible'
        | 'holdout-contract-mismatch'
        | 'holdout-claim-rejected'
    }

export type AggregateAcceptanceContext = Readonly<{
  categoryPopulations: Readonly<Record<string, number>>
  holdoutAuthorization?: TrustedHoldoutAuthorization
}>

export interface AggregateAcceptance {
  readonly protocol: JsonObject
  readonly reportSchema: JsonObject
  acceptForPublicEmission(
    report: unknown,
    context: AggregateAcceptanceContext,
  ): AcceptanceResult
  authorizeHoldoutBeforeInputOpen(
    contract: AggregateContractIdentity,
    trustedState: TrustedHoldoutState,
  ): Promise<HoldoutAuthorizationResult>
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deepFreezeJson<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const child of value) deepFreezeJson(child)
    Object.freeze(value)
  } else if (isJsonObject(value)) {
    for (const child of Object.values(value)) deepFreezeJson(child)
    Object.freeze(value)
  }
  return value
}

function requireProtocol(value: unknown): Protocol {
  if (!isJsonObject(value)) throw new Error('invalid-protocol')
  const candidate = value as unknown as Protocol
  if (
    typeof candidate.protocolVersion !== 'string' ||
    !['development-open', 'frozen'].includes(candidate.protocolState) ||
    typeof candidate.aggregateReportSchemaVersion !== 'string' ||
    !Array.isArray(candidate.categories) ||
    !Array.isArray(candidate.outcomes) ||
    !Array.isArray(candidate.versionAxes) ||
    !isJsonObject(candidate.reporting) ||
    !isJsonObject(candidate.execution) ||
    !isJsonObject(candidate.metrics)
  )
    throw new Error('invalid-protocol')

  if (
    candidate.categories.length === 0 ||
    candidate.outcomes.length === 0 ||
    candidate.versionAxes.length === 0 ||
    new Set(candidate.categories).size !== candidate.categories.length ||
    new Set(candidate.outcomes).size !== candidate.outcomes.length ||
    new Set(candidate.versionAxes).size !== candidate.versionAxes.length ||
    !candidate.categories.every((entry) => typeof entry === 'string') ||
    !candidate.outcomes.every((entry) => typeof entry === 'string') ||
    !candidate.versionAxes.every((entry) => typeof entry === 'string') ||
    !Number.isInteger(candidate.reporting.minimumPopulation) ||
    candidate.reporting.minimumPopulation < 1 ||
    !Number.isInteger(candidate.reporting.maximumCount) ||
    candidate.reporting.maximumCount < candidate.reporting.minimumPopulation ||
    !Number.isInteger(candidate.reporting.rateDecimalPlaces) ||
    candidate.reporting.rateDecimalPlaces < 0 ||
    candidate.reporting.rateDecimalPlaces > 9 ||
    candidate.reporting.rateRounding !== 'half-up'
  )
    throw new Error('invalid-protocol')

  const gates = [
    ...Object.values(candidate.metrics.overall).map((formula) => formula.gate),
    candidate.metrics.categoryReady.gate,
    candidate.metrics.zeroTolerance.gate,
  ]
  if (!gates.every(isSupportedGate)) throw new Error('invalid-protocol')

  const zeroToleranceCounters = [
    ...candidate.metrics.zeroTolerance.safetyCounters,
    ...candidate.metrics.zeroTolerance.conformanceCounters,
    ...candidate.metrics.zeroTolerance.reproducibilityCounters,
  ]
  if (
    zeroToleranceCounters.length === 0 ||
    new Set(zeroToleranceCounters).size !== zeroToleranceCounters.length
  )
    throw new Error('invalid-protocol')

  return candidate
}

function isSupportedGate(gate: unknown): gate is Gate {
  if (!isJsonObject(gate) || typeof gate.operator !== 'string') return false
  if (gate.operator === 'report-only')
    return Object.keys(gate).length === 1
  return (
    (gate.operator === 'equal' || gate.operator === 'at-least') &&
    typeof gate.value === 'number' &&
    Number.isFinite(gate.value) &&
    gate.value >= 0 &&
    gate.value <= 1
  )
}

function requireSchema(value: unknown): JsonObject {
  if (!isJsonObject(value) || value.$schema !== draft202012)
    throw new Error('invalid-report-schema')
  return value
}

function roundedRate(
  numerator: number,
  denominator: number,
  decimalPlaces: number,
): number {
  const scale = 10 ** decimalPlaces
  return (
    Math.floor((2 * numerator * scale + denominator) / (2 * denominator)) /
    scale
  )
}

function gateSatisfied(
  gate: Gate,
  numerator: number,
  denominator: number,
): boolean {
  if (gate.operator === 'report-only') return true
  const exactRate = numerator / denominator
  if (gate.operator === 'equal') return exactRate === gate.value
  return exactRate >= gate.value
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: string[],
): boolean {
  const actualKeys = Object.keys(value)
  return (
    actualKeys.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  )
}

function contractMatchesProtocol(
  protocol: Protocol,
  contract: AggregateContractIdentity,
): boolean {
  return (
    contract.schemaVersion === protocol.aggregateReportSchemaVersion &&
    contract.versions.protocolVersion === protocol.protocolVersion &&
    exactKeys(contract.versions, protocol.versionAxes)
  )
}

function claimMatchesReport(
  protocol: Protocol,
  claim: TrustedHoldoutClaim,
  report: AggregateReport,
): boolean {
  if (
    claim.schemaVersion !== report.schemaVersion ||
    !exactKeys(claim.versions, protocol.versionAxes)
  )
    return false
  for (const axis of protocol.versionAxes)
    if (claim.versions[axis] !== report.versions[axis]) return false

  return (
    claim.publicArtifact.packageName === report.publicArtifact.packageName &&
    claim.publicArtifact.packageVersion ===
      report.publicArtifact.packageVersion &&
    claim.publicArtifact.gitCommit === report.publicArtifact.gitCommit &&
    claim.publicArtifact.packedArtifactSha256 ===
      report.publicArtifact.packedArtifactSha256
  )
}

export function createAggregateAcceptance(
  protocolValue: unknown,
  schemaValue: unknown,
): AggregateAcceptance {
  const protocolArtifact = deepFreezeJson(structuredClone(protocolValue))
  const schemaArtifact = deepFreezeJson(structuredClone(schemaValue))
  const protocol = requireProtocol(protocolArtifact)
  const reportSchema = requireSchema(schemaArtifact)
  const ajv = new Ajv2020({
    allErrors: true,
    coerceTypes: false,
    multipleOfPrecision: 9,
    removeAdditional: false,
    strict: true,
  })
  const validateReport: ValidateFunction<AggregateReport> =
    ajv.compile<AggregateReport>(reportSchema)
  const authorizations = new WeakMap<object, TrustedHoldoutClaim>()
  const consumedAuthorizations = new WeakSet<object>()

  function acceptForPublicEmission(
    reportValue: unknown,
    context: AggregateAcceptanceContext,
  ): AcceptanceResult {
    if (!validateReport(reportValue))
      return { accepted: false, errors: ['schema-invalid'] }
    const report = reportValue
    const errors = new Set<AcceptanceError>()

    if (
      report.schemaVersion !== protocol.aggregateReportSchemaVersion ||
      report.versions.protocolVersion !== protocol.protocolVersion
    )
      errors.add('report-version-mismatch')

    const populations = context?.categoryPopulations
    const validPopulations =
      isJsonObject(populations) &&
      exactKeys(populations, protocol.categories) &&
      protocol.categories.every((category) => {
        const population = populations[category]
        return (
          typeof population === 'number' &&
          Number.isInteger(population) &&
          population >= 0 &&
          population <= protocol.reporting.maximumCount
        )
      })
    if (!validPopulations) errors.add('trusted-category-populations-invalid')

    if (report.evaluation.gate === 'development') {
      if (
        !protocol.execution.development.allowedProtocolStates.includes(
          protocol.protocolState,
        )
      )
        errors.add('evaluation-state-ineligible')
    } else if (
      protocol.protocolState !==
      protocol.execution.holdout.requiredProtocolState
    ) {
      errors.add('evaluation-state-ineligible')
    } else {
      const authorization = context?.holdoutAuthorization
      if (typeof authorization !== 'object' || authorization === null) {
        errors.add('holdout-authorization-required')
      } else {
        const claim = authorizations.get(authorization)
        if (!claim || !claimMatchesReport(protocol, claim, report)) {
          errors.add('holdout-authorization-mismatch')
        } else if (consumedAuthorizations.has(authorization)) {
          errors.add('holdout-authorization-consumed')
        } else {
          consumedAuthorizations.add(authorization)
        }
      }
    }

    for (const [rateName, formula] of Object.entries(
      protocol.metrics.overall,
    )) {
      const numerator = report.counts[formula.numeratorCounter]
      const denominator = report.counts[formula.denominatorCounter]
      if (
        !Number.isInteger(numerator) ||
        !Number.isInteger(denominator) ||
        numerator < 0 ||
        denominator <= 0 ||
        numerator > denominator
      ) {
        errors.add('counter-range-invalid')
        continue
      }
      const derived = roundedRate(
        numerator,
        denominator,
        protocol.reporting.rateDecimalPlaces,
      )
      if (
        Object.is(report.rates[rateName], -0) ||
        report.rates[rateName] !== derived
      )
        errors.add('rate-not-derived')
      if (!gateSatisfied(formula.gate, numerator, denominator))
        errors.add('overall-gate-failed')
    }

    if (validPopulations) {
      for (const category of protocol.categories) {
        const population = populations[category]
        const cell = report.categories[category]
        if (cell.status === 'suppressed') {
          if (population >= protocol.reporting.minimumPopulation)
            errors.add('suppression-ineligible')
          continue
        }
        if (population < protocol.reporting.minimumPopulation)
          errors.add('suppression-required')
        if (cell.denominator !== population)
          errors.add('category-population-mismatch')
        if (
          !Number.isInteger(cell.numerator) ||
          !Number.isInteger(cell.denominator) ||
          cell.numerator < 0 ||
          cell.denominator <= 0 ||
          cell.numerator > cell.denominator
        ) {
          errors.add('counter-range-invalid')
          continue
        }
        const derived = roundedRate(
          cell.numerator,
          cell.denominator,
          protocol.reporting.rateDecimalPlaces,
        )
        if (Object.is(cell.rate, -0) || cell.rate !== derived)
          errors.add('rate-not-derived')
        if (
          !gateSatisfied(
            protocol.metrics.categoryReady.gate,
            cell.numerator,
            cell.denominator,
          )
        )
          errors.add('category-gate-failed')
      }
    }

    const zeroToleranceCounters = [
      ...protocol.metrics.zeroTolerance.safetyCounters,
      ...protocol.metrics.zeroTolerance.conformanceCounters,
      ...protocol.metrics.zeroTolerance.reproducibilityCounters,
    ]
    const zeroToleranceGate = protocol.metrics.zeroTolerance.gate
    for (const counter of zeroToleranceCounters) {
      const value = report.zeroTolerance[counter]
      if (
        zeroToleranceGate.operator === 'report-only' ||
        (zeroToleranceGate.operator === 'equal' &&
          value !== zeroToleranceGate.value) ||
        (zeroToleranceGate.operator === 'at-least' &&
          value < zeroToleranceGate.value)
      )
        errors.add('zero-tolerance-gate-failed')
    }

    const completedFromOutcomes = protocol.outcomes.reduce(
      (sum, outcome) => sum + report.outcomes[outcome],
      0,
    )
    if (
      completedFromOutcomes !== report.counts.completed ||
      report.outcomes['rendered-ready'] +
        report.outcomes['source-preserved-ready'] !==
        report.counts.publicationReady
    )
      errors.add('outcome-conservation-failed')

    return errors.size === 0
      ? { accepted: true, errors: [] }
      : { accepted: false, errors: [...errors] }
  }

  async function authorizeHoldoutBeforeInputOpen(
    contract: AggregateContractIdentity,
    trustedState: TrustedHoldoutState,
  ): Promise<HoldoutAuthorizationResult> {
    if (
      protocol.protocolState !==
        protocol.execution.holdout.requiredProtocolState ||
      protocol.execution.holdout.maximumQualifyingTransactions !== 1
    )
      return { authorized: false, error: 'holdout-protocol-ineligible' }
    if (!contractMatchesProtocol(protocol, contract))
      return { authorized: false, error: 'holdout-contract-mismatch' }

    const claim: TrustedHoldoutClaim = Object.freeze({
      exactFrozenProtocolArtifact: protocolArtifact as JsonObject,
      protocolState: protocol.protocolState,
      maximumQualifyingTransactions:
        protocol.execution.holdout.maximumQualifyingTransactions,
      schemaVersion: contract.schemaVersion,
      versions: Object.freeze({ ...contract.versions }),
      publicArtifact: Object.freeze({ ...contract.publicArtifact }),
    })
    let consumed = false
    try {
      consumed = await trustedState.consultAndConsume(claim)
    } catch {
      consumed = false
    }
    if (!consumed)
      return { authorized: false, error: 'holdout-claim-rejected' }

    const authorization = Object.freeze({}) as TrustedHoldoutAuthorization
    authorizations.set(authorization, claim)
    return { authorized: true, authorization }
  }

  return {
    protocol: protocolArtifact as JsonObject,
    reportSchema,
    acceptForPublicEmission,
    authorizeHoldoutBeforeInputOpen,
  }
}

export async function loadAggregateAcceptance(): Promise<AggregateAcceptance> {
  const evaluationDirectory = new URL(
    '../../evaluation/layout-epub-v1/',
    import.meta.url,
  )
  const [protocolSource, schemaSource] = await Promise.all([
    readFile(new URL('protocol.json', evaluationDirectory), 'utf8'),
    readFile(
      new URL('aggregate-report.schema.json', evaluationDirectory),
      'utf8',
    ),
  ])
  return createAggregateAcceptance(
    JSON.parse(protocolSource) as unknown,
    JSON.parse(schemaSource) as unknown,
  )
}
