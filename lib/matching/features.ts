import { AMENITY_KEYS, type AmenityKey, type EntryDate, type ProtectedSpaceType, type TriState } from '../listings'
import { FEATURE_RULES, IMMEDIATE_ENTRY, PROTECTED_SPACE_RULES, normalizeText, stripMatches } from './feature-dictionary'

/**
 * Source-agnostic evidence. Each source adapter (Yad2, Madlan, Facebook) maps its raw data into this shape;
 * the derivation and matching rules below never look at the source.
 */
export type FeatureEvidence = {
  /** Structured flags from the source. true = YES, null/undefined = not stated; false depends on `flagSemantics`. */
  flags: Partial<Record<AmenityKey, boolean | null | undefined>>
  /**
   * How a structured `false` should be read.
   * - 'explicit' (default): false is a deliberate NO (e.g. manual import).
   * - 'positive-only': false only means "not ticked" and is UNKNOWN (Yad2 checkboxes). NO then requires text evidence.
   */
  flagSemantics?: 'explicit' | 'positive-only'
  /** What a structured `mamad` flag physically represents for this source (Yad2 "safe_room" is a ממ"ד). */
  protectedSpaceFlagType?: ProtectedSpaceType
  /** Free text (title, description, …). Negations found here override structured flags. */
  texts: (string | null | undefined)[]
  availableFrom?: string | null
}

export type DerivedFeatures = {
  features: Record<AmenityKey, TriState>
  protectedSpaceType: ProtectedSpaceType | null
  entryDate: EntryDate
}

function fromFlag(value: boolean | null | undefined, semantics: FeatureEvidence['flagSemantics']): TriState {
  if (value === true) return 'yes'
  if (value === false && semantics !== 'positive-only') return 'no'
  return 'unknown'
}

/** Explicit negatives always win, then any positive evidence, otherwise unknown. */
export function combineStates(...states: TriState[]): TriState {
  if (states.includes('no')) return 'no'
  if (states.includes('yes')) return 'yes'
  return 'unknown'
}

function textState(key: Exclude<AmenityKey, 'mamad'>, text: string): TriState {
  if (!text) return 'unknown'
  const rule = FEATURE_RULES[key]
  if (rule.negative.test(text)) return 'no'
  const cleaned = rule.neutral ? stripMatches(text, rule.neutral) : text
  return rule.positive.test(cleaned) ? 'yes' : 'unknown'
}

function protectedSpaceFromText(text: string) {
  if (!text) return { state: 'unknown' as TriState, type: null, negatedTypes: [] as ProtectedSpaceType[] }
  // "אין ממ"ד, יש מקלט" → the mamad is negated but the miklat still counts.
  let remaining = text
  const negatedTypes: ProtectedSpaceType[] = []
  for (const rule of PROTECTED_SPACE_RULES) {
    if (rule.negative.test(remaining)) {
      negatedTypes.push(rule.type)
      remaining = stripMatches(remaining, rule.negative)
    }
  }
  const found = PROTECTED_SPACE_RULES.find((rule) => rule.positive.test(remaining))
  if (found) return { state: 'yes' as TriState, type: found.type, negatedTypes }
  return { state: (negatedTypes.length ? 'no' : 'unknown') as TriState, type: null, negatedTypes }
}

function deriveEntryDate(availableFrom: string | null | undefined, text: string): EntryDate {
  const raw = availableFrom?.trim()
  if (raw) {
    if (IMMEDIATE_ENTRY.test(raw)) return { kind: 'immediate' }
    if (Number.isFinite(new Date(raw).getTime())) return { kind: 'date', value: raw }
  }
  if (text && IMMEDIATE_ENTRY.test(text)) return { kind: 'immediate' }
  return null
}

export function deriveFeatures(evidence: FeatureEvidence): DerivedFeatures {
  const text = normalizeText(...evidence.texts)
  const features = {} as Record<AmenityKey, TriState>

  for (const key of AMENITY_KEYS) {
    if (key === 'mamad') continue
    features[key] = combineStates(fromFlag(evidence.flags[key], evidence.flagSemantics), textState(key, text))
  }
  // A terrace is a balcony for search purposes; it never overrides an explicit "no balcony".
  if (features.balcony === 'unknown' && features.terrace === 'yes') features.balcony = 'yes'

  const flagType = evidence.protectedSpaceFlagType ?? 'mamad'
  const flag = evidence.flags.mamad
  const fromText = protectedSpaceFromText(text)
  let protectedSpaceType: ProtectedSpaceType | null = null

  if (fromText.state === 'yes') {
    features.mamad = 'yes'
    protectedSpaceType = flag === true && !fromText.negatedTypes.includes(flagType) ? flagType : fromText.type
  } else if (fromText.state === 'no') {
    features.mamad = 'no'
  } else {
    features.mamad = fromFlag(flag, evidence.flagSemantics)
    if (flag === true) protectedSpaceType = flagType
  }

  return { features, protectedSpaceType, entryDate: deriveEntryDate(evidence.availableFrom, text) }
}
