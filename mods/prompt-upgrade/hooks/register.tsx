import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import {
  ASK_SYSTEM, METHODS, REWRITE_SYSTEM,
  askPrompt, judge, methodLine, parseQuestions, parseRewrite, rewritePrompt, splitPrefix,
} from './upgrade'
import type { Answer, Background, Mode, Question, Rewrite, Verdict } from './upgrade'
import type { View } from '../types'

const MODE_KEY = 'mode'
const PANE = 'refine'

// Two colours and the default foreground: the accent (the theme's own Claude orange) marks where you are and what to act on,
// green marks what is done. Plain terminal colour names, so they read on any theme.
const ACCENT = 'claude' // Claude's orange; titles, frames, current step, keys
const DONE = 'green' // finished steps, the upgraded prompt
const REVIEW_QUESTION = 'Run this upgraded prompt?'
const MAX_REVISIONS = 3

let configMode: Mode = 'auto'
let mode: Mode = 'auto'
let isModeStored = false
let useHaiku = true
let wantsPane = true
let rewriteModel = 'sonnet'
let last: { request: string; verdict: string; method?: string } | undefined
// Set when the box was refilled: what the person sends from it next is theirs, not upgraded again.
let isRefilled = false
// A panel flow is under way: a second one waits its turn.
let isBusy = false
// The terminal's width, learnt from /refine; the panel opens at about 60% of it.
let termColumns = 0

type Outcome =
  | { kind: 'pass' } // send what was typed
  | { kind: 'run'; text: string }
  | { kind: 'edit'; text: string }
  | { kind: 'cancel' }

async function background($: EngineInterface): Promise<Background> {
  const b: Background = {}
  try {
    b.cwd = await $.session.cwd()
    const entries = await $.fs.list(b.cwd)
    b.entries = entries.map(e => e.name).filter(n => !n.startsWith('.')).slice(0, 40)
  } catch {
    // The folder is a hint, not a requirement.
  }
  try {
    const messages = await $.session.messages()
    b.recent = messages
      .filter(m => m.text.trim())
      .slice(-6)
      .map(m => ({ role: m.role, text: m.text.slice(0, 600) }))
  } catch {
    // Same for the conversation.
  }
  return b
}

const SKIP = 'Skip'
const LABELS = { run: 'Run it', edit: 'Edit it myself', original: 'Use my original', cancel: 'Cancel' } as const
const stripRecommended = (s: string) => s.replace(/\s*\(Recommended\)\s*$/i, '')

type Pick = { pick: keyof typeof LABELS | 'back' } | { change: string }

// Panel-only answers besides a choice or typed text.
const BACK = '\u0000back'
const SKIP_REST = '\u0000rest'
const CLOSED = '\u0000closed'

// Where the conversation happens: the engine's question dialog, or the side panel.
// ask() gives the answer, BACK, SKIP_REST, or undefined when the person closed it.
type Ui = {
  ask: (q: Question, index: number, total: number, answered?: string) => Promise<string | undefined>
  review: (r: Rewrite, round: number, canGoBack: boolean) => Promise<Pick>
  working: (note: string, stage: number) => Promise<void>
}

function toPick(answer: string): Pick {
  if (!answer) return { pick: 'cancel' }
  if (answer === BACK) return { pick: 'back' }
  for (const [pick, label] of Object.entries(LABELS)) if (answer === label) return { pick: pick as keyof typeof LABELS }
  // Typed under "Other" / the text field: what to change.
  return { change: answer }
}

// The engine's own question dialog: pick one of the choices, type under "Other", or Skip.
// The rewrite sits in the question text itself, so it is read before anything runs.
// It has no room for Back or Skip the rest: those are the panel's.
const dialogUi = ($: EngineInterface): Ui => ({
  ask: q => $.ui.ask(q.question, { options: [...q.options, SKIP], header: q.header }).catch(() => undefined),
  review: async r =>
    toPick(
      await $.ui
        .ask(`Method: ${methodLine(r)}\n\n${r.prompt}\n\n${REVIEW_QUESTION}`, { options: Object.values(LABELS), header: 'Review' })
        .then(a => a.trim(), () => ''),
    ),
  working: async () => undefined,
})

const IDLE: View = {
  step: 'idle', note: '', request: '', header: '', question: '', options: [], method: '', draft: '', round: 0,
  stage: 0, index: 0, total: 0, answered: '',
}
const view = atom({ plugin: 'prompt-upgrade', key: 'view' } as const, IDLE)

// The panel's buttons and field call answer(); the flow awaits waitFor().
let pending: ((value: string) => void) | undefined
const answer = (value: string) => {
  const resolve = pending
  pending = undefined
  resolve?.(value)
}
const waitFor = () => new Promise<string>(resolve => (pending = resolve))

const paneUi = ($: EngineInterface, request: string): Ui => ({
  working: async (note, stage) => void (await update($, view, (v): View => ({ ...v, step: 'working', note, request, stage }))),
  ask: async (q, index, total, answered) => {
    await update($, view, (v): View => ({
      ...v, step: 'ask', stage: 1, request, header: q.header, question: q.question, options: q.options,
      index, total, answered: answered ?? '',
    }))
    const a = await waitFor()
    return a === CLOSED ? undefined : a
  },
  review: async (r, round, canGoBack) => {
    await update($, view, (v): View => ({ ...v, step: 'review', stage: 3, request, method: methodLine(r), draft: r.prompt, round, total: canGoBack ? v.total : 0 }))
    const a = await waitFor()
    return toPick(a === CLOSED ? '' : a.trim())
  },
})

/**
 * Asks the questions from `startAt`, keeping earlier answers so Back can show them.
 * Back steps to the previous question; Skip the rest leaves the remaining ones open.
 */
async function askQuestions(ui: Ui, questions: Question[], answers: Answer[], startAt = 0): Promise<Answer[] | 'dismissed'> {
  const out = questions.map((q, i) => answers[i] ?? { question: q.question })
  let i = startAt
  while (i < questions.length) {
    const q = questions[i]!
    const picked = await ui.ask(q, i, questions.length, out[i]?.answer)
    if (picked === undefined) return 'dismissed'
    if (picked === BACK) {
      i = Math.max(0, i - 1)
      continue
    }
    if (picked === SKIP_REST) {
      for (let k = i; k < questions.length; k++) out[k] = { question: questions[k]!.question }
      break
    }
    const a = picked.trim()
    out[i] = { question: q.question, answer: a && a !== SKIP ? stripRecommended(a) : undefined }
    i++
  }
  return out
}

async function rewrite($: EngineInterface, request: string, answers: Answer[], b: Background, previous?: Rewrite, change?: string) {
  const r = await $.model
    .complete({
      model: rewriteModel,
      system: REWRITE_SYSTEM,
      prompt: rewritePrompt(request, answers, b, previous, change),
      effort: 'low',
      maxTokens: 1500,
      timeoutMs: 60000,
    })
    .catch(() => undefined)
  return r?.isAnswered ? parseRewrite(r.text) : undefined
}

/**
 * Haiku drafts the question. Undefined means "send the prompt as typed": it was clear
 * enough, or nothing usable came back. `forced`: the person asked for it (`/refine`, mode
 * always), so a clear prompt is still rewritten, just without a question.
 */
async function draft($: EngineInterface, request: string, forced: boolean, b: Background): Promise<Question[] | undefined> {
  const drafted = await $.model
    .complete({ model: 'haiku', system: ASK_SYSTEM, prompt: askPrompt(request, b, forced), effort: 'low', maxTokens: 800, timeoutMs: 20000 })
    .catch(() => undefined)
  const questions = drafted?.isAnswered ? parseQuestions(drafted.text) : undefined
  if (!forced && (questions === undefined || questions.length === 0)) {
    if (last) last.verdict = questions ? 'clear (Haiku)' : 'no question drafted'
    return undefined
  }
  return questions ?? []
}

// Ask, rewrite, review. Back from the review returns to the last question with the answers kept.
async function converse($: EngineInterface, ui: Ui, request: string, questions: Question[], b: Background): Promise<Outcome> {
  let answers: Answer[] = []
  let startAt = 0
  for (;;) {
    if (questions.length > 0) {
      const got = await askQuestions(ui, questions, answers, startAt)
      if (got === 'dismissed') return { kind: 'pass' }
      answers = got
    }

    await ui.working('Rewriting your prompt…', 2)
    let current = await rewrite($, request, answers, b)
    if (!current) {
      $.ui.toast("prompt-upgrade: couldn't rewrite it; sending your prompt as typed.")
      return { kind: 'pass' }
    }
    if (last) last.method = METHODS[current.method].label

    let wentBack = false
    for (let round = 0; ; round++) {
      const pick = await ui.review(current, round, questions.length > 0)
      if ('change' in pick) {
        if (round >= MAX_REVISIONS) return { kind: 'edit', text: current.prompt }
        await ui.working('Revising…', 2)
        const revised = await rewrite($, request, answers, b, current, pick.change)
        if (revised) current = revised
        else $.ui.toast("prompt-upgrade: couldn't revise it; showing the last version.")
        if (last) last.method = METHODS[current.method].label
        continue
      }
      if (pick.pick === 'back' && questions.length > 0) {
        wentBack = true
        break
      }
      if (pick.pick === 'run') return { kind: 'run', text: current.prompt }
      if (pick.pick === 'edit') return { kind: 'edit', text: current.prompt }
      if (pick.pick === 'original') return { kind: 'pass' }
      if (pick.pick === 'cancel') return { kind: 'cancel' }
    }
    if (wentBack) startAt = questions.length - 1
  }
}

const panelColumns = () => (termColumns > 0 ? Math.max(64, Math.round(termColumns * 0.6)) : 100)

/**
 * Opens the side panel and runs the conversation there, after the calling hook has returned:
 * a hook that waited on the person's clicks would outrun its time budget. False when no
 * panel could be drawn (narrow terminal, no surface): the caller falls back to the dialog.
 */
async function runInPanel($: EngineInterface, request: string, prefix: string, original: string, questions: Question[], b: Background): Promise<boolean> {
  if (!wantsPane || isBusy) return false
  const opened = await $.ui.open({ id: PANE, title: 'Refine prompt', focus: true, closeOnEscape: true, columns: panelColumns() }).catch(() => undefined)
  if (!opened?.isPlaced) {
    await $.ui.close({ id: PANE }).catch(() => undefined)
    return false
  }
  isBusy = true
  const ui = paneUi($, request)
  await ui.working('Thinking about your prompt…', 0)
  $.clock.after(0, () => {
    void (async () => {
      const out = await converse($, ui, request, questions, b).catch((): Outcome => ({ kind: 'pass' }))
      isBusy = false
      pending = undefined
      await update($, view, () => IDLE)
      await $.ui.close({ id: PANE }).catch(() => undefined)
      conclude($, out, prefix, original)
    })()
  })
  return true
}

// What happens to the prompt once the person has chosen.
function conclude($: EngineInterface, out: Outcome, prefix: string, original: string) {
  if (out.kind === 'run') void $.prompt.submit({ text: prefix + out.text, asUser: true })
  else if (out.kind === 'pass') void $.prompt.submit({ text: original, asUser: true })
  else refill($, out.kind === 'edit' ? prefix + out.text : original)
}

// Filled once the dropped submission has cleared the box.
function refill($: EngineInterface, text: string) {
  isRefilled = true
  $.clock.after(50, () => {
    void $.prompt.fill({ text }).then(r => {
      if (!r.isFilled) $.ui.log(`prompt-upgrade: couldn't fill the prompt box. The prompt was:\n${text}`)
    })
  })
}

function describeMode(m: Mode): string {
  if (m === 'auto') return 'auto: steps in on prompts that look vague'
  if (m === 'always') return 'always: steps in on every new task you type'
  return 'off: only /refine <prompt>'
}

function describeVerdict(v: Verdict): string {
  return `${v.kind} (${v.reason})`
}

export const register: Register = (on, options) => {
  configMode = options.mode === 'always' || options.mode === 'off' ? options.mode : 'auto'
  useHaiku = options.detector !== 'rules'
  rewriteModel = typeof options.rewriteModel === 'string' ? options.rewriteModel : 'sonnet'
  wantsPane = options.ui !== 'dialog'

  on('session.start', async ($, e, next) => {
    const stored = await $.store.get(MODE_KEY)
    isModeStored = stored === 'auto' || stored === 'always' || stored === 'off'
    mode = isModeStored ? (stored as Mode) : configMode
    await $.command.register({
      name: 'refine',
      description: 'prompt-upgrade: upgrade one prompt, or set when it steps in',
      argumentHint: '<prompt> | auto | always | off | status',
    })
    return next(e)
  })

  // The typing area posts its text when Enter is pressed in it.
  on('ui.message', async ($, e, next) => {
    const d = e.data as { kind?: string; text?: string } | undefined
    if (e.element.startsWith('editor-') && d?.kind === 'submit' && d.text) answer(d.text)
    return next(e)
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') answer(CLOSED)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const v = await read($, view)
    // Choices 1..n, then "Type my own answer" as the next number: it opens the question dialog to type in.
    const typeKey = String(v.options.length + 1)
    const choices = v.options.map((o, i) => (
      <Button key={`opt${i}`} hotkey={String(i + 1)} plain onPress={() => answer(o)}>
        {o}{v.answered === stripRecommended(o) ? '  ✓ your answer' : ''}
      </Button>
    ))
    // Typing happens in the panel's own wrapped text area (a Client, see editor.tsx). It takes keys
    // once focused; a click gives it focus, and the typing button tries to do the same.
    const Client = 'Client' in ui ? ui.Client : undefined
    const editorKey = `editor-${v.step}-${v.index}-${v.round}`
    const focusEditor = () =>
      void $.ui.focus({ requestId: PANE, key: editorKey }).then(
        r => 'deny' in r && $.ui.toast('Click the box under it, then type.'),
        () => undefined,
      )
    const editor = (placeholder: string) =>
      Client && <Client key={editorKey} module="./editor.tsx" width="100%" props={{ id: editorKey, placeholder }} />

    // The step bar, in its own frame: done is green ✓, current is bold ●, later is dim ○.
    const steps = ['Your prompt', v.total > 0 ? `Questions ${v.step === 'ask' ? `${v.index + 1}/${v.total}` : ''}`.trim() : 'Questions', 'Rewrite', 'Review']
    const bar = (
      <Box borderStyle="round" borderColor={ACCENT} borderDimColor paddingX={1} flexDirection="row" flexWrap="wrap" columnGap={1}>
        {steps.flatMap((name, i) => {
          const done = i < v.stage
          const now = i === v.stage
          const step = (
            <Text key={`step${i}`} color={done ? DONE : now ? ACCENT : undefined} bold={now} dimColor={i > v.stage}>
              {done ? '✓' : now ? '●' : '○'} {name}
            </Text>
          )
          return i < steps.length - 1 ? [step, <Text key={`sep${i}`} dimColor>›</Text>] : [step]
        })}
      </Box>
    )
    const isLast = v.index + 1 >= v.total

    // One dot per question: done green, current bold, later dim.
    const dots = Array.from({ length: v.total }, (_, i) => (
      <Text key={`dot${i}`} color={i < v.index ? DONE : i === v.index ? ACCENT : undefined} bold={i === v.index} dimColor={i > v.index}>
        {i < v.index ? '✓' : i === v.index ? '●' : '○'}
      </Text>
    ))

    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        <Text bold color={ACCENT}>✦ Refine your prompt</Text>
        {v.step !== 'idle' && bar}
        <Box flexDirection="column">
          <Text dimColor>YOUR PROMPT</Text>
          <Box paddingLeft={2}>
            <Text>{v.request.length > 300 ? `${v.request.slice(0, 300)}…` : v.request}</Text>
          </Box>
        </Box>
        {v.step === 'idle' && <Text dimColor>Nothing to refine right now.</Text>}
        {v.step === 'working' && <Text color={ACCENT}>⟳ {v.note}</Text>}
        {v.step === 'ask' && (
          <Box flexDirection="column" gap={1}>
            <Box borderStyle="round" borderColor={ACCENT} paddingX={1} paddingY={1} flexDirection="column" gap={1}>
              <Box flexDirection="row" columnGap={1}>
                <Text bold color={ACCENT}>{`QUESTION ${v.index + 1} OF ${v.total}`}</Text>
                <Box flexDirection="row" columnGap={1}>{dots}</Box>
                <Text dimColor>{v.header}</Text>
              </Box>
              <Text bold>{v.question}</Text>
              <Box flexDirection="column" paddingLeft={2}>
                {choices}
                <Button key="type" hotkey={typeKey} plain onPress={focusEditor}>
                  Type my own answer…{v.answered && !v.options.some(o => stripRecommended(o) === v.answered) ? `  ✓ "${v.answered}"` : ''}
                </Button>
                {editor('click here and type your answer, Enter to send')}
                <Button key="skip" hotkey="s" plain dimColor onPress={() => answer(SKIP)}>Skip this question</Button>
              </Box>
            </Box>
          </Box>
        )}
        {v.step === 'review' && (
          <Box flexDirection="column" gap={1}>
            <Box flexDirection="column">
              <Text bold color={DONE}>{v.round > 0 ? `Upgraded prompt (revision ${v.round})` : 'Upgraded prompt'}</Text>
              <Text dimColor>Method: {v.method}</Text>
            </Box>
            <Box borderStyle="round" borderColor={DONE} paddingX={1} paddingY={1}>
              <Text>{v.draft}</Text>
            </Box>
            <Box flexDirection="column" paddingLeft={2}>
              <Button key="run" hotkey="1" plain onPress={() => answer(LABELS.run)}>{LABELS.run}</Button>
              <Button key="edit" hotkey="2" plain onPress={() => answer(LABELS.edit)}>{LABELS.edit}</Button>
              <Button key="original" hotkey="3" plain onPress={() => answer(LABELS.original)}>{LABELS.original}</Button>
              <Button key="cancel" hotkey="4" plain onPress={() => answer(LABELS.cancel)}>{LABELS.cancel}</Button>
              <Button key="change" hotkey="5" plain onPress={focusEditor}>Ask for a change…</Button>
              {editor('click here and type what to change, Enter to send')}
              {v.total > 0 && <Button key="back" hotkey="b" plain onPress={() => answer(BACK)}>Back: change my answers</Button>}
            </Box>
          </Box>
        )}
        {v.step !== 'idle' && (
          // The way-out keys, always in one framed bar at the bottom: bright and bold, not dim.
          <Box borderStyle="round" borderColor={ACCENT} paddingX={1} flexDirection="row" flexWrap="wrap" columnGap={3}>
            {v.step === 'ask' && v.index > 0 && (
              <Button key="back" hotkey="b" plain onPress={() => answer(BACK)}><Text bold>Back</Text></Button>
            )}
            {v.step === 'ask' && !isLast && (
              <Button key="rest" hotkey="x" plain onPress={() => answer(SKIP_REST)}><Text bold>Skip the rest, rewrite now</Text></Button>
            )}
            <Text>
              <Text bold color={ACCENT}>Esc</Text>: <Text bold>Send my prompt as typed</Text>
            </Text>
          </Box>
        )}
      </Box>
    )
  })

  on('command.run', { command: 'refine' }, async ($, e) => {
    termColumns = e.presentation?.columns ?? termColumns
    const arg = e.args.trim()
    const word = arg.toLowerCase()

    if (word === 'on' || word === 'auto' || word === 'always' || word === 'off') {
      mode = word === 'on' ? 'auto' : word
      isModeStored = true
      await $.store.set(MODE_KEY, mode)
      return { text: describeMode(mode) }
    }

    if (word === '' || word === 'status') {
      return {
        text: [
          `Mode: ${describeMode(mode)} (${isModeStored ? 'set by /refine' : 'from /config'})`,
          `Detector: ${useHaiku ? 'rules + Haiku' : 'rules only'} · question by Haiku · rewrite by ${rewriteModel} · shown in the ${wantsPane ? 'side panel' : 'dialog'}`,
          `Last prompt: ${last ? `"${last.request.slice(0, 60)}" → ${last.verdict}${last.method ? ` → ${last.method}` : ''}` : 'none yet'}`,
          'Use /refine <prompt> to upgrade one prompt; /refine auto|always|off to change when it steps in.',
        ].join('\n'),
      }
    }

    const { prefix, body } = splitPrefix(arg)
    last = { request: body, verdict: 'asked with /refine' }
    $.ui.toast('Upgrading your prompt…')
    const b = await background($)
    const questions = (await draft($, body, true, b)) ?? []
    if (await runInPanel($, body, prefix, arg, questions, b)) return { text: 'Refining in the side panel.' }

    const out = await converse($, dialogUi($), body, questions, b).catch((): Outcome => ({ kind: 'pass' }))
    // A command may not submit while it holds the session; a timer runs once it has finished.
    $.clock.after(0, () => conclude($, out, prefix, arg))
    return { text: out.kind === 'run' || out.kind === 'pass' ? 'Sending the prompt.' : out.kind === 'edit' ? 'The upgraded prompt is going to the prompt box.' : 'Cancelled.' }
  })

  on('prompt.submit', async ($, e, next) => {
    // Only fresh prompts the person typed while the session was idle.
    if (e.command || e.isMeta || e.turnId || e.origin.kind !== 'composer' || (e.attachments?.length ?? 0) > 0) return next(e)
    if (mode === 'off' || isBusy) return next(e)
    if (isRefilled) {
      isRefilled = false
      return next(e)
    }

    const { prefix, body } = splitPrefix(e.text)
    let hasHistory = false
    try {
      hasHistory = (await $.session.messages()).length > 0
    } catch {
      // Treat as a fresh session.
    }
    const verdict = judge(body, mode, hasHistory)
    last = { request: body, verdict: describeVerdict(verdict) }
    if (verdict.kind === 'skip' || verdict.kind === 'clear') return next(e)
    if (verdict.kind === 'unsure' && !useHaiku) return next(e)

    $.ui.toast('Upgrading your prompt…')
    const b = await background($)
    const questions = await draft($, body, mode === 'always', b).catch(() => undefined)
    if (questions === undefined) return next(e)

    if (await runInPanel($, body, prefix, e.text, questions, b)) {
      return { drop: 'prompt-upgrade: refining in the side panel. Your prompt is sent when you choose.' }
    }
    const out = await converse($, dialogUi($), body, questions, b).catch((): Outcome => ({ kind: 'pass' }))
    if (out.kind === 'pass') return next(e)
    if (out.kind === 'run') return next({ ...e, text: prefix + out.text })
    if (out.kind === 'edit') {
      refill($, prefix + out.text)
      return { drop: 'prompt-upgrade: the upgraded prompt is in the prompt box to edit.' }
    }
    refill($, e.text)
    return { drop: 'prompt-upgrade: cancelled; your prompt is back in the box.' }
  })
}
