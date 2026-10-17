<p align="center"><img src="images/banner.svg" alt="daymods: small mods for Claude Code" width="100%"></p>

<p align="center">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-34d399?style=flat-square"></a>
  <img alt="Claude Code 2.1.300+" src="https://img.shields.io/badge/Claude%20Code-2.1.300%2B-818cf8?style=flat-square">
  <img alt="mods" src="https://img.shields.io/badge/mods-4-f472b6?style=flat-square">
</p>

A collection of small mods for [Claude Code](https://claude.com/claude-code). Each mod is its own plugin, so you install only the ones you want.

Mods use Claude Code's hooks-module API, which is early access and may change between releases. They were built and tested on Claude Code 2.1.300.

## 🧩 Mods

| Mod | What it does |
| --- | --- |
| [autoroute](mods/autoroute) | Picks the model and effort for each prompt, sends subagents to cheaper models, and keeps Fable and extra-usage spend in check. |
| [prompt-upgrade](mods/prompt-upgrade) | Catches vague prompts, asks one quick multiple-choice question, rewrites the prompt with a working method, and lets you review it before it runs. |
| [box-tools](mods/box-tools) | A filled `✦ Tools` button in a row above the prompt. Click it for a small box where you switch the model, the effort, and each of your daymods on or off. |
| [pace-statusline](https://github.com/daydeda/claude-code-statusline) | A 4-line status line with limit bars, reset times and a pace prediction (`⚠ runs out today 4:19pm`) so you know before you hit the wall. Lives in its own repo. |

More mods will be added here as they are ready.

## 📦 Install

Add the marketplace once, then install any mod from it.

In a Claude Code session:

```
/plugin install autoroute --marketplace daydeda/daymods
```

Or from a shell:

```bash
claude plugin marketplace add daydeda/daymods
claude plugin install autoroute@daymods
claude plugin install prompt-upgrade@daymods
claude plugin install box-tools@daymods
claude plugin install pace-statusline@daymods
```

Answer `y` when asked to add the marketplace and pick a scope. The mod is active right away. Mods installed at the user scope load in every later session.

To remove one: `claude plugin uninstall autoroute`.

## 🧭 autoroute

Routes each prompt to a suitable model and effort, so small jobs stop burning Opus tokens and big jobs get a plan.

<p align="center"><img src="images/autoroute.svg" alt="autoroute choosing Haiku, Sonnet or Opus for four different prompts" width="100%"></p>

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

```mermaid
flowchart LR
  A([your prompt]) --> B{rules}
  B -->|clear| D[tier]
  B -->|unclear| C[Haiku classifier] --> D
  D --> E{plan and spend gate}
  E -->|Fable, not Max| F[Opus]
  E -->|limit near, extra usage on| G[Sonnet cap]
  E -->|ok| H[chosen model]
```

### Two spend rules

These apply to every request, whatever chose its model, and stay on even when routing is turned off.

- **Fable needs a Max plan.** autoroute reads your plan from the local Claude login record (`~/.claude.json`). Anything other than a Max plan, or a plan it cannot read, is downgraded from Fable to Opus. This covers the router, `!fable`, Fable picked in `/model`, and Fable subagents.
- **Spend guard.** If extra usage is switched on for your account and any limit window (5-hour or weekly) passes the threshold (90% by default), routes are capped at Sonnet and a warning shows in the status line.

The plan check reads a local file the user can edit. It prevents accidental charges; it is not a security boundary.

### Controls

- **Status line:** by default autoroute adds no row of its own. It writes the current route to `~/.claude/autoroute.state`, and a status line script can show it inline. [pace-statusline](https://github.com/daydeda/claude-code-statusline) does: `Opus ▶ high ⇢ Haiku·low ▶ ⌂ daymods`, plus a `⚠` note for downgrades or spend warnings. The `⇢` part is hidden once the running model matches the route. Set `display` to `line` to get autoroute's own row instead, for example `autoroute: Haiku · low · "typo" (rules)`.
- **Compact status line:** with pace-statusline, `STATUSLINE_COMPACT=1` folds ctx, 5-hour, weekly and session stats into one row with short bars. The reset countdown shows only past 50% used.
- **Override one prompt:** start a message with `!haiku`, `!sonnet`, `!opus`, `!fable` or `!max`. `!auto` routes normally.
- **`/route on|off|status`:** turn routing on or off, or show the last route, your plan, and the spend guard state.
- **Options** (in `/config`):
  - `classifier`: `rules+haiku` (default) or `rules` only. Rules-only makes no model call.
  - `display`: `statusline` (default) writes the route for your status line to show; `line` shows autoroute's own row.
  - `spendGuardPercent`: threshold for the spend guard, default `90`.

### Notes and limits

- The keyword rules are a starting point and will misjudge some prompts. Use `!` overrides, or `/route status` to see why a route was chosen.
- The model IDs are set in `mods/autoroute/hooks/route.ts`. If your Claude Code build uses different IDs, change them there.
- The Haiku classifier sends the start of your prompt (up to 4000 characters) to Haiku through your own Claude session. Nothing goes to any other service.

## ✨ prompt-upgrade

Turns a vague prompt like "make a todo app" into a clear one before Claude starts, and lets you check it first.

### How it works

1. **Spot vague prompts.** Quick local rules let most prompts straight through: follow-ups like "yes" or "continue", slash commands, questions, and anything that names a file, function, error or URL. Short, broad prompts ("make it better", "build a website") count as vague. Borderline ones get a quick Haiku check, which can also decide the prompt is already clear. "fix it" right after an error is left alone, because the conversation already says what "it" is.
2. **Ask a few quick questions.** Haiku drafts as few as will do: one when one thing is open, up to three for a very vague prompt. Each is about a specific open decision in your prompt (where it runs, what it saves, how big), and one may check its reading: "Do you mean something like this: …?". They appear one at a time in a **side panel** (see below). For each, pick a numbered choice, pick **Type my own answer…** (a wrapped text box appears under it), or **Skip**. Press Esc to send your prompt untouched.
3. **Rewrite.** Sonnet rewrites the prompt with your answer. It keeps your intent and adds the goal, where in the project, constraints and how to check it's done. It doesn't invent requirements: anything still open is left for Claude to pick a sensible default and say which.
4. **Review.** The panel shows the rewritten prompt and its method:
   - **Run it**: sends the rewrite.
   - **Edit it myself**: puts the rewrite in the prompt box for you to change and send.
   - **Use my original**: sends what you typed, unchanged.
   - **Cancel**: sends nothing, and your text goes back in the prompt box.
   - **Ask for a change…**: type what to change ("use Go", "smaller scope") in the text box under it, and it rewrites again.

The panel opens beside the transcript (or above the prompt). A step bar at the top shows where you are: `✓ Your prompt → ● Questions 2/3 → ○ Rewrite → ○ Review`. Keys:

- Questions: `1`-`3` pick a choice, the next number types your own answer, `s` skips the question, `x` skips the rest and rewrites now, `b` goes back to the previous question (your earlier answer is marked ✓).
- Review: `1`-`4` as above, `5` asks for a change, `b` goes back to the questions with your answers kept, then rewrites again.
- Always: `Esc` sends your prompt as typed. Back, Skip the rest and Esc sit together in a bar at the bottom of the panel.

Each question is its own card (`QUESTION 2 OF 3`, one dot per question). The panel uses Claude's orange for what is current and green for what is done, and opens at about 60% of the terminal width once you have run `/refine` once (100 columns before that).

**Typing your own answer.** Claude Code's text field is one line and cuts long text off, so the panel draws its own wrapped text box instead. Press the typing key (or click the box), type, and press Enter. It supports typing, Backspace and Ctrl+U to clear; there is no cursor movement. It is not available in the VS Code and mobile layouts, which only get the numbered choices and Skip.

The panel needs a terminal about 110 columns wide; on a narrower one it falls back to Claude Code's question dialog, with the rewrite shown inside the question. Set `ui` to `dialog` to always use the dialog.

### Methods

Each rewrite picks one working method and writes its step into the prompt:

| Method | Idea | What the prompt asks for |
| --- | --- | --- |
| Direct | prompt engineering | A clear spec and nothing else, for small well-defined changes. |
| Context first | context engineering | Read specific code, docs or data before deciding. |
| Plan first | plan, then build | A short plan and a pause for your OK before editing, for big or open-ended work. |
| Verify loop | loop engineering | A named check (tests, build, lint) and iterating until it passes, stopping after 3 failed tries. |
| Make it a rule | harness engineering | Do the task now, then suggest making it permanent as a CLAUDE.md rule, hook, skill or `/loop`. |

### Controls

- **`/refine <prompt>`**: upgrade one prompt on demand, whatever the mode.
- **`/refine auto|always|off`**: when it steps in. `auto` (default) handles vague prompts only, `always` every new task you type, `off` only `/refine <prompt>`.
- **`/refine status`**: the mode, and why the last prompt was or wasn't upgraded.
- **Options** (in `/config`): `mode`, `detector` (`rules+haiku` or `rules` alone), `ui` (`panel` or `dialog`), and `rewriteModel` (`sonnet` by default, or `haiku` or `opus`).

### Notes and limits

- It only steps in on prompts you type while Claude is idle. Prompts with images attached, prompts typed mid-turn, and prompts from other plugins go through untouched.
- A leading `!opus`-style autoroute override is kept in front of the rewritten prompt.
- An upgrade costs one small Haiku call, plus one Sonnet call if it rewrites, and adds a few seconds before the turn starts. The calls go through your own Claude session and send the prompt, the names of the top-level files in your project and the last few messages. Nothing goes to any other service.

## 🧰 box-tools

A filled orange `✦ Tools` pill sits in a row above the prompt. Click it and a small box opens beside the transcript:

```
✦ Tools                                       Opus · high
╭─────────────────────────────────────────────────────────╮
│ ◆  Model                                            1-5 │
│ 1: ○ Default 2: ○ Haiku 3: ○ Sonnet 4: ● Opus 5: ○ Fable │
╰─────────────────────────────────────────────────────────╯
╭─────────────────────────────────────────────────────────╮
│ ⚡ Effort                                    q w e r t │
│ q: ○ low  w: ○ medium  e: ● high  r: ○ xhigh  t: ○ max  │
╰─────────────────────────────────────────────────────────╯
╭─────────────────────────────────────────────────────────╮
│ ❖  Mods                                         a s d … │
│ a: ● on   autoroute                                     │
╰─────────────────────────────────────────────────────────╯
```

### Controls

- **Open:** click `✦ Tools`, or run `/tools`. Clicking the button again closes the box.
- **Pick:** click a choice, press its hotkey, or Tab to it and press Enter. Hotkeys: `1`-`5` for models, `q` `w` `e` `r` `t` for effort, `a` `s` `d`… for mods.
- **Close:** Esc, a click anywhere outside the box (the transcript or the prompt), `x`, or the button again.

### What each control does

- **Model** sets the `model` row of `/config`, the same as picking it there. It becomes your default for new sessions too.
- **Effort** runs the built-in `/effort <level>`, as if you typed it. Claude Code saves the level for the current model, so it carries over to new sessions.
- **Mods** lists the daymods you have installed (Box Tools itself is left out). A toggle runs `claude plugin enable` or `claude plugin disable`, then `/reload-plugins`, so the change applies right away and stays on or off in later sessions.

### Notes and limits

- When **autoroute** is on, it picks the model and effort for each prompt and overrides what you pick here. The box says so. Turn autoroute off in the same box to keep your pick.
- A change made while Claude is working waits until the turn ends, the same as a typed command.
- Mods loaded with `--plugin-dir` aren't installed, so they don't appear in the list.
- **Options** (in `/config`): `button` (`show` or `hide`). With `hide`, the band is left alone and `/tools` opens the box.

## 🛠 Development

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

## 📄 License

[MIT](LICENSE)
