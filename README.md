# dsh-alias

Define your own slash commands in DeepSeek Harness, from the composer or from
the Plugins page.

## What you get

```
/alias add gm summarize the repository in five bullets
/alias add rev /perf-review {args}
/alias add ship /cordis-review
/alias list
/alias remove gm
```

After that, `/gm`, `/rev src/app.ts`, and `/ship` are ordinary commands: they
show up in the composer's command directory and run without a model turn of
their own. The Plugins page gains an **Alias** card that edits the same set.

## Install

> **Install it as a bundle.** `dsh plugin add …` mounts the row from the
> package's own patch layer, which is what the settings editor can write to. A
> row added with `--patch` is an overlay: it disappears at the next start, and
> the Plugins card cannot save into it (the editor refuses a write an overlay
> would win).

```sh
dsh plugin --profile web add github:maci0/dsh-alias#v0.5.1
```

Pin a release tag: a bare `github:` spec floats on `main`. To upgrade, run the
same command with the newer tag, then restart `dsh web` (bundle layers compose
at boot).

The bundled `cordis.patch.yml` inserts the `alias` row.

## Commands

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

`/alias` with no verb lists the aliases; `/alias set` is a synonym for `add`,
and `rm` and `delete` are synonyms for `remove`.

## Configure

Aliases live in one settings field, the plugin's own row:

```yaml
- id: alias
  name: 'dsh-alias'
  config:
    aliases:
      gm: summarize the repository in five bullets
      rev: /perf-review {args}
```

## How it works

The field is `volatile()`, so the Plugins page's **Alias** card, `/alias`, and
the profile patch are three views of one document: a write from any of them
lands on the running instance with no remount. A deployment whose settings
document refuses writes still gets working aliases in every current session
until dsh restarts, and the reply says so. The card reports a write the host refuses.

The card's **Edit** control loads a row back into the form; the same write
adds and updates, and the button says which one it will do.

## Limits

- Aliases accept no attachments; the composer refuses a submission that carries
  any, rather than dropping them silently.
- A name typed in `/alias add` must already be lowercase; the card lowercases
  the name for you.

## Development

dsh loads plugins on Node `^22.19.0 || >=24.0.0`; development and tests run on
bun.

Plain JavaScript, no build step: `bun test` runs the suite over the host
half (`index.js`) and the browser half (`lib/client.js`) against structural
fakes of the harness surfaces they use, plus a composition test that mounts the
plugin in a real `@deepseek-ai/cordis` context.

```sh
bun install --frozen-lockfile
bun test
```

For local development, `dsh plugin --profile <name> add <path-to-checkout>`.

## Licence

MIT, see [LICENSE](LICENSE).
