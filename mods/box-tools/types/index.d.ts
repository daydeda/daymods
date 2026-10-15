export type Mod = { id: string; name: string; isEnabled: boolean }

// What the Tools box shows.
export type View = {
  model: string
  models: string[]
  effort: string
  mods: Mod[]
  // One line under the controls: what the last change did, or why it didn't.
  note: string
  // Set while a change is running, so a second press waits.
  busy: string
}

declare module 'claude-code' {
  interface PluginState {
    'box-tools': { view: View }
  }
}
