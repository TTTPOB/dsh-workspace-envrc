/**
 * Recording `ctx.shell` provider row for the real Loader composition test.
 *
 * A plain-ESM default-export class extending the REAL `ShellExecutor`
 * service definition, so the Loader instantiates it exactly like a concrete
 * provider. Every resolved request is recorded on the instance (`records`);
 * nothing spawns or runs.
 */
import { ShellExecutor } from '@deepseek-ai/dsh-shell'

export default class RecordingShellExecutor extends ShellExecutor {
  constructor(ctx) {
    super(ctx)
    this.records = []
  }

  resolve(request) {
    this.records.push(request)
    return {
      command: request.command,
      workdir: request.workdir ?? '/default-workdir',
      timeoutMs: request.timeoutMs ?? 1000,
      stdoutMaxBytes: request.stdoutMaxBytes ?? 1024,
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
      ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
      ...(request.env !== undefined ? { env: request.env } : {}),
      ...(request.dshEnv !== undefined ? { dshEnv: request.dshEnv } : {}),
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  run() {
    return Promise.resolve({
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: 1000,
      stdout: { text: '', truncated: false },
      stderr: { text: '', truncated: false },
    })
  }

  start() {
    return {
      status: 'completed',
      exitCode: 0,
      signal: null,
      done: Promise.resolve(),
      readOutput: () => ({ delta: '', lossy: false }),
      kill: () => false,
    }
  }
}
