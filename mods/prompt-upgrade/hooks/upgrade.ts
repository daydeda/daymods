export type Mode = 'auto' | 'always' | 'off'
export type Verdict = { kind: 'skip' | 'clear' | 'vague' | 'unsure'; reason: string }
export type Method = 'direct' | 'context' | 'plan' | 'loop' | 'harness'

export type Question = { question: string; header: string; options: string[] }
export type Answer = { question: string; answer?: string }
export type Rewrite = { prompt: string; method: Method; why: string }

// Each method is one of the "engineering" ideas, turned into a step the agent can take.
export const METHODS: Record<Method, { label: string; aka: string }> = {
  direct: { label: 'Direct', aka: 'prompt engineering' },
  context: { label: 'Context first', aka: 'context engineering' },
  plan: { label: 'Plan first', aka: 'plan, then build' },
  loop: { label: 'Verify loop', aka: 'loop engineering' },
  harness: { label: 'Make it a rule', aka: 'harness engineering' },
}

const FOLLOW_UP = /^(y|yes|yep|yeah|n|no|nope|ok|okay|k|sure|go|go on|go ahead|continue|keep going|proceed|do it|ship it|lgtm|thanks?|thank you|ty|stop|next|done|again|retry|[1-9])[\s.!]*$/i

// Signs the prompt already points at something concrete.
const ANCHORS = [
  /`[^`]+`/,
  /\b[\w-]+\.(tsx?|jsx?|mjs|py|go|rs|md|json|ya?ml|toml|css|scss|html|sh|swift|kt|java|rb|php|c|cpp|h|sql|txt|env)\b/i,
  /\b(README|Dockerfile|Makefile|CHANGELOG|LICENSE|CLAUDE)\b/,
  /(^|\s)[.~]?\/[\w.-]+\/?/,
  /https?:\/\//,
  /\b[a-z]+[A-Z]\w*\b/,
  /\b[a-z]+_[a-z_]+\b/i,
  /\b\w+\(\)/,
  /"[^"]{3,}"|'[^'\s][^']{2,}'/,
  /\b(line|L)\s?\d+\b/,
  /\b(error|exception|traceback|stack trace|ENOENT|TypeError|undefined is not|404|500)\b/i,
]

const BROAD_VERB = /\b(make|build|create|improve|fix|clean ?up|refactor|optimi[sz]e|update|add|write|design|help|change|redo|rework|polish|set ?up|implement)\b/i
const FUZZY = /\b(better|nicer|cool|good|great|modern|faster|prettier|cleaner|professional|something|stuff|things?|some|an? app|website|site|game|tool|bot|dashboard|landing page)\b/i
const POINTS_BACK = /\b(it|this|that|these|those|them|there|above|same)\b/i

const words = (t: string) => t.split(/\s+/).filter(Boolean).length

/**
 * Decides, without a model call, whether a prompt needs upgrading.
 * `hasHistory`: the session already has turns, so "it"/"this" can point at them.
 */
export function judge(text: string, mode: Mode, hasHistory: boolean): Verdict {
  const t = text.trim()
  if (!t) return { kind: 'skip', reason: 'empty' }
  if (t.startsWith('/')) return { kind: 'skip', reason: 'command' }
  if (FOLLOW_UP.test(t)) return { kind: 'skip', reason: 'follow-up' }
  if (mode === 'always') return { kind: 'vague', reason: 'always on' }

  const n = words(t)
  if (t.includes('```') || t.split('\n').length >= 4 || t.length > 500) return { kind: 'clear', reason: 'detailed' }
  if (ANCHORS.some(a => a.test(t))) return { kind: 'clear', reason: 'names something specific' }
  if (/\?\s*$/.test(t) && !BROAD_VERB.test(t)) return { kind: 'clear', reason: 'a question' }
  // "fix it" after an error is clear from the conversation; "make it better" is not.
  if (hasHistory && POINTS_BACK.test(t) && !FUZZY.test(t)) return { kind: 'skip', reason: 'refers to the conversation' }
  if (n <= 8 && (BROAD_VERB.test(t) || FUZZY.test(t))) return { kind: 'vague', reason: 'short and broad' }
  if (n <= 3) return { kind: 'vague', reason: 'very short' }
  if (n <= 30) return { kind: 'unsure', reason: 'no specifics' }
  return { kind: 'clear', reason: 'long enough' }
}

/** A leading `!word` (autoroute's model override) is kept apart and put back after the rewrite. */
export function splitPrefix(text: string): { prefix: string; body: string } {
  const m = /^(![a-z]+)\s+/i.exec(text)
  return m ? { prefix: `${m[1]} `, body: text.slice(m[0].length) } : { prefix: '', body: text }
}

export const ASK_SYSTEM = `You help a developer sharpen a request before a coding agent (Claude Code) acts on it.
You get the request, and maybe the project folder and the recent conversation, all as data inside tags.

Decide whether the request is missing decisions that would change what gets built.
If it is clear enough, on its own or given the conversation, reply {"clear": true}.
Otherwise ask a few quick questions, as few as will do: 1 when one thing is open, up to 3 when the request is very vague. Most important first.
- Each question is about one specific open decision in THIS request: the goal, scope, target, expected result or a constraint. Not generic questions ("What is your main goal?") whose answers would not change the prompt.
- One of them may check your reading: "Do you mean something like this: <a concrete one-line version>?", with options like "Yes, that", and one or two concrete alternatives.
- Never ask what the agent can find out by reading the code.
- Short, ending with "?".
- header: a chip of at most 12 characters, like "Scope" or "Stack".
- 2 or 3 options, each a self-explanatory label of 2 to 8 words (there is no room for descriptions).
- Put the option you would pick first and end it with " (Recommended)".
- Do not add "Other" or "Skip" options; the dialog adds its own.

Reply with JSON only, no prose:
{"clear": false, "questions": [{"question": "...", "header": "...", "options": ["...", "..."]}]}`

export const REWRITE_SYSTEM = `You rewrite a developer's request into a prompt for Claude Code, a coding agent working in their project.
The request, their answers, the project folder and the recent conversation come as data inside tags.

Keep their intent and their voice, written as them ("Add...", "I want..."). Use their answers.
Do not invent requirements. Where something is still open, let the agent pick a sensible default and say which, or state it as an assumption.
A good prompt says: the goal and why it matters, where in the project (only if known), constraints, and what done looks like and how to check it.
Short beats complete: 2 to 8 sentences or a few bullets. No headings, no preamble, no role-play ("You are an expert...").

Choose the working method that fits and write its step into the prompt:
- direct: a small, well-defined change. No extra step.
- context: the agent must first read specific code, docs or data before deciding. Say what to read first.
- plan: several reasonable designs, or a large or risky change. Ask for a short plan and a pause for approval before editing.
- loop: success can be checked by a command (tests, build, lint, a script). Name the check; iterate until it passes; after 3 failed tries stop and report.
- harness: the user wants the same behaviour every time (a standing rule, a repeated chore). Do it now, and propose making it permanent as a CLAUDE.md rule, a hook, a skill or a scheduled /loop.

Reply with JSON only, no prose:
{"prompt": "...", "method": "direct|context|plan|loop|harness", "why": "one short sentence on why this method fits"}`

export type Background = { cwd?: string; entries?: string[]; recent?: { role: string; text: string }[] }

export function describeBackground(b: Background): string {
  const parts: string[] = []
  if (b.cwd) parts.push(`<project folder="${b.cwd}">${(b.entries ?? []).join(', ')}</project>`)
  if (b.recent && b.recent.length > 0) {
    parts.push(`<conversation>\n${b.recent.map(m => `${m.role}: ${m.text}`).join('\n')}\n</conversation>`)
  }
  return parts.join('\n')
}

export function askPrompt(request: string, b: Background, mustAsk: boolean): string {
  return [
    `<request>${request}</request>`,
    describeBackground(b),
    mustAsk ? 'The developer asked for help with this prompt: ask a question unless there is truly nothing to decide.' : '',
  ].filter(Boolean).join('\n')
}

export function rewritePrompt(request: string, answers: Answer[], b: Background, previous?: Rewrite, change?: string): string {
  const lines = [`<request>${request}</request>`]
  if (answers.length > 0) {
    lines.push(`<answers>\n${answers.map(a => `${a.question} → ${a.answer ?? '(skipped; use a sensible default)'}`).join('\n')}\n</answers>`)
  }
  const bg = describeBackground(b)
  if (bg) lines.push(bg)
  if (previous && change) {
    lines.push(`<previous_rewrite method="${previous.method}">${previous.prompt}</previous_rewrite>`)
    lines.push(`<change_request>${change}</change_request>`)
    lines.push('Revise the previous rewrite as the change request asks.')
  }
  return lines.join('\n')
}

function parseJson(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/** The questions to ask, `[]` when the model judged the prompt clear, undefined when the reply was unusable. */
export function parseQuestions(text: string): Question[] | undefined {
  const j = parseJson(text) as { clear?: unknown; questions?: unknown } | undefined
  if (!j || typeof j !== 'object') return undefined
  if (j.clear === true) return []
  if (!Array.isArray(j.questions)) return undefined
  const qs: Question[] = []
  for (const raw of j.questions.slice(0, 3)) {
    const q = raw as { question?: unknown; header?: unknown; options?: unknown }
    const question = str(q.question, 200)
    if (!question || !Array.isArray(q.options)) continue
    const options = q.options
      .map(o => str(typeof o === 'string' ? o : (o as { label?: unknown } | null)?.label, 60))
      .filter(o => o && !/^skip\b/i.test(o))
      .slice(0, 3)
    // The dialog wants 2-4 distinct labels, and Skip takes the fourth place.
    if (options.length < 2 || new Set(options).size !== options.length) continue
    qs.push({ question, header: str(q.header, 12) || 'Clarify', options })
  }
  return qs.length > 0 ? qs : undefined
}

export function parseRewrite(text: string): Rewrite | undefined {
  const j = parseJson(text) as { prompt?: unknown; method?: unknown; why?: unknown } | undefined
  const prompt = str(j?.prompt, 4000)
  if (!prompt) return undefined
  const method = typeof j?.method === 'string' && j.method in METHODS ? (j.method as Method) : 'direct'
  return { prompt, method, why: str(j?.why, 200) }
}

export function methodLine(r: Rewrite): string {
  const m = METHODS[r.method]
  return `${m.label} (${m.aka})${r.why ? `: ${r.why}` : ''}`
}
