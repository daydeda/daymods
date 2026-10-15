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
}

declare module 'claude-code' {
  interface PluginState {
    'prompt-upgrade': { view: View }
  }
}
