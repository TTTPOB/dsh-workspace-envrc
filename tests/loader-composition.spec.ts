/**
 * REAL Loader composition tests (Block D).
 *
 * A real Cordis Loader (`@deepseek-ai/cordis-plugin-loader`) reads a test
 * `cordis.yml` through the real Include builtin; every row activates through
 * the Loader's own import/inject/fiber machinery — no installer is ever
 * hand-called. The composition mounts:
 *
 * - the REAL DSH services: AgentRegistry, TerminalSessionService, the
 *   terminal-bash backend, SandboxPolicyService, and the REAL
 *   `dsh-workspace-overlay` registry (its `loader` inject is satisfied by
 *   the mounted Loader itself);
 * - recording provider rows for shell/sandbox/subprocess (plain-ESM
 *   fixtures extending the real service definitions, because the local
 *   concrete providers are not installed and real ones would confine the
 *   host / allocate real PTYs);
 * - THIS bundle's BUILT provider (`dist/provider.js`, default export) and
 *   integration plugin (`dist/integration-plugin.js`, named exports only)
 *   by absolute module path — the same form a deployed cordis.yml row uses.
 *   The loader's import path runs through real Node ESM, which cannot load
 *   the `.ts` sources, so the package's `pnpm test` script builds before
 *   Vitest and this suite fails rather than silently skipping a missing dist.
 *
 * The tests prove the patch export forms (provider default export,
 * integration named exports without default), that the integration row's
 * apply stays pending until every injected service exists and runs once
 * they do, that both adapters are live through the loaded composition, and
 * that disposing the integration fiber restores every decorated method
 * while the other rows stay composed. No Web server and no LLM are started.
 *
 * @module tests/loader-composition
 */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFERRED_ENV_CAPTURE_SCRIPT, DEFERRED_ENV_SHIM_LABEL } from '../src/core.js'
import * as IntegrationModule from '../src/integration-plugin.js'
import * as ProviderModule from '../src/provider.js'

/** The repository root: every temp composition lives inside the repo. */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
/** Repo-internal gitignored scratch root for composition temp dirs. */
const TMP_ROOT = join(REPO_ROOT, '.artifacts', 'loader-composition')

/**
 * Absolute module URL of one BUILT bundle entry, as a cordis.yml row name.
 *
 * The Loader's fallback import path runs through real Node ESM (the loader
 * marks its dynamic imports `@vite-ignore`), which cannot execute the `.ts`
 * sources and keeps a separate module registry from the test runner. The
 * built `dist/` entries are the production load form and are shared with the
 * installed-DSH contract, so the composition rows reference them; the suite
 * is built by the package test script before this suite starts.
 */
const PROVIDER_URL = pathToFileURL(join(REPO_ROOT, 'dist', 'provider.js')).href
const INTEGRATION_URL = pathToFileURL(join(REPO_ROOT, 'dist', 'integration-plugin.js')).href

const FIXTURE_DIR = join(REPO_ROOT, 'tests', 'fixtures', 'loader-composition')
const fixtureUrl = (name: string): string => pathToFileURL(join(FIXTURE_DIR, name)).href

/** One live composition case: the booted context and its temp root. */
interface Case {
  ctx: Context
  root: string
  workspace: string
  /** The include entry's create promise; settles when EVERY row activated. */
  includeReady: Promise<unknown>
}

const liveCases: Case[] = []

afterEach(async () => {
  for (const c of liveCases.splice(0)) {
    try {
      await c.ctx.fiber.dispose()
    } finally {
      await rm(c.root, { recursive: true, force: true })
    }
  }
})

/**
 * The test composition as a real cordis.yml document. Row ORDER is
 * deliberate: the integration row comes FIRST so activation must wait on the
 * inject machinery, never on YAML order.
 */
function composition(workspace: string, opts: { omitSandbox?: boolean } = {}): string {
  const sandboxRow = opts.omitSandbox
    ? ''
    : [
        '- id: sandbox',
        `  name: ${fixtureUrl('recording-sandbox.mjs')}`,
        '',
      ].join('\n')
  return [
    // The bundle's wiring row first: it must stay pending until every
    // declared service below exists.
    '- id: workspace-envrc-integration',
    `  name: ${INTEGRATION_URL}`,
    '',
    '- id: workspace-envrc',
    `  name: ${PROVIDER_URL}`,
    '  config:',
    '    executable: direnv',
    '    shimShell: /bin/bash',
    '    enableBash: true',
    '    enableTerminal: true',
    '    versionCheckTimeoutMs: 5000',
    '',
    '- id: agents',
    "  name: '@deepseek-ai/dsh-agent'",
    '',
    '- id: terminals',
    "  name: '@deepseek-ai/dsh-terminal'",
    '',
    '- id: sandbox-policy',
    "  name: '@deepseek-ai/dsh-sandbox-policy'",
    '  config:',
    '    mode: read-only',
    `    workspaceRoot: ${workspace}`,
    '',
    '- id: terminal-bash',
    "  name: '@deepseek-ai/dsh-terminal-bash'",
    '  config:',
    '    backendType: shell',
    '    shellPath: /bin/bash',
    "    shellArgs: ['--noprofile', '--norc', '-i']",
    '    rows: 24',
    '    cols: 80',
    '    scrollbackLines: 10',
    '    scrollbackMaxBytes: 1024',
    '    maxReadBytes: 256',
    '    pollIntervalMs: 5',
    '    exactProbeAfterMs: 10',
    '    idleSilenceMs: 40',
    '    handoffGraceMs: 10',
    '    timeoutMs: 120',
    '    disposeGraceMs: 20',
    '',
    '- id: shell',
    `  name: ${fixtureUrl('recording-shell.mjs')}`,
    '',
    sandboxRow,
    '- id: subprocess',
    `  name: ${fixtureUrl('recording-subprocess.mjs')}`,
    '',
    // The real workspace overlay: its loader inject is satisfied by the
    // Loader mounted below; the overlay bundle provides the workspaceCordis
    // service the envrc provider row injects.
    '- id: workspaceCordis',
    "  name: 'dsh-workspace-overlay'",
    '  config:',
    '    trustWorkspaceConfig: false',
    '    watchWorkspaceConfig: false',
    '',
  ].join('\n')
}

/** A loader tree entry: the subset of Entry the tests observe. */
interface EntryView {
  /** Namespaced entry id (include subtree ids carry the include prefix). */
  id: string
  options: { id: string }
  fiber: { uid: number } | undefined
}

/**
 * Boot one composition through the real Loader + Include: the Loader plugin
 * is mounted on a fresh Context, the Include builtin is registered, and the
 * Loader creates the root Include entry pointing at the test cordis.yml.
 * The include create promise is NOT awaited here: with a missing injected
 * service it stays pending, which the inject-gating test observes.
 */
async function bootCase(rowsBuilder: (workspace: string) => string): Promise<Case> {
  await mkdir(TMP_ROOT, { recursive: true })
  const ctx = new Context()
  const root = await mkdtemp(join(TMP_ROOT, 'case-'))
  const workspace = join(root, 'workspace')
  await mkdir(join(root, 'host'), { recursive: true })
  await mkdir(workspace)
  ctx.baseUrl = pathToFileURL(join(root, 'host')).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, rowsBuilder(workspace))
  // The shipped loader types omit the (optional, runtime-supported) id.
  const includeReady = ctx.loader.create({
    id: 'include',
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  } as never)
  const c: Case = { ctx, root, workspace, includeReady }
  liveCases.push(c)
  return c
}

/** All loader entries across the root tree and the include subtree. */
function entries(c: Case): EntryView[] {
  return [...c.ctx.loader.entries()] as unknown as EntryView[]
}

/** The entry whose options id ends with `suffix` (include-subtree ids are namespaced). */
function entryBySuffix(c: Case, suffix: string): EntryView {
  const found = entries(c).find((entry) => entry.options.id.endsWith(suffix))
  if (found === undefined) throw new Error(`no loader entry ending with ${suffix}`)
  return found
}

/** Register one live agent whose ctx is the workspace lease's scope ctx. */
function makeAgent(c: Case, lease: { ctx: Context }, id: string): Agent {
  return {
    id,
    session: { id, header: { id, cwd: c.workspace, version: 0, createdAt: 0 }, events: [] },
    ctx: lease.ctx,
  } as unknown as Agent
}

/** Resolve one shell request inside the real initiator boundary. */
function resolveAs(c: Case, agent: Agent, command: string): { command: string } {
  return c.ctx.agents.withInitiator(agent, () =>
    c.ctx.shell.resolve({ command, workdir: join(c.workspace, 'sub'), timeoutMs: 5000 }),
  ) as { command: string }
}

describe('real Loader composition of dsh-workspace-envrc', () => {
  it('composes the bundle rows through the real Loader and activates both adapters', async () => {
    const c = await bootCase(composition)
    try {
      // Boot the tree: activation runs the REAL preflight (`direnv version`
      // + shim-shell children) inside the loader's fiber machinery.
      await c.includeReady
      await c.ctx.loader.await()

      // Patch export forms. The LOADED provider row (built entry, real Node
      // ESM registry) is a Service named workspaceEnvrc with the projected
      // methods — the loader consumed its default export; the source module
      // (test-runner registry) carries the default-export class, and the
      // integration module carries the named function-plugin namespace.
      const service = c.ctx.get('workspaceEnvrc') as
        | { name: string; wrapCommand: unknown; wrapDeferredArgv: unknown }
        | undefined
      expect(service).toBeDefined()
      expect(service!.name).toBe('workspaceEnvrc')
      expect(typeof service!.wrapCommand).toBe('function')
      expect(typeof service!.wrapDeferredArgv).toBe('function')
      expect(typeof ProviderModule.default).toBe('function')
      expect((IntegrationModule as { default?: unknown }).default).toBeUndefined()
      expect(IntegrationModule.name).toBe('workspace-envrc-integration')
      expect(IntegrationModule.inject).toEqual([
        'agents',
        'shell',
        'sandbox',
        'subprocess',
        'terminals',
        'workspaceEnvrc',
      ])
      expect(typeof IntegrationModule.apply).toBe('function')

      // The real overlay registry provides workspaceCordis; acquiring the
      // workspace mints the scope mapping the adapter resolves through.
      const registry = c.ctx.workspaceCordis
      const lease = await registry.acquire(c.workspace)
      const agent = makeAgent(c, lease, 'agent-lc')
      const detach = c.ctx.agents.register(agent)
      try {
        // Bash adapter live: only `command` changes; the canonical workspace
        // comes from the agent's scope, never the request workdir.
        const spec = resolveAs(c, agent, 'echo hi')
        expect(spec.command.startsWith(`exec 'direnv' 'exec' '${c.workspace}'`)).toBe(true)
        expect(spec.command.endsWith("'/bin/bash' '-c' 'echo hi'")).toBe(true)
        const shellProvider = c.ctx.shell as unknown as { records: Array<{ workdir: string }> }
        expect(shellProvider.records[0]!.workdir).toBe(join(c.workspace, 'sub'))

        // Terminal adapter live: the real backend chain ends in
        // sandbox.confine, which must receive the deferred direnv wrapper
        // naming the canonical workspace (never a real PTY).
        await c.ctx.terminals.spawn(agent, { type: 'shell' }, new AbortController().signal).catch(() => {})
        const sandbox = c.ctx.sandbox as unknown as { calls: Array<{ argv: string[] }> }
        expect(sandbox.calls).toHaveLength(1)
        const confined = sandbox.calls[0]!
        expect(confined.argv.slice(0, 6)).toEqual(['env', '-u', 'BASH_ENV', '-u', 'ENV', '/bin/bash'])
        expect(confined.argv).toContain(DEFERRED_ENV_CAPTURE_SCRIPT)
        expect(confined.argv).toContain(DEFERRED_ENV_SHIM_LABEL)
        expect(confined.argv).toContain(c.workspace)
        const subprocess = c.ctx.subprocess as unknown as { terminalSpecs: Array<{ argv: string[] }> }
        expect(subprocess.terminalSpecs[0]!.argv).toEqual(['/sandbox', '--', ...confined.argv])
      } finally {
        detach()
      }
    } finally {
      await c.ctx.fiber.dispose()
      await rm(c.root, { recursive: true, force: true })
      const index = liveCases.indexOf(c)
      if (index >= 0) liveCases.splice(index, 1)
    }
  })

  it('keeps the integration row pending until every injected service exists, then activates', async () => {
    const c = await bootCase((workspace) => composition(workspace, { omitSandbox: true }))
    try {
      // The loader applies the tree while the integration row's injects are
      // unsatisfied: the cordis checker keeps the plugin's apply unrun, so
      // the composition settles but no adapter is installed yet.
      await c.includeReady
      await c.ctx.loader.await()
      expect(c.ctx.get('sandbox')).toBeUndefined()

      const registry = c.ctx.workspaceCordis
      const lease = await registry.acquire(c.workspace)
      const agent = makeAgent(c, lease, 'agent-pending')
      const detach = c.ctx.agents.register(agent)
      try {
        // The bash adapter is NOT installed: the integration row is pending
        // on its sandbox inject (the resolve passes through unwrapped).
        const pending = resolveAs(c, agent, 'echo pending')
        expect(pending.command).toBe('echo pending')

        // The missing provider arrives as a new loader row (the shipped
        // loader types omit the optional id; the runtime generates one):
        // the inject gate opens and the integration row activates.
        await c.ctx.loader.create({ name: fixtureUrl('recording-sandbox.mjs') })
        await c.ctx.loader.await()
        const active = resolveAs(c, agent, 'echo now-active')
        expect(active.command.startsWith(`exec 'direnv' 'exec' '${c.workspace}'`)).toBe(true)
      } finally {
        detach()
      }
    } finally {
      await c.ctx.fiber.dispose()
      await rm(c.root, { recursive: true, force: true })
      const index = liveCases.indexOf(c)
      if (index >= 0) liveCases.splice(index, 1)
    }
  })

  it('disposing the integration fiber restores every decorated method while services stay composed', async () => {
    const c = await bootCase(composition)
    try {
      await c.includeReady
      await c.ctx.loader.await()
      const registry = c.ctx.workspaceCordis
      const lease = await registry.acquire(c.workspace)
      const agent = makeAgent(c, lease, 'agent-dispose')
      const detach = c.ctx.agents.register(agent)
      try {
        // Live before the removal.
        const before = resolveAs(c, agent, 'echo before')
        expect(before.command.startsWith(`exec 'direnv' 'exec' '${c.workspace}'`)).toBe(true)

        // Disable the integration row through the public loader API: the
        // loader disposes the row's fiber and the effect disposers restore
        // the exact previous method descriptors. (Removing include-subtree
        // rows by id is a loader no-op, so `update(..., { disabled: true })`
        // is the supported disposal path for a row owned by an Include.)
        const integrationId = entryBySuffix(c, 'workspace-envrc-integration').id
        await c.ctx.loader.update(integrationId, { disabled: true })

        const after = resolveAs(c, agent, 'echo after')
        expect(after.command).toBe('echo after')
        await c.ctx.terminals.spawn(agent, { type: 'shell' }, new AbortController().signal).catch(() => {})
        const sandbox = c.ctx.sandbox as unknown as { calls: Array<{ argv: string[] }> }
        expect(sandbox.calls).toHaveLength(1)
        expect(sandbox.calls[0]!.argv).toEqual(['/bin/bash', '--noprofile', '--norc', '-i'])
        expect(sandbox.calls[0]!.argv).not.toContain(DEFERRED_ENV_CAPTURE_SCRIPT)

        // The other rows stay composed: provider, agents, terminals, and the
        // real overlay registry all remain live.
        const service = c.ctx.get('workspaceEnvrc') as { name: string } | undefined
        expect(service).toBeDefined()
        expect(service!.name).toBe('workspaceEnvrc')
        expect(c.ctx.get('agents')).toBeDefined()
        expect(c.ctx.get('terminals')).toBeDefined()
        expect(c.ctx.get('workspaceCordis')).toBeDefined()
        expect(registry.workspaceForScope(lease.key)).toBe(c.workspace)
      } finally {
        detach()
      }
    } finally {
      await c.ctx.fiber.dispose()
      await rm(c.root, { recursive: true, force: true })
      const index = liveCases.indexOf(c)
      if (index >= 0) liveCases.splice(index, 1)
    }
  })
})
