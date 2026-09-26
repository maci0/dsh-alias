/**
 * dsh-alias — browser half.
 *
 * One surface: the Alias card on the Plugins page, keyed on the `alias`
 * settings namespace the host half declares as its row id. It lists every
 * defined alias with a Remove control and adds one through a name + text pair;
 * every write goes through `ctx.configForms`, the same settings document
 * `/alias` writes on the host, so the two surfaces cannot disagree.
 *
 * Chrome is a stylesheet, not inline style objects: the module system claims
 * every `<style>` tag a factory appends while it materializes and removes it
 * when the package unloads, so the tags cost nothing to own. All classes are
 * `da-`-prefixed because that sheet lands in the page's own document.
 *
 * This file is plain JavaScript on purpose. The client module system serves a
 * package's `exports["./client"]` artifact as a lazy-CJS factory registered on
 * `window.__ModuleLoader__`, and that is the whole format — an out-of-tree
 * plugin can author it directly instead of reproducing the repository's tsdown
 * client preset. `react` is provided by the module system; nothing else is
 * required here.
 *
 * The card mirrors the shipped plugin cards: the page draws the title, icon,
 * and breadcrumb, and the entry renders the body (`view: 'page'`) or the
 * one-liner under the title (`view: 'summary'`).
 */

window.__ModuleLoader__.load({
  id: 'dsh-alias',

  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    /** Settings namespace shared with the host half; also this card's slot key. */
    const NAMESPACE = 'alias'

    /** Locale namespace for this plugin's copy. */
    const LOCALE_NS = 'alias'

    /** The names the command registry accepts, mirroring the host half. */
    const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u

    /** Every class is `da-`-prefixed: the sheet lands in the page's own document. */
    const CSS = [
      '.da-page{display:flex;flex-direction:column;gap:12px}',
      '.da-group{display:flex;flex-direction:column;gap:8px}',
      '.da-label{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
      '.da-list{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}',
      '.da-item{display:flex;align-items:flex-start;gap:10px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-4)}',
      '.da-item-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}',
      '.da-name{font-size:13px;font-weight:600;line-height:1.5;color:var(--dsw-alias-label-primary)}',
      '.da-text{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere}',
      '.da-row{display:flex;flex-wrap:wrap;gap:8px}',
      '.da-input{font:inherit;font-size:13px;line-height:1.5;padding:5px 12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-4);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;box-sizing:border-box}',
      '.da-input:disabled{cursor:default;opacity:.5}',
      '.da-input-name{width:160px;flex:none}',
      '.da-input-text{flex:1;min-width:200px}',
      '.da-button{appearance:none;font:inherit;font-size:13px;line-height:1.5;padding:5px 14px;cursor:pointer;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-4);border:1px solid var(--dsw-alias-border-l2);border-radius:8px}',
      '.da-button:disabled{cursor:default;opacity:.5}',
      '.da-button-remove{flex:none;padding:3px 10px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.da-status{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
      '.da-error{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-error)}',
    ].join('')

    // Appended while the factory materializes: the module system claims the tag
    // for this package and disposes it on unload. Guarded because the node unit
    // tests evaluate this file without a DOM.
    if (typeof document !== 'undefined') {
      const style = document.createElement('style')
      style.textContent = CSS
      document.head.append(style)
    }

    /** Plugin version, shown in the card header. Kept in lockstep with package.json. */
    const VERSION = '0.1.3'

    const en = {
      title: 'Alias',
      summaryEmpty: 'No aliases defined.',
      summary: '{count} alias(es) defined.',
      groupExisting: 'Defined aliases',
      groupNew: 'Add an alias',
      namePlaceholder: 'name',
      textPlaceholder: 'text it stands for ({args} optional)',
      add: 'Add',
      update: 'Update',
      edit: 'Edit',
      remove: 'Remove',
      empty: 'No aliases yet. Add one below, or run /alias add <name> <text>.',
      badName: 'A name is lowercase letters, digits, `_` or `-`, and must start with a letter.',
      emptyText: 'The alias text must not be empty.',
      persists: 'Saved to your profile; /alias lists the same set.',
      readOnly: 'Read-only: this deployment does not persist settings, so changes apply to this page only.',
      version: 'v{version}',
    }

    const zh = {
      title: '别名',
      summaryEmpty: '未定义别名。',
      summary: '已定义 {count} 个别名。',
      groupExisting: '已定义的别名',
      groupNew: '添加别名',
      namePlaceholder: '名称',
      textPlaceholder: '它代表的文本（可用 {args}）',
      add: '添加',
      update: '更新',
      edit: '编辑',
      remove: '删除',
      empty: '还没有别名。在下面添加，或运行 /alias add <name> <text>。',
      badName: '名称只能是小写字母、数字、`_` 或 `-`，且必须以字母开头。',
      emptyText: '别名文本不能为空。',
      persists: '已保存到你的配置；/alias 列出同一组别名。',
      readOnly: '只读：此部署不持久化设置，改动仅对本页面生效。',
      version: 'v{version}',
    }

    /**
     * Bind one settings scope to a React subscription.
     * @param scope - the scope bound to the alias settings namespace.
     * @returns a hook reading that scope's current snapshot.
     */
    function useScope(scope) {
      const subscribe = (listener) => scope.subscribe(listener)
      const getSnapshot = () => scope.getSnapshot()
      return () => React.useSyncExternalStore(subscribe, getSnapshot)
    }

    /**
     * Read a snapshot's alias dictionary. A namespace this deployment does not
     * serve reports no dictionary, which the card renders as nothing at all.
     * @param snapshot - the settings scope snapshot.
     * @returns name-to-text, or `undefined` when unreadable.
     */
    function aliasesOf(snapshot) {
      if (snapshot.status !== 'ready') return undefined
      const value = snapshot.value !== null && typeof snapshot.value === 'object' ? snapshot.value : {}
      const aliases = value.aliases
      if (aliases === null || typeof aliases !== 'object' || Array.isArray(aliases)) return {}
      return aliases
    }

    /**
     * One alias row: the name, its text, and the Edit and Remove controls.
     *
     * Edit loads the row into the form below, because a list whose entries can
     * only be deleted is a list users re-type from scratch.
     */
    function AliasRow(props) {
      const { t, name, text, disabled, onRemove, onEdit } = props
      return React.createElement(
        'li',
        { className: 'da-item' },
        React.createElement(
          'div',
          { className: 'da-item-main' },
          React.createElement('span', { className: 'da-name' }, `/${name}`),
          React.createElement('span', { className: 'da-text' }, text),
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'da-button da-button-remove',
            disabled,
            onClick: () => { onEdit(name, text) },
          },
          t('edit'),
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'da-button da-button-remove',
            disabled,
            onClick: () => { onRemove(name) },
          },
          t('remove'),
        ),
      )
    }

    /**
     * Build the card component over one bound settings scope.
     * @param scope - the scope bound to the alias settings namespace.
     * @param t - translate function bound to this plugin's locale namespace.
     * @returns the component the slot renders.
     */
    function createCard(scope, t) {
      const useAlias = useScope(scope)

      return function AliasCard(props) {
        const snapshot = useAlias()
        const [error, setError] = React.useState(null)
        const [draftName, setDraftName] = React.useState('')
        const [draftText, setDraftText] = React.useState('')

        const aliases = aliasesOf(snapshot)
        // A namespace this deployment does not serve renders no trace of itself.
        if (aliases === undefined) return null

        const names = Object.keys(aliases).sort()
        if (props != null && props.view === 'summary') {
          return names.length === 0 ? t('summaryEmpty') : t('summary', { count: String(names.length) })
        }

        const disabled = !snapshot.writable
        const write = (run) => {
          setError(null)
          Promise.resolve(run()).catch((cause) => {
            setError(cause instanceof Error ? cause.message : String(cause))
          })
        }
        const edit = (name, text) => {
          setError(null)
          setDraftName(name)
          setDraftText(text)
        }
        const remove = (name) => {
          write(() => scope.mutate([{ op: 'unset', path: ['aliases', name] }]))
        }
        const add = () => {
          const name = draftName.trim().toLowerCase()
          const text = draftText.trim()
          if (!COMMAND_NAME.test(name)) {
            setError(t('badName'))
            return
          }
          if (text === '') {
            setError(t('emptyText'))
            return
          }
          write(() => scope.mutate([{ op: 'set', path: ['aliases', name], value: text }]).then((accepted) => {
            if (accepted !== false) {
              setDraftName('')
              setDraftText('')
            }
          }))
        }

        return React.createElement(
          'div',
          { className: 'da-page' },
          React.createElement(
            'div',
            { className: 'da-group' },
            React.createElement('span', { className: 'da-label' }, t('groupExisting')),
            names.length === 0
              ? React.createElement('span', { className: 'da-status' }, t('empty'))
              : React.createElement(
                'ul',
                { className: 'da-list' },
                names.map((name) => React.createElement(AliasRow, {
                  key: name, t, name, text: aliases[name], disabled, onRemove: remove, onEdit: edit,
                })),
              ),
          ),
          React.createElement(
            'div',
            { className: 'da-group' },
            React.createElement('span', { className: 'da-label' }, t('groupNew')),
            React.createElement(
              'div',
              { className: 'da-row' },
              React.createElement('input', {
                className: 'da-input da-input-name',
                type: 'text',
                value: draftName,
                placeholder: t('namePlaceholder'),
                'aria-label': t('namePlaceholder'),
                disabled,
                onChange: (event) => { setDraftName(event.target.value) },
              }),
              React.createElement('input', {
                className: 'da-input da-input-text',
                type: 'text',
                value: draftText,
                placeholder: t('textPlaceholder'),
                'aria-label': t('textPlaceholder'),
                disabled,
                onChange: (event) => { setDraftText(event.target.value) },
                onKeyDown: (event) => {
                  if (event.key === 'Enter') add()
                },
              }),
              React.createElement(
                'button',
                { type: 'button', className: 'da-button', disabled, onClick: add },
                // The same write serves both: `set` on an existing name is an
                // update, and saying so is the whole difference.
                Object.hasOwn(aliases, draftName.trim().toLowerCase()) ? t('update') : t('add'),
              ),
            ),
          ),
          React.createElement(
            'div',
            { className: 'da-status' },
            snapshot.writable ? t('persists') : t('readOnly'),
            ' ',
            t('version', { version: VERSION }),
          ),
          error === null ? null : React.createElement('div', { className: 'da-error' }, error),
        )
      }
    }

    /**
     * Mount the browser surface: the Alias card on the Plugins page.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(LOCALE_NS)
      ctx.effect(
        () => ctx.locale.register(LOCALE_NS, { en, zh }),
        'dsh-alias: locale dictionary',
      )

      const scope = ctx.configForms.get(NAMESPACE)
      const Card = createCard(scope, t)

      // The owner declares its own slot; injecting waits for it to exist, so
      // this registration does not depend on plugin load order. The card takes
      // no injected props — it closes over its own bound scope — so the entry
      // declares the documented `locale` namespace and no `inject`.
      ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config',
        key: 'dsh-alias#alias',
        locale: LOCALE_NS,
      }, Card))
    }

    exports.apply = apply
    exports.inject = ['slots', 'configForms', 'locale']
    return module.exports
  },
})
