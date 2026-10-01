/**
 * Browser half: the Plugins-page card.
 *
 * The file is evaluated the way the client module system evaluates it — a
 * lazy-CJS factory registered on `window.__ModuleLoader__` — over a minimal
 * React (element trees plus two hooks) and a fake browser plugin context, so
 * the wiring and the settings operations are checked without a DOM.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/**
 * The element tree plus the hooks a component reaches for. `useState` cells
 * persist across renders the way React's do; `useSyncExternalStore` reads the
 * scope directly, since nothing re-renders asynchronously in a test.
 */
function createReact() {
  const hooks = { cells: [], index: 0 }
  return {
    hooks,
    createElement(type, props, ...children) {
      return { type, props: { ...(props ?? {}), children: children.flat(Infinity) } }
    },
    useState(initial) {
      const cell = hooks.index++
      if (!Object.hasOwn(hooks.cells, cell)) {
        hooks.cells[cell] = typeof initial === 'function' ? initial() : initial
      }
      return [
        hooks.cells[cell],
        (next) => { hooks.cells[cell] = typeof next === 'function' ? next(hooks.cells[cell]) : next },
      ]
    },
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot() },
  }
}

/** Load `lib/client.js` through the module loader and return its exports. */
function loadClient() {
  let registration
  const window = { __ModuleLoader__: { load: (spec) => { registration = spec } } }
  // The file is a script, not a module: it registers itself, exactly as the
  // module system evaluates it in the page.
  new Function('window', SOURCE)(window)
  const React = createReact()
  const exports = registration.factory((id) => {
    assert.equal(id, 'react')
    return React
  })
  return { registration, exports, React }
}

/** Render one element or component tree, running function components. */
function render(node, React) {
  React.hooks.index = 0
  return node.type !== undefined && typeof node.type === 'function' && node.props?.children === undefined
    ? render(node.type(node.props), React)
    : renderNode(node, React)
}

function renderNode(node, React) {
  if (node === null || node === undefined || typeof node === 'boolean') return node
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map((child) => renderNode(child, React))
  if (typeof node.type === 'function') {
    const saved = React.hooks.index
    React.hooks.index = 0
    const rendered = node.type(node.props)
    React.hooks.index = saved
    return renderNode(rendered, React)
  }
  return { type: node.type, props: { ...node.props, children: renderNode(node.props.children ?? [], React) } }
}

/** Render a component function with its own hook frame. */
function mountComponent(component, props, React) {
  React.hooks.index = 0
  return renderNode(component(props), React)
}

/** Every element of one type in a rendered tree, depth first. */
function findAll(node, type) {
  const found = []
  const visit = (current) => {
    if (current === null || current === undefined || typeof current !== 'object') return
    if (Array.isArray(current)) {
      for (const child of current) visit(child)
      return
    }
    if (current.type === type) found.push(current)
    visit(current.props?.children ?? [])
  }
  visit(node)
  return found
}

/** The concatenated text of a rendered subtree. */
function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children ?? [])
}

/** One fake browser context with its recorded surface and a mutable scope. */
function createClient(options = {}) {
  const { exports, React } = loadClient()
  const record = { mutations: [], labels: [] }
  const snapshot = {
    status: options.status ?? 'ready',
    value: { aliases: { ...(options.aliases ?? { gm: 'good morning' }) } },
    base: { aliases: {} },
    user: options.user ?? { aliases: { gm: 'good morning' } },
    revision: 1,
    writable: options.writable !== false,
    mode: 'host',
  }
  const scope = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    set: async () => true,
    unset: async () => true,
    mutate: async (ops) => {
      record.mutations.push(ops)
      return options.acceptWrites !== false
    },
  }
  const ctx = {
    locale: {
      bind: (ns) => {
        record.labels.push(ns)
        // The dictionary itself is asserted separately; here the key plus its
        // parameters is enough to see which copy a surface reached for.
        return (key, params = {}) => {
          const names = Object.keys(params)
          return names.length === 0 ? key : `${key}:${names.map((name) => String(params[name])).join(',')}`
        }
      },
      register: (ns, dictionaries) => { record.locale = { ns, dictionaries } },
    },
    effect: (callback, label) => { record.effects = [...(record.effects ?? []), label]; return callback() },
    configForms: { get: (ns) => { record.namespace = ns; return scope } },
    slots: {
      inject: (name, callback) => { record.injected = name; callback() },
      register: (spec, component) => { record.slot = spec; record.component = component },
    },
  }
  record.exports = exports
  record.apply = () => exports.apply(ctx)
  record.render = (props) => mountComponent(record.component, props, React)
  record.flush = () => new Promise((resolve) => { setImmediate(resolve) })
  return record
}

test('apply binds the alias namespace and registers the row card', () => {
  const client = createClient()
  client.apply()

  assert.deepEqual(client.exports.inject, ['slots', 'configForms', 'locale'])
  assert.equal(client.namespace, 'alias')
  assert.equal(client.locale.ns, 'alias')
  assert.equal(typeof client.locale.dictionaries.en.summary, 'string')
  assert.equal(typeof client.locale.dictionaries.zh.summary, 'string')
  assert.equal(client.injected, 'plugins.row.config')
  assert.equal(client.slot.key, 'dsh-alias#alias')
  assert.equal(client.slot.locale, 'alias')
})

test('an unserved namespace renders nothing at all', () => {
  const client = createClient({ status: 'unavailable' })
  client.apply()
  assert.equal(client.render({ view: 'page' }), null)
  assert.equal(client.render({ view: 'summary' }), null)
})

test('the summary view reports the alias count', () => {
  const empty = createClient({ aliases: {} })
  empty.apply()
  assert.equal(empty.render({ view: 'summary' }), 'summaryEmpty')

  const two = createClient({ aliases: { gm: 'good morning', rev: '/perf-review' } })
  two.apply()
  assert.equal(two.render({ view: 'summary' }), 'summary:2')
})

test('the page lists every alias and removes one through the settings path', async () => {
  const client = createClient({ aliases: { gm: 'good morning', rev: '/perf-review {args}' } })
  client.apply()
  const tree = client.render({ view: 'page' })

  const items = findAll(tree, 'li')
  assert.equal(items.length, 2)
  assert.match(textOf(items[0]), /\/gm/)
  assert.match(textOf(items[0]), /good morning/)
  assert.match(textOf(items[1]), /\/rev/)
  assert.match(textOf(tree), /persists/)

  const remove = findAll(tree, 'button').find((button) => textOf(button) === 'remove')
  assert.notEqual(remove, undefined)
  remove.props.onClick()
  await client.flush()
  assert.deepEqual(client.mutations, [[{ op: 'unset', path: ['aliases', 'gm'] }]])
})

test('editing a row loads it into the form and the same write updates it', async () => {
  const client = createClient({ aliases: { gm: 'good morning' } })
  client.apply()
  let tree = client.render({ view: 'page' })

  const edit = findAll(tree, 'button').find((button) => textOf(button) === 'edit')
  assert.notEqual(edit, undefined)
  edit.props.onClick()
  tree = client.render({ view: 'page' })
  assert.deepEqual(findAll(tree, 'input').map((input) => input.props.value), ['gm', 'good morning'])
  // The primary control now says what the write does.
  const primary = findAll(tree, 'button').find((button) => ['add', 'update'].includes(textOf(button)))
  assert.equal(textOf(primary), 'update')

  const text = findAll(tree, 'input')[1]
  text.props.onChange({ target: { value: 'good evening' } })
  tree = client.render({ view: 'page' })
  findAll(tree, 'button').find((button) => textOf(button) === 'update').props.onClick()
  await client.flush()
  assert.deepEqual(client.mutations, [[{ op: 'set', path: ['aliases', 'gm'], value: 'good evening' }]])
})

test('the add row writes the normalized name and clears the drafts', async () => {
  const client = createClient()
  client.apply()
  let tree = client.render({ view: 'page' })

  const inputs = findAll(tree, 'input')
  assert.equal(inputs.length, 2)
  inputs[0].props.onChange({ target: { value: ' Rev ' } })
  inputs[1].props.onChange({ target: { value: '/perf-review {args}' } })
  tree = client.render({ view: 'page' })

  const add = findAll(tree, 'button').find((button) => textOf(button) === 'add')
  add.props.onClick()
  await client.flush()
  assert.deepEqual(client.mutations, [[{ op: 'set', path: ['aliases', 'rev'], value: '/perf-review {args}' }]])

  tree = client.render({ view: 'page' })
  assert.deepEqual(findAll(tree, 'input').map((input) => input.props.value), ['', ''])
})

test('the add row rejects a bad name or empty text without writing', async () => {
  const client = createClient()
  client.apply()

  const interact = (name, text) => {
    let tree = client.render({ view: 'page' })
    const inputs = findAll(tree, 'input')
    inputs[0].props.onChange({ target: { value: name } })
    inputs[1].props.onChange({ target: { value: text } })
    tree = client.render({ view: 'page' })
    findAll(tree, 'button').find((button) => textOf(button) === 'add').props.onClick()
    return client.render({ view: 'page' })
  }

  assert.match(textOf(interact('9bad', 'text')), /badName/)
  assert.match(textOf(interact('ok', '   ')), /emptyText/)
  await client.flush()
  assert.deepEqual(client.mutations, [])
})

test('a write the host refuses is reported, and the add drafts stay', async () => {
  // Regression: `ConfigForm.mutate` resolves `false` on a refused write (an
  // overlay row, a revision conflict) rather than throwing, so the card
  // swallowed the refusal and the edit silently did nothing.
  const client = createClient({ acceptWrites: false })
  client.apply()
  let tree = client.render({ view: 'page' })

  findAll(tree, 'button').find((button) => textOf(button) === 'remove').props.onClick()
  await client.flush()
  assert.match(textOf(client.render({ view: 'page' })), /refused/)

  tree = client.render({ view: 'page' })
  const inputs = findAll(tree, 'input')
  inputs[0].props.onChange({ target: { value: 'rev' } })
  inputs[1].props.onChange({ target: { value: '/perf-review' } })
  tree = client.render({ view: 'page' })
  findAll(tree, 'button').find((button) => textOf(button) === 'add').props.onClick()
  await client.flush()
  tree = client.render({ view: 'page' })
  assert.match(textOf(tree), /refused/)
  assert.deepEqual(findAll(tree, 'input').map((input) => input.props.value), ['rev', '/perf-review'])
  assert.equal(client.mutations.length, 2)
})

test('a read-only deployment disables the controls and says so', () => {
  const client = createClient({ writable: false })
  client.apply()
  const tree = client.render({ view: 'page' })
  assert.match(textOf(tree), /readOnly/)
  assert.equal(findAll(tree, 'input').every((input) => input.props.disabled === true), true)
  assert.equal(findAll(tree, 'button').every((button) => button.props.disabled === true), true)
})

test('the card version stays in lockstep with package.json', () => {
  assert.match(SOURCE, new RegExp(`const VERSION = '${PACKAGE.version.replace(/\./gu, '\\.')}'`))
})
