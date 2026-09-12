/**
 * REAL MCP SDK + native direnv + WorkspaceTree hot-reload tests (plan §11
 * next block).
 *
 * Everything here is real and runs as real child processes:
 *
 * - the fixture server (`tests/fixtures/mcp/fixture-server.mjs`) is a real
 *   `@modelcontextprotocol/sdk` `Server` over `StdioServerTransport`,
 *   spawned by the real overlay MCP transport (the MCP SDK's own stdio
 *   spawn, not a test shim);
 * - the workspace registry is the REAL `dsh-workspace-overlay`
 *   `WorkspaceRegistry` with `watchWorkspaceConfig: true` — real chokidar
 *   watchers, real debounce timers, real `WorkspaceTree` mounts, and real
 *   top-level `.dsh/cordis.yml` hot reload;
 * - the REAL `WorkspaceMcpManager` and the REAL `workspace-client` module
 *   drive global vs workspace namespaces, masks, reservations, and teardown;
 * - the REAL `workspaceEnvrc` provider and the REAL integration row install
 *   the workspace MCP adapter over that manager; every other integration
 *   inject is satisfied by real or recording providers (real AgentRegistry,
 *   recording shell/sandbox/subprocess, recording terminals shape);
 * - native direnv (host-installed) evaluates the workspace `.envrc` inside
 *   repo-internal isolated `XDG_DATA_HOME`/`XDG_CONFIG_HOME`/`XDG_CACHE_HOME`
 *   and `HOME`; every `direnv allow` child in this suite runs with that same
 *   isolated environment, so the user's real direnv authorization state is
 *   never read or written. All allow/deny calls are made by the TEST
 *   directly — the plugin never calls allow/deny.
 *
 * The suite proves, end to end, the §11.2/§11.3 contract:
 *
 * - an allowed workspace `.envrc` reaches the MCP child (ordinary and
 *   credential-shaped exports), config explicit ordinary env follows native
 *   precedence (.envrc overrides), every DSH_* name from config/.envrc/the
 *   ambient parent is absent in the child (the empty managed snapshot), and
 *   the child cwd is the manager-resolved canonical workspace root;
 * - the global row of the SAME serverName is byte-for-byte unwrapped: it
 *   never loads the workspace `.envrc`, its explicit env (including an
 *   explicit DSH_* entry, which the overlay transport preserves) reaches the
 *   child, and workspace reloads never disturb the global process or view;
 * - no `.envrc` watcher exists: changing only `.envrc` freezes the live MCP
 *   process at v1; saving the top-level config afterwards disposes the old
 *   process, native direnv blocks the fresh start (content changed, not
 *   re-allowed), the registry reload status becomes `failed`, the workspace
 *   tools/mask disappear per the overlay's existing failure semantics while
 *   the workspace lease/scope mapping stay alive, and the global row keeps
 *   running;
 * - re-allowing the exact `.envrc` and saving the config again starts a
 *   fresh workspace MCP process (new pid) with the v2 environment and a
 *   restored mask; final lease release exits the process and removes tools
 *   and mask, the global row survives, and disposing it exits too — no
 *   process residue;
 * - blocked-start diagnostics never carry an `.envrc`-exported canary;
 * - with `enableWorkspaceMcp: false` a workspace MCP row starts WITHOUT
 *   direnv (even with a blocked `.envrc`) and its explicit env is visible.
 *
 * Every child is bounded (timeout + kill), awaited through `close` (reaped),
 * and marker files prove start/exit pids. All temp state lives under the
 * repo-internal gitignored `.artifacts/mcp-live-direnv/`.
 *
 * @module tests/mcp-live-direnv
 */
import { Context, LoggerService } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WorkspaceRegistry, { type WorkspaceRegistryConfig } from 'dsh-workspace-overlay'
import WorkspaceMcpManager from 'dsh-workspace-overlay/mcp/manager'
import * as workspaceClient from 'dsh-workspace-overlay/mcp/workspace-client'
import { defaultConfig as envrcDefaultConfig, type PreflightSpawn, type WorkspaceEnvrcConfig } from '../src/core.js'
import * as Integration from '../src/integration-plugin.js'
import WorkspaceEnvrc from '../src/provider.js'
import { RecordingShellExecutor } from './helpers.js'

/** The repository root: every temp dir and marker below lives inside the repo. */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
/** Repo-internal gitignored scratch root for all live MCP/direnv state. */
const ARTIFACTS_ROOT = join(REPO_ROOT, '.artifacts', 'mcp-live-direnv')
/** The real MCP SDK fixture server (never an overlay test-fixture path). */
const FIXTURE_SERVER = fileURLToPath(new URL('fixtures/mcp/fixture-server.mjs', import.meta.url))
/** The REAL workspace-client row module the workspace composition mounts. */
const WORKSPACE_CLIENT_URL = pathToFileURL(
  join(REPO_ROOT, 'node_modules', 'dsh-workspace-overlay', 'dist', 'mcp', 'workspace-client.js'),
).href

/** The mask pair: serverName 'srv', global 'masked' (env_snapshot + t1..t5). */
const GLOBAL_SRV_NAMES = [
  'mcp__srv__env_snapshot', 'mcp__srv__t1', 'mcp__srv__t2',
  'mcp__srv__t3', 'mcp__srv__t4', 'mcp__srv__t5',
]
/** The workspace override's own names: env_snapshot + t1..t3. */
const WORKSPACE_SRV_NAMES = ['mcp__srv__env_snapshot', 'mcp__srv__t1', 'mcp__srv__t2', 'mcp__srv__t3']

/** Require the native direnv binary: a runtime prerequisite, fail loud. */
function requireDirenv(): string {
  execFileSync('direnv', ['version'], { stdio: 'ignore' })
  const resolved = execFileSync('bash', ['-c', 'command -v direnv'], { encoding: 'utf8' }).trim()
  if (resolved.length === 0) throw new Error('direnv is required for native integration tests')
  return resolved
}

const direnvPath = requireDirenv()

/** One settled child, bounded and reaped. */
interface ChildResult {
  code: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  stdout: string
  stderr: string
}

/** Spawn one child with an EXPLICIT environment and bounded lifetime. */
function runChild(
  argv: readonly string[],
  options: { cwd?: string; env: Record<string, string>; timeoutMs?: number },
): Promise<ChildResult> {
  const { cwd, env, timeoutMs = 20_000 } = options
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const cap = (current: string, chunk: Buffer): string =>
      current.length >= 256 * 1024 ? current : current + chunk.toString('utf8')
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = cap(stdout, chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = cap(stderr, chunk)
    })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, timedOut, stdout, stderr })
    })
  })
}

/** The isolated environment every direnv/MCP child in a case shares. */
function caseEnv(root: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: '/usr/bin:/bin',
    HOME: join(root, 'home'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_CACHE_HOME: join(root, 'cache'),
    // Keep direnv stderr clean: only real errors may reach the child stderr.
    DIRENV_LOG_FORMAT: '',
    ...extra,
  }
}

/** Preflight children (real `direnv version` + shim probe) run isolated too. */
function isolatedPreflightSpawn(root: string): PreflightSpawn {
  const env = caseEnv(root)
  return (argv, signal) => {
    const file = argv[0]!
    const child = spawn(file, argv.slice(1), { stdio: ['ignore', 'ignore', 'ignore'], signal, env })
    let settled = false
    const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; spawnError?: Error }>((resolve) => {
      const settle = (exit: { code: number | null; signal: NodeJS.Signals | null; spawnError?: Error }): void => {
        if (settled) return
        settled = true
        resolve(exit)
      }
      child.once('error', (error) => settle({ code: null, signal: null, spawnError: error }))
      child.once('close', (code, signal) => settle({ code, signal }))
    })
    return { kill: () => child.kill('SIGTERM'), done }
  }
}

/** Run one native direnv CLI child (allow/deny/...) under the isolated env. */
function runDirenv(root: string, args: readonly string[]): Promise<ChildResult> {
  return runChild([direnvPath, ...args], { env: caseEnv(root) })
}

/** Parsed fixture marker file. */
interface MarkerLog {
  starts: number[]
  exits: number[]
}

/** Read and parse one fixture marker file (missing file = empty log). */
async function readMarkers(file: string): Promise<MarkerLog> {
  let body: string
  try {
    body = await readFile(file, 'utf8')
  } catch {
    body = ''
  }
  const starts: number[] = []
  const exits: number[] = []
  for (const line of body.split('\n')) {
    const [kind, pidText] = line.trim().split(' ')
    const pid = Number(pidText)
    if (kind === 'start' && Number.isInteger(pid)) starts.push(pid)
    if (kind === 'exit' && Number.isInteger(pid)) exits.push(pid)
  }
  return { starts, exits }
}

/** Kill every fixture process still alive according to the marker file. */
async function killMarkedProcesses(file: string): Promise<void> {
  const { starts, exits } = await readMarkers(file)
  for (const pid of starts) {
    if (exits.includes(pid)) continue
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
}

/** Every pid that started but never reported an exit, across marker files. */
async function residueOf(files: readonly string[]): Promise<number[]> {
  const residue: number[] = []
  for (const file of files) {
    const { starts, exits } = await readMarkers(file)
    for (const pid of starts) {
      if (!exits.includes(pid)) residue.push(pid)
    }
  }
  return residue
}

/** One live case: the booted composition and its repo-internal temp root. */
interface LiveCase {
  ctx: Context
  registry: WorkspaceRegistry
  /** The case root; every child env and marker lives below it. */
  root: string
  markerDir: string
  /** The env the MCP rows must carry (isolated XDG trio + HOME + PATH). */
  baseEnv(): Record<string, string>
  /** All marker files this case created, for residue sweeps. */
  markers: string[]
  /** Dispose the composition and remove the case root; idempotent. */
  dispose(): Promise<void>
}

const liveCases: LiveCase[] = []

async function disposeCase(c: LiveCase): Promise<void> {
  const index = liveCases.indexOf(c)
  if (index >= 0) liveCases.splice(index, 1)
  try {
    await c.ctx.fiber.dispose()
  } finally {
    await rm(c.root, { recursive: true, force: true })
  }
}

afterEach(async () => {
  // A test that failed before its own `finally` leaves its case registered:
  // dispose the composition, let dying transports close, force-kill anything
  // the markers still report as alive, then remove the case root.
  const leftover = liveCases.splice(0)
  for (const c of leftover) {
    try {
      await c.ctx.fiber.dispose()
    } finally {
      // Keep the root until the marker sweep below has read it.
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 400))
  for (const c of leftover) {
    for (const marker of c.markers) await killMarkedProcesses(marker)
    await rm(c.root, { recursive: true, force: true })
  }
})

/**
 * Boot a real composition: Loader + Include, SystemPrompt + ToolRuntime, the
 * REAL overlay registry (real chokidar watchers, real debounce), the REAL
 * workspace MCP manager, the REAL agent registry, a recording shell provider,
 * the REAL workspaceEnvrc provider (isolated preflight children), and the REAL
 * integration row.
 */
async function makeCase(options: { enableWorkspaceMcp?: boolean } = {}): Promise<LiveCase> {
  const enableWorkspaceMcp = options.enableWorkspaceMcp ?? true
  await mkdir(ARTIFACTS_ROOT, { recursive: true })
  const root = await mkdtemp(join(ARTIFACTS_ROOT, 'case-'))
  for (const sub of ['data', 'config', 'cache', 'home', 'host']) {
    await mkdir(join(root, sub))
  }
  const markerDir = join(root, 'markers')
  await mkdir(markerDir)
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(join(root, 'host')).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const registryConfig: WorkspaceRegistryConfig = {
    trustWorkspaceConfig: true,
    watchWorkspaceConfig: true,
    reloadDebounceMs: 100,
  }
  await ctx.plugin(WorkspaceRegistry, registryConfig)
  await ctx.plugin(WorkspaceMcpManager)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(RecordingShellExecutor)
  const providerConfig: WorkspaceEnvrcConfig = {
    ...envrcDefaultConfig,
    executable: direnvPath,
    enableWorkspaceMcp,
  }
  const RuntimeProvider = class extends WorkspaceEnvrc {
    constructor(applyCtx: Context) {
      super(applyCtx, providerConfig, { spawn: isolatedPreflightSpawn(root) })
    }
  }
  await ctx.plugin(RuntimeProvider, providerConfig as never)
  await ctx.plugin(Integration)
  const markers: string[] = []
  const c: LiveCase = {
    ctx,
    registry: ctx.workspaceCordis,
    root,
    markerDir,
    baseEnv: () => caseEnv(root),
    markers,
    dispose: () => disposeCase(c),
  }
  liveCases.push(c)
  return c
}

/** Create one workspace directory (without config yet). */
async function makeWorkspace(root: string, name: string): Promise<string> {
  const ws = join(root, name)
  await mkdir(join(ws, '.dsh'), { recursive: true })
  return ws
}

/** Write `<ws>/.envrc` (never allowed by the plugin — only by the test). */
async function writeEnvrc(ws: string, body: string): Promise<void> {
  await writeFile(join(ws, '.envrc'), `${body}\n`)
}

/** The v1 `.envrc` (allowed before the first mount). */
function envrcV1(canary: string): string {
  return [
    'export GREETING=from-envrc',
    `export FAKE_API_KEY=${canary}`,
    'export DSH_FORGED=forged-by-envrc-v1',
  ].join('\n')
}

/** The v2 `.envrc` (content changed, must be re-allowed). */
function envrcV2(canary: string): string {
  return [
    'export GREETING=from-envrc-v2',
    `export FAKE_API_KEY=${canary}`,
    'export DSH_FORGED=forged-by-envrc-v2',
  ].join('\n')
}

/** The workspace row's explicit config env (kept identical across reloads). */
const CONFIG_ENV: Record<string, string> = {
  GREETING: 'from-config',
  CONFIG_ONLY: 'from-config',
  DSH_EXPLICIT: 'config-value',
}

/** One workspace MCP row config; env carries the isolated XDG world. */
function workspaceRowConfig(c: LiveCase, marker: string): Record<string, unknown> {
  return {
    transport: 'stdio',
    serverName: 'srv',
    command: process.execPath,
    args: [FIXTURE_SERVER],
    env: {
      ...c.baseEnv(),
      MCP_FIXTURE_MARKER: marker,
      MCP_FIXTURE_MODE: 'masked-partial',
      MCP_FIXTURE_MASKED_COUNT: '3',
      ...CONFIG_ENV,
    },
    cwd: '',
    toolCallTimeoutMs: 8_000,
    failOnStartupError: true,
    reconnect: { initialDelayMs: 30, maxDelayMs: 60, maxAttempts: 2 },
  }
}

/** The full workspace composition document for one MCP row. */
function workspaceConfigYaml(c: LiveCase, config: Record<string, unknown>): string {
  const lines = ['- id: mcp-srv', `  name: ${JSON.stringify(WORKSPACE_CLIENT_URL)}`, '  config:']
  for (const [key, value] of Object.entries(config)) {
    lines.push(`    ${key}: ${JSON.stringify(value)}`)
  }
  return `${lines.join('\n')}\n`
}

/** Write `<ws>/.dsh/cordis.yml`. */
async function writeWorkspaceConfig(ws: string, body: string): Promise<void> {
  await writeFile(join(ws, '.dsh', 'cordis.yml'), body)
}

/** The global row config: same serverName, unwrapped by the adapter. */
function globalRowConfig(c: LiveCase, marker: string): Record<string, unknown> {
  return {
    transport: 'stdio',
    serverName: 'srv',
    command: process.execPath,
    args: [FIXTURE_SERVER],
    env: {
      MCP_FIXTURE_MARKER: marker,
      MCP_FIXTURE_MODE: 'masked',
      MCP_FIXTURE_MASKED_COUNT: '5',
      // Explicit ordinary env the global child must see verbatim.
      GLOBAL_ONLY: 'global-marker-7f3a',
      // The overlay transport preserves explicit DSH_* config env; keeping it
      // proves the global row is NOT wrapped (the workspace shim would delete
      // it). Docs never encourage relying on it.
      DSH_GLOBAL_EXPLICIT: 'global-kept-9b1c',
    },
    cwd: '',
    toolCallTimeoutMs: 8_000,
    failOnStartupError: true,
    reconnect: { initialDelayMs: 30, maxDelayMs: 60, maxAttempts: 2 },
  }
}

/** One fresh marker file inside the case's repo-internal marker dir. */
function newMarker(c: LiveCase, name: string): string {
  const file = join(c.markerDir, `${name}.log`)
  c.markers.push(file)
  return file
}

/** The public tool names one scope's view exposes, sorted. */
async function viewNames(scopeCtx: Context, scope: ScopeKey | undefined): Promise<string[]> {
  const viewer = await scopeCtx.plugin({ name: 'viewer', inject: ['tools'], apply() {} })
  try {
    return viewer.ctx.tools.schemas(scope).map((schema) => schema.name).sort()
  } finally {
    await viewer.dispose()
  }
}

let callSeq = 0

/** Call `env_snapshot` on the given scope's view and parse its JSON. */
async function envSnapshot(
  scopeCtx: Context,
  scope: ScopeKey | undefined,
  names: string[],
): Promise<{ pid: number; cwd: string; env: Record<string, string | null> }> {
  const viewer = await scopeCtx.plugin({ name: 'viewer', inject: ['tools'], apply() {} })
  try {
    const result = await viewer.ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId(`mcp-live-direnv-${++callSeq}`),
      name: 'mcp__srv__env_snapshot',
      arguments: { names },
      // The registry's scoped lookup (`get`/`view` in dsh-tools) chains by
      // ScopeKey: the exec `agent` value is used DIRECTLY as the scope-chain
      // key, so a workspace tool call must carry the workspace ScopeKey (the
      // official loop's Agent object is not dereferenced in rc.6 — a finding
      // this suite documents rather than works around).
      ...(scope !== undefined ? { agent: scope as never } : {}),
    })
    if (result.isError) {
      throw new Error(`env_snapshot failed: ${String(result.error?.message ?? result.error)}`)
    }
    const text = result.content.find((block) => block.type === 'text')?.text
    if (typeof text !== 'string') throw new Error('env_snapshot returned no text block')
    return JSON.parse(text) as { pid: number; cwd: string; env: Record<string, string | null> }
  } finally {
    await viewer.dispose()
  }
}

/** Install a process-wide Cordis logger capture; returns the restore fn. */
function captureCordisLogs(): { warns: string[]; errors: string[]; infos: string[]; restore(): void } {
  const warns: string[] = []
  const errors: string[] = []
  const infos: string[] = []
  const proto = LoggerService.prototype
  const original = {
    warn: proto.warn,
    error: proto.error,
    info: proto.info,
  }
  proto.warn = function (this: unknown, message: unknown) {
    warns.push(String(message))
    return original.warn.apply(this, arguments as never)
  }
  proto.error = function (this: unknown, message: unknown) {
    errors.push(String(message))
    return original.error.apply(this, arguments as never)
  }
  proto.info = function (this: unknown, message: unknown) {
    infos.push(String(message))
    return original.info.apply(this, arguments as never)
  }
  return {
    warns,
    errors,
    infos,
    restore() {
      proto.warn = original.warn
      proto.error = original.error
      proto.info = original.info
    },
  }
}

describe('real MCP SDK + native direnv + WorkspaceTree hot reload', () => {
  it('full lifecycle: allowed v1 env, global untouched, no .envrc watcher, blocked reload, re-allow recovery, final cleanup', async () => {
    const c = await makeCase()
    try {
      const ws = await makeWorkspace(c.root, 'ws')
      const canonical = ws // no symlinks under the repo-internal case root
      const canaryV1 = 'cred-canary-v1-4f9a'
      const canaryV2 = 'cred-canary-v2-8c2b'
      await writeEnvrc(ws, envrcV1(canaryV1))
      const envrcPath = join(ws, '.envrc')

      // The TEST allows the exact .envrc under the isolated XDG world —
      // outside any DSH child, never through the plugin.
      const allowed = await runDirenv(c.root, ['allow', envrcPath])
      expect(allowed.timedOut).toBe(false)
      expect(allowed.code).toBe(0)

      // Global row first (same serverName 'srv'), then the workspace config.
      const markerGlobal = newMarker(c, 'global')
      const globalRow = await c.ctx.plugin(workspaceClient, globalRowConfig(c, markerGlobal) as never)
      const markerWs1 = newMarker(c, 'ws-v1')
      const markerWs2 = newMarker(c, 'ws-v2')
      await writeWorkspaceConfig(ws, workspaceConfigYaml(c, workspaceRowConfig(c, markerWs1)))
      const lease = await c.registry.acquire(ws)
      const scopeKey = lease.key

      // --- Phase A: the allowed v1 workspace row is live ---
      await vi.waitFor(async () => {
        expect((await readMarkers(markerWs1)).starts).toHaveLength(1)
      }, { timeout: 8_000 })
      const pid1 = (await readMarkers(markerWs1)).starts[0]!
      await vi.waitFor(async () => {
        expect(await viewNames(lease.ctx, scopeKey)).toEqual(WORKSPACE_SRV_NAMES)
      }, { timeout: 8_000 })
      await vi.waitFor(async () => {
        expect(await viewNames(c.ctx, undefined)).toEqual(expect.arrayContaining(GLOBAL_SRV_NAMES))
      }, { timeout: 8_000 })

      // The v1 environment reaches the fixture: .envrc overrides config
      // ordinary env, credential-shaped exports are visible, every DSH_*
      // name (config/.envrc/ambient) is absent, BASH_ENV is absent, cwd is
      // the manager-resolved canonical workspace root, and the process is
      // the marker pid.
      const v1 = await envSnapshot(lease.ctx, scopeKey, [
        'GREETING', 'CONFIG_ONLY', 'FAKE_API_KEY', 'DSH_EXPLICIT', 'DSH_FORGED',
        'DSH_SESSION_ID', 'DSH_HOME', 'BASH_ENV', 'HOME', 'MCP_FIXTURE_MARKER',
      ])
      expect(v1.pid).toBe(pid1)
      expect(v1.cwd).toBe(canonical)
      expect(v1.env.GREETING).toBe('from-envrc') // native precedence: .envrc overrides config
      expect(v1.env.CONFIG_ONLY).toBe('from-config')
      expect(v1.env.FAKE_API_KEY).toBe(canaryV1) // credential-shaped export visible
      expect(v1.env.DSH_EXPLICIT).toBeNull() // config DSH_* deleted by the empty-snapshot shim
      expect(v1.env.DSH_FORGED).toBeNull() // .envrc forged DSH_* export deleted
      expect(v1.env.DSH_SESSION_ID).toBeNull() // ambient DSH_* scrubbed by the transport
      expect(v1.env.DSH_HOME).toBeNull()
      expect(v1.env.BASH_ENV).toBeNull()
      expect(v1.env.HOME).toBe(join(c.root, 'home')) // isolated HOME reached the child

      // The global row of the same serverName is unwrapped: it never loads
      // the workspace .envrc, its explicit env (ordinary AND DSH_*) reaches
      // the child verbatim, and its process is untouched.
      const globalPid = (await readMarkers(markerGlobal)).starts[0]!
      const globalSnapshot = await envSnapshot(c.ctx, undefined, [
        'GLOBAL_ONLY', 'GREETING', 'DSH_GLOBAL_EXPLICIT',
      ])
      expect(globalSnapshot.pid).toBe(globalPid)
      expect(globalSnapshot.env.GLOBAL_ONLY).toBe('global-marker-7f3a')
      expect(globalSnapshot.env.GREETING).toBeNull() // no .envrc world
      expect(globalSnapshot.env.DSH_GLOBAL_EXPLICIT).toBe('global-kept-9b1c') // no shim ran

      // Workspace scope/key mapping is stable.
      expect(c.registry.workspaceForScope(scopeKey)).toBe(canonical)
      let scopeDisposed = false
      lease.ctx.effect(() => () => {
        scopeDisposed = true
      })

      // --- Phase B: changing ONLY .envrc must not touch the live row ---
      await writeEnvrc(ws, envrcV2(canaryV2))
      // Far past the 100ms config debounce: no .envrc watcher exists, so the
      // v1 process keeps its frozen environment and pid.
      await new Promise((resolve) => setTimeout(resolve, 900))
      const frozen = await envSnapshot(lease.ctx, scopeKey, ['GREETING', 'FAKE_API_KEY'])
      expect(frozen.pid).toBe(pid1)
      expect(frozen.env.GREETING).toBe('from-envrc')
      expect(frozen.env.FAKE_API_KEY).toBe(canaryV1)
      expect((await readMarkers(markerWs1)).starts).toHaveLength(1)

      // --- Phase C: saving the top-level config triggers the whole-tree
      // reload; the old process exits, the fresh start is blocked by native
      // direnv (content changed, not re-allowed) ---
      const logs = captureCordisLogs()
      try {
        await writeWorkspaceConfig(ws, workspaceConfigYaml(c, workspaceRowConfig(c, markerWs2)))
        await vi.waitFor(() => {
          expect(c.registry.get(canonical)?.reload?.status).toBe('failed')
        }, { timeout: 8_000 })
        // The old workspace process is disposed.
        await vi.waitFor(async () => {
          expect((await readMarkers(markerWs1)).exits).toContain(pid1)
        }, { timeout: 8_000 })
        // The fresh start never ran the fixture: native direnv blocked it.
        await vi.waitFor(async () => {
          expect((await readMarkers(markerWs2)).starts).toHaveLength(0)
        }, { timeout: 8_000 })
        // Workspace tools and mask are gone per the overlay's failure
        // semantics: the workspace inherits the full global generation.
        await vi.waitFor(async () => {
          expect(await viewNames(lease.ctx, scopeKey)).toEqual(expect.arrayContaining(GLOBAL_SRV_NAMES))
        }, { timeout: 8_000 })
        expect(c.registry.get(canonical)?.composition).toBeUndefined()
        // The workspace lease, scope, and scope-root mapping stay alive.
        expect(c.registry.get(canonical)?.leases).toBe(1)
        expect(c.registry.workspaceForScope(scopeKey)).toBe(canonical)
        expect(scopeDisposed).toBe(false)
        // The global row is untouched: process and view survive.
        expect((await readMarkers(markerGlobal)).starts).toEqual([globalPid])
        expect((await readMarkers(markerGlobal)).exits).toHaveLength(0)
        expect(await viewNames(c.ctx, undefined)).toEqual(expect.arrayContaining(GLOBAL_SRV_NAMES))
        // Blocked diagnostics never carry an .envrc-exported canary.
        const all = [...logs.errors, ...logs.warns, ...logs.infos].join('\n')
        expect(all).not.toContain(canaryV1)
        expect(all).not.toContain(canaryV2)
        expect(all).not.toContain('FAKE_API_KEY=')
      } finally {
        logs.restore()
      }

      // --- Phase D: re-allow the exact .envrc, save the config again ---
      const reallowed = await runDirenv(c.root, ['allow', envrcPath])
      expect(reallowed.timedOut).toBe(false)
      expect(reallowed.code).toBe(0)
      await writeWorkspaceConfig(ws, workspaceConfigYaml(c, workspaceRowConfig(c, markerWs2)))
      await vi.waitFor(async () => {
        expect((await readMarkers(markerWs2)).starts).toHaveLength(1)
      }, { timeout: 8_000 })
      const pid2 = (await readMarkers(markerWs2)).starts[0]!
      expect(pid2).not.toBe(pid1)
      // The mask is restored: the workspace sees only its own names again.
      await vi.waitFor(async () => {
        expect(await viewNames(lease.ctx, scopeKey)).toEqual(WORKSPACE_SRV_NAMES)
      }, { timeout: 8_000 })
      await vi.waitFor(() => {
        expect(c.registry.get(canonical)?.reload?.status).toBe('idle')
      }, { timeout: 8_000 })
      // The fresh process carries the v2 environment.
      const v2 = await envSnapshot(lease.ctx, scopeKey, [
        'GREETING', 'FAKE_API_KEY', 'DSH_EXPLICIT', 'DSH_FORGED',
      ])
      expect(v2.pid).toBe(pid2)
      expect(v2.cwd).toBe(canonical)
      expect(v2.env.GREETING).toBe('from-envrc-v2')
      expect(v2.env.FAKE_API_KEY).toBe(canaryV2)
      expect(v2.env.DSH_EXPLICIT).toBeNull()
      expect(v2.env.DSH_FORGED).toBeNull()
      expect(c.registry.workspaceForScope(scopeKey)).toBe(canonical)

      // --- Phase E: final release and global disposal, no residue ---
      expect(await viewNames(lease.ctx, scopeKey)).toEqual(WORKSPACE_SRV_NAMES)
      await lease.release()
      await vi.waitFor(async () => {
        expect((await readMarkers(markerWs2)).exits).toContain(pid2)
      }, { timeout: 8_000 })
      // The workspace tools and mask are gone (host viewer + scope key: the
      // scope layer is unwound, so the view is the inherited global set).
      expect(await viewNames(c.ctx, scopeKey)).toEqual(expect.arrayContaining(GLOBAL_SRV_NAMES))
      expect((await readMarkers(markerGlobal)).starts).toEqual([globalPid])
      expect((await readMarkers(markerGlobal)).exits).toHaveLength(0)
      expect(scopeDisposed).toBe(true)
      await globalRow.dispose()
      await vi.waitFor(async () => {
        expect((await readMarkers(markerGlobal)).exits).toContain(globalPid)
      }, { timeout: 8_000 })
      // Every fixture process that started also exited.
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(await residueOf([markerGlobal, markerWs1, markerWs2])).toEqual([])
    } finally {
      await c.dispose()
    }
  })

  it('enableWorkspaceMcp=false starts a workspace MCP row without direnv even with a blocked .envrc; explicit env is visible', async () => {
    const c = await makeCase({ enableWorkspaceMcp: false })
    try {
      const ws = await makeWorkspace(c.root, 'ws-bypass')
      // A .envrc that is NEVER allowed: native direnv would refuse to run it.
      await writeEnvrc(ws, 'export GREETING=from-envrc')
      const marker = newMarker(c, 'ws-bypass')
      await writeWorkspaceConfig(ws, workspaceConfigYaml(c, {
        transport: 'stdio',
        serverName: 'srv',
        command: process.execPath,
        args: [FIXTURE_SERVER],
        env: {
          ...c.baseEnv(),
          MCP_FIXTURE_MARKER: marker,
          MCP_FIXTURE_MODE: 'normal',
          NO_DIRENV_MARKER: 'visible-3d1e',
          DSH_EXPLICIT: 'kept-no-shim',
        },
        cwd: '',
        toolCallTimeoutMs: 8_000,
        failOnStartupError: true,
        reconnect: { initialDelayMs: 30, maxDelayMs: 60, maxAttempts: 2 },
      }))
      const lease = await c.registry.acquire(ws)
      const scopeKey = lease.key
      try {
        // The fixture starts even though the .envrc is blocked: with
        // enableWorkspaceMcp false the adapter is transparent and the row
        // spawns node directly, never through direnv.
        await vi.waitFor(async () => {
          expect((await readMarkers(marker)).starts).toHaveLength(1)
        }, { timeout: 8_000 })
        const pid = (await readMarkers(marker)).starts[0]!
        await vi.waitFor(async () => {
          expect(await viewNames(lease.ctx, scopeKey)).toContain('mcp__srv__env_snapshot')
        }, { timeout: 8_000 })
        const snapshot = await envSnapshot(lease.ctx, scopeKey, [
          'NO_DIRENV_MARKER', 'GREETING', 'DSH_EXPLICIT',
        ])
        expect(snapshot.pid).toBe(pid)
        // The explicit env is visible verbatim — including the DSH_* entry,
        // which proves no shim ran (the wrapped path would delete it).
        expect(snapshot.env.NO_DIRENV_MARKER).toBe('visible-3d1e')
        expect(snapshot.env.DSH_EXPLICIT).toBe('kept-no-shim')
        // The blocked .envrc was never evaluated.
        expect(snapshot.env.GREETING).toBeNull()
      } finally {
        await lease.release()
      }
      await vi.waitFor(async () => {
        expect((await readMarkers(marker)).exits).toHaveLength(1)
      }, { timeout: 8_000 })
      expect(await residueOf([marker])).toEqual([])
    } finally {
      await c.dispose()
    }
  })
})
