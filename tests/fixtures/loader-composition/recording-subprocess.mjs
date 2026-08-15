/**
 * Recording `ctx.subprocess` provider row for the real Loader composition
 * test.
 *
 * Extends the REAL `SubprocessRuntime` service definition and records every
 * terminal spawn spec on the instance (`terminalSpecs`), returning a fake
 * terminal handle whose output ends on terminate — no real PTY is allocated
 * and no long-lived terminal process exists in tests.
 */
import { PassThrough } from 'node:stream'
import SubprocessRuntime from '@deepseek-ai/dsh-subprocess'

export default class RecordingSubprocessRuntime extends SubprocessRuntime {
  constructor(ctx) {
    super(ctx)
    this.terminalSpecs = []
  }

  async resolveExecutable(command) {
    return command
  }

  spawn() {
    throw new Error('unused: recording-subprocess.spawn')
  }

  async spawnTerminal(spec) {
    this.terminalSpecs.push(spec)
    const output = new PassThrough()
    return {
      pid: 123,
      output,
      done: Promise.resolve({ exitCode: 0, signal: null }),
      write: async () => {},
      inspectForeground: async () => ({ processGroupId: 123, inputWaiting: true }),
      signalForeground: async () => 123,
      terminate: async () => {
        output.end()
      },
    }
  }
}
