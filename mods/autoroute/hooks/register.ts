import type { EngineInterface, Register } from 'claude-code'

import {
  CLASSIFIER_SYSTEM, DELEGATE_CONTEXT, DIRECT_CONTEXT, MODELS, TIER_ROUTE, UNKNOWN_PLAN,
  classifyByRules, gate, gateAlias, isFable, parseOverride, parsePlan, parseTier, shortName,
} from './route'
import type { Effort, Plan, Route } from './route'

const ENABLED_KEY = 'enabled'

let useHaiku = true
let guardPercent = 90
let ownLine = false

let plan: Plan = UNKNOWN_PLAN
let isEnabled = true
let route: Route | undefined
let guardNote: string | undefined
const agentEffort = new Map<string, Effort>()

async function readPlan($: EngineInterface): Promise<Plan> {
  try {
    const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? (await $.env.get('HOME'))
    const text = await $.fs.read(`${dir}/.claude.json`)
    return typeof text === 'string' ? parsePlan(text) : UNKNOWN_PLAN
  } catch {
    return UNKNOWN_PLAN
  }
}

// With extra usage on, a window near its limit means further work may be billed.
async function isSpendCapped($: EngineInterface): Promise<boolean> {
  if (!plan.hasExtraUsage) return false
  try {
    const { rateLimits } = await $.session.usage()
    const hot = rateLimits.find(w => w.percentUsed >= guardPercent)
    guardNote = hot ? `${hot.kind} at ${hot.percentUsed}% with extra usage on` : undefined
    return hot !== undefined
  } catch {
    return false
  }
}

// The statusline reads this file to show the route inline: one `key=value` per line.
async function statePath($: EngineInterface): Promise<string> {
  const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${await $.env.get('HOME')}/.claude`
  return `${dir}/autoroute.state`
}

let writing: Promise<void> = Promise.resolve()

async function writeState($: EngineInterface, notes: readonly string[]) {
  const clean = (v: string) => v.replace(/[\r\n]+/g, ' ')
  const lines = route && isEnabled
    ? [`model=${shortName(route.model)}`, `effort=${route.effort}`, `tier=${route.tier}`, `reason=${clean(route.reason)}`, `source=${route.source}`]
    : ['off=1']
  const warn = [...notes, ...(guardNote ? [guardNote] : [])]
  if (warn.length > 0) lines.push(`warn=${clean(warn.join('; '))}`)
  const text = `${lines.join('\n')}\n`
  // Chained so a slow earlier write can never land after a newer one.
  writing = writing.then(async () => $.fs.write(await statePath($), text)).catch(() => undefined)
  await writing
}

function showStatus($: EngineInterface, notes: readonly string[] = []) {
  void writeState($, notes)
  if (!ownLine) return
  const parts = [
    route && isEnabled ? `${shortName(route.model)} · ${route.effort} · ${route.reason} (${route.source})` : 'routing off',
    ...notes,
    ...(guardNote ? [`⚠ ${guardNote}`] : []),
  ]
  $.ui.status(`autoroute: ${parts.join(' | ')}`)
}

async function classify($: EngineInterface, text: string): Promise<Route | undefined> {
  const verdict = classifyByRules(text)
  if (verdict.tier === 'keep') return route
  if (verdict.tier !== 'unsure') return { tier: verdict.tier, ...TIER_ROUTE[verdict.tier], reason: verdict.reason, source: 'rules' }
  if (useHaiku) {
    const r = await $.model
      .complete({ model: 'haiku', system: CLASSIFIER_SYSTEM, prompt: text.slice(0, 4000), effort: 'low', maxTokens: 8, timeoutMs: 8000 })
      .catch(() => undefined)
    const tier = r?.isAnswered ? parseTier(r.text) : undefined
    if (tier) return { tier, ...TIER_ROUTE[tier], reason: tier, source: 'haiku' }
  }
  return route ?? { tier: 'normal', ...TIER_ROUTE.normal, reason: 'default', source: 'fallback' }
}

export const register: Register = (on, options) => {
  useHaiku = options.classifier !== 'rules'
  guardPercent = typeof options.spendGuardPercent === 'number' ? options.spendGuardPercent : 90
  ownLine = options.display === 'line'

  on('session.start', async ($, e, next) => {
    plan = await readPlan($)
    isEnabled = (await $.store.get(ENABLED_KEY)) !== false
    await $.command.register({
      name: 'route',
      description: 'autoroute: turn auto model routing on or off, or show its status',
      argumentHint: '[on|off|status]',
    })
    showStatus($)
    return next(e)
  })

  on('command.run', { command: 'route' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on' || arg === 'off') {
      isEnabled = arg === 'on'
      await $.store.set(ENABLED_KEY, isEnabled)
      showStatus($)
      return { text: `autoroute: routing ${arg}. The Fable and spend rules stay on either way.` }
    }
    if (arg !== '' && arg !== 'status') return { text: 'Usage: /route [on|off|status]' }

    plan = await readPlan($)
    const isCapped = await isSpendCapped($)
    return {
      text: [
        `Routing: ${isEnabled ? 'on' : 'off'} (classifier: ${useHaiku ? 'rules + Haiku' : 'rules only'})`,
        `Last route: ${route ? `${shortName(route.model)} · ${route.effort} · ${route.tier} — ${route.reason} (${route.source})` : 'none yet'}`,
        `Plan: ${plan.type ?? 'unknown'} → Fable ${plan.isMax ? 'allowed' : 'blocked (Max plan only)'}`,
        `Extra usage: ${plan.hasExtraUsage ? 'on' : 'off'} → spend guard ${isCapped ? `ACTIVE (${guardNote}), capping at Sonnet` : `idle (caps at Sonnet past ${guardPercent}%)`}`,
        'Override one prompt with !haiku, !sonnet, !opus, !fable or !max at its start.',
      ].join('\n'),
    }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta) return next(e)

    const override = parseOverride(e.text)
    const text = override ? override.text : e.text
    const notes: string[] = []

    if (override && override.route !== 'auto') {
      route = { ...override.route, reason: 'override', source: 'you' }
    } else if (isEnabled) {
      route = await classify($, text)
    }

    if (route && !plan.isMax && route.model === MODELS.fable) {
      notes.push(`Fable is Max-only (${plan.type ?? 'plan unknown'}) → Opus`)
      $.ui.toast('autoroute: Fable needs a Max plan; using Opus instead.')
    }
    await isSpendCapped($)
    showStatus($, notes)

    const context = !route || !isEnabled ? [] : route.tier === 'large' ? [DELEGATE_CONTEXT] : route.tier === 'top' ? [] : [DIRECT_CONTEXT(route.tier)]
    return next({ ...e, text, context: [...(e.context ?? []), ...context] })
  })

  on('turn.step', async function* ($, e, next) {
    const isMain = e.agentId === undefined
    const wanted = isMain && isEnabled && route ? route : undefined
    const model = wanted?.model ?? e.model
    const effort = wanted?.effort ?? (e.agentId ? agentEffort.get(e.agentId) : undefined) ?? e.effort
    const gated = gate(model, effort, plan, await isSpendCapped($))

    if (gated.notes.length > 0 && isMain) showStatus($, gated.notes)
    if (gated.model === e.model && gated.effort === e.effort) return yield* next(e)
    return yield* next({ ...e, model: gated.model, ...(gated.effort === undefined ? {} : { effort: gated.effort }) })
  })

  on('agent.spawn', async ($, e, next) => {
    if (e.fork || e.resume) return next(e)

    let model = e.model
    let effort: Effort | undefined
    if (isEnabled) {
      if (e.subagentType === 'Explore') [model, effort] = ['haiku', 'low']
      else if (e.subagentType === 'Plan') [model, effort] = ['opus', 'high']
      else if (model === undefined) [model, effort] = ['sonnet', 'medium']
    }
    model = gateAlias(model, e.parentModel, plan, await isSpendCapped($))

    const started = await next(model === e.model ? e : { ...e, model })
    if (effort && 'agentId' in started && started.agentId) agentEffort.set(started.agentId, effort)
    return started
  }).catch(($, e, next) =>
    // Fail closed on Fable: without a plan reading, a Fable subagent runs on Opus.
    next.called ? next(e) : next(isFable(e.model) ? { ...e, model: 'opus' } : e),
  )
}
