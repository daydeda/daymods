import type { AgentSpawnInput, On, SessionRateLimit, TurnStepInput } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

type World = {
  account?: Record<string, unknown>
  isUnreadable?: boolean
  rateLimits?: SessionRateLimit[]
  haikuSays?: string
}

// The engine beneath the plugin: a login record, usage, Haiku, and recorders.
function world(on: On, w: World) {
  const seen: { step?: TurnStepInput; spawn?: AgentSpawnInput; context?: readonly string[]; text?: string; state?: string; toasts: string[] } = { toasts: [] }
  mock.env(on, { HOME: '/home/t' })
  mock.store(on)
  on('fs.read', () => {
    if (w.isUnreadable) throw new Error('no file')
    return { value: JSON.stringify({ oauthAccount: w.account ?? {} }) }
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: w.rateLimits ?? [] } }))
  on('model.complete', () => ({
    value: { isAnswered: true, text: w.haikuSays ?? 'normal', usage: { input_tokens: 1, output_tokens: 1 } },
  }) as never)
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.status', () => ({ value: undefined }))
  on('fs.write', ($, e) => (seen.state = e.text, { value: undefined }))
  on('ui.toast', ($, e) => (seen.toasts.push(e.text), { value: undefined }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('prompt.submit', ($, e) => ((seen.text = e.text), (seen.context = e.context), { text: e.text, context: e.context }))
  on('turn.step', async function* ($, e) {
    seen.step = e
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } as never
  })
  on('agent.spawn', ($, e) => ((seen.spawn = e), { model: e.model ?? e.parentModel, agentId: 'agent-1' }))
  return seen
}

const PRO = { organizationType: 'claude_pro', hasExtraUsageEnabled: false }
const PRO_EXTRA = { organizationType: 'claude_pro', hasExtraUsageEnabled: true }
const MAX = { organizationType: 'claude_max', hasExtraUsageEnabled: false }

async function start($: Engine) {
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
}

async function submit($: Engine, text: string) {
  await $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false } as never)
}

async function step($: Engine, model = 'claude-opus-5-5', agentId?: string) {
  const s = $.turn.step({ turnId: 't', index: 0, model, effort: 'high', messageCount: 1, ...(agentId ? { agentId } : {}) })
  for await (const _ of s) void _
  return s.result
}

async function spawn($: Engine, subagentType: string, model?: string) {
  return $.agent.spawn({
    tool_use_id: 'tu', prompt: 'p', description: 'd', subagentType, model,
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5',
    background: false, fork: false,
  } as never)
}

describe('Fable gate', () => {
  test('a Pro plan never reaches Fable, even with !fable', async ($, on) => {
    const seen = world(on, { account: PRO })
    await start($)
    await submit($, '!fable design the cache layer')
    expect(seen.text).toBe('design the cache layer')
    await step($)
    expect(seen.step?.model).toBe('claude-opus-5-5')
    expect(seen.toasts.length).toBe(1)
  })

  test('a Max plan may use Fable', async ($, on) => {
    const seen = world(on, { account: MAX })
    await start($)
    await submit($, '!fable design the cache layer')
    await step($)
    expect(seen.step?.model).toBe('claude-fable-5-1')
  })

  test('an unreadable plan fails closed', async ($, on) => {
    const seen = world(on, { isUnreadable: true })
    await start($)
    await submit($, '!max rethink this')
    await step($)
    expect(seen.step?.model).toBe('claude-opus-5-5')
  })

  test('Fable picked in /model is rewritten even with routing off', async ($, on) => {
    const seen = world(on, { account: PRO })
    await start($)
    await $.command.run({ command: 'route', args: 'off', origin: { kind: 'composer' } } as never)
    await submit($, 'whatever')
    await step($, 'claude-fable-5-1')
    expect(seen.step?.model).toBe('claude-opus-5-5')
  })

  test('a Fable subagent on Pro runs on Opus', async ($, on) => {
    const seen = world(on, { account: PRO })
    await start($)
    await spawn($, 'general-purpose', 'fable')
    expect(seen.spawn?.model).toBe('opus')
  })
})

describe('routing', () => {
  test('a typo fix goes to Haiku at low effort', async ($, on) => {
    const seen = world(on, { account: PRO })
    await start($)
    await submit($, 'fix the typo in README')
    await step($)
    expect(seen.step?.model).toBe('claude-haiku-5-5')
    expect(seen.step?.effort).toBe('low')
  })

  test('large work goes to Opus with the delegation pipeline', async ($, on) => {
    const seen = world(on, { account: PRO })
    await start($)
    await submit($, 'migrate the whole codebase to TypeScript')
    await step($)
    expect(seen.step?.model).toBe('claude-opus-5-5')
    expect(seen.context?.[0]).toContain('LARGE')
  })

  test('an unclear prompt asks Haiku', async ($, on) => {
    const seen = world(on, { account: PRO, haikuSays: 'hard' })
    await start($)
    await submit($, 'the login page and the session cookie disagree sometimes')
    await step($)
    expect(seen.step?.model).toBe('claude-opus-5-5')
  })

  test('a follow-up keeps the last route', async ($, on) => {
    const seen = world(on, { account: PRO })
    await start($)
    await submit($, 'fix the typo in README')
    await submit($, 'continue')
    await step($)
    expect(seen.step?.model).toBe('claude-haiku-5-5')
  })

  test('Explore subagents run on Haiku at low effort', async ($, on) => {
    const seen = world(on, { account: PRO })
    await start($)
    await spawn($, 'Explore')
    expect(seen.spawn?.model).toBe('haiku')
    await step($, 'claude-haiku-5-5', 'agent-1')
    expect(seen.step?.effort).toBe('low')
  })
})

describe('spend guard', () => {
  test('extra usage near a limit caps routes at Sonnet', async ($, on) => {
    const seen = world(on, { account: PRO_EXTRA, rateLimits: [{ kind: 'five_hour', percentUsed: 95 }] })
    await start($)
    await submit($, 'migrate the whole codebase to TypeScript')
    await step($)
    expect(seen.step?.model).toBe('claude-sonnet-5-5')
  })

  test('without extra usage the guard stays idle', async ($, on) => {
    const seen = world(on, { account: PRO, rateLimits: [{ kind: 'five_hour', percentUsed: 95 }] })
    await start($)
    await submit($, 'migrate the whole codebase to TypeScript')
    await step($)
    expect(seen.step?.model).toBe('claude-opus-5-5')
  })
})

describe('statusline state', () => {
  test('the route is written for the statusline to show', async ($, on) => {
    const seen = world(on, { account: PRO })
    await start($)
    await submit($, 'fix a typo in the readme')
    await new Promise(r => setTimeout(r, 10))
    expect(seen.state).toContain('model=Haiku')
    expect(seen.state).toContain('effort=low')
  })
})
