export type Step = 'idle' | 'working' | 'ask' | 'review'

// What the side panel shows: one step of the refine flow at a time.
export type View = {
  step: Step
  note: string
  request: string
  header: string
  question: string
  options: string[]
  method: string
  draft: string
  round: number
  // The step bar: 0 your prompt, 1 questions, 2 rewrite, 3 review.
  stage: number
  // Which question is shown (0-based) of how many, and the answer given before, if any.
  index: number
  total: number
  answered: string
}

declare module 'claude-code' {
  interface PluginState {
    'prompt-upgrade': { view: View }
  }
}
