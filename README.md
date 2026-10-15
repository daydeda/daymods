# daymods

A collection of small mods for [Claude Code](https://claude.com/claude-code). Each mod is its own plugin, so you install only the ones you want.

Mods use Claude Code's hooks-module API, which is early access and may change between releases. They were built and tested on Claude Code 2.1.300.

## Mods

| Mod | What it does |
| --- | --- |
| [autoroute](mods/autoroute) | Picks the model and effort for each prompt, sends subagents to cheaper models, and keeps Fable and extra-usage spend in check. |

| [pace-statusline](https://github.com/daydeda/claude-code-statusline) | A 4-line status line with limit bars, reset times and a pace prediction (`⚠ runs out today 4:19pm`) so you know before you hit the wall. Lives in its own repo. |

More mods will be added here as they are ready.

## Install

Add the marketplace once, then install any mod from it.

In a Claude Code session:

```
/plugin install autoroute --marketplace daydeda/daymods
```

Or from a shell:

```bash
claude plugin marketplace add daydeda/daymods
claude plugin install autoroute@daymods
claude plugin install pace-statusline@daymods
```

Answer `y` when asked to add the marketplace and pick a scope. The mod is active right away. Mods installed at the user scope load in every later session.

To remove one: `claude plugin uninstall autoroute`.

## autoroute

Routes each prompt to a suitable model and effort, so small jobs stop burning Opus tokens and big jobs get a plan.

### How it works

1. **Pick a route per prompt.** When you send a message, quick keyword and length rules choose a tier. If the rules cannot tell, a low-effort Haiku call decides. The choice is locked for the whole reply, so the prompt cache stays warm instead of being rebuilt on every step.

   | Tier | Typical prompts | Model | Effort |
   | --- | --- | --- | --- |
   | trivial | a question, typo, rename, quick lookup | Haiku | low |
   | normal | a feature or fix in 1-3 files | Sonnet | medium |
   | hard | tricky debugging, design, refactors | Opus | high |
   | large | migrations, rewrites, architecture | Opus | high, plus a delegation plan |

   Short follow-ups like "continue" or "yes" keep the previous route.

2. **Delegate large work.** For the large tier, autoroute tells the model to work as a pipeline: Explore subagents map the code, a plan is written to a file, then a Sonnet subagent implements it. Other tiers are told to work directly.

3. **Route subagents.** Explore agents run on Haiku at low effort, Plan agents on Opus, and any other subagent with no model set runs on Sonnet.

### Two spend rules

These apply to every request, whatever chose its model, and stay on even when routing is turned off.

- **Fable needs a Max plan.** autoroute reads your plan from the local Claude login record (`~/.claude.json`). Anything other than a Max plan, or a plan it cannot read, is downgraded from Fable to Opus. This covers the router, `!fable`, Fable picked in `/model`, and Fable subagents.
- **Spend guard.** If extra usage is switched on for your account and any limit window (5-hour or weekly) passes the threshold (90% by default), routes are capped at Sonnet and a warning shows in the status line.

The plan check reads a local file the user can edit. It prevents accidental charges; it is not a security boundary.

### Controls

- **Status line:** shows the current route, for example `autoroute: Haiku · low · "typo" (rules)`, plus any downgrade notes or spend warnings.
- **Override one prompt:** start a message with `!haiku`, `!sonnet`, `!opus`, `!fable` or `!max`. `!auto` routes normally.
- **`/route on|off|status`:** turn routing on or off, or show the last route, your plan, and the spend guard state.
- **Options** (in `/config`):
  - `classifier`: `rules+haiku` (default) or `rules` only. Rules-only makes no model call.
  - `spendGuardPercent`: threshold for the spend guard, default `90`.

### Notes and limits

- The keyword rules are a starting point and will misjudge some prompts. Use `!` overrides, or `/route status` to see why a route was chosen.
- The model IDs are set in `mods/autoroute/hooks/route.ts`. If your Claude Code build uses different IDs, change them there.
- The Haiku classifier sends the start of your prompt (up to 4000 characters) to Haiku through your own Claude session. Nothing goes to any other service.

## Development

Each mod lives in `mods/<name>/` with the standard layout:

```
mods/<name>/
├── .claude-plugin/plugin.json
├── hooks/hooks.json
├── hooks/register.ts
└── tests/
```

Check and test a mod with:

```bash
claude plugin validate mods/autoroute
claude plugin test mods/autoroute
```

Try one without installing it: `claude --plugin-dir mods/autoroute`.

## License

[MIT](LICENSE)
