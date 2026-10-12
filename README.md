# agent-activity

A Claude Code plugin that adds a live **Subagents** panel: what each subagent is doing, as it does it.

## What it shows

**The list**
- A header with the number of subagents, the time elapsed, a status bar with one segment per agent, and counts by
  state: ✓ done, ⠋ running, ! needs you, ✗ failed, ■ stopped.
- Filters: All, Active, Finished.
- A card per agent: its name, type and time running, its latest words, the command or file it is on now, and how many
  files it read and edited, commands it ran and tokens it used.
  - **Needs you** cards move to the top and say what the agent wants to do and how long it has waited.
  - **Done** cards show the start of the result; **failed** cards show the error.
- Past six agents, the ones that ended shrink to a single line each.
- **Clear finished**, **Stop all**, and **Try again** on a failed or stopped agent.

**One agent** (See activity, or open a subagent's transcript in the app)
- The task Claude gave the agent, then its transcript in order: its text as it writes it, and each tool call with the
  command's output underneath.
- **Stop**, **Try again**, and a message box with **Send** and **Send now** (Send now stops the agent first, so the
  message starts it again at once).
- ↑ ↓ to move between agents.

**Above the prompt**, while agents run: `⠋ 3 subagents · 2 running · 1 done` and a **Show** button, plus a line for any
agent that needs you.

**Keys**, while the panel has focus: `1` `2` `3` the filters, `c` clear finished; in one agent's view `b` back,
`k` / `j` the agent above or below, `x` stop, `r` try again.

The panel opens when the first subagent starts. `/subagents` opens it at any time.

## Install

In a Claude Code terminal session:

```
/plugin install agent-activity --marketplace stefanivic/agent-activity
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session, the desktop app's Code tab
included).

The plugin is built on Claude Code's plugin API, which is in early access and may change between Claude Code
releases; a release that changes it can break the panel until the plugin is updated.

## Limits

These come from what Claude Code lets a plugin do, not from this plugin:

- **Approvals** are still answered in Claude's own permission prompt; a card can't hold Allow and Deny.
- **Messaging an agent doesn't work in auto mode**: auto mode's classifier refuses a message no request in the
  conversation asked for, so in auto mode the panel shows a note instead of the message box. The panel learns the mode
  when a subagent starts or an approval is asked, so just after a mode switch it may show the old one.
- **No plan or "Step 3 of 7"**: subagents have neither TodoWrite nor the task tools to keep one.
- **Command output appears when the command ends**, not while it runs. A command an agent runs in the background shows
  as finished at once.
- **No Pause, queued agents or time estimates.**
- **In the desktop app, the first click after Claude replies only focuses the panel**: Claude's reply moves focus to the
  chat input, and the app spends the next click on giving the panel focus back.

## Develop

`hooks/register.tsx` collects what the agents do, `hooks/view.tsx` draws the panel and the line above the prompt,
`hooks/activity.ts` holds the logic both share, and `types/index.d.ts` declares the state the panel keeps.

Run a working copy in a session with `claude --plugin-dir <this folder>`. Claude Code writes the API's type
declarations into `.claude-plugin/types/` when it loads the plugin; after that `tsc -p .` type-checks it. Check and test
it with:

```
claude plugin validate .
claude plugin test .
```

## License

[MIT](LICENSE)
