import { Context } from '@deepseek-ai/cordis'
import { vi, beforeEach, describe, expect, it } from 'vitest'
import * as BashAdapter from '../src/bash-adapter.js'
import * as Integration from '../src/integration-plugin.js'
import * as McpAdapter from '../src/mcp-adapter.js'

vi.mock('../src/bash-adapter.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/bash-adapter.js')>()
  return {
    ...mod,
    installWorkspaceEnvrcBashAdapter: vi.fn(() => ({ dispose: vi.fn() })),
  }
})

vi.mock('../src/mcp-adapter.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/mcp-adapter.js')>()
  return {
    ...mod,
    installWorkspaceEnvrcMcpAdapter: vi.fn(() => ({ dispose: vi.fn() })),
  }
})

const bashInstall = BashAdapter.installWorkspaceEnvrcBashAdapter as unknown as ReturnType<typeof vi.fn>
const mcpInstall = McpAdapter.installWorkspaceEnvrcMcpAdapter as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  bashInstall.mockReset()
  mcpInstall.mockReset()
  bashInstall.mockImplementation(() => ({ dispose: vi.fn() }))
  mcpInstall.mockImplementation(() => ({ dispose: vi.fn() }))
})

describe('workspace-envrc-integration plugin adapter ordering', () => {
  it('installs Bash then MCP and disposes MCP before Bash', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(Integration)
    const bashHandle = bashInstall.mock.results[0]!.value as { dispose: ReturnType<typeof vi.fn> }
    const mcpHandle = mcpInstall.mock.results[0]!.value as { dispose: ReturnType<typeof vi.fn> }

    expect(bashInstall).toHaveBeenCalledTimes(1)
    expect(mcpInstall).toHaveBeenCalledTimes(1)
    expect(bashInstall.mock.invocationCallOrder[0]!).toBeLessThan(mcpInstall.mock.invocationCallOrder[0]!)

    await fiber.dispose()
    expect(mcpHandle.dispose).toHaveBeenCalledTimes(1)
    expect(bashHandle.dispose).toHaveBeenCalledTimes(1)
    expect(mcpHandle.dispose.mock.invocationCallOrder[0]!).toBeLessThan(bashHandle.dispose.mock.invocationCallOrder[0]!)
  })

  it('rolls back Bash when MCP installation fails', async () => {
    const ctx = new Context()
    const failure = new Error('mcp adapter exploded')
    mcpInstall.mockImplementationOnce(() => { throw failure })

    await expect(ctx.plugin(Integration)).rejects.toBe(failure)
    const bashHandle = bashInstall.mock.results[0]!.value as { dispose: ReturnType<typeof vi.fn> }
    expect(bashHandle.dispose).toHaveBeenCalledTimes(1)
  })
})
