import type { ClientModule } from 'claude-code'

// A small typing area for the refine panel: the whole text, wrapped, in one place.
// Claude Code's own text field is a single line that cuts long text off, so this draws its own.
type Props = { id: string; placeholder: string }
type State = { text: string }

const ACCENT = 'claude'
const NAMED = new Set([
  'up', 'down', 'left', 'right', 'return', 'tab', 'backspace', 'delete', 'pageup', 'pagedown', 'home', 'end',
  'insert', 'escape', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
])

// The text lives here, not in the closure, so a burst of keys (a paste) never loses characters.
let buffer = ''
let current = ''

const Editor: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  if (props.id !== current) {
    current = props.id
    buffer = ''
  }

  surface.onKey(event => {
    if (event.key === 'return') {
      const text = buffer.trim()
      if (text) surface.post({ kind: 'submit', id: props.id, text })
      return
    }
    if (event.key === 'backspace' || event.key === 'delete') buffer = [...buffer].slice(0, -1).join('')
    else if (event.ctrl && event.key === 'u') buffer = ''
    else if (!event.ctrl && !event.meta && !NAMED.has(event.key)) buffer += event.key
    else return
    surface.setState({ text: buffer })
  })

  return (
    <Box flexDirection="row" paddingLeft={2} columnGap={1}>
      <Text bold color={ACCENT}>›</Text>
      {buffer ? <Text wrap="wrap">{buffer}▌</Text> : <Text dimColor>{props.placeholder}</Text>}
    </Box>
  )
}

export default Editor
