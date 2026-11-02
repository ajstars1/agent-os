// Display metadata per venture. Colors are the validated categorical slots (dark steps) in fixed order,
// so a venture keeps its color on every page; it is always shown next to its name, never alone.

export interface VentureMeta {
  key: string
  name: string
  blurb: string
  color: string
}

const KNOWN: VentureMeta[] = [
  { key: '0unveiled', name: '0unveiled', blurb: 'Hiring shortlists for startups', color: '#3987e5' },
  { key: 'dawnwell', name: 'Dawnwell', blurb: 'VitalPaw, vet hospital network', color: '#d95926' },
  { key: 'gkt', name: 'Garh Ka Tailor', blurb: 'Tailoring shop, Meta ads push', color: '#199e70' },
  { key: 'aos', name: 'aos build', blurb: 'Building this agent system', color: '#c98500' },
  { key: 'linkedin', name: 'LinkedIn', blurb: 'Personal brand and posts', color: '#d55181' },
  { key: 'consultancy', name: 'Consultancy', blurb: 'Client work', color: '#008300' },
  { key: 'general', name: 'General', blurb: 'Everything else', color: '#9085e9' },
]

const FALLBACK = '#7b8494'

export const VENTURE_ORDER = KNOWN.map((v) => v.key)

export const ventureMeta = (key: string): VentureMeta =>
  KNOWN.find((v) => v.key === key) ?? { key, name: key, blurb: '', color: FALLBACK }

export const isVentureKey = (key: string): boolean => /^[a-z0-9_-]{1,40}$/i.test(key)
