import { Context } from '@deepseek-ai/cordis'
import { bindScopeParent, createScope, type ScopeKey } from '@deepseek-ai/dsh-scope'
import { describe, expect, it } from 'vitest'
import { resolveAgentWorkspace, type WorkspaceCordisLookup } from '../src/core.js'

/**
 * A fake `workspaceCordis` mirroring the real registry's public contract: a
 * WeakMap from live workspace scope keys to canonical roots whose entries die
 * with the key (disposed mappings resolve to undefined).
 */
function fakeRegistry(entries: ReadonlyMap<ScopeKey, string>): WorkspaceCordisLookup {
  const roots = new WeakMap<ScopeKey, string>()
  for (const [key, root] of entries) roots.set(key, root)
  return { workspaceForScope: (key) => roots.get(key) }
}

function makeAgent(): { ctx: Context } {
  const ctx = new Context()
  return { ctx }
}

/** Mint one scope chain: agent -> optional parents -> ... -> workspace. */
function scopeAgent(parent?: ScopeKey): { ctx: Context; key: ScopeKey } {
  const ctx = new Context()
  const key: ScopeKey = {}
  const scope = createScope(ctx, key, parent !== undefined ? { parent } : undefined)
  return { ctx: scope.ctx, key }
}

describe('resolveAgentWorkspace', () => {
  it('returns undefined for an unscoped agent context', () => {
    expect(resolveAgentWorkspace(makeAgent(), fakeRegistry(new Map()))).toBeUndefined()
  })

  it('resolves a direct agent -> workspace mapping', () => {
    const agent = scopeAgent()
    const registry = fakeRegistry(new Map([[agent.key, '/workspaces/direct']]))
    expect(resolveAgentWorkspace(agent, registry)).toBe('/workspaces/direct')
  })

  it('walks an agent -> preset -> workspace chain', () => {
    const workspaceKey: ScopeKey = {}
    const preset = scopeAgent(workspaceKey)
    const agent = scopeAgent(preset.key)
    const registry = fakeRegistry(new Map([[workspaceKey, '/workspaces/preset-root']]))
    expect(resolveAgentWorkspace(agent, registry)).toBe('/workspaces/preset-root')
  })

  it('returns the nearest mapping when several ancestors map', () => {
    const workspaceKey: ScopeKey = {}
    const preset = scopeAgent(workspaceKey)
    const agent = scopeAgent(preset.key)
    const registry = fakeRegistry(
      new Map([
        [workspaceKey, '/workspaces/root'],
        [preset.key, '/workspaces/preset'],
      ]),
    )
    expect(resolveAgentWorkspace(agent, registry)).toBe('/workspaces/preset')
  })

  it('keeps two agents in different workspaces isolated', () => {
    const wsA: ScopeKey = {}
    const wsB: ScopeKey = {}
    const agentA = scopeAgent(wsA)
    const agentB = scopeAgent(wsB)
    const registry = fakeRegistry(
      new Map([
        [wsA, '/workspaces/a'],
        [wsB, '/workspaces/b'],
      ]),
    )
    expect(resolveAgentWorkspace(agentA, registry)).toBe('/workspaces/a')
    expect(resolveAgentWorkspace(agentB, registry)).toBe('/workspaces/b')
  })

  it('returns undefined for a scoped agent with no mapping anywhere', () => {
    const agent = scopeAgent()
    expect(resolveAgentWorkspace(agent, fakeRegistry(new Map()))).toBeUndefined()
  })

  it('returns undefined once the workspace mapping is disposed', () => {
    const workspaceKey: ScopeKey = {}
    const agent = scopeAgent(workspaceKey)
    const registry = fakeRegistry(new Map([[workspaceKey, '/workspaces/live']]))
    expect(resolveAgentWorkspace(agent, registry)).toBe('/workspaces/live')
    // Disposing the workspace entry drops its scopeRoots WeakMap entry; the
    // walk then continues to an exhausted chain and yields undefined.
    const afterDisposal = fakeRegistry(new Map())
    expect(resolveAgentWorkspace(agent, afterDisposal)).toBeUndefined()
  })

  it('walks a disposed agent scope chain safely (public API terminates)', () => {
    const workspaceKey: ScopeKey = {}
    const agent = scopeAgent(workspaceKey)
    const registry = fakeRegistry(new Map([[workspaceKey, '/workspaces/still-live']]))
    // The workspace entry outlives the agent scope: scope disposal does not
    // delete the parent binding, so the walk still reaches the live root.
    expect(resolveAgentWorkspace(agent, registry)).toBe('/workspaces/still-live')
  })
})
