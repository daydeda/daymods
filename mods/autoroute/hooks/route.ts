// Pure routing logic: no `$`, so it can be read and tested on its own.

export type Tier = 'trivial' | 'normal' | 'hard' | 'large' | 'top'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type Route = { tier: Tier; model: string; effort: Effort; reason: string; source: string }
export type Plan = { type: string | undefined; hasExtraUsage: boolean; isMax: boolean }

export const MODELS = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  fable: 'claude-fable-5-1',
} as const

export const TIER_ROUTE: Record<Exclude<Tier, 'top'>, { model: string; effort: Effort }> = {
  trivial: { model: MODELS.haiku, effort: 'low' },
  normal: { model: MODELS.sonnet, effort: 'medium' },
  hard: { model: MODELS.opus, effort: 'high' },
  large: { model: MODELS.opus, effort: 'high' },
}

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

const LARGE = /\b(architect(ure)?|re-?design|rewrite|migrat(e|ion)|from scratch|end[- ]to[- ]end|across (the )?(whole |entire )?(codebase|repo|project)|(entire|whole) (codebase|repo|app|project|system)|multi-?(service|module|package)|monorepo|build (an?|the) (new )?(app|system|platform|service|backend|frontend))\b/i
const HARD = /\b(debug|race condition|deadlock|leak|performance|optimi[sz]e|security|vulnerab\w*|concurren\w*|refactor\w*|investigate|root cause|flaky|intermittent|design|trade-?offs?|algorithm|plan|why (does|is|do|are))\b/i
const TRIVIAL = /\b(typo|rename|spelling|what is|what's|what does|explain|how do i|where is|list|show me|format|lint|commit|bump|quick|small|one-?liner)\b/i
const NORMAL = /\b(add|implement|fix|update|change|create|write|tests?|remove|delete|support|handle|wire|hook up)\b/i
const FOLLOW_UP = /^(go|yes|y|no|n|ok(ay)?|sure|continue|proceed|do it|next|keep going|lgtm|sounds good|approved?|thanks?|thank you)\b[\s.!]*$/i

export type Verdict = { tier: Exclude<Tier, 'top'> | 'keep' | 'unsure'; reason: string }

export function classifyByRules(text: string): Verdict {
  const t = text.trim()
  if (FOLLOW_UP.test(t)) return { tier: 'keep', reason: 'follow-up' }
  if (t.length > 2000) return { tier: 'large', reason: 'long brief' }
  const large = t.match(LARGE)
  if (large) return { tier: 'large', reason: `"${large[0]}"` }
  const hard = t.match(HARD)
  if (hard) return { tier: 'hard', reason: `"${hard[0]}"` }
  const trivial = t.match(TRIVIAL)
  if (trivial && t.length < 200) return { tier: 'trivial', reason: `"${trivial[0]}"` }
  const normal = t.match(NORMAL)
  if (normal && t.length < 800) return { tier: 'normal', reason: `"${normal[0]}"` }
  return { tier: 'unsure', reason: 'no rule matched' }
}

export const CLASSIFIER_SYSTEM = `You route coding-assistant requests to a model tier. Reply with exactly one word:
trivial - a question, explanation, typo, rename or tiny edit
normal - a feature or bug fix touching about 1-3 files
hard - tricky debugging, design decisions, or changes across many files
large - architectural or multi-part work that needs planning before implementation`

export function parseTier(reply: string): Exclude<Tier, 'top'> | undefined {
  const word = reply.trim().toLowerCase().match(/trivial|normal|hard|large/)
  return word ? (word[0] as Exclude<Tier, 'top'>) : undefined
}

export type Override = { route: Omit<Route, 'reason' | 'source'> | 'auto'; text: string }

// `!haiku fix this` forces a route for that one prompt; `!auto` routes as usual.
export function parseOverride(text: string): Override | undefined {
  const m = text.match(/^!(haiku|sonnet|opus|fable|max|auto)\b\s*/i)
  if (!m) return undefined
  const rest = text.slice(m[0].length)
  switch ((m[1] ?? '').toLowerCase()) {
    case 'haiku': return { route: { tier: 'trivial', model: MODELS.haiku, effort: 'low' }, text: rest }
    case 'sonnet': return { route: { tier: 'normal', model: MODELS.sonnet, effort: 'medium' }, text: rest }
    case 'opus': return { route: { tier: 'hard', model: MODELS.opus, effort: 'high' }, text: rest }
    case 'fable': return { route: { tier: 'top', model: MODELS.fable, effort: 'high' }, text: rest }
    case 'max': return { route: { tier: 'top', model: MODELS.fable, effort: 'max' }, text: rest }
    default: return { route: 'auto', text: rest }
  }
}

export const isFable = (model: string | undefined) => model !== undefined && /fable/i.test(model)
const isAboveSonnet = (model: string | undefined) => model !== undefined && /opus|fable/i.test(model)

export function parsePlan(json: string): Plan {
  const account = (JSON.parse(json) as { oauthAccount?: Record<string, unknown> }).oauthAccount ?? {}
  const type = typeof account.organizationType === 'string' ? account.organizationType : undefined
  return { type, hasExtraUsage: account.hasExtraUsageEnabled === true, isMax: type === 'claude_max' }
}

// Fails closed: an unknown plan is treated as not Max.
export const UNKNOWN_PLAN: Plan = { type: undefined, hasExtraUsage: false, isMax: false }

export type Gated = { model: string; effort?: Effort | number; notes: string[] }

// The two money rules, applied to every request whatever chose its model.
export function gate(model: string, effort: Effort | number | undefined, plan: Plan, isSpendCapped: boolean): Gated {
  const notes: string[] = []
  let m = model
  let eff = effort
  if (isFable(m) && !plan.isMax) {
    m = MODELS.opus
    notes.push(`Fable is Max-only (${plan.type ?? 'plan unknown'}) → Opus`)
  }
  if (isSpendCapped && isAboveSonnet(m)) {
    m = MODELS.sonnet
    if (typeof eff === 'string' && EFFORTS.indexOf(eff) > EFFORTS.indexOf('high')) eff = 'high'
    notes.push('spend guard → Sonnet')
  }
  return { model: m, effort: eff, notes }
}

// The same rules for a subagent's `model` parameter, which takes aliases.
export function gateAlias(model: string | undefined, parentModel: string, plan: Plan, isSpendCapped: boolean) {
  const effective = model === undefined || model === 'inherit' ? parentModel : model
  if (isFable(effective) && !plan.isMax) return isSpendCapped ? 'sonnet' : 'opus'
  if (isSpendCapped && isAboveSonnet(effective)) return 'sonnet'
  return model
}

export const shortName = (model: string) =>
  (model.match(/haiku|sonnet|opus|fable/i)?.[0] ?? model).replace(/^./, c => c.toUpperCase())

export const DELEGATE_CONTEXT = `[autoroute] This task was classified LARGE. Work it as a pipeline, skipping any step that does not pay for itself:
1. Map the relevant code with Explore subagents (they run on Haiku) instead of reading broadly yourself.
2. Write a concrete implementation plan to a file (or spawn a Plan subagent, which runs on Opus).
3. Spawn a general-purpose subagent with model "sonnet", pointed at that plan file, to implement; keep delicate parts for yourself.
4. Review the result against the plan before reporting.`

export const DIRECT_CONTEXT = (tier: Tier) =>
  `[autoroute] This task was classified ${tier.toUpperCase()}: handle it directly, without spawning subagents unless the user asks.`
