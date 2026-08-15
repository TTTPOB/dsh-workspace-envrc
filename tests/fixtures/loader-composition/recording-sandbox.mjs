/**
 * Recording `ctx.sandbox` provider row for the real Loader composition test.
 *
 * Extends the REAL `SandboxProvider` service definition and records every
 * confined argv/policy pair on the instance (`calls`), wrapping each argv as
 * `['/sandbox', '--', ...argv]` like the real runners while staying inert —
 * no host confinement happens in tests.
 */
import SandboxProvider from '@deepseek-ai/dsh-sandbox'

export default class RecordingSandbox extends SandboxProvider {
  constructor(ctx) {
    super(ctx)
    this.calls = []
  }

  confine(argv, policy) {
    this.calls.push({ argv, policy })
    return {
      argv: ['/sandbox', '--', ...argv],
      enforcement: 'full',
      denialSignatures: [],
      runnerFailureRules: [],
    }
  }
}
