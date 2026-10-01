/**
 * Host half: parsing, expansion, the command wiring, and the settings writes.
 *
 * The fake host is structural on purpose: it declares only the slice of
 * `ctx` this plugin reaches, so the suite runs without the harness installed.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply, expandAlias, MAX_DEPTH, parseAliasInput, preview, userMessage } from '../index.js'

/** Canonical slash-command shape, copied from the registry's own parser. */
const COMMAND_LINE = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u

/**
 * Warnings the plugin printed since the last mount. The plugin reports through
 * `console.warn`; the suite owns the process, so it captures the sink once.
 * @type {string[]}
 */
const warnings = []
console.warn = (message) => { warnings.push(String(message)) }

/**
 * Build one fake host.
 * @param {{ aliases?: Record<string, string>, acceptWrites?: boolean, commands?: string[] }} [options] - seed state.
 */
function harness(options = {}) {
  const state = {
    aliases: { ...(options.aliases ?? {}) },
    registered: new Map(),
    writes: [],
    follows: [],
    executions: [],
    volatile: [],
    warnings: [],
    acceptWrites: options.acceptWrites !== false,
  }
  for (const name of options.commands ?? []) {
    state.registered.set(name, { name, description: 'pre-existing', handler: () => ({ kind: 'success' }) })
  }

  const commands = {
    register(definition) {
      if (state.registered.has(definition.name)) {
        throw new Error(`command "${definition.name}" is already registered`)
      }
      state.registered.set(definition.name, definition)
      return () => { state.registered.delete(definition.name) }
    },
    find(_agent, name) { return state.registered.get(name) },
    async execute(agent, line, attachments, signal) {
      state.executions.push(line)
      const match = COMMAND_LINE.exec(line)
      if (match === null) return undefined
      const definition = state.registered.get(match[1])
      if (definition === undefined) return undefined
      const result = await definition.handler({
        commandId: 'cmd-1', agent, rawInput: line.slice(match[0].length), attachments, signal,
      })
      return { commandId: 'cmd-1', result }
    },
  }

  const settings = {
    async mutate(ns, ops) {
      state.writes.push({ ns, ops })
      if (!state.acceptWrites) throw new Error('the settings document is read-only')
      for (const op of ops) {
        if (op.op === 'set') state.aliases[op.path[1]] = op.value
        else delete state.aliases[op.path[1]]
      }
      for (const listener of state.volatile) listener()
    },
  }

  const ctx = {
    fiber: { entry: { options: { id: 'alias' } } },
    get(name) { return name === 'settings' ? settings : undefined },
    on(event, listener) {
      if (event === 'loader/volatile-update') state.volatile.push(listener)
      return () => {}
    },
    inject(dependencies, callback) {
      assert.deepEqual(dependencies, ['commands'])
      callback({
        commands,
        on: ctx.on,
        effect(callback2) { return callback2() },
      })
    },
  }

  return {
    state,
    ctx,
    agent: {
      followup(message) { state.follows.push(message) },
      session: { id: 'session-1' },
    },
  }
}

/** Mount the plugin over a fake host and reset the captured warnings. */
function mount(options = {}) {
  const { state, ctx, agent } = harness(options)
  warnings.length = 0
  apply(ctx, { aliases: { get: () => state.aliases } })
  return { state, agent, warnings, ctx }
}

/** Invoke a registered command the way the registry would. */
async function run(state, agent, line) {
  const match = COMMAND_LINE.exec(line)
  assert.notEqual(match, null, `"${line}" must be a command line`)
  const definition = state.registered.get(match[1])
  assert.notEqual(definition, undefined, `/${match[1]} must be registered`)
  return definition.handler({
    commandId: 'cmd-1',
    agent,
    rawInput: line.slice(match[0].length),
    attachments: [],
    signal: new AbortController().signal,
  })
}

test('parseAliasInput splits the three verbs', () => {
  assert.deepEqual(parseAliasInput(''), { kind: 'list' })
  assert.deepEqual(parseAliasInput('  list  '), { kind: 'list' })
  assert.deepEqual(parseAliasInput('add gm good morning'), { kind: 'add', name: 'gm', text: 'good morning' })
  assert.deepEqual(parseAliasInput('add gm   keep  the  spacing'), { kind: 'add', name: 'gm', text: 'keep  the  spacing' })
  assert.deepEqual(parseAliasInput('remove gm'), { kind: 'remove', name: 'gm' })
  assert.equal(parseAliasInput('add gm').kind, 'error')
  assert.equal(parseAliasInput('add GM text').kind, 'error')
  assert.equal(parseAliasInput('remove GM').kind, 'error')
  assert.equal(parseAliasInput('list now').kind, 'error')
  assert.equal(parseAliasInput('frobnicate').kind, 'error')
})

test('expandAlias fills {args} or appends them', () => {
  assert.equal(expandAlias('good morning', ''), 'good morning')
  assert.equal(expandAlias('good morning', 'world'), 'good morning world')
  assert.equal(expandAlias('/perf-review {args}', 'src/app.ts'), '/perf-review src/app.ts')
  assert.equal(expandAlias('/perf-review {args}', ''), '/perf-review ')
  assert.equal(expandAlias('/review {args} then {args}', 'x'), '/review x then x')
})

test('preview collapses whitespace and bounds the line', () => {
  assert.equal(preview('  a\n b  '), 'a b')
  assert.equal(preview('x'.repeat(200)).length, 72)
  assert.equal(preview('x'.repeat(200)).endsWith('…'), true)
})

test('userMessage is a frozen, alias-sourced user message', () => {
  const message = userMessage('hello')
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'alias')
  assert.deepEqual(message.content, [{ type: 'text', text: 'hello' }])
  assert.equal(Object.isFrozen(message), true)
  assert.equal(typeof message.id, 'string')
})

test('mounting registers /alias and every configured alias', async () => {
  const { state, agent } = mount({ aliases: { gm: 'good morning', rev: '/perf-review {args}' } })
  assert.equal(state.registered.has('alias'), true)
  assert.equal(state.registered.get('gm').description, '↪ good morning')

  const listed = await run(state, agent, '/alias list')
  assert.equal(listed.kind, 'success')
  assert.match(listed.text, /Aliases \(2\):/)
  assert.match(listed.text, / {2}\/gm {2}good morning/)
  assert.match(listed.text, / {2}\/rev {2}\/perf-review \{args\}/)

  assert.equal((await run(state, agent, '/alias')).kind, 'success')
})

test('a configured prompt alias queues the expanded text as a follow-up', async () => {
  const { state, agent } = mount({ aliases: { gm: 'good morning' } })
  const result = await run(state, agent, '/gm summarize the repo')
  assert.equal(result.kind, 'success')
  assert.equal(state.follows.length, 1)
  assert.equal(state.follows[0].content[0].text, 'good morning summarize the repo')
  assert.equal(state.follows[0].source.kind, 'alias')
  assert.equal(state.follows[0].role, 'user')
})

test('a configured slash alias runs the target command with the arguments', async () => {
  const { state, agent } = mount({ aliases: { rev: '/perf-review {args}' }, commands: ['perf-review'] })
  const result = await run(state, agent, '/rev src/app.ts')
  assert.deepEqual(state.executions, ['/perf-review src/app.ts'])
  assert.equal(result.kind, 'success')
})

test('an alias pointing at an unregistered command reports it', async () => {
  const { state, agent } = mount({ aliases: { gone: '/not-a-command' } })
  const result = await run(state, agent, '/gone')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /not a command this session can run/)
  assert.deepEqual(state.executions, [])
})

test('nested aliases stop at the depth bound instead of looping', async () => {
  const { state, agent } = mount({ aliases: { a: '/a' } })
  const result = await run(state, agent, '/a')
  assert.equal(result.kind, 'error')
  assert.match(result.text, new RegExp(`more than ${MAX_DEPTH} levels deep`))
  assert.equal(state.executions.length, MAX_DEPTH)
})

test('/alias add registers the command and writes the settings path', async () => {
  const { state, agent } = mount({ commands: ['perf-review'] })
  const added = await run(state, agent, '/alias add rev /perf-review {args}')
  assert.equal(added.kind, 'success')
  assert.deepEqual(state.writes, [{ ns: 'alias', ops: [{ op: 'set', path: ['aliases', 'rev'], value: '/perf-review {args}' }] }])
  assert.equal(state.registered.has('rev'), true)

  await run(state, agent, '/rev --staged')
  assert.deepEqual(state.executions, ['/perf-review --staged'])

  const updated = await run(state, agent, '/alias add rev /surgical-patch {args}')
  assert.equal(updated.kind, 'success')
  assert.match(updated.text, /updated to/)
  assert.equal(state.writes.length, 2)
})

test('/alias add refuses a name another plugin owns, without writing', async () => {
  const { state, agent } = mount({ commands: ['caveman'] })
  const taken = await run(state, agent, '/alias add caveman be terse')
  assert.equal(taken.kind, 'error')
  assert.match(taken.text, /already a registered command/)
  assert.deepEqual(state.writes, [])
  const own = await run(state, agent, '/alias add alias nope')
  assert.equal(own.kind, 'error')
  assert.deepEqual(state.writes, [])
})

test('/alias remove unregisters the command and clears the field', async () => {
  const { state, agent } = mount({ aliases: { gm: 'good morning', rev: '/perf-review' } })
  const removed = await run(state, agent, '/alias remove gm')
  assert.equal(removed.kind, 'success')
  assert.deepEqual(state.writes, [{ ns: 'alias', ops: [{ op: 'unset', path: ['aliases', 'gm'] }] }])
  assert.equal(state.registered.has('gm'), false)
  assert.equal(state.registered.has('rev'), true)

  const missing = await run(state, agent, '/alias remove gm')
  assert.equal(missing.kind, 'error')
  assert.match(missing.text, /Unknown alias/)
  assert.equal(state.writes.length, 1)
})

test('a refused settings write still leaves the alias usable until restart', async () => {
  const { state, agent, warnings } = mount({ acceptWrites: false })
  const added = await run(state, agent, '/alias add gm good morning')
  assert.equal(added.kind, 'success')
  assert.match(added.text, /until dsh restarts/)
  assert.equal(state.registered.has('gm'), true)
  assert.equal(warnings.some(line => line.includes('settings write refused')), true)

  await run(state, agent, '/gm now')
  assert.equal(state.follows.length, 1)

  const listed = await run(state, agent, '/alias list')
  assert.match(listed.text, /Aliases \(1\):/)

  const removed = await run(state, agent, '/alias remove gm')
  assert.equal(removed.kind, 'success')
  assert.equal(state.registered.has('gm'), false)
})

test('an alias a later settings write adopts stops shadowing the document', async () => {
  const { state, agent } = mount({ acceptWrites: false })
  await run(state, agent, '/alias add gm good morning')
  assert.equal(state.registered.has('gm'), true)

  // The document catching up must not fight the local overlay.
  state.aliases.gm = 'good morning'
  for (const listener of state.volatile) listener()
  assert.equal(state.registered.has('gm'), true)
  await run(state, agent, '/gm again')
  assert.equal(state.follows[0].content[0].text, 'good morning again')
})

test('removing a saved alias reports the refused write rather than blaming the composition layer', async () => {
  const { state, agent } = mount({ aliases: { gm: 'good morning' }, acceptWrites: false })
  const result = await run(state, agent, '/alias remove gm')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /settings document did not accept/)
  assert.equal(state.registered.has('gm'), true)
})

test('an older successful add cannot erase a newer add whose settings write fails', async () => {
  const { state, agent, ctx } = mount()
  const settings = ctx.get('settings')
  const mutate = settings.mutate.bind(settings)
  let finishFirst, failSecond
  const firstGate = new Promise(resolve => { finishFirst = resolve })
  const secondGate = new Promise(resolve => { failSecond = resolve })
  settings.mutate = async (ns, ops) => {
    if (ops[0].value === 'first') {
      await firstGate
      return mutate(ns, ops)
    }
    await secondGate
    throw new Error('second write refused')
  }
  const first = run(state, agent, '/alias add gm first')
  const second = run(state, agent, '/alias add gm second')
  finishFirst()
  await first
  failSecond()
  assert.equal((await second).kind, 'success', 'the refused write keeps a usable local alias')
  await run(state, agent, '/gm')
  assert.equal(state.follows.at(-1).content[0].text, 'second')
  assert.equal(state.aliases.gm, 'first', 'the document accepted only the first write')
})

test('invalid configured aliases are reported and skipped, not fatal', () => {
  const { state, warnings } = mount({
    aliases: { 'Bad Name': 'x', alias: 'x', empty: '   ', gm: 'good morning' },
  })
  assert.equal(state.registered.has('gm'), true)
  assert.equal(state.registered.has('Bad Name'), false)
  assert.equal(state.registered.has('empty'), false)
  assert.equal(warnings.length, 3)
  assert.match(warnings[0], /ignoring alias "Bad Name"/)
})

test('concurrent invocations do not share the nested-expansion depth guard', async () => {
  // Regression: the depth counter was one variable for the whole plugin
  // instance. A nested expansion suspended inside an async target command left
  // it non-zero, and the very next /alias invocation in the process was
  // refused as a cycle before it expanded anything.
  const { state, agent } = mount({
    aliases: { deep: '/d1', d1: '/d2', d2: '/d3', d3: '/slow', solo: '/slow' },
    commands: ['slow'],
  })
  let pending = []
  state.registered.get('slow').handler = () => new Promise((resolve) => { pending.push(resolve) })

  const deep = run(state, agent, '/deep')
  const solo = run(state, agent, '/solo')
  await new Promise((resolve) => { setImmediate(resolve) }) // let both chains reach the suspended command
  assert.equal(pending.length, 2, 'both invocations reached the target command')
  for (const resolve of pending.splice(0)) resolve({ kind: 'success' })

  assert.equal((await solo).kind, 'success', 'a second alias expands while the first is suspended')
  assert.equal((await deep).kind, 'success')
})

test('a volatile update re-registers exactly what moved', async () => {
  const { state } = mount({ aliases: { gm: 'good morning' } })
  const original = state.registered.get('gm')

  state.aliases.gm = 'good evening'
  delete state.aliases.none
  state.aliases.rev = '/perf-review'
  for (const listener of state.volatile) listener()

  assert.notEqual(state.registered.get('gm'), original)
  assert.equal(state.registered.get('gm').description, '↪ good evening')
  assert.equal(state.registered.has('rev'), true)

  delete state.aliases.gm
  for (const listener of state.volatile) listener()
  assert.equal(state.registered.has('gm'), false)
  assert.equal(state.registered.has('rev'), true)
})
