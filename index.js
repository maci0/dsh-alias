/**
 * dsh-alias: user-defined slash commands, as a DeepSeek Harness plugin.
 *
 * `/alias add <name> <text>` registers `/<name>`, `/alias remove <name>` drops
 * it, `/alias list` prints them; a bare `/alias` lists. The same aliases are
 * editable from the Plugins page, where this package's browser half renders the
 * row's configuration card (`lib/client.js`).
 *
 * One settings field carries the state: the `aliases` dictionary of the
 * plugin's own row in the profile patch.
 *
 * ```yaml
 * - id: alias
 *   name: 'dsh-alias'
 *   config:
 *     aliases: { gm: good morning, summarize the repo }
 * ```
 *
 * The field is `volatile()`, so a write from either surface updates the live
 * config reference in place, with no remount, and emits
 * `loader/volatile-update`; this half re-reads the dictionary there and
 * re-registers exactly the commands that changed. A deployment whose settings
 * document refuses the write still gets a working alias until dsh restarts, held
 * in a local overlay, and the reply says so.
 *
 * What `/<name>` does when invoked:
 *
 * - expanded text starting with `/` runs that command through `ctx.commands`,
 *   so `/alias add rev /perf-review` makes `/rev src/app.ts` equivalent to
 *   `/perf-review src/app.ts` (bounded to {@link MAX_DEPTH} nested expansions);
 * - anything else is queued to the agent as the ordinary follow-up prompt
 *   `/loop`-style, which is what makes `/alias add gm summarize the repo` a
 *   usable shortcut.
 *
 * `{args}` in the text is replaced with whatever follows the alias name; when
 * the text has no placeholder and the caller typed arguments, they are
 * appended.
 *
 * This file is plain JavaScript on purpose, like `dsh-loop`: the plugin needs
 * no build step, no bundled runtime, and `bun test` runs the suite on the
 * sources directly.
 *
 * @module dsh-alias
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import Schema from '@deepseek-ai/schemastery'

/** Plugin name as it appears in the loader. */
export const name = 'alias'

/**
 * Row id this plugin's browser card is keyed by: the Plugins page pairs
 * `plugins.row.config` entry `dsh-alias#alias` with the settings namespace the
 * row declares, which is this same id.
 */
export const ROW_ID = 'alias'

/** The names the command registry accepts, and this plugin therefore allows. */
const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u

/** A complete slash-command line, split the way the registry splits it. */
const COMMAND_LINE = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u

/** Name of the management command itself: no alias may shadow it. */
const ALIAS_COMMAND = 'alias'

/** How far one alias may expand into another before the call is refused. */
export const MAX_DEPTH = 4

/**
 * Nested-expansion depth of the invocation chain currently running. Per async
 * chain, not per plugin: concurrent invocations (another session, another
 * plugin's nested command) must not count each other's nesting.
 */
const aliasDepth = new AsyncLocalStorage()

/** Longest alias text echoed in a description line or a listing. */
const PREVIEW_LIMIT = 72

/** Usage line shared by every rejected `/alias` form. */
const USAGE = 'Usage: /alias add <name> <text> (creates /<name>); '
  + '/alias remove <name>; /alias list. A name is lowercase letters, digits, `_` or `-`. '
  + 'Text may use {args} for whatever you type after the alias.'

/**
 * Configuration accepted from this plugin's row in a profile patch.
 *
 * `aliases` maps a command name (without the slash) to the text that command
 * expands to. It is the only editable field, it is `volatile()` so both
 * surfaces edit it live, and the `default({})` keeps the form present in a
 * deployment whose row states no aliases.
 *
 * `apply` receives the schema-resolved row, so the field is a live reference
 * rather than a value: read it with `.get()`, as the harness documents for
 * every volatile Config field.
 *
 * @typedef {{ readonly aliases: import('@deepseek-ai/cordis').Volatile<Record<string, string>> }} Config
 */
export const Config = Schema.object({
  aliases: Schema.dict(Schema.string()).default({}).volatile(),
})

/**
 * Parse the text after `/alias`.
 * @param {string} input - verbatim `rawInput` of the invocation.
 * @returns {{ kind: 'list' }
 *   | { kind: 'add', name: string, text: string }
 *   | { kind: 'remove', name: string }
 *   | { kind: 'error', text: string }} the requested verb.
 */
export function parseAliasInput(input) {
  const trimmed = input.trim()
  if (trimmed === '') return { kind: 'list' }
  const space = trimmed.search(/\s/u)
  const verb = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase()
  const rest = space === -1 ? '' : trimmed.slice(space + 1).trim()

  if (verb === 'list') return rest === '' ? { kind: 'list' } : { kind: 'error', text: USAGE }
  if (verb === 'add' || verb === 'set') {
    // The name and the text are separated by whitespace; the text keeps its own.
    const match = /^([a-z][a-z0-9_-]*)\s+([\s\S]+)$/u.exec(rest)
    if (match === null) return { kind: 'error', text: USAGE }
    const text = match[2].trim()
    if (text === '') return { kind: 'error', text: USAGE }
    return { kind: 'add', name: match[1], text }
  }
  if (verb === 'remove' || verb === 'rm' || verb === 'delete') {
    if (!COMMAND_NAME.test(rest)) return { kind: 'error', text: USAGE }
    return { kind: 'remove', name: rest }
  }
  return { kind: 'error', text: USAGE }
}

/**
 * Expand one alias into the line it stands for.
 * @param {string} text - the alias text as configured.
 * @param {string} args - what the caller typed after the alias name, trimmed.
 * @returns {string} the expanded text.
 */
export function expandAlias(text, args) {
  const expanded = text.includes('{args}') ? text.split('{args}').join(args) : text
  if (text.includes('{args}') || args === '') return expanded
  return `${expanded} ${args}`
}

/**
 * Freeze a freshly built message graph in place.
 * @template T
 * @param {T} value - the value to freeze, children included.
 * @returns {T} the same value.
 */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

/**
 * Build the follow-up prompt one alias expands to.
 *
 * Mirrors `createUserMessage` from `@deepseek-ai/dsh-llm/message` (a frozen,
 * freshly identified plain object) instead of importing the harness package:
 * this plugin then carries no runtime dependency beyond its Config schema, and
 * the suite runs against these sources without the harness installed. The
 * source is deliberately not `user`, so the terse-talk deactivation watchers
 * cannot mistake echoed text for the human's own words.
 * @param {string} text - the prompt the alias stands for.
 * @returns {object} a frozen user message ready for `agent.followup`.
 */
export function userMessage(text) {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'alias', form: 'relay' },
  })
}

/**
 * One-line rendering of an alias text for listings and descriptions.
 * @param {string} text - the alias text as configured.
 * @returns {string} whitespace-collapsed, bounded text.
 */
export function preview(text) {
  const collapsed = text.replace(/\s+/gu, ' ').trim()
  return collapsed.length <= PREVIEW_LIMIT
    ? collapsed
    : `${collapsed.slice(0, PREVIEW_LIMIT - 1)}…`
}

/**
 * Mount the plugin.
 * @param {object} ctx - the host context.
 * @param {Config} config - the row's resolved configuration.
 */
export function apply(ctx, config) {
  const warn = (message) => { console.warn(`[alias] ${message}`) }
  const message = (error) => (error instanceof Error ? error.message : String(error))

  /** Aliases already reported as unusable, so one bad row warns once. */
  const reported = new Set()

  /**
   * The configured dictionary, validated field by field: a hand-edited row can
   * name a command the registry refuses, and that must cost one warning rather
   * than the whole plugin.
   * @returns {Record<string, string>} name to text, invalid entries dropped.
   */
  const configured = () => {
    const raw = config.aliases.get()
    const aliases = {}
    if (raw === null || typeof raw !== 'object') return aliases
    for (const [aliasName, text] of Object.entries(raw)) {
      if (!COMMAND_NAME.test(aliasName) || aliasName === ALIAS_COMMAND) {
        if (!reported.has(aliasName)) {
          reported.add(aliasName)
          warn(`ignoring alias "${aliasName}": a name must match ${String(COMMAND_NAME)} and must not be "${ALIAS_COMMAND}"`)
        }
        continue
      }
      if (typeof text !== 'string' || text.trim() === '') {
        if (!reported.has(aliasName)) {
          reported.add(aliasName)
          warn(`ignoring alias "${aliasName}": its text must be a non-empty string`)
        }
        continue
      }
      aliases[aliasName] = text.trim()
    }
    return aliases
  }

  /**
   * Runtime aliases the settings document could not hold. They shadow the
   * document until it carries the same value, so an alias added on a read-only
   * deployment still works in every session until dsh restarts.
   * @type {Map<string, string>}
   */
  const local = new Map()

  /** @returns {Record<string, string>} the document's aliases overlaid by the runtime's. */
  const effective = () => ({ ...configured(), ...Object.fromEntries(local) })

  /** The injected `commands` scope, once the service is mounted. */
  let commandScope
  /**
   * Every alias command this instance owns, by name, with the text it was
   * registered for. `dispose` is absent when the registry refused the name
   * (another plugin already owns it), which keeps `sync` from retrying.
   * @type {Map<string, { text: string, dispose?: () => void }>}
   */
  const registered = new Map()

  const entryId = () => {
    const id = ctx.fiber?.entry?.options?.id
    return typeof id === 'string' ? id : undefined
  }
  const settingsService = () => ctx.get('settings')

  /**
   * Run one alias command.
   *
   * The nested-expansion depth rides the async context of this call, never a
   * shared variable: one counter for the whole plugin would count an expansion
   * suspended elsewhere in the process as this call's own nesting and refuse a
   * legitimate alias as a cycle.
   * @param {string} aliasName - the alias being invoked.
   * @param {object} invocation - the registry's command invocation.
   * @returns {Promise<object>} the command result the UI renders.
   */
  const invokeAlias = async (aliasName, invocation) => {
    const text = effective()[aliasName]
    if (text === undefined) {
      return { kind: 'error', text: `Alias "/${aliasName}" is no longer defined.` }
    }
    const line = expandAlias(text, invocation.rawInput.trim())

    if (!line.startsWith('/')) {
      // An ordinary prompt: queued as its own follow-up turn, exactly as if the
      // caller had typed the text.
      invocation.agent.followup(userMessage(line))
      return { kind: 'success', text: `/${aliasName}: ${preview(line)}` }
    }

    const parsed = COMMAND_LINE.exec(line)
    if (parsed === null || commandScope.commands.find(invocation.agent, parsed[1]) === undefined) {
      return {
        kind: 'error',
        text: `Alias "/${aliasName}" stands for ${preview(line)}, which is not a command this session can run.`,
      }
    }
    const depth = aliasDepth.getStore() ?? 0
    if (depth >= MAX_DEPTH) {
      return {
        kind: 'error',
        text: `Alias "/${aliasName}" expands more than ${MAX_DEPTH} levels deep; check the aliases for a cycle.`,
      }
    }
    try {
      const execution = await aliasDepth.run(
        depth + 1,
        () => commandScope.commands.execute(invocation.agent, line, [], invocation.signal),
      )
      return execution === undefined
        ? { kind: 'error', text: `Alias "/${aliasName}" could not run ${preview(line)}.` }
        : execution.result
    } catch (error) {
      return { kind: 'error', text: message(error) }
    }
  }

  /**
   * Register one alias command.
   * @param {string} aliasName - command name without the slash.
   * @param {string} text - the text it expands to.
   * @returns {boolean} whether the registry accepted the name.
   */
  const registerAlias = (aliasName, text) => {
    try {
      const dispose = commandScope.commands.register({
        name: aliasName,
        description: `↪ ${preview(text)}`,
        input: { hint: '{args}' },
        handler: (invocation) => invokeAlias(aliasName, invocation),
      })
      registered.set(aliasName, { text, dispose })
      return true
    } catch (error) {
      warn(`could not register "/${aliasName}": ${message(error)}`)
      registered.set(aliasName, { text })
      return false
    }
  }

  /**
   * Make the live registry match {@link effective}: drop commands whose alias
   * is gone or whose text moved, register the rest.
   */
  const sync = () => {
    if (commandScope === undefined) return
    const aliases = effective()
    for (const [aliasName, entry] of [...registered]) {
      if (aliases[aliasName] === entry.text) continue
      entry.dispose?.()
      registered.delete(aliasName)
    }
    for (const [aliasName, text] of Object.entries(aliases)) {
      if (!registered.has(aliasName)) registerAlias(aliasName, text)
    }
  }

  /**
   * Write one field operation through the settings document.
   * @param {Array<{ op: 'set' | 'unset', path: string[], value?: string }>} ops - the edit.
   * @returns {Promise<boolean>} whether the document accepted the write.
   */
  const persist = async (ops) => {
    const settings = settingsService()
    const id = entryId()
    if (settings === undefined || id === undefined) return false
    try {
      await settings.mutate(id, ops)
      return true
    } catch (error) {
      warn(`settings write refused: ${message(error)}`)
      return false
    }
  }

  /**
   * `/alias add <name> <text>`.
   * @param {string} aliasName - command name without the slash.
   * @param {string} text - the text it expands to.
   * @returns {Promise<object>} the command result.
   */
  const addAlias = async (aliasName, text) => {
    const previous = effective()[aliasName]
    // The runtime overlay lands first, so the alias works on this turn
    // even when the document refuses the write.
    local.set(aliasName, text)
    sync()
    if (registered.get(aliasName)?.dispose === undefined) {
      local.delete(aliasName)
      sync()
      return { kind: 'error', text: `"/${aliasName}" is already a registered command; pick another name.` }
    }
    if (!await persist([{ op: 'set', path: ['aliases', aliasName], value: text }])) {
      return {
        kind: 'success',
        text: `/${aliasName} is set until dsh restarts: the settings document did not accept the write.`,
      }
    }
    if (local.get(aliasName) === text) local.delete(aliasName) // leave any newer edit intact
    return {
      kind: 'success',
      text: previous === undefined
        ? `/${aliasName} now stands for: ${preview(text)}`
        : `/${aliasName} updated to: ${preview(text)}`,
    }
  }

  /**
   * `/alias remove <name>`.
   * @param {string} aliasName - command name without the slash.
   * @returns {Promise<object>} the command result.
   */
  const removeAlias = async (aliasName) => {
    if (!Object.hasOwn(effective(), aliasName)) {
      return { kind: 'error', text: `Unknown alias "/${aliasName}".` }
    }
    local.delete(aliasName)
    const persisted = await persist([{ op: 'unset', path: ['aliases', aliasName] }])
    sync()
    if (Object.hasOwn(effective(), aliasName)) {
      return {
        kind: 'error',
        text: local.has(aliasName)
          ? `/${aliasName} changed while it was being removed; the newer alias remains.`
          : persisted
            ? `/${aliasName} comes from the profile's composition layer; remove it there.`
            : `/${aliasName} could not be removed: the settings document did not accept the write.`,
      }
    }
    return {
      kind: 'success',
      text: persisted
        ? `Removed /${aliasName}.`
        : `Removed /${aliasName} until dsh restarts: the settings document did not accept the write.`,
    }
  }

  /**
   * `/alias list`.
   * @returns {object} the command result.
   */
  const listAliases = () => {
    const aliases = effective()
    const names = Object.keys(aliases).sort()
    if (names.length === 0) {
      return { kind: 'success', text: `No aliases defined. Add one with /alias add <name> <text>.` }
    }
    const lines = names.map((aliasName) => `  /${aliasName}  ${preview(aliases[aliasName])}`)
    return { kind: 'success', text: [`Aliases (${names.length}):`, ...lines].join('\n') }
  }

  /**
   * `/alias …`.
   * @param {object} invocation - the registry's command invocation.
   * @returns {Promise<object>} the command result.
   */
  const handleAlias = async (invocation) => {
    const parsed = parseAliasInput(invocation.rawInput)
    if (parsed.kind === 'error') return { kind: 'error', text: parsed.text }
    if (parsed.kind === 'list') return listAliases()
    if (parsed.kind === 'add') return addAlias(parsed.name, parsed.text)
    return removeAlias(parsed.name)
  }

  // The document is authoritative once it moves: a runtime alias the
  // write did land is dropped, and everything is re-registered from scratch.
  ctx.on('loader/volatile-update', () => {
    for (const [aliasName, text] of [...local]) {
      if (configured()[aliasName] === text) local.delete(aliasName)
    }
    sync()
  })

  ctx.inject(['commands'], (scope) => {
    commandScope = scope
    scope.commands.register({
      name: ALIAS_COMMAND,
      description: '⇄ Define slash-command aliases: /alias add <name> <text>, /alias remove <name>, /alias list',
      input: { hint: 'add <name> <text> | remove <name> | list' },
      handler: handleAlias,
    })
    sync()
    scope.effect(() => () => {
      for (const entry of registered.values()) entry.dispose?.()
      registered.clear()
      commandScope = undefined
    }, 'dsh-alias: alias commands')
  })
}
