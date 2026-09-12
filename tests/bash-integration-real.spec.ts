import { Context, type Fiber } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { JobId } from '@deepseek-ai/dsh-jobs'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createScope, type Scope, type ScopeKey } from '@deepseek-ai/dsh-scope'
import * as BashEnvPlugin from '@deepseek-ai/dsh-shell-env'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultConfig, type WorkspaceEnvrcConfig } from '../src/core.js'
import * as Integration from '../src/integration-plugin.js'
import WorkspaceEnvrc from '../src/provider.js'
import {
  inertWorkspaceMcp,
  mutableWorkspaceRegistry,
  okSpawn,
  RecordingShellExecutor,
} from './helpers.js'

/**
 * REAL background-path harness: the official AgentRegistry (withInitiator +
 * currentInitiator), ToolRuntime, tool-bash, the in-memory jobs provider
 * (LocalJobRegistry + an attached controller), shell-env, system-prompt, and
 * this bundle's provider + integration plugin. Only the `ctx.shell` provider
 * is a recording stub — the resolve call happens inside the real tool-bash
 * execute (foreground) and inside the real jobs `start` run starter
 * (background), exactly like production.
 */
interface Harness {
  ctx: Context
  executor: RecordingShellExecutor
  registry: ReturnType<typeof mutableWorkspaceRegistry>
  /** Register one live agent whose ctx carries `key` (scoped under `parent` when given). */
  makeAgent(id: string, key: ScopeKey, parent?: ScopeKey): Promise<{ agent: Agent; dispose(): Promise<void> }>
  /** Run one bash tool call for `agent` inside the real initiator boundary. */
  bash(agent: Agent, args: Record<string, unknown>): Promise<ToolExecutionResult>
  dispose(): Promise<void>
}

let callCounter = 0

async function setup(config: WorkspaceEnvrcConfig = defaultConfig): Promise<Harness> {
  const ctx = new Context()
  const registry = mutableWorkspaceRegistry()
  const fibers: Fiber[] = []
  const scopes: Scope[] = []
  fibers.push(await ctx.plugin(SystemPrompt))
  fibers.push(await ctx.plugin(ToolRuntime))
  fibers.push(await ctx.plugin(AgentRegistry))
  fibers.push(await ctx.plugin(LocalJobRegistry))
  // A controller attached from the unscoped host serves every owner, which is
  // what the real `dsh-tool-jobs` row provides for composed agents.
  ctx.jobs.attachController('envrc-real-test')
  fibers.push(await ctx.plugin(BashEnvPlugin))
  fibers.push(await ctx.plugin(RecordingShellExecutor))
  fibers.push(await ctx.plugin(ToolBash))
  ctx.provide('workspaceCordis', registry)
  // The integration row injects the MCP manager; this Bash harness never
  // activates an MCP row.
  ctx.provide('workspaceMcp', inertWorkspaceMcp())
  const RuntimeProvider = class extends WorkspaceEnvrc {
    constructor(applyCtx: Context) {
      super(applyCtx, config, { spawn: okSpawn() })
    }
  }
  fibers.push(await ctx.plugin(RuntimeProvider, config as never))
  fibers.push(await ctx.plugin(Integration))

  return {
    ctx,
    executor: ctx.shell as unknown as RecordingShellExecutor,
    registry,
    async makeAgent(id, key, parent) {
      const scope = createScope(ctx, key, parent !== undefined ? { parent } : undefined)
      scopes.push(scope)
      const agent = {
        id,
        session: { id, header: { id, cwd: `/cwd/${id}`, version: 0, createdAt: 0 } },
        ctx: scope.ctx,
      } as unknown as Agent
      const detach = ctx.agents.register(agent)
      return {
        agent,
        dispose: async () => {
          detach()
          await scope.dispose()
        },
      }
    },
    bash(agent, args) {
      return ctx.agents.withInitiator(agent, () =>
        ctx.tools.execute({
          callId: ToolCallId(`call-${++callCounter}`),
          name: 'bash',
          arguments: args,
          agent,
          signal: new AbortController().signal,
        }),
      )
    },
    async dispose() {
      for (const scope of scopes.reverse()) await scope.dispose()
      for (const fiber of fibers.reverse()) await fiber.dispose()
    },
  }
}

describe('workspace-envrc Bash adapter over the real tool-bash path', () => {
  let h: Harness
  beforeEach(async () => {
    h = await setup()
  })
  afterEach(async () => {
    await h.dispose()
  })

  it('wraps the foreground resolve with the exact agent workspace, never the workdir', async () => {
    const wsA: ScopeKey = {}
    h.registry.set(wsA, '/workspaces/a')
    const { agent } = await h.makeAgent('agent-a', wsA)

    const result = await h.bash(agent, { command: 'echo hi', description: 'demo', workdir: '/workspaces/b' })
    expect(result.isError).toBe(false)

    const recorded = h.executor.records[0]!.request
    // The canonical workspace comes from the Agent's scope mapping, while the
    // caller-resolved workdir points at a DIFFERENT workspace path: the
    // wrapper must not guess from workdir.
    expect(recorded.command.startsWith("exec 'direnv' 'exec' '/workspaces/a'")).toBe(true)
    expect(recorded.command.endsWith("'/bin/bash' '-c' 'echo hi'")).toBe(true)
    expect(recorded.workdir).toBe('/workspaces/b')
    // The managed snapshot flows from the real shell-env collect().
    expect(recorded.dshEnv?.DSH_SESSION_ID).toBe('agent-a')
  })

  it('wraps the background resolve inside the real jobs starter with the exact agent workspace', async () => {
    const wsA: ScopeKey = {}
    h.registry.set(wsA, '/workspaces/a')
    const { agent } = await h.makeAgent('agent-a', wsA)

    const result = await h.bash(agent, {
      command: 'sleep 0',
      description: 'demo',
      // A workdir inside the OTHER workspace: the background resolve must
      // still use the exact Agent's workspace, never guess from workdir.
      workdir: '/workspaces/b',
      run_in_background: true,
    })
    expect(result.isError).toBe(false)
    const value = result.value as { kind: string; jobId: string }
    expect(value.kind).toBe('background')

    // The only resolve recorded so far happened inside jobs.start()'s run
    // starter (synchronous, within the inherited initiator context) — not in
    // the foreground path, which this call never takes. The background
    // request carries no tool signal, unlike a foreground request.
    expect(h.executor.records).toHaveLength(1)
    const recorded = h.executor.records[0]!.request
    expect(recorded.command.startsWith("exec 'direnv' 'exec' '/workspaces/a'")).toBe(true)
    expect(recorded.signal).toBeUndefined()
    expect(recorded.dshEnv?.DSH_SESSION_ID).toBe('agent-a')

    // The job registry owns the process: read the settled record through the
    // real jobs provider with the exact owner.
    const { snapshot } = h.ctx.jobs.read(value.jobId as JobId, agent)
    expect(snapshot.status).toBe('completed')
    expect(snapshot.ownerSession).toBe('agent-a')
  })

  it('keeps two agents in two workspaces isolated across foreground and background', async () => {
    const wsA: ScopeKey = {}
    h.registry.set(wsA, '/workspaces/a')
    const wsB: ScopeKey = {}
    h.registry.set(wsB, '/workspaces/b')
    const { agent: agentA } = await h.makeAgent('agent-a', wsA)
    const { agent: agentB } = await h.makeAgent('agent-b', wsB)

    await Promise.all([
      h.bash(agentA, { command: 'echo a', description: 'd' }),
      h.bash(agentB, { command: 'echo b', description: 'd' }),
    ])
    const [foregroundA, foregroundB] = h.executor.records
    expect(foregroundA!.request.command.startsWith("exec 'direnv' 'exec' '/workspaces/a'")).toBe(true)
    expect(foregroundB!.request.command.startsWith("exec 'direnv' 'exec' '/workspaces/b'")).toBe(true)

    await Promise.all([
      h.bash(agentA, { command: 'echo a-bg', description: 'd', run_in_background: true }),
      h.bash(agentB, { command: 'echo b-bg', description: 'd', run_in_background: true }),
    ])
    const [backgroundA, backgroundB] = h.executor.records.slice(2)
    expect(backgroundA!.request.command.startsWith("exec 'direnv' 'exec' '/workspaces/a'")).toBe(true)
    expect(backgroundB!.request.command.startsWith("exec 'direnv' 'exec' '/workspaces/b'")).toBe(true)
  })

  it('resolves through an agent -> preset -> workspace scope chain', async () => {
    const wsKey: ScopeKey = {}
    h.registry.set(wsKey, '/workspaces/preset-root')
    const presetKey: ScopeKey = {}
    createScope(h.ctx, presetKey, { parent: wsKey })

    const agentKey: ScopeKey = {}
    const { agent } = await h.makeAgent('agent-preset', agentKey, presetKey)

    const result = await h.bash(agent, { command: 'echo chained', description: 'd' })
    expect(result.isError).toBe(false)
    expect(h.executor.records[0]!.request.command.startsWith("exec 'direnv' 'exec' '/workspaces/preset-root'")).toBe(true)
  })

  it('leaves agentless direct shell.resolve untouched while the adapter is mounted', async () => {
    const wsA: ScopeKey = {}
    h.registry.set(wsA, '/workspaces/a')
    // A direct call outside any initiator boundary — even with a workdir
    // inside the mapped workspace — must run unchanged.
    const spec = h.ctx.shell.resolve({
      command: 'echo direct',
      workdir: '/workspaces/a',
      timeoutMs: 5000,
    })
    expect(spec.command).toBe('echo direct')
    expect(h.executor.records).toHaveLength(1)
    expect(h.executor.records[0]!.request.command).toBe('echo direct')
  })
})
