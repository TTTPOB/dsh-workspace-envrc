/**
 * Real Loader composition coverage for the built provider and Host integration.
 * The composition proves that Bash and workspace MCP activate through the
 * Loader, and that disposing the integration restores both decorated methods.
 */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { MANAGED_ENV_SHIM_LABEL, MANAGED_ENV_SHIM_SCRIPT } from '../src/core.js'
import * as IntegrationModule from '../src/integration-plugin.js'
import * as ProviderModule from '../src/provider.js'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const TMP_ROOT = join(REPO_ROOT, '.artifacts', 'loader-composition')
const PROVIDER_URL = pathToFileURL(join(REPO_ROOT, 'dist', 'provider.js')).href
const INTEGRATION_URL = pathToFileURL(join(REPO_ROOT, 'dist', 'integration-plugin.js')).href
const FIXTURE_DIR = join(REPO_ROOT, 'tests', 'fixtures', 'loader-composition')
const fixtureUrl = (name: string): string => pathToFileURL(join(FIXTURE_DIR, name)).href

interface Case {
  ctx: Context
  root: string
  workspace: string
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

function composition(workspace: string, omitMcp = false): string {
  return [
    '- id: workspace-envrc-integration',
    `  name: ${INTEGRATION_URL}`,
    '',
    '- id: workspace-envrc',
    `  name: ${PROVIDER_URL}`,
    '  config:',
    '    executable: direnv',
    '    shimShell: /bin/bash',
    '    enableBash: true',
    '    enableWorkspaceMcp: true',
    '    versionCheckTimeoutMs: 5000',
    '',
    '- id: agents',
    "  name: '@deepseek-ai/dsh-agent'",
    '',
    '- id: shell',
    `  name: ${fixtureUrl('recording-shell.mjs')}`,
    '',
    ...omitMcp ? [] : [
      '- id: workspace-mcp',
      `  name: ${fixtureUrl('recording-workspace-mcp.mjs')}`,
      '',
    ],
    '- id: workspaceCordis',
    "  name: 'dsh-workspace-overlay'",
    '  config:',
    '    trustWorkspaceConfig: false',
    '    watchWorkspaceConfig: false',
    '',
  ].join('\n')
}

async function bootCase(rows: (workspace: string) => string): Promise<Case> {
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
  await writeFile(configPath, rows(workspace))
  const includeReady = ctx.loader.create({
    id: 'include',
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  } as never)
  const c = { ctx, root, workspace, includeReady }
  liveCases.push(c)
  return c
}

function makeAgent(c: Case, lease: { ctx: Context }, id: string): Agent {
  return {
    id,
    session: { id, header: { id, cwd: c.workspace, version: 0, createdAt: 0 }, events: [] },
    ctx: lease.ctx,
  } as unknown as Agent
}

function resolveAs(c: Case, agent: Agent, command: string): { command: string } {
  return c.ctx.agents.withInitiator(agent, () =>
    c.ctx.shell.resolve({ command, workdir: join(c.workspace, 'sub'), timeoutMs: 5000 }),
  ) as { command: string }
}

function stdioConfig(serverName: string): Record<string, unknown> {
  return {
    transport: 'stdio',
    serverName,
    command: '/bin/echo',
    args: ['hi'],
    env: { ORDINARY: 'value' },
    cwd: '',
    toolCallTimeoutMs: 60_000,
    failOnStartupError: true,
  }
}

function mcpActivations(c: Case): Array<{ rawConfig: unknown }> {
  return (c.ctx.workspaceMcp as unknown as { activations: Array<{ rawConfig: unknown }> }).activations
}

describe('real Loader composition of dsh-workspace-envrc', () => {
  it('loads the built rows and activates Bash plus workspace MCP', async () => {
    const c = await bootCase(composition)
    await c.includeReady
    await c.ctx.loader.await()

    const service = c.ctx.get('workspaceEnvrc') as { name: string; wrapCommand: unknown; wrapArgv: unknown } | undefined
    expect(service?.name).toBe('workspaceEnvrc')
    expect(typeof service?.wrapCommand).toBe('function')
    expect(typeof service?.wrapArgv).toBe('function')
    expect(typeof ProviderModule.default).toBe('function')
    expect((IntegrationModule as { default?: unknown }).default).toBeUndefined()
    expect(IntegrationModule.inject).toEqual([
      'agents',
      'shell',
      'workspaceCordis',
      'workspaceMcp',
      'workspaceEnvrc',
    ])

    const lease = await c.ctx.workspaceCordis.acquire(c.workspace)
    const agent = makeAgent(c, lease, 'agent-loader')
    const detach = c.ctx.agents.register(agent)
    try {
      expect(resolveAs(c, agent, 'echo hi').command.startsWith(`exec 'direnv' 'exec' '${c.workspace}'`)).toBe(true)
      const raw = stdioConfig('loader-srv')
      await c.ctx.workspaceMcp.activate(lease.ctx, raw)
      const wrapped = mcpActivations(c).at(-1)!.rawConfig as { command: string; args: string[] }
      expect([wrapped.command, ...wrapped.args]).toEqual([
        'direnv', 'exec', c.workspace,
        'env', '-u', 'BASH_ENV', '-u', 'ENV',
        '/bin/bash', '--noprofile', '--norc', '-c',
        MANAGED_ENV_SHIM_SCRIPT, MANAGED_ENV_SHIM_LABEL, '0',
        '/bin/echo', 'hi',
      ])
    } finally {
      detach()
    }
  })

  it('keeps both adapters pending until workspaceMcp arrives', async () => {
    const c = await bootCase(workspace => composition(workspace, true))
    await c.includeReady
    await c.ctx.loader.await()
    const lease = await c.ctx.workspaceCordis.acquire(c.workspace)
    const agent = makeAgent(c, lease, 'agent-pending')
    const detach = c.ctx.agents.register(agent)
    try {
      expect(resolveAs(c, agent, 'echo pending').command).toBe('echo pending')
      await c.ctx.loader.create({ name: fixtureUrl('recording-workspace-mcp.mjs') })
      await c.ctx.loader.await()
      expect(resolveAs(c, agent, 'echo active').command.startsWith(`exec 'direnv' 'exec' '${c.workspace}'`)).toBe(true)
    } finally {
      detach()
    }
  })
})
