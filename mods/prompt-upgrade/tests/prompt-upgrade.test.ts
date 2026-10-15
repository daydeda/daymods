import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { judge, parseQuestions, parseRewrite, splitPrefix } from '../hooks/upgrade'

type World = {
  history?: { role: 'user' | 'assistant'; text: string }[]
  haikuSays?: string
  rewrites?: string[]
  // One entry per dialog, in order: the label picked or text typed, or 'dismiss'.
  dialogs?: string[]
  // The side panel is drawn (a wide terminal); otherwise ui.open finds no surface.
  hasPanel?: boolean
}

const QUESTION = JSON.stringify({
  clear: false,
  questions: [{
    question: 'What kind of todo app?',
    header: 'Scope',
    options: ['CLI (Recommended)', 'Web app'],
  }],
})
const THREE = JSON.stringify({
  clear: false,
  questions: [
    { question: 'Where should it run?', header: 'Target', options: ['Terminal (Recommended)', 'Web page'] },
    { question: 'Where are todos saved?', header: 'Storage', options: ['A JSON file', 'Nowhere'] },
    { question: 'Do you mean something like this: a tiny CLI?', header: 'Check', options: ['Yes, that', 'Bigger than that'] },
  ],
})
const rewriteOf = (prompt: string, method = 'plan') => JSON.stringify({ prompt, method, why: 'it is a new app' })

// The engine beneath the plugin: models, the AskUserQuestion dialog, the session, and recorders.
function world(on: On, w: World) {
  const seen = {
    text: undefined as string | undefined,
    asked: [] as { question: string; header: string; options: { label: string }[] }[],
    calls: [] as string[],
    filled: undefined as string | undefined,
    submitted: undefined as string | undefined,
    closed: 0,
    columns: undefined as number | undefined,
  }
  const rewrites = [...(w.rewrites ?? [rewriteOf('Build a CLI todo app. Plan first, then wait for my OK.')])]
  const dialogs = [...(w.dialogs ?? [])]
  const clock = mock.clock(on)
  mock.store(on)
  on('session.cwd', () => ({ value: '/w' }))
  on('fs.list', () => ({ value: [{ name: 'package.json' }, { name: 'src' }, { name: '.git' }] }) as never)
  on('session.messages', () => ({ value: (w.history ?? []).map(m => ({ ...m, toolUses: [] })) }) as never)
  on('model.complete', ($, e) => {
    const isAsk = e.system?.includes('sharpen') ?? false
    seen.calls.push(isAsk ? 'ask' : 'rewrite')
    const text = isAsk ? (w.haikuSays ?? QUESTION) : (rewrites.shift() ?? rewriteOf('fallback'))
    return { value: { isAnswered: true, text, usage: { input_tokens: 1, output_tokens: 1 } } } as never
  })
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const input = e as unknown as { questions: { question: string; header: string; options: { label: string }[] }[] }
    const q = input.questions[0]!
    seen.asked.push(q)
    const answer = dialogs.shift() ?? ''
    if (answer === 'dismiss') return { deny: 'dismissed' }
    return { result: { questions: input.questions, answers: { [q.question]: answer } } } as never
  })
  if (w.hasPanel) {
    on('ui.open', ($, e) => ((seen.columns = (e as { columns?: number }).columns), { value: { isPlaced: true } }) as never)
    on('ui.close', () => (seen.closed++, { value: undefined }))
  }
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('prompt.fill', ($, e) => ((seen.filled = e.text), { isFilled: true, text: e.text }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('prompt.submit', ($, e) => {
    seen.text = e.text
    if (e.origin.kind === 'plugin') seen.submitted = e.text
    return { text: e.text }
  })
  return { seen, clock }
}

async function start($: Engine) {
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
}

async function submit($: Engine, text: string) {
  return $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false } as never)
}

describe('judge', () => {
  test('rules sort prompts', () => {
    expect(judge('make a todo app', 'auto', false).kind).toBe('vague')
    expect(judge('make it better', 'auto', true).kind).toBe('vague')
    expect(judge('fix it', 'auto', true).kind).toBe('skip')
    expect(judge('continue', 'always', true).kind).toBe('skip')
    expect(judge('/compact', 'auto', false).kind).toBe('skip')
    expect(judge('fix the typo in README', 'auto', false).kind).toBe('clear')
    expect(judge('rename getUser to fetchUser in src/api.ts', 'auto', false).kind).toBe('clear')
    expect(judge('what does this repo do?', 'auto', false).kind).toBe('clear')
    expect(judge('the login page and the session cookie disagree sometimes', 'auto', false).kind).toBe('unsure')
    expect(judge('rename getUser to fetchUser in src/api.ts', 'always', false).kind).toBe('vague')
  })

  test('parsers accept the model replies and refuse junk', () => {
    expect(parseQuestions(QUESTION)?.[0]?.options.length).toBe(2)
    expect(parseQuestions('{"clear": true}')).toEqual([])
    expect(parseQuestions('no idea')).toBeUndefined()
    expect(parseRewrite(rewriteOf('x', 'loop'))?.method).toBe('loop')
    expect(parseRewrite(rewriteOf('x', 'weird'))?.method).toBe('direct')
    expect(splitPrefix('!opus make a game')).toEqual({ prefix: '!opus ', body: 'make a game' })
  })
})

describe('auto mode', () => {
  test('a clear prompt goes through with no model call', async ($, on) => {
    const { seen } = world(on, {})
    await start($)
    await submit($, 'rename getUser to fetchUser in src/api.ts')
    expect(seen.text).toBe('rename getUser to fetchUser in src/api.ts')
    expect(seen.calls).toEqual([])
  })

  test('a vague prompt is asked about, rewritten, reviewed and run', async ($, on) => {
    const { seen } = world(on, {
      dialogs: ['CLI (Recommended)', 'Run it'],
    })
    await start($)
    await submit($, 'make a todo app')
    expect(seen.calls).toEqual(['ask', 'rewrite'])
    expect(seen.asked[0]?.question).toBe('What kind of todo app?')
    expect(seen.asked[0]?.options.map(o => o.label)).toEqual(['CLI (Recommended)', 'Web app', 'Skip'])
    const review = seen.asked[1]
    expect(review?.options.map(o => o.label)).toEqual(['Run it', 'Edit it myself', 'Use my original', 'Cancel'])
    expect(review?.question).toContain('Build a CLI todo app')
    expect(review?.question).toContain('Plan first')
    expect(seen.text).toBe('Build a CLI todo app. Plan first, then wait for my OK.')
  })

  test('Haiku can call a borderline prompt clear', async ($, on) => {
    const { seen } = world(on, { haikuSays: '{"clear": true}' })
    await start($)
    await submit($, 'the login page and the session cookie disagree sometimes')
    expect(seen.calls).toEqual(['ask'])
    expect(seen.text).toBe('the login page and the session cookie disagree sometimes')
  })

  test('dismissing the question sends the prompt as typed', async ($, on) => {
    const { seen } = world(on, { dialogs: ['dismiss'] })
    await start($)
    await submit($, 'make a todo app')
    expect(seen.calls).toEqual(['ask'])
    expect(seen.text).toBe('make a todo app')
  })

  test('a skipped question still gets a rewrite', async ($, on) => {
    const { seen } = world(on, { dialogs: ['Skip', 'Run it'] })
    await start($)
    await submit($, 'make a todo app')
    expect(seen.calls).toEqual(['ask', 'rewrite'])
    expect(seen.text).toContain('CLI todo app')
  })

  test('typing under Other revises the rewrite', async ($, on) => {
    const { seen } = world(on, {
      rewrites: [rewriteOf('Build a CLI todo app.'), rewriteOf('Build a CLI todo app in Go.', 'direct')],
      dialogs: ['CLI (Recommended)', 'use Go', 'Run it'],
    })
    await start($)
    await submit($, 'make a todo app')
    expect(seen.calls).toEqual(['ask', 'rewrite', 'rewrite'])
    expect(seen.text).toBe('Build a CLI todo app in Go.')
  })

  test('"Use my original" sends what was typed', async ($, on) => {
    const { seen } = world(on, { dialogs: ['Web app', 'Use my original'] })
    await start($)
    await submit($, 'make a todo app')
    expect(seen.text).toBe('make a todo app')
  })

  test('"Edit it myself" drops the prompt and fills the box', async ($, on) => {
    const { seen, clock } = world(on, { dialogs: ['Web app', 'Edit it myself'] })
    await start($)
    const r = await submit($, 'make a todo app')
    expect('drop' in r && r.drop).toContain('prompt box')
    await clock.advance(100)
    expect(seen.filled).toBe('Build a CLI todo app. Plan first, then wait for my OK.')
  })

  test('what is sent from a refilled box is not upgraded again', async ($, on) => {
    const { seen, clock } = world(on, { dialogs: ['Web app', 'Edit it myself'] })
    await start($)
    await $.command.run({ command: 'refine', args: 'always', origin: { kind: 'composer' } } as never)
    await submit($, 'make a todo app')
    await clock.advance(100)
    await submit($, 'Build a web todo app.')
    expect(seen.calls).toEqual(['ask', 'rewrite'])
    expect(seen.text).toBe('Build a web todo app.')
  })

  test('an autoroute override is kept in front of the rewrite', async ($, on) => {
    const { seen } = world(on, { dialogs: ['Web app', 'Run it'] })
    await start($)
    await submit($, '!opus make a todo app')
    expect(seen.text?.startsWith('!opus Build')).toBe(true)
  })

  test('"fix it" mid-conversation is left alone', async ($, on) => {
    const { seen } = world(on, { history: [{ role: 'user', text: 'run the tests' }, { role: 'assistant', text: '3 failed' }] })
    await start($)
    await submit($, 'fix it')
    expect(seen.calls).toEqual([])
  })
})

describe('/refine', () => {
  test('off stops auto mode', async ($, on) => {
    const { seen } = world(on, {})
    await start($)
    await $.command.run({ command: 'refine', args: 'off', origin: { kind: 'composer' } } as never)
    await submit($, 'make a todo app')
    expect(seen.calls).toEqual([])
  })

  test('/refine <prompt> runs the flow and submits the result', async ($, on) => {
    const { seen, clock } = world(on, {
      haikuSays: '{"clear": true}',
      dialogs: ['Run it'],
    })
    await start($)
    const r = await $.command.run({ command: 'refine', args: 'rename getUser in src/api.ts', origin: { kind: 'composer' } } as never)
    await clock.settle()
    expect(seen.calls).toEqual(['ask', 'rewrite'])
    expect((r as { text?: string }).text).toContain('Sending')
    expect(seen.submitted).toContain('CLI todo app')
  })
})

const PANE_PROPS = { title: 'Refine prompt', isFocused: true, bodyColumns: 60, placement: 'dock' } as never

describe('side panel', () => {
  async function mountPane($: Engine, surface: 'terminal' | 'desktop' = 'terminal') {
    return $.ui.mount({ plugin: 'prompt-upgrade', surface, component: 'Pane', requestId: 'refine', props: PANE_PROPS })
  }

  test('the question and the review are answered with buttons in the panel', async ($, on) => {
    const { seen, clock } = world(on, { hasPanel: true })
    await start($)
    const r = await submit($, 'make a todo app')
    expect('drop' in r && r.drop).toContain('side panel')
    await clock.advance(10)

    const ui = await mountPane($)
    expect(await ui.find({ type: 'Text', text: /What kind of todo app/ })).toBeDefined()
    expect(await ui.find({ key: 'opt1' })).toBeDefined()
    await ui.press({ key: 'opt0' })
    await clock.advance(10)

    expect(await ui.find({ type: 'Text', text: /Build a CLI todo app/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Plan first/ })).toBeDefined()
    await ui.press({ key: 'run' })
    await clock.advance(10)

    expect(seen.calls).toEqual(['ask', 'rewrite'])
    expect(seen.asked).toEqual([])
    expect(seen.submitted).toBe('Build a CLI todo app. Plan first, then wait for my OK.')
    expect(seen.closed).toBe(1)
    await ui.unmount()
  })

  async function typeInto($: Engine, ui: Awaited<ReturnType<typeof mountPane>>, key: string, text: string) {
    for (const ch of text) await ui.key({ key: ch, in: key })
  }

  test('typing in the panel\'s own text area answers the question and asks for a change', async ($, on) => {
    const { seen, clock } = world(on, {
      hasPanel: true,
      rewrites: [rewriteOf('Build a CLI todo app.'), rewriteOf('Build a CLI todo app in Go.', 'direct')],
    })
    await start($)
    await submit($, 'make a todo app')
    await clock.advance(10)
    const ui = await mountPane($)
    await typeInto($, ui, 'editor-ask-0-0', 'a CLI')
    await clock.advance(10)
    expect(await ui.find({ type: 'Text', text: 'a CLI▌', in: 'editor-ask-0-0' })).toBeDefined()
    await ui.key({ key: 'backspace', in: 'editor-ask-0-0' })
    await clock.advance(10)
    expect(await ui.find({ type: 'Text', text: 'a CL▌', in: 'editor-ask-0-0' })).toBeDefined()
    await ui.key({ key: 'I', in: 'editor-ask-0-0' })
    await ui.key({ key: 'return', in: 'editor-ask-0-0' })
    await clock.advance(10)
    expect(seen.asked).toEqual([])
    expect(await ui.find({ type: 'Text', text: /Upgraded prompt/ })).toBeDefined()
    await typeInto($, ui, 'editor-review-0-0', 'use Go')
    await ui.key({ key: 'return', in: 'editor-review-0-0' })
    await clock.advance(10)
    expect(await ui.find({ type: 'Text', text: /in Go/ })).toBeDefined()
    await ui.press({ key: 'run' })
    await clock.advance(10)
    expect(seen.submitted).toBe('Build a CLI todo app in Go.')
    await ui.unmount()
  })

  test('a long answer is shown once, in full, wrapped, with no shortened copy', async ($, on) => {
    const { clock } = world(on, { hasPanel: true })
    await start($)
    await submit($, 'make a todo app')
    await clock.advance(10)
    const ui = await mountPane($)
    const long = 'a command line todo app that saves to a JSON file and syncs with my phone every night'
    await typeInto($, ui, 'editor-ask-0-0', long)
    await clock.advance(10)
    expect((await ui.findAll({ type: 'Text', text: long, in: 'editor-ask-0-0' })).length).toBe(1)
    expect((await ui.findAll({ type: 'Text', text: long })).length).toBe(0) // nowhere else in the panel
    expect((await ui.find({ type: 'Text', text: long, in: 'editor-ask-0-0' }))?.props.wrap).toBe('wrap')
    expect((await ui.findAll({ type: 'Input' })).length).toBe(0)
    await ui.unmount()
  })

  test('cancel puts the original back in the prompt box', async ($, on) => {
    const { seen, clock } = world(on, { hasPanel: true })
    await start($)
    await submit($, 'make a todo app')
    await clock.advance(10)
    const ui = await mountPane($)
    await ui.press({ key: 'skip' })
    await clock.advance(10)
    await ui.press({ key: 'cancel' })
    await clock.advance(100)
    expect(seen.filled).toBe('make a todo app')
    expect(seen.submitted).toBeUndefined()
    await ui.unmount()
  })

  test('the panel works on the desktop too', async ($, on) => {
    const { clock } = world(on, { hasPanel: true })
    await start($)
    await submit($, 'make a todo app')
    await clock.advance(10)
    const ui = await mountPane($, 'desktop')
    expect(await ui.find({ key: 'opt0' })).toBeDefined()
    await ui.unmount()
  })

  test('a terminal too narrow for a panel falls back to the dialog', async ($, on) => {
    const { seen } = world(on, { dialogs: ['CLI (Recommended)', 'Run it'] })
    on('ui.open', () => ({ value: { isPlaced: false, reason: 'narrow' } }) as never)
    on('ui.close', () => ({ value: undefined }))
    await start($)
    await submit($, 'make a todo app')
    expect(seen.asked.length).toBe(2)
    expect(seen.text).toContain('CLI todo app')
  })
})

describe('step by step in the panel', () => {
  async function open($: Engine) {
    return $.ui.mount({ plugin: 'prompt-upgrade', surface: 'terminal', component: 'Pane', requestId: 'refine', props: PANE_PROPS })
  }

  test('up to three questions, with Back keeping the earlier answer', async ($, on) => {
    const { seen, clock } = world(on, { hasPanel: true, haikuSays: THREE })
    await start($)
    await submit($, 'make a todo app')
    await clock.advance(10)
    const ui = await open($)
    expect(await ui.find({ type: 'Text', text: /Questions 1\/3/ })).toBeDefined()
    expect(await ui.find({ key: 'back' })).toBeUndefined()
    await ui.press({ key: 'opt1' })
    await clock.advance(10)
    expect(await ui.find({ type: 'Text', text: /Where are todos saved/ })).toBeDefined()
    await ui.press({ key: 'back' })
    await clock.advance(10)
    expect(await ui.find({ type: 'Text', text: /Where should it run/ })).toBeDefined()
    expect(await ui.find({ text: /your answer/ })).toBeDefined()
    await ui.press({ key: 'opt0' })
    await clock.advance(10)
    await ui.press({ key: 'rest' })
    await clock.advance(10)
    expect(await ui.find({ type: 'Text', text: /Upgraded prompt/ })).toBeDefined()
    await ui.press({ key: 'run' })
    await clock.advance(10)
    expect(seen.calls).toEqual(['ask', 'rewrite'])
    expect(seen.submitted).toContain('CLI todo app')
    await ui.unmount()
  })

  test('the last question has no "skip the rest"', async ($, on) => {
    const { clock } = world(on, { hasPanel: true })
    await start($)
    await submit($, 'make a todo app')
    await clock.advance(10)
    const ui = await open($)
    expect(await ui.find({ key: 'rest' })).toBeUndefined()
    expect(await ui.find({ key: 'type' })).toBeDefined()
    await ui.unmount()
  })

  test('Back from the review returns to the questions and rewrites again', async ($, on) => {
    const { seen, clock } = world(on, {
      hasPanel: true,
      rewrites: [rewriteOf('Build a CLI todo app.'), rewriteOf('Build a web todo app.')],
    })
    await start($)
    await submit($, 'make a todo app')
    await clock.advance(10)
    const ui = await open($)
    await ui.press({ key: 'opt0' })
    await clock.advance(10)
    await ui.press({ key: 'back' })
    await clock.advance(10)
    expect(await ui.find({ type: 'Text', text: /What kind of todo app/ })).toBeDefined()
    await ui.press({ key: 'opt1' })
    await clock.advance(10)
    expect(await ui.find({ type: 'Text', text: /web todo app/ })).toBeDefined()
    await ui.press({ key: 'run' })
    await clock.advance(10)
    expect(seen.calls).toEqual(['ask', 'rewrite', 'rewrite'])
    expect(seen.submitted).toBe('Build a web todo app.')
    await ui.unmount()
  })
})

describe('step bar', () => {
  test('finished, current and later steps look different', async ($, on) => {
    const { clock } = world(on, { hasPanel: true, haikuSays: THREE })
    await start($)
    await submit($, 'make a todo app')
    await clock.advance(10)
    const ui = await $.ui.mount({ plugin: 'prompt-upgrade', surface: 'terminal', component: 'Pane', requestId: 'refine', props: PANE_PROPS })
    const done = await ui.find({ type: 'Text', text: /Your prompt/ })
    const now = await ui.find({ type: 'Text', text: /Questions 1/ })
    const later = await ui.find({ type: 'Text', text: /Review/ })
    expect(done?.text).toContain('✓ Your prompt')
    expect(done?.props.color).toBe('green')
    expect(done?.props.bold).toBeFalsy()
    expect(now?.text).toContain('● Questions 1/3')
    expect(now?.props.bold).toBe(true)
    expect(now?.props.color).toBe('claude')
    expect(later?.text).toContain('○ Review')
    expect(later?.props.dimColor).toBe(true)
    expect(later?.props.color).toBeUndefined()
    await ui.unmount()
  })
})

describe('panel size and question progress', () => {
  test('the panel opens at about 60% of the terminal width, and 100 when unknown', async ($, on) => {
    const { seen, clock } = world(on, { hasPanel: true })
    await start($)
    await submit($, 'make a todo app')
    await clock.advance(10)
    expect(seen.columns).toBe(100)
    await $.command.run({ command: 'refine', args: 'status', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } } as never)
    await submit($, 'make a game')
    await clock.advance(10)
    expect(seen.columns).toBe(100)
  })

  test('each question shows "QUESTION n OF m" with one dot per question', async ($, on) => {
    const { seen, clock } = world(on, { hasPanel: true, haikuSays: THREE })
    await $.command.run({ command: 'refine', args: 'status', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } } as never)
    await start($)
    await $.command.run({ command: 'refine', args: 'make a todo app', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } } as never)
    await clock.advance(10)
    expect(seen.columns).toBe(120)
    const ui = await $.ui.mount({ plugin: 'prompt-upgrade', surface: 'terminal', component: 'Pane', requestId: 'refine', props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: 'QUESTION 1 OF 3' })).toBeDefined()
    expect((await ui.findAll({ type: 'Text', text: /^[●✓○]$/ })).length).toBe(3)
    await ui.press({ key: 'opt0' })
    await clock.advance(10)
    expect(await ui.find({ type: 'Text', text: 'QUESTION 2 OF 3' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^✓$/ }))?.props.color).toBe('green')
    await ui.unmount()
  })
})

describe('typing, Back from the review', () => {
  test('one typing area, no one-line field: a button and a wrapped box', async ($, on) => {
    const { clock } = world(on, { hasPanel: true })
    await start($)
    await submit($, 'make a todo app')
    await clock.advance(10)
    const ui = await $.ui.mount({ plugin: 'prompt-upgrade', surface: 'terminal', component: 'Pane', requestId: 'refine', props: PANE_PROPS })
    expect((await ui.findAll({ type: 'Input' })).length).toBe(0)
    expect((await ui.findAll({ type: 'Button', text: /Type my own answer/ })).length).toBe(1)
    const framed = (await ui.findAll({ type: 'Box' })).filter(b => b.props.borderStyle === 'round')
    expect(framed.length).toBe(3) // step bar, question card, footer
    await ui.unmount()
  })

  test('the review offers Back next to the other choices when there were questions', async ($, on) => {
    const { clock } = world(on, { hasPanel: true })
    await start($)
    await submit($, 'make a todo app')
    await clock.advance(10)
    const ui = await $.ui.mount({ plugin: 'prompt-upgrade', surface: 'terminal', component: 'Pane', requestId: 'refine', props: PANE_PROPS })
    await ui.press({ key: 'opt0' })
    await clock.advance(10)
    expect((await ui.find({ key: 'back' }))?.text).toContain('change my answers')
    await ui.unmount()
  })
})

describe('footer bar', () => {
  test('Back, Skip the rest and Esc sit in the footer at full brightness', async ($, on) => {
    const { clock } = world(on, { hasPanel: true, haikuSays: THREE })
    await start($)
    await submit($, 'make a todo app')
    await clock.advance(10)
    const ui = await $.ui.mount({ plugin: 'prompt-upgrade', surface: 'terminal', component: 'Pane', requestId: 'refine', props: PANE_PROPS })
    await ui.press({ key: 'opt0' })
    await clock.advance(10)
    for (const key of ['back', 'rest']) {
      const b = await ui.find({ key })
      expect(b).toBeDefined()
      expect(b?.props.dimColor).toBeFalsy()
    }
    expect(await ui.find({ type: 'Text', text: 'Esc' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Send my prompt as typed/ })).toBeDefined()
    await ui.unmount()
  })
})
