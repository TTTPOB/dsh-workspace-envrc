import { vi, beforeEach, describe, expect, it } from 'vitest'
import * as BashAdapter from '../src/bash-adapter.js'
import * as Integration from '../src/integration-plugin.js'
import * as McpAdapter from '../src/mcp-adapter.js'
import * as TerminalAdapter from '../src/terminal-adapter.js'
import { terminalHarness } from './terminal-harness.js'

/**
 * The integration installer's install/dispose ORDER is only observable
 * through the installer modules themselves, so this file mocks the three
 * adapter modules with pass-through spies (every call still runs the real
 * installer and returns the real handle, with a spied dispose). The
 * integration plugin's apply is the real code under test.
 */
vi.mock('../src/bash-adapter.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/bash-adapter.js')>()
  const install = vi.fn(
    (...args: Parameters<typeof mod.installWorkspaceEnvrcBashAdapter>): ReturnType<typeof mod.installWorkspaceEnvrcBashAdapter> => {
      const handle = mod.installWorkspaceEnvrcBashAdapter(...args)
      return { ...handle, dispose: vi.fn(() => handle.dispose()) }
    },
  )
  return { ...mod, installWorkspaceEnvrcBashAdapter: install }
})

vi.mock('../src/terminal-adapter.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/terminal-adapter.js')>()
  const install = vi.fn(
    (...args: Parameters<typeof mod.installWorkspaceEnvrcTerminalAdapter>): ReturnType<typeof mod.installWorkspaceEnvrcTerminalAdapter> => {
      const handle = mod.installWorkspaceEnvrcTerminalAdapter(...args)
      return { ...handle, dispose: vi.fn(() => handle.dispose()) }
    },
  )
  return { ...mod, installWorkspaceEnvrcTerminalAdapter: install }
})

vi.mock('../src/mcp-adapter.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/mcp-adapter.js')>()
  const install = vi.fn(
    (...args: Parameters<typeof mod.installWorkspaceEnvrcMcpAdapter>): ReturnType<typeof mod.installWorkspaceEnvrcMcpAdapter> => {
      const handle = mod.installWorkspaceEnvrcMcpAdapter(...args)
      return { ...handle, dispose: vi.fn(() => handle.dispose()) }
    },
  )
  return { ...mod, installWorkspaceEnvrcMcpAdapter: install }
})

const bashInstall = BashAdapter.installWorkspaceEnvrcBashAdapter as unknown as ReturnType<typeof vi.fn>
const terminalInstall = TerminalAdapter.installWorkspaceEnvrcTerminalAdapter as unknown as ReturnType<typeof vi.fn>
const mcpInstall = McpAdapter.installWorkspaceEnvrcMcpAdapter as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  bashInstall.mockClear()
  terminalInstall.mockClear()
  mcpInstall.mockClear()
})

describe('workspace-envrc-integration plugin adapter ordering', () => {
  it('installs Bash then Terminal then MCP, and disposes MCP first then Terminal then Bash', async () => {
    const h = await terminalHarness()
    try {
      const fiber = await h.ctx.plugin(Integration)

      // Install order: Bash, then Terminal, then the MCP adapter.
      expect(bashInstall).toHaveBeenCalledTimes(1)
      expect(terminalInstall).toHaveBeenCalledTimes(1)
      expect(mcpInstall).toHaveBeenCalledTimes(1)
      expect(bashInstall.mock.invocationCallOrder[0]!).toBeLessThan(terminalInstall.mock.invocationCallOrder[0]!)
      expect(terminalInstall.mock.invocationCallOrder[0]!).toBeLessThan(mcpInstall.mock.invocationCallOrder[0]!)

      const bashHandle = bashInstall.mock.results[0]!.value as { dispose: ReturnType<typeof vi.fn> }
      const terminalHandle = terminalInstall.mock.results[0]!.value as { dispose: ReturnType<typeof vi.fn> }
      const mcpHandle = mcpInstall.mock.results[0]!.value as { dispose: ReturnType<typeof vi.fn> }

      await fiber.dispose()

      // Disposal order: MCP first, then Terminal, then Bash (reverse install).
      expect(mcpHandle.dispose).toHaveBeenCalledTimes(1)
      expect(terminalHandle.dispose).toHaveBeenCalledTimes(1)
      expect(bashHandle.dispose).toHaveBeenCalledTimes(1)
      expect(mcpHandle.dispose.mock.invocationCallOrder[0]!).toBeLessThan(terminalHandle.dispose.mock.invocationCallOrder[0]!)
      expect(terminalHandle.dispose.mock.invocationCallOrder[0]!).toBeLessThan(bashHandle.dispose.mock.invocationCallOrder[0]!)
    } finally {
      await h.dispose()
    }
  })

  it('rolls back a partially failed terminal install without leaving Bash mounted', async () => {
    const h = await terminalHarness()
    try {
      const fiber = await h.ctx.plugin(Integration)
      // Sanity: all three adapters are live before the failure.
      expect(bashInstall).toHaveBeenCalledTimes(1)
      expect(terminalInstall).toHaveBeenCalledTimes(1)
      expect(mcpInstall).toHaveBeenCalledTimes(1)

      // Now make a LATER terminal install fail while Bash installs fine.
      terminalInstall.mockImplementationOnce(() => {
        throw new Error('terminal adapter exploded')
      })
      await expect(h.ctx.plugin(Integration)).rejects.toThrow('terminal adapter exploded')

      // The failed fiber's Bash adapter was rolled back; the FIRST fiber's
      // adapters are untouched (successor safety). The MCP stage never ran.
      const firstBashHandle = bashInstall.mock.results[0]!.value as { dispose: ReturnType<typeof vi.fn> }
      const secondBashHandle = bashInstall.mock.results[1]!.value as { dispose: ReturnType<typeof vi.fn> }
      expect(secondBashHandle.dispose).toHaveBeenCalledTimes(1)
      expect(firstBashHandle.dispose).not.toHaveBeenCalled()
      expect(mcpInstall).toHaveBeenCalledTimes(1) // the first fiber's install

      await fiber.dispose()
      expect(firstBashHandle.dispose).toHaveBeenCalledTimes(1)
    } finally {
      await h.dispose()
    }
  })

  it('rolls back a partially failed MCP install without leaving Bash or Terminal mounted', async () => {
    const h = await terminalHarness()
    try {
      const fiber = await h.ctx.plugin(Integration)
      expect(bashInstall).toHaveBeenCalledTimes(1)
      expect(terminalInstall).toHaveBeenCalledTimes(1)
      expect(mcpInstall).toHaveBeenCalledTimes(1)

      // A later MCP install fails while Bash and Terminal install fine.
      mcpInstall.mockImplementationOnce(() => {
        throw new Error('mcp adapter exploded')
      })
      await expect(h.ctx.plugin(Integration)).rejects.toThrow('mcp adapter exploded')

      // The failed fiber's Terminal AND Bash adapters were rolled back
      // (reverse of the install order reached so far); the FIRST fiber's
      // adapters are untouched (successor safety).
      const firstBashHandle = bashInstall.mock.results[0]!.value as { dispose: ReturnType<typeof vi.fn> }
      const firstTerminalHandle = terminalInstall.mock.results[0]!.value as { dispose: ReturnType<typeof vi.fn> }
      const secondBashHandle = bashInstall.mock.results[1]!.value as { dispose: ReturnType<typeof vi.fn> }
      const secondTerminalHandle = terminalInstall.mock.results[1]!.value as { dispose: ReturnType<typeof vi.fn> }
      expect(secondTerminalHandle.dispose).toHaveBeenCalledTimes(1)
      expect(secondBashHandle.dispose).toHaveBeenCalledTimes(1)
      expect(secondTerminalHandle.dispose.mock.invocationCallOrder[0]!).toBeLessThan(
        secondBashHandle.dispose.mock.invocationCallOrder[0]!,
      )
      expect(firstBashHandle.dispose).not.toHaveBeenCalled()
      expect(firstTerminalHandle.dispose).not.toHaveBeenCalled()

      await fiber.dispose()
      expect(firstTerminalHandle.dispose).toHaveBeenCalledTimes(1)
      expect(firstBashHandle.dispose).toHaveBeenCalledTimes(1)
    } finally {
      await h.dispose()
    }
  })
})
