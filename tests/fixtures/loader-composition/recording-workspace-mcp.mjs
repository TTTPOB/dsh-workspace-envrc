/**
 * Recording `ctx.workspaceMcp` provider row for the real Loader composition
 * test.
 *
 * A plain-ESM default-export class extending the REAL Cordis `Service`
 * definition, so the Loader instantiates it exactly like the overlay's MCP
 * manager. Every `activate(rowCtx, rawConfig)` call is recorded on the
 * instance (`activations`); nothing connects, spawns, or registers tools.
 */
import { Service } from '@deepseek-ai/cordis'

export default class RecordingWorkspaceMcp extends Service {
  constructor(ctx) {
    super(ctx, 'workspaceMcp')
    this.activations = []
  }

  activate(rowCtx, rawConfig) {
    this.activations.push({ rowCtx, rawConfig, receiver: this })
    return Promise.resolve()
  }
}
