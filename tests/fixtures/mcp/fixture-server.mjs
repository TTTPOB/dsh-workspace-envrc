/**
 * Minimal real MCP SDK stdio fixture for the workspace-envrc live direnv
 * suite (`tests/mcp-live-direnv.spec.ts`).
 *
 * Built on the REAL `@modelcontextprotocol/sdk` `Server` +
 * `StdioServerTransport`; the suite proves the wrapped workspace argv spawns
 * this process through native `direnv exec`. This fixture is self-contained
 * — it never imports anything from the dsh-workspace-overlay repository or
 * its test fixtures.
 *
 * Run: `node tests/fixtures/mcp/fixture-server.mjs`
 *
 * Environment:
 * - MCP_FIXTURE_MARKER: append `start <pid>` on boot and `exit <pid>` on
 *   exit, so the suite can prove which process generation is live and that
 *   every generation exited.
 * - MCP_FIXTURE_MODE: 'normal' | 'masked' | 'masked-partial' (default
 *   'normal'). 'masked' serves `env_snapshot` plus t1..tN
 *   (MCP_FIXTURE_MASKED_COUNT, default 5); 'masked-partial' serves
 *   `env_snapshot` plus t1..tN (default 3) — the namespace-mask pair used to
 *   prove a workspace override replaces the inherited global generation.
 *
 * Tools:
 * - `env_snapshot` — reports `{ pid, cwd, env }` for the named environment
 *   variables (`null` when unset). The suite asserts the final child
 *   environment: canonical workspace `.envrc` exports, config explicit env
 *   precedence, credential-shaped visibility, absence of every DSH_* name
 *   and of BASH_ENV, and the manager-resolved workspace cwd.
 * - `add` / `greet` — trivial echo tools proving tool execution works end to
 *   end when a server is reachable.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  InitializeRequestSchema,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js'

const marker = process.env.MCP_FIXTURE_MARKER
function mark(line) {
  if (!marker) return
  try {
    mkdirSync(dirname(marker), { recursive: true })
    appendFileSync(marker, line)
  } catch {
    // A marker failure must never take the fixture down.
  }
}
mark(`start ${process.pid}\n`)
process.on('exit', () => mark(`exit ${process.pid}\n`))

const mode = process.env.MCP_FIXTURE_MODE ?? 'normal'

/** One controllable tool: schema plus the handler that produces its result. */
const tools = new Map()

function register(tool) {
  tools.set(tool.name, tool)
}

register({
  name: 'env_snapshot',
  title: 'Env Snapshot Tool',
  description: 'Reports pid, cwd, and the values of the named environment variables.',
  inputSchema: {
    type: 'object',
    properties: { names: { type: 'array', items: { type: 'string' } } },
    required: ['names'],
  },
  handler: async (args) => {
    const names = Array.isArray(args.names) ? args.names.map(String) : []
    const env = Object.fromEntries(names.map((name) => [name, process.env[name] ?? null]))
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ pid: process.pid, cwd: process.cwd(), env }),
      }],
    }
  },
})

register({
  name: 'add',
  title: 'Add Tool',
  description: 'Adds two numbers.',
  inputSchema: {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'],
  },
  handler: async (args) => ({
    content: [{ type: 'text', text: String(Number(args.a) + Number(args.b)) }],
  }),
})

register({
  name: 'greet',
  title: 'Greet Tool',
  description: 'Greets a person by name.',
  inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  handler: async (args) => ({ content: [{ type: 'text', text: `Hello, ${String(args.name)}!` }] }),
})

const server = new Server(
  { name: 'fixture-server', version: '1.0.0' },
  { capabilities: { tools: { listChanged: true } } },
)

server.setRequestHandler(InitializeRequestSchema, async (request) => ({
  protocolVersion: request.params.protocolVersion,
  capabilities: { tools: { listChanged: true } },
  serverInfo: { name: 'fixture-server', version: '1.0.0' },
}))

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const all = [...tools.values()].map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }))
  switch (mode) {
    case 'masked': {
      // Namespace-mask tests: env_snapshot plus t1..tN.
      const count = Math.max(1, Number(process.env.MCP_FIXTURE_MASKED_COUNT ?? '5'))
      return {
        tools: [
          ...all.filter((tool) => tool.name === 'env_snapshot'),
          ...Array.from({ length: count }, (_, i) => ({
            name: `t${i + 1}`,
            description: `Masked tool ${i + 1}.`,
            inputSchema: { type: 'object' },
          })),
        ],
      }
    }
    case 'masked-partial': {
      // The override side: env_snapshot plus t1..tN (a subset of 'masked').
      const count = Math.max(1, Number(process.env.MCP_FIXTURE_MASKED_COUNT ?? '3'))
      return {
        tools: [
          ...all.filter((tool) => tool.name === 'env_snapshot'),
          ...Array.from({ length: count }, (_, i) => ({
            name: `t${i + 1}`,
            description: `Override tool ${i + 1}.`,
            inputSchema: { type: 'object' },
          })),
        ],
      }
    }
    default:
      return { tools: all }
  }
})

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = tools.get(request.params.name)
  if (tool === undefined) {
    throw new McpError(-32602, `Unknown tool: ${request.params.name}`)
  }
  try {
    return await tool.handler(request.params.arguments ?? {})
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    }
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
