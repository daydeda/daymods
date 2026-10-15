import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { firstLine, modelChoices, parseMods } from '../hooks/tools'

const PLUGINS = JSON.stringify([
  { id: 'autoroute@daymods', enabled: true },
  { id: 'prompt-upgrade@daymods', enabled: false },
  { id: 'box-tools@daymods', enabled: true },
  { id: 'vercel@claude-plugins-official', enabled: true },
])

const MODEL_ROW = {
  key: 'model', label: 'Model', kind: 'choice', value: 'sonnet', isLocked: false,
  options: ['default', 'sonnet', 'opus', 'haiku', 'fable', 'sonnet[1m]', 'opusplan'],
  provider: { plugin: 'engine', tier: 'core' },
}

// The engine beneath the plugin: settings, the plugin CLI, commands, and the pane's focus.
// `isLateFocus`: a command finishes before the keyboard moves, as a fast /effort does.
function world(on: On, { isLateFocus = false } = {}) {
  const seen = {
    opened: 0,
    closed: 0,
    configSet: [] as unknown[],
    commands: [] as string[],
    argv: [] as string[][],
  }
  const pane = { isOpen: false, isFocused: false }
  const clock = mock.clock(on)
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('config.list', () => ({ value: [MODEL_ROW] }) as never)
  on('config.set', ($, e) => (seen.configSet.push(e.value), { value: e.value }) as never)
  on('settings.read', () => ({ value: { effortLevel: 'high', modelSettings: { 'claude-sonnet-5-5': { effortLevel: 'medium' } } } }) as never)
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }) as never)
  on('process.run', ($, e) => {
    const argv = [...(e as unknown as { argv: string[] }).argv]
    seen.argv.push(argv)
    const stdout = argv.includes('list') ? PLUGINS : ''
    return { value: { exitCode: 0, stdout, stderr: '' } } as never
  })
  on('command.run', ($, e) => {
    seen.commands.push(`${e.command} ${e.args}`.trim())
    // As in a session: a command run hands the keyboard to the prompt.
    if (!isLateFocus) pane.isFocused = false
    if (e.command === 'effort') return { text: `Set effort level to ${e.args} (this session only): more words` }
    return { text: '' }
  })
  on('ui.open', () => ((pane.isOpen = true), (pane.isFocused = true), seen.opened++, { value: { isPlaced: true } }) as never)
  on('ui.close', () => ((pane.isOpen = false), seen.closed++, { value: undefined }))
  on('ui.panes', () => ({
    value: pane.isOpen ? [{ id: 'box-tools', title: 'Tools', isShown: true, isFocused: pane.isFocused, isPlaced: true }] : [],
  }) as never)
  return { seen, pane, clock }
}

async function start($: Engine) {
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
}

const PANE_PROPS = { title: 'Tools', isFocused: true, bodyColumns: 52, placement: 'dock' } as never

async function mountPane($: Engine, surface: 'terminal' | 'desktop' = 'terminal') {
  return $.ui.mount({ plugin: 'box-tools', surface, component: 'Pane', requestId: 'box-tools', props: PANE_PROPS })
}

async function openBox($: Engine) {
  await $.command.run({ command: 'tools', args: '', origin: { kind: 'composer' } } as never)
}

describe('helpers', () => {
  test('parseMods keeps the other daymods and leaves Box Tools out', () => {
    expect(parseMods(PLUGINS)).toEqual([
      { id: 'autoroute@daymods', name: 'autoroute', isEnabled: true },
      { id: 'prompt-upgrade@daymods', name: 'prompt-upgrade', isEnabled: false },
    ])
    expect(parseMods('not json')).toBeUndefined()
  })

  test('modelChoices keeps the plain models in order', () => {
    expect(modelChoices(MODEL_ROW.options)).toEqual(['default', 'haiku', 'sonnet', 'opus', 'fable'])
    expect(modelChoices(undefined)).toEqual([])
    expect(firstLine('\n  hi\nthere')).toBe('hi')
  })
})

describe('footer button', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`a Tools button sits after the mode labels (${surface})`, async ($, on) => {
      const { seen } = world(on)
      await start($)
      const ui = await $.ui.mount({ plugin: 'box-tools', surface, component: 'SessionMode', props: { modes: ['focus'] } as never })
      expect(await ui.find({ type: 'Text', text: /focus/ })).toBeDefined()
      await ui.press({ key: 'tools' })
      expect(seen.opened).toBe(1)
      await ui.press({ key: 'tools' })
      expect(seen.closed).toBe(1)
      await ui.unmount()
    })
  }

  test('button: hide leaves the footer alone', { options: { button: 'hide' } }, async ($, on) => {
    world(on)
    on('ui.render', { component: 'SessionMode' }, () => ({ type: 'Text', props: {}, children: ['engine'] }) as never)
    await start($)
    const ui = await $.ui.mount({ plugin: 'box-tools', surface: 'terminal', component: 'SessionMode', props: { modes: [] } as never })
    expect(await ui.find({ key: 'tools' })).toBeUndefined()
    await ui.unmount()
  })
})

describe('Tools box', () => {
  test('shows the current model, effort and mods', async ($, on) => {
    const { clock } = world(on)
    await start($)
    await openBox($)
    await clock.settle()
    const ui = await mountPane($)
    expect(await ui.find({ type: 'Text', text: /● Sonnet/ })).toBeDefined()
    // The effort /effort saved for this model, over the top-level default.
    expect(await ui.find({ type: 'Text', text: /● medium/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /● on\s+autoroute/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /○ off\s+prompt-upgrade/ })).toBeDefined()
    expect(await ui.find({ key: 'mod-box-tools' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /autoroute is on/ })).toBeDefined()
    await ui.unmount()
  })

  test('picking a model sets the /config model row', async ($, on) => {
    const { seen, clock } = world(on)
    await start($)
    await openBox($)
    await clock.settle()
    const ui = await mountPane($)
    await ui.press({ key: 'model-opus' })
    expect(seen.configSet).toEqual(['opus'])
    expect(await ui.find({ type: 'Text', text: /● Opus/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Model set to Opus/ })).toBeDefined()
    await ui.unmount()
  })

  test('picking an effort runs /effort', async ($, on) => {
    const { seen, clock } = world(on)
    await start($)
    await openBox($)
    await clock.settle()
    const ui = await mountPane($)
    await ui.press({ key: 'effort-low' })
    expect(seen.commands).toContain('effort low')
    expect(await ui.find({ type: 'Text', text: /● low/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Set effort level to low \(this session only\)\./ })).toBeDefined()
    await ui.unmount()
  })

  test('the keyboard /effort takes is handed back, and the box stays open', async ($, on) => {
    const { seen, pane, clock } = world(on)
    await start($)
    await openBox($)
    await clock.advance(300)
    const ui = await mountPane($)
    await ui.press({ key: 'effort-max' })
    // Opened afresh, which is how a pane gets the keyboard back.
    expect(seen.closed).toBe(1)
    expect(seen.opened).toBe(2)
    expect(pane.isFocused).toBe(true)
    await clock.advance(1000)
    expect(pane.isOpen).toBe(true)
    expect(seen.closed).toBe(1)
    await ui.unmount()
  })

  test('toggling a mod disables or enables the plugin and reloads plugins', async ($, on) => {
    const { seen, clock } = world(on)
    await start($)
    await openBox($)
    await clock.settle()
    const ui = await mountPane($)
    await ui.press({ key: 'mod-autoroute' })
    expect(seen.argv).toContainEqual(['claude', 'plugin', 'disable', 'autoroute@daymods'])
    expect(seen.commands).toContain('reload-plugins')
    expect(await ui.find({ type: 'Text', text: /○ off\s+autoroute/ })).toBeDefined()
    await ui.press({ key: 'mod-prompt-upgrade' })
    expect(seen.argv).toContainEqual(['claude', 'plugin', 'enable', 'prompt-upgrade@daymods'])
    expect(await ui.find({ type: 'Text', text: /● on\s+prompt-upgrade/ })).toBeDefined()
    await ui.unmount()
  })

  test('works on the desktop too', async ($, on) => {
    const { clock } = world(on)
    await start($)
    await openBox($)
    await clock.settle()
    const ui = await mountPane($, 'desktop')
    expect(await ui.find({ key: 'model-opus' })).toBeDefined()
    await ui.unmount()
  })
})

describe('keyboard after a change', () => {
  test('a keyboard loss just after a change is taken back; a later one closes the box', async ($, on) => {
    const { seen, pane, clock } = world(on, { isLateFocus: true })
    await start($)
    await openBox($)
    await clock.advance(300)
    const ui = await mountPane($)
    await ui.press({ key: 'effort-low' })
    expect(seen.commands).toContain('effort low')
    pane.isFocused = false
    await clock.advance(300)
    expect(pane.isOpen).toBe(true)
    expect(pane.isFocused).toBe(true)
    await clock.advance(2000)
    pane.isFocused = false
    await clock.advance(300)
    expect(pane.isOpen).toBe(false)
    await ui.unmount()
  })

  test('picking what is already set runs nothing', async ($, on) => {
    const { seen, clock } = world(on)
    await start($)
    await openBox($)
    await clock.settle()
    const ui = await mountPane($)
    await ui.press({ key: 'effort-medium' })
    await ui.press({ key: 'model-sonnet' })
    expect(seen.commands).toEqual([])
    expect(seen.configSet).toEqual([])
    expect(await ui.find({ type: 'Text', text: /Already on Sonnet/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('closing', () => {
  test('a click away (the box loses the keyboard) closes it', async ($, on) => {
    const { seen, pane, clock } = world(on)
    await start($)
    await openBox($)
    pane.isFocused = true
    await clock.advance(300)
    expect(seen.closed).toBe(0)
    pane.isFocused = false
    await clock.advance(300)
    expect(seen.closed).toBe(1)
  })

  test('a box that never had the keyboard stays open', async ($, on) => {
    const { seen, clock } = world(on)
    await start($)
    await openBox($)
    await clock.advance(1000)
    expect(seen.closed).toBe(0)
  })

  test('the Close button closes it', async ($, on) => {
    const { seen, clock } = world(on)
    await start($)
    await openBox($)
    await clock.settle()
    const ui = await mountPane($)
    await ui.press({ key: 'close' })
    expect(seen.closed).toBe(1)
    await ui.unmount()
  })
})
