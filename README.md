# dsh-alias

Define your own slash commands in DeepSeek Harness — from the composer or from
the Plugins page.

```
/alias add gm summarize the repository in five bullets
/alias add rev /perf-review {args}
/alias add ship /cordis-review && /perf-review
/alias list
/alias remove gm
```

After that, `/gm`, `/rev src/app.ts`, and `/ship` are ordinary commands: they
show up in the composer's command directory and run without a model turn of
their own.

## What a command does

`/alias add <name> <text>` registers `/<name>`. What `/<name>` does depends on
the text it stands for:

- **Text starting with `/` runs that command.** `/alias add rev /perf-review`
  makes `/rev --staged` equivalent to `/perf-review --staged`, including the
  `/perf-review` lifecycle row in the log. Nested aliases are allowed and stop
  after four levels, so a cycle is reported instead of hanging.
- **Anything else is queued to the agent as a prompt.** `/alias add gm good
  morning` turns `/gm now what` into a follow-up turn whose prompt is
  `good morning now what`. The message is attributed to the alias rather than
  to you, so mode commands such as `normal mode` inside an alias text cannot
  be mistaken for your own words.

`{args}` in the text is replaced with whatever you typed after the alias name;
when the text has no placeholder and you did type arguments, they are appended.
A name is lowercase letters, digits, `_` or `-`, must start with a letter, and
may not be `alias` or shadow another registered command.

## Install

`dsh plugin add dsh-alias`, or add the package to your profile's bundle list.
The bundled `cordis.patch.yml` inserts the `alias` row.

## Configuration

Aliases live in one settings field, the plugin's own row:

```yaml
- id: alias
  name: 'dsh-alias'
  config:
    aliases:
      gm: summarize the repository in five bullets
      rev: /perf-review {args}
```

The field is `volatile()`, so the Plugins page's **Alias** card, `/alias`, and
the profile patch are three views of one document — a write from any of them
lands on the running instance with no remount. A deployment whose settings
document refuses writes still gets working aliases for the session, and the
reply says it is session-only.

## Notes

- Aliases accept no attachments; the composer refuses a submission that carries
  any, rather than dropping them silently.
- `/alias` with no verb lists the aliases; `/alias set` is a synonym for `add`.

## Development

Plain JavaScript, no build step: `npm test` runs `node --test` over the host
half (`index.js`) and the browser half (`lib/client.js`) against structural
fakes of the harness surfaces they use.
