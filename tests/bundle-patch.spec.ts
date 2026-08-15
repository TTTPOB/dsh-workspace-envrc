/**
 * Bundle patch structure test (Block D).
 *
 * Parses `cordis.patch.yml` (js-yaml) and asserts the complete deployed
 * shape: exactly one insert holding the workspaceEnvrc provider row (full
 * Config) and exactly one `workspace-envrc-integration` row, no re-installed
 * official providers, and no overlay rows — the workspace overlay dependency
 * is supplied by its OWN bundle in the profile, so this patch only adds this
 * bundle's two rows.
 *
 * @module tests/bundle-patch
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { defaultConfig } from '../src/core.js'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

interface PatchEntry {
  id?: string
  name?: string
  config?: Record<string, unknown>
  disabled?: unknown
  group?: unknown
  isolate?: unknown
  inject?: unknown
  [key: string]: unknown
}

interface PatchOptions {
  insert?: PatchEntry[]
  update?: Array<{ id: string } & Record<string, unknown>>
  remove?: string[]
  disabled?: string[]
}

function loadPatch(): PatchOptions[] {
  const content = readFileSync(join(REPO_ROOT, 'cordis.patch.yml'), 'utf8')
  const parsed = yaml.load(content) as unknown
  if (!Array.isArray(parsed)) throw new Error('cordis.patch.yml must be a top-level YAML array')
  return parsed as PatchOptions[]
}

function loadPackage(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as Record<string, unknown>
}

describe('cordis.patch.yml bundle structure', () => {
  it('contains exactly one insert with the provider row (full Config) and the single integration row', () => {
    const patch = loadPatch()
    // Exactly one insert op; no update/remove/disabled ops: the bundle only
    // ever adds its own rows to a profile.
    expect(patch).toHaveLength(1)
    const inserts = patch.flatMap((op) => op.insert ?? [])
    expect(inserts).toHaveLength(2)

    const provider = inserts.find((entry) => entry.id === 'workspace-envrc')
    expect(provider).toBeDefined()
    expect(provider!.name).toBe('dsh-workspace-envrc')
    expect(provider!.config).toEqual(defaultConfig)

    const integration = inserts.find((entry) => entry.id === 'workspace-envrc-integration')
    expect(integration).toBeDefined()
    expect(integration!.name).toBe('dsh-workspace-envrc/integration-plugin')
    // The wiring row carries no config of its own.
    expect(integration!.config).toBeUndefined()
  })

  it('never re-installs official providers and never touches the overlay bundle rows', () => {
    const patch = loadPatch()
    const inserts = patch.flatMap((op) => op.insert ?? [])
    for (const entry of inserts) {
      // The official @deepseek-ai/* providers come from the DSH installation
      // itself; this bundle must not duplicate any of them.
      expect(entry.name?.startsWith('@deepseek-ai/')).toBe(false)
      // The overlay dependency is provided by the dsh-workspace-overlay
      // bundle's own patch; this patch must not add or alter overlay rows.
      expect(entry.name?.includes('workspace-overlay')).toBe(false)
      expect(entry.id?.includes('workspaceCordis')).toBe(false)
    }
  })

  it('declares the overlay as a peer dependency (its own bundle installs it), not a runtime dependency', () => {
    const pkg = loadPackage()
    const peer = pkg.peerDependencies as Record<string, string>
    const dependencies = pkg.dependencies as Record<string, string> | undefined
    expect(peer?.['dsh-workspace-overlay']).toBeDefined()
    expect(dependencies?.['dsh-workspace-overlay']).toBeUndefined()
    const bundle = pkg.dsh as { bundle?: { patch?: string } }
    expect(bundle?.bundle?.patch).toBe('./cordis.patch.yml')
  })

  it('exports the MCP adapter subpath for the integration row and Loader consumers', () => {
    const pkg = loadPackage()
    const exportsMap = pkg.exports as Record<string, unknown>
    const mcpExport = exportsMap['./mcp-adapter'] as { types?: string; default?: string } | undefined
    expect(mcpExport).toBeDefined()
    expect(mcpExport!.types).toBe('./dist/mcp-adapter.d.ts')
    expect(mcpExport!.default).toBe('./dist/mcp-adapter.js')
  })
})
