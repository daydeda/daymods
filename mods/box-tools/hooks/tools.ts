// Pure helpers: no `$`, so they can be read and tested on their own.

import type { Mod } from '../types'

export const SELF = 'box-tools'
export const MARKETPLACE = 'daymods'

// The plain model choices, in the order the box shows them; `/config` may offer more.
const MODEL_CHOICES = ['default', 'haiku', 'sonnet', 'opus', 'fable'] as const
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

// Hotkeys inside the box: digits for models, the qwert row for effort, asdfg… for mods.
export const MODEL_KEYS = ['1', '2', '3', '4', '5']
export const EFFORT_KEYS = ['q', 'w', 'e', 'r', 't']
export const MOD_KEYS = ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l']

export function modelChoices(options: readonly string[] | undefined): string[] {
  if (!options) return []
  return MODEL_CHOICES.filter(m => options.includes(m))
}

export const title = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s)

/**
 * The installed daymods, from `claude plugin list --json`. Box Tools itself is left out:
 * turning it off from its own box would take the box away.
 */
export function parseMods(json: string): Mod[] | undefined {
  let list: unknown
  try {
    list = JSON.parse(json)
  } catch {
    return undefined
  }
  if (!Array.isArray(list)) return undefined
  const mods: Mod[] = []
  for (const p of list) {
    if (!p || typeof p !== 'object') continue
    const { id, enabled } = p as { id?: unknown; enabled?: unknown }
    if (typeof id !== 'string') continue
    const [name, marketplace] = id.split('@')
    if (marketplace !== MARKETPLACE || !name || name === SELF) continue
    mods.push({ id, name, isEnabled: enabled === true })
  }
  return mods.sort((a, b) => a.name.localeCompare(b.name))
}

// The first line of a command's output, for the note under the controls.
export function firstLine(text: string | undefined): string {
  return (text ?? '').split('\n').map(l => l.trim()).find(Boolean) ?? ''
}
