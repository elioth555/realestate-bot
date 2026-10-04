import type { AmenityKey, ProtectedSpaceType } from '../listings'

const HE = 'א-ת'
// Gershayim / geresh variants: ממ"ד, ממ״ד, ממ''ד, ממד
const GERSH = `(?:''|["'״׳])?`
// Hebrew attaches single-letter prefixes (ו, ב, ה, ל, מ, ש, כ) directly to words.
const HE_PREFIX = '[ובהלמשכ]?'
const HE_NEG = '(?:אין|ללא|בלי|לא כולל|אין בה|אין בדירה)\\s+'
const EN_NEG = '(?:no|without|w\\/o|not including)\\s+(?:an?\\s+|any\\s+)?'

// Hebrew has no \b support in JS regex, so word edges are asserted with Hebrew-letter lookarounds.
const he = (words: string) => `(?<![${HE}])${HE_PREFIX}(?:${words})(?![${HE}])`
const en = (words: string) => `\\b(?:${words})\\b`
const pattern = (...parts: string[]) => new RegExp(parts.join('|'), 'i')

function negationOf(heWords: string, enWords: string, ...extra: string[]) {
  return pattern(
    `(?<![${HE}])${HE_NEG}${HE_PREFIX}(?:${heWords})(?![${HE}])`,
    `\\b${EN_NEG}(?:${enWords})\\b`,
    `\\b(?:${enWords})\\s*[:\\-]\\s*(?:no|none)\\b`,
    ...extra,
  )
}

export type FeatureRule = {
  positive: RegExp
  negative: RegExp
  /** Phrases that mention the feature but are not evidence of it (e.g. street parking). Stripped before matching. */
  neutral?: RegExp
}

const ELEVATOR = { he: 'מעלית|מעליות', en: 'elevators?|lifts?' }
const PARKING = { he: 'חני(?:י)?ה|חניות|חני(?:י)?ת', en: 'parking(?: spot| space)?|garage' }
const BALCONY = { he: 'מרפסת|מרפסות', en: 'balcon(?:y|ies)|terraces?' }
const TERRACE = { he: 'מרפסת גג|גג פרטי|גג צמוד', en: 'roof terrace|rooftop|terraces?' }
const GARDEN = { he: 'גינה|גינת|גינה פרטית', en: 'gardens?|private garden' }
const POOL = { he: 'בריכה|בריכת שחייה|בריכת', en: '(?:swimming )?pool' }
const GYM = { he: 'חדר כושר', en: 'gym|fitness (?:room|center|centre)' }
const SEA_VIEW = { he: 'נוף לים|נוף ים|נוף פתוח לים', en: 'sea[- ]view|ocean view' }

export const FEATURE_RULES: Record<Exclude<AmenityKey, 'mamad'>, FeatureRule> = {
  elevator: {
    positive: pattern(he(ELEVATOR.he), en(ELEVATOR.en)),
    negative: negationOf(ELEVATOR.he, ELEVATOR.en),
  },
  parking: {
    positive: pattern(he(PARKING.he), en(PARKING.en)),
    negative: negationOf(PARKING.he, PARKING.en),
    neutral: pattern(
      he('חני(?:י)?ה (?:ברחוב|ציבורית|בשפע באזור|באזור)'),
      en('street parking|public parking|parking (?:on the street|nearby)'),
    ),
  },
  balcony: {
    positive: pattern(he(BALCONY.he), en(BALCONY.en)),
    negative: negationOf(BALCONY.he, BALCONY.en),
  },
  terrace: {
    positive: pattern(he(TERRACE.he), en(TERRACE.en)),
    negative: negationOf(TERRACE.he, TERRACE.en),
  },
  furnished: {
    positive: pattern(
      he('מרוהטת|מרוהט|מרוהטים|ריהוט מלא|כולל ריהוט|עם ריהוט'),
      en('fully furnished|furnished'),
    ),
    negative: pattern(
      he('לא מרוהטת|לא מרוהט|לא מרוהטים|ללא ריהוט|בלי ריהוט|ריקה מריהוט'),
      en('unfurnished|not furnished|no furniture'),
    ),
    neutral: pattern(
      he('מרוהטת חלקית|מרוהט חלקית|ריהוט חלקי'),
      en('partially furnished|semi[- ]furnished|part[- ]furnished'),
    ),
  },
  garden: {
    positive: pattern(he(GARDEN.he), en(GARDEN.en)),
    negative: negationOf(GARDEN.he, GARDEN.en),
    neutral: pattern(he('גינה ציבורית|גן ציבורי'), en('public (?:garden|park)')),
  },
  pool: {
    positive: pattern(he(POOL.he), en(POOL.en)),
    negative: negationOf(POOL.he, POOL.en),
  },
  gym: {
    positive: pattern(he(GYM.he), en(GYM.en)),
    negative: negationOf(GYM.he, GYM.en),
  },
  seaView: {
    positive: pattern(he(SEA_VIEW.he), en(SEA_VIEW.en)),
    negative: negationOf(SEA_VIEW.he, SEA_VIEW.en),
  },
  petFriendly: {
    positive: pattern(
      he(
        'בעלי חיים מותרים|מותר(?:ים)? (?:עם )?בעלי חיים|מתאימ(?:ה)? לבעלי חיים|מתאים לבעלי חיים|ידידותי(?:ת)? לבעלי חיים|אפשר (?:עם )?בעלי חיים|חיות מחמד מותרות',
      ),
      en('pets? allowed|pets? (?:are )?welcome|pet[- ]friendly|pets? ok'),
    ),
    negative: pattern(
      he(
        'ללא בעלי חיים|בלי בעלי חיים|אין בעלי חיים|בעלי חיים אסורים|אסור(?:ים)? בעלי חיים|לא מתאים(?:ה)? לבעלי חיים|ללא חיות(?: מחמד)?|בלי חיות(?: מחמד)?',
      ),
      en('no pets?(?: allowed)?|no animals|pets? (?:are )?not allowed|pets? forbidden|not pet[- ]friendly'),
    ),
  },
}

/** Checked in order: more specific types first so "מרחב מוגן קומתי" is a mamak, not a generic protected space. */
export const PROTECTED_SPACE_RULES: { type: ProtectedSpaceType; positive: RegExp; negative: RegExp }[] = [
  {
    type: 'mamad',
    positive: pattern(he(`ממ${GERSH}ד|חדר מוגן|חדר ביטחון|חדר בטחון`), en('mamad|safe[- ]room|protected room')),
    negative: negationOf(`ממ${GERSH}ד|חדר מוגן|חדר ביטחון`, 'mamad|safe[- ]room|protected room'),
  },
  {
    type: 'mamak',
    positive: pattern(he(`ממ${GERSH}ק|מרחב מוגן קומתי`), en('mamak|protected floor(?: space)?|floor shelter')),
    negative: negationOf(`ממ${GERSH}ק|מרחב מוגן קומתי`, 'mamak|protected floor(?: space)?'),
  },
  {
    type: 'miklat',
    positive: pattern(he('מקלט'), en('miklat|(?:bomb )?shelter')),
    negative: negationOf('מקלט', 'miklat|(?:bomb )?shelter'),
  },
  {
    type: 'other',
    positive: pattern(he('מרחב מוגן'), en('protected (?:space|area)')),
    negative: negationOf('מרחב מוגן', 'protected (?:space|area)'),
  },
]

export const IMMEDIATE_ENTRY = pattern(
  he('כניסה מיידית|כניסה מידית|כניסה מיד|מיידית|מיידי'),
  en('immediate(?:ly)?|available now|move[- ]in now|ready to move in'),
)

export function normalizeText(...texts: (string | null | undefined)[]) {
  return texts
    .filter((t): t is string => typeof t === 'string' && t.trim() !== '')
    .join(' \n ')
    .replace(/[\u201C\u201D\u05F4]/g, '"')
    .replace(/[\u2018\u2019\u05F3]/g, "'")
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

export function stripMatches(text: string, regex: RegExp) {
  return text.replace(new RegExp(regex.source, 'gi'), ' ')
}
