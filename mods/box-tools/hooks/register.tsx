import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, Timer } from 'claude-code'

import { EFFORTS, EFFORT_KEYS, MODEL_KEYS, MOD_KEYS, firstLine, modelChoices, parseMods, title } from './tools'
import type { View } from '../types'

const PANE = 'box-tools'
const FOCUS_POLL_MS = 250

let showButton = true

const EMPTY: View = { model: '', models: [], effort: '', mods: [], note: '', busy: '' }
const view = atom({ plugin: 'box-tools', key: 'view' } as const, EMPTY)

// The model as /config holds it, and the plain choices it offers.
async function readModel($: EngineInterface): Promise<Pick<View, 'model' | 'models'>> {
  try {
    const row = (await $.config.list()).find(r => r.key === 'model')
    if (!row || row.isLocked) return { model: '', models: [] }
    return { model: String(row.value), models: modelChoices(row.options) }
  } catch {
    return { model: '', models: [] }
  }
}

async function readMods($: EngineInterface) {
  try {
    const { exitCode, stdout } = await $.process.run(['claude', 'plugin', 'list', '--json'])
    return exitCode === 0 ? parseMods(stdout) : undefined
  } catch {
    return undefined
  }
}

// /effort saves the level per model (`modelSettings`), over the top-level default.
async function readEffort($: EngineInterface): Promise<string> {
  try {
    const [settings, modelId] = await Promise.all([$.settings.read(), $.session.model()])
    const perModel = (settings as { modelSettings?: Record<string, { effortLevel?: unknown }> }).modelSettings
    const level = perModel?.[modelId]?.effortLevel ?? settings.effortLevel
    return typeof level === 'string' ? level : ''
  } catch {
    return ''
  }
}

async function refresh($: EngineInterface) {
  const [model, mods, effort] = await Promise.all([readModel($), readMods($), readEffort($)])
  await update($, view, (v): View => ({
    ...v,
    ...model,
    effort: effort || v.effort,
    mods: mods ?? v.mods,
    note: mods === undefined ? "Couldn't read your installed plugins." : v.note,
  }))
}

// Effort colors follow the theme, cool to hot, like the status line's.
const EFFORT_COLORS: Record<string, string> = { low: 'success', medium: 'suggestion', high: 'warning', xhigh: 'error', max: 'error' }

const PANE_ARGS = { id: PANE, title: 'Tools', focus: true, closeOnEscape: true, columns: 74, rows: 24 } as const

// Set while a change runs, and for a moment after: the command it runs takes the keyboard,
// sometimes just after it has finished, and that is not a click away.
let isChanging = false
let graceUntil = 0
const GRACE_MS = 1000

// One change at a time: a press while another runs is ignored.
async function run($: EngineInterface, busy: string, work: () => Promise<Partial<View>>) {
  if (isChanging || (await read($, view)).busy) return
  isChanging = true
  try {
    await update($, view, (v): View => ({ ...v, busy, note: '' }))
    const changed = await work().catch((err: unknown): Partial<View> => ({ note: `Failed: ${firstLine(String(err))}` }))
    await update($, view, (v): View => ({ ...v, ...changed, busy: '' }))
  } finally {
    isChanging = false
    graceUntil = (await $.clock.now()) + GRACE_MS
  }
  await takeKeyboard($)
}

// A command run from the box (/effort, /reload-plugins) hands the keyboard to the prompt, and an
// open pane can't ask for it again: open the box afresh, which takes it over the empty prompt.
async function takeKeyboard($: EngineInterface) {
  const pane = (await $.ui.panes()).find(p => p.id === PANE)
  if (!pane || pane.isFocused) return
  await $.ui.close({ id: PANE }).catch(() => undefined)
  const opened = await $.ui.open(PANE_ARGS).catch(() => undefined)
  if (opened?.isPlaced) watchFocus($)
}

const setModel = async ($: EngineInterface, model: string) => {
  if ((await read($, view)).model === model) return void (await update($, view, (v): View => ({ ...v, note: `Already on ${title(model)}.` })))
  return run($, `Switching to ${title(model)}…`, async () => {
    const r = await $.config.set({ key: 'model', value: model })
    if ('deny' in r && r.deny) return { note: `Model not changed: ${r.deny}` }
    // Effort is kept per model: show the new model's.
    const effort = await readEffort($)
    return { model, ...(effort ? { effort } : {}), note: `Model set to ${title(model)}.` }
  })
}

const setEffort = async ($: EngineInterface, effort: string) => {
  if ((await read($, view)).effort === effort) return void (await update($, view, (v): View => ({ ...v, note: `Effort is already ${effort}.` })))
  return run($, `Setting effort to ${effort}…`, async () => {
    // The built-in /effort, as if typed: it waits until Claude is idle.
    const r = await $.command.run({ command: 'effort', args: effort })
    const said = firstLine('text' in r ? r.text : undefined).split(':')[0] ?? ''
    return { effort, note: said ? `${said}.` : `Effort set to ${effort}.` }
  })
}

const toggleMod = ($: EngineInterface, id: string, name: string, on: boolean) =>
  run($, `Turning ${name} ${on ? 'on' : 'off'}…`, async () => {
    const r = await $.process.run(['claude', 'plugin', on ? 'enable' : 'disable', id])
    if (r.exitCode !== 0) return { note: `${name} not changed: ${firstLine(r.stderr || r.stdout) || `exit ${r.exitCode}`}` }
    await update($, view, (cur): View => ({
      ...cur,
      mods: cur.mods.map(m => (m.id === id ? { ...m, isEnabled: on } : m)),
      note: `${name} ${on ? 'on' : 'off'}. Reloading plugins…`,
      busy: '',
    }))
    // Reloads this mod too: the box stays open and its state is kept.
    void $.command.run({ command: 'reload-plugins' }).catch(() => undefined)
    return {}
  })

// Click-away: once the box has had the keyboard, losing it (a click in the transcript or the prompt) closes it.
let watch: Timer | undefined
let hadFocus = false

function stopWatch() {
  watch?.cancel()
  watch = undefined
}

function watchFocus($: EngineInterface) {
  stopWatch()
  hadFocus = false
  watch = $.clock.every(FOCUS_POLL_MS, () => {
    void (async () => {
      if (isChanging) return
      const pane = (await $.ui.panes()).find(p => p.id === PANE)
      if (!pane) return stopWatch()
      if (pane.isFocused) hadFocus = true
      else if ((await $.clock.now()) < graceUntil) await takeKeyboard($)
      else if (hadFocus) {
        stopWatch()
        await $.ui.close({ id: PANE }).catch(() => undefined)
      }
    })()
  })
}

async function isOpen($: EngineInterface) {
  return (await $.ui.panes()).some(p => p.id === PANE)
}

// The footer button and /tools both toggle the box.
async function toggle($: EngineInterface): Promise<boolean> {
  if (await isOpen($)) {
    stopWatch()
    await $.ui.close({ id: PANE }).catch(() => undefined)
    return false
  }
  await update($, view, (v): View => ({ ...v, note: '' }))
  void refresh($)
  const opened = await $.ui.open(PANE_ARGS)
  if (opened.isPlaced) watchFocus($)
  return opened.isPlaced
}

export const register: Register = (on, options) => {
  showButton = options.button !== 'hide'

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'tools', description: 'box-tools: open the Tools box (model, effort, mods)' })
    // A reload with the box open (after a mod toggle) picks the fresh plugin list up
    // and takes the keyboard back once /reload-plugins has finished with it.
    if (await isOpen($)) {
      void refresh($)
      graceUntil = (await $.clock.now()) + GRACE_MS
      watchFocus($)
      $.clock.after(300, () => void takeKeyboard($))
    }
    return next(e)
  })

  on('command.run', { command: 'tools' }, async $ => {
    const isShown = await toggle($)
    return { text: isShown ? 'Tools box open. Esc or a click outside closes it.' : 'Tools box closed.' }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    stopWatch()
    return next(e)
  })

  // A Button is pressable in the band above the prompt or in a pane; the footer's mode labels
  // no longer take a click. So the Tools button is one right-aligned row of the band.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!showButton || e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" justifyContent="flex-end">
        <Button key="tools" plain onPress={() => void toggle($)}>
          <Text bold inverse color="claude">{' ✦ Tools '}</Text>
        </Button>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const v = await read($, view)
    const autoroute = v.mods.find(m => m.name === 'autoroute')
    const isFailure = /^(Failed|Couldn)|not changed|not available/i.test(v.note)

    // A chip is one choice: the current one is a filled pill in the section's color, the rest sit dim.
    const chip = (key: string, hotkey: string | undefined, label: string, isCurrent: boolean, color: string, onPress: () => void) => (
      <Button key={key} hotkey={hotkey} plain dimColor={!isCurrent} onPress={onPress}>
        {isCurrent
          ? <Text bold inverse color={color}>{` ● ${label} `}</Text>
          : <Text>{` ○ ${label} `}</Text>}
      </Button>
    )

    // A titled card: a rounded border in the section's color, the title on top.
    const card = (icon: string, name: string, color: string, hint: string, children: RenderChildren) => (
      <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold color={color}>{`${icon}  ${name}`}</Text>
          <Text dimColor>{hint}</Text>
        </Box>
        {children}
      </Box>
    )

    const modelName = v.model ? title(v.model) : '…'
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold color="claude">{'✦ Tools'}</Text>
          <Text dimColor>{`${modelName} · ${v.effort || '…'}`}</Text>
        </Box>
        {card('◆', 'Model', 'claude', '1-5', (
          <Box flexDirection="row" flexWrap="wrap">
            {v.models.length === 0 && <Text dimColor>Not available here (use /model).</Text>}
            {v.models.map((m, i) => chip(`model-${m}`, MODEL_KEYS[i], title(m), m === v.model, 'claude', () => void setModel($, m)))}
          </Box>
        ))}
        {card('⚡', 'Effort', 'warning', 'q w e r t', (
          <Box flexDirection="row" flexWrap="wrap">
            {EFFORTS.map((level, i) => chip(`effort-${level}`, EFFORT_KEYS[i], level, level === v.effort, EFFORT_COLORS[level] ?? 'warning', () => void setEffort($, level)))}
          </Box>
        ))}
        {card('❖', 'Mods', 'success', 'a s d …', (
          <Box flexDirection="column">
            {v.mods.length === 0 && <Text dimColor>No other daymods installed.</Text>}
            {v.mods.map((m, i) => (
              <Button key={`mod-${m.name}`} hotkey={MOD_KEYS[i]} plain dimColor={!m.isEnabled} onPress={() => void toggleMod($, m.id, m.name, !m.isEnabled)}>
                <Text bold={m.isEnabled} color={m.isEnabled ? 'success' : undefined}>{`${m.isEnabled ? '● on ' : '○ off'}  ${m.name}`}</Text>
              </Button>
            ))}
          </Box>
        ))}
        {autoroute?.isEnabled && <Text color="warning" dimColor>{'⚠ autoroute is on: it picks the model and effort per prompt, over these.'}</Text>}
        {(v.busy || v.note) && <Text color={v.busy ? 'suggestion' : isFailure ? 'error' : 'success'}>{v.busy ? `⏳ ${v.busy}` : `✓ ${v.note}`}</Text>}
        <Box flexDirection="row" columnGap={2}>
          <Button key="close" hotkey="x" plain dimColor onPress={() => void $.ui.close({ id: PANE }).catch(() => undefined)}>Close</Button>
          <Text dimColor>Esc or click away to close</Text>
        </Box>
      </Box>
    )
  })
}
