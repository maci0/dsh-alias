/**
 * Real-composition test: the plugin mounts into a real `@deepseek-ai/cordis`
 * `Context`, registers through the seam it injects, and releases every
 * registration when its fiber disposes.
 *
 * The unit suite drives a plain-object fake, which cannot tell a service read
 * apart from a property read — a real context throws on the latter for a
 * service it does not provide — and cannot show whether a registration is
 * released. Both matter here: this plugin registers commands dynamically, and
 * the Web client reloads plugin rows on every profile edit.
 *
 * @module dsh-alias/tests/composition
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { Context, Service } from '@deepseek-ai/cordis'
import { createVolatile, updateVolatile } from '@deepseek-ai/cosmokit'

import * as Alias from '../index.js'

/**
 * The smallest `ctx.commands` seam this plugin reaches: register and lookup.
 *
 * It is a real `Service`, so `this.ctx` is the *consumer's* context — the same
 * relationship the harness registry has — and a registration is released when
 * that context disposes. A plain object would keep the entries forever and make
 * the plugin look like it leaks them.
 */
class CommandsSeam extends Service {
  registered = new Map()

  constructor(ctx) {
    super(ctx, 'commands')
  }

  register(definition) {
    return this.ctx.effect(() => {
      if (this.registered.has(definition.name)) throw new Error(`command "${definition.name}" is already registered`)
      this.registered.set(definition.name, definition)
      return () => { this.registered.delete(definition.name) }
    })
  }

  find(_agent, name) {
    return this.registered.get(name)
  }

  async execute() {
    return undefined
  }
}

test('the plugin mounts into a real Cordis context and releases its commands', async () => {
  const ctx = new Context()
  const seam = new CommandsSeam(ctx)

  // The module, not a bare apply: Cordis resolves the row through the exported
  // `Config` schema, which is what hands `apply` live references.
  const fiber = await ctx.plugin(Alias, { aliases: { gm: 'good morning' } })
  const registered = seam.registered
  assert.deepEqual([...registered.keys()].sort(), ['alias', 'gm'], 'the management command and the row\'s alias')

  // A settings write moves the live reference and the loader emits this; the
  // listener re-reads the row on a real context without reaching a service it
  // did not inject.
  const live = fiber.config.aliases
  updateVolatile(live, createVolatile({ gm: 'good morning', rev: '/alias list' }))
  ctx.emit('loader/volatile-update')
  assert.deepEqual([...registered.keys()].sort(), ['alias', 'gm', 'rev'], 'the new alias is registered')
  assert.equal(registered.get('rev').description, '↪ /alias list')

  await fiber.dispose()
  assert.deepEqual([...registered.keys()], [], 'every registration is released with the fiber')
})

test('the row schema the loader validates is the one this plugin declares', () => {
  const parsed = Alias.Config({ aliases: { gm: 'good morning' } })
  assert.equal(typeof parsed.aliases.get, 'function', 'aliases is volatile: the settings document can write it')
  assert.deepEqual(parsed.aliases.get(), { gm: 'good morning' })
})
