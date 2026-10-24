#!/usr/bin/env node
/**
 * Dev-only loader stub: evaluates `plugin/client.js` under the real
 * `window.__ModuleLoader__.load({ id, factory })` contract, with a tiny React
 * stand-in, so the bundle's registration surface and pure helpers can be
 * exercised by `node --test` without a browser or a DSH profile.
 *
 * This is a preview/test utility and is never shipped in the plugin `files`.
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const CLIENT_PATH = path.resolve(here, '..', 'client.js')
export const EXPECTED_ID = 'dsh-codex-review'

/** Modules a client bundle may require from the platform module table. */
export const PLATFORM_MODULES = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

/** Minimal React surface: enough to define components, never actually renders. */
export function createReactStub() {
  const noop = () => {}
  class Component {
    constructor(props) {
      this.props = props
      this.state = {}
    }
    setState() {}
  }
  return {
    version: '18.0.0-stub',
    Fragment: Symbol('react.fragment'),
    Component,
    createElement(type, props, ...children) {
      return { type, props: Object.assign({}, props, { children }) }
    },
    createContext: (value) => ({ _currentValue: value, Provider: 'Provider', Consumer: 'Consumer' }),
    forwardRef: (render) => render,
    memo: (component) => component,
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, noop]
    },
    useReducer(_reducer, initial) {
      return [initial, noop]
    },
    useEffect: noop,
    useLayoutEffect: noop,
    useMemo: (factory) => factory(),
    useCallback: (callback) => callback,
    useRef: (initial) => ({ current: initial }),
    useId: () => 'id-1',
  }
}

/** Read the bundle, run it in a sandbox, and collect its loader definitions. */
export function loadBundle() {
  const source = fs.readFileSync(CLIENT_PATH, 'utf8')
  const definitions = []
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    AbortController,
    Date,
    Math,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Promise,
    Error,
    Symbol,
    fetch: async () => {
      throw new Error('loader stub: fetch must not run at factory time')
    },
    navigator: {},
    location: { href: 'http://localhost/' },
    window: {
      __ModuleLoader__: {
        load(definition) {
          definitions.push(definition)
        },
      },
      open() {},
    },
  }
  vm.runInNewContext(source, vm.createContext(sandbox), { filename: CLIENT_PATH })
  return { source, definitions, sandbox }
}

/** Instantiate the plugin factory with the React stub. */
export function loadPlugin() {
  const { source, definitions, sandbox } = loadBundle()
  const definition = definitions[0]
  if (!definition) throw new Error('bundle did not call window.__ModuleLoader__.load')
  const react = createReactStub()
  const requireCalls = []
  const plugin = definition.factory((name) => {
    requireCalls.push(name)
    if (name === 'react') return react
    throw new Error(`loader stub: unsupported platform module "${name}"`)
  })
  return { source, definitions, definition, plugin, requireCalls, sandbox }
}

/** Fake Cordis client context exposing exactly the surfaces the plugin uses. */
export function createFakeCtx() {
  const registrations = []
  const localeRegistrations = []
  const effects = []
  const ctx = {
    effect(factory, label) {
      effects.push(label)
      const dispose = factory()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: {
      register(namespace, dictionaries) {
        localeRegistrations.push({ namespace, dictionaries })
        return () => {}
      },
      bind() {
        const dictionaries = localeRegistrations[0] && localeRegistrations[0].dictionaries
        const table = (dictionaries && dictionaries.zh) || {}
        return (key) => (Object.prototype.hasOwnProperty.call(table, key) ? table[key] : key)
      },
    },
    slots: {
      inject(key, callback) {
        callback()
        return () => {}
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  return { ctx, registrations, localeRegistrations, effects }
}

/** Every string passed to require(...) in the bundle source. */
export function listRequiredModules(source) {
  const names = new Set()
  for (const match of source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) names.add(match[1])
  return [...names]
}
