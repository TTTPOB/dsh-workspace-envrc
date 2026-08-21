/**
 * `workspaceEnvrc` service provider: applies the local machine's native
 * direnv environment to explicitly Agent/workspace-owned executions.
 *
 * The provider owns strict Config validation, a bounded activation preflight,
 * Agent-to-workspace resolution through scope ancestry, and the pure POSIX
 * argv/command wrappers. `./integration-plugin.js` installs the reversible
 * Bash and workspace MCP adapters that consume these projections.
 *
 * The plugin never calls `direnv allow`/`deny`/`permit`/`grant`/`edit`,
 * never parses or sources `.envrc`, and never mutates `process.env`;
 * activation checks run through plain node child processes.
 *
 * @module dsh-workspace-envrc
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import z from '@deepseek-ai/schemastery'
import type WorkspaceRegistry from 'dsh-workspace-overlay'
import {
  MANAGED_ENV_SHIM_LABEL,
  MANAGED_ENV_SHIM_SCRIPT,
  assertPosixPlatform,
  assertWorkspaceEnvrcConfig,
  buildExecArgv,
  defaultConfig,
  resolveAgentWorkspace,
  runPreflight,
  wrapCommand as wrapCommandCore,
  type PreflightSpawn,
  type WorkspaceEnvrcConfig,
} from './core.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Native-direnv workspace environment projections for owned executions. */
    workspaceEnvrc: WorkspaceEnvrc
  }
}

export type { WorkspaceEnvrcConfig } from './core.js'
export { defaultConfig } from './core.js'

/**
 * Constructor-only seams for deterministic tests.
 *
 * The plugin loader cannot pass constructor arguments to a class plugin, so
 * a production registration always gets the real child-process spawner;
 * tests that need deterministic preflight control construct the service
 * directly (or through a wrapper plugin) with these options. The seam is
 * deliberately absent from the Config schema.
 */
export interface WorkspaceEnvrcRuntime {
  /** Injectable preflight child launcher for the activation checks. */
  spawn?: PreflightSpawn | undefined
}

export default class WorkspaceEnvrc extends Service {
  static Config = z.object({
    executable: z.string().default(defaultConfig.executable),
    shimShell: z.string().default(defaultConfig.shimShell),
    enableBash: z.boolean().default(defaultConfig.enableBash),
    enableWorkspaceMcp: z.boolean().default(defaultConfig.enableWorkspaceMcp),
    versionCheckTimeoutMs: z
      .natural()
      .min(1)
      .max(MAX_TIMER_DELAY_MS)
      .default(defaultConfig.versionCheckTimeoutMs),
  }) as z<WorkspaceEnvrcConfig>

  /** Activate only once the Agent registry and the workspace registry exist. */
  static inject = ['agents', 'workspaceCordis']

  /**
   * The in-flight activation preflight controller, reaped by the fiber
   * disposer when the fiber is disposed before init completes.
   */
  private activePreflight: AbortController | undefined

  constructor(
    ctx: Context,
    private readonly config: WorkspaceEnvrcConfig = defaultConfig,
    private readonly runtime: WorkspaceEnvrcRuntime = {},
  ) {
    super(ctx, 'workspaceEnvrc')
    assertWorkspaceEnvrcConfig(config)
    // A fiber disposed while the activation preflight is still in flight
    // (init rollback, host teardown) must reap the child: aborting the
    // controller kills it, and runPreflight always awaits the child's close.
    ctx.effect(() => () => this.activePreflight?.abort())
  }

  /**
   * Strict activation gate: V1 is POSIX-only, and both native checks —
   * `direnv version` and one real clear/restore shim probe under the configured
   * shell — must complete within `versionCheckTimeoutMs` before this service
   * is ready. The checks never use `shell: true`, read
   * or run no workspace `.envrc`, and never touch `process.env`. A missing
   * executable, a bad version command, an invalid absolute shim shell, or a
   * timeout fails loudly and leaves no adapters installed.
   */
  async [Service.init](): Promise<void> {
    assertPosixPlatform(process.platform)
    const controller = new AbortController()
    this.activePreflight = controller
    try {
      await runPreflight({
        argv: [this.config.executable, 'version'],
        stage: 'direnv version',
        identity: this.config.executable,
        timeoutMs: this.config.versionCheckTimeoutMs,
        signal: controller.signal,
        spawn: this.runtime.spawn,
      })
      await runPreflight({
        // Execute the real restoration shim, not merely `exit 0`: this rejects
        // a configured shell whose prefix expansion cannot clear arbitrary
        // DSH_* names (notably the Bash 3.2 compatibility boundary). Ambient
        // startup hooks stay disabled for both shim and probe shells.
        argv: [
          'env', '-u', 'BASH_ENV', '-u', 'ENV',
          'DSH_ENVRC_STALE=must-be-cleared',
          this.config.shimShell, '--noprofile', '--norc', '-c',
          MANAGED_ENV_SHIM_SCRIPT,
          MANAGED_ENV_SHIM_LABEL,
          '1', 'DSH_ENVRC_PREFLIGHT', 'restored',
          this.config.shimShell, '--noprofile', '--norc', '-c',
          'test -z "${DSH_ENVRC_STALE-}" && test "${DSH_ENVRC_PREFLIGHT-}" = restored',
        ],
        stage: 'shim semantics',
        identity: this.config.shimShell,
        timeoutMs: this.config.versionCheckTimeoutMs,
        signal: controller.signal,
        spawn: this.runtime.spawn,
      })
    } finally {
      this.activePreflight = undefined
    }
  }

  /**
   * Read-only projection of the `enableBash` config. The Bash adapter checks
   * this on every resolve: when false the adapter may stay installed but is
   * permanently transparent. Never a mutable config handle.
   */
  get bashEnabled(): boolean {
    return this.config.enableBash
  }

  /**
   * Read-only projection of the `enableWorkspaceMcp` config. The MCP
   * adapter checks this on every `workspaceMcp.activate` call: when false
   * the adapter may stay installed but is permanently transparent. Never a
   * mutable config handle.
   */
  get workspaceMcpEnabled(): boolean {
    return this.config.enableWorkspaceMcp
  }

  /**
   * Resolve the canonical workspace root of an exact live Agent through
   * scope ancestry (`scopeOf(agent.ctx)` then `scopeParentOf`, first
   * `workspaceCordis.workspaceForScope` hit wins). Returns undefined for an
   * unscoped Agent or when no live mapping exists; never falls back to
   * cwd-based workspace guessing and never reads `session.header.cwd`.
   */
  workspaceForAgent(agent: Agent): string | undefined {
    return resolveAgentWorkspace(agent, this.ctx.workspaceCordis)
  }

  /**
   * Wrap an original program's argv as native `direnv exec` plus the
   * managed-env shim:
   *
   * ```text
   * <executable> exec <canonical-workspace> <managed-env-shim> <original argv>
   * ```
   *
   * `dshEnv` is the exact managed DSH_* snapshot for this execution; its
   * names are validated strictly and its values travel through argv, never
   * spliced into the shim script. The canonical workspace root is fixed as
   * the lookup directory; no per-command workdir is consulted.
   */
  wrapArgv(
    canonicalWorkspace: string,
    originalArgv: readonly string[],
    dshEnv: Readonly<Record<string, string>> = {},
  ): readonly string[] {
    return buildExecArgv({
      executable: this.config.executable,
      canonicalWorkspace,
      shimShell: this.config.shimShell,
      shimLabel: MANAGED_ENV_SHIM_LABEL,
      managedEnv: dshEnv,
      originalArgv,
    })
  }

  /**
   * Wrap one shell command as a POSIX-safe `exec` of the wrapped argv whose
   * original program is `<shimShell> -c <originalCommand>`. The returned
   * string replaces only `request.command` — workdir, timeout, signal,
   * sandbox policy, stdin, ordinary env, and the managed DSH_* snapshot all
   * survive untouched.
   */
  wrapCommand(
    canonicalWorkspace: string,
    originalCommand: string,
    dshEnv: Readonly<Record<string, string>> = {},
  ): string {
    return wrapCommandCore(
      {
        executable: this.config.executable,
        canonicalWorkspace,
        shimShell: this.config.shimShell,
        shimLabel: MANAGED_ENV_SHIM_LABEL,
        managedEnv: dshEnv,
      },
      originalCommand,
    )
  }
}
