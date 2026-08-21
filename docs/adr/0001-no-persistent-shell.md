# ADR 0001: Do not support persistent shells

- Status: Accepted
- Date: 2026-08-21

## Context

This bundle runs as a Host profile layer. Its Bash adapter decorates the Host `shell` service, and its workspace MCP adapter decorates the Host `workspaceMcp` manager. Both services exist while the Host plugin tree activates.

DSH persistent shells use a different lifetime and service realm. A preset that offers a persistent shell mounts `terminals` inside an entry-local `isolate` realm in that preset's separately loaded `agent.cordis.yml`. The default `standard`, `code`, and `cordis` presets do not mount that service; only presets that explicitly include the persistent-shell group have an instance to decorate. A Host integration row cannot inject this preset-private service because Host activation occurs before any session or preset generation exists.

Cordis `Include` accepts runtime patches, so an out-of-tree overlay could theoretically augment preset trees. Doing so without a DSH public extension point would require intercepting framework configuration resolution or reproducing parts of the private preset mount lifecycle. The implementation would need to identify private `PresetTree` mounts, preserve official standing-mount records and audits, handle cold mounts and concurrent workspace generations, and include augmentation revisions in generation identity. These internal integration points are likely to change while DSH is developing rapidly.

Persistent shells are not required by the current deployment. Agent-owned foreground and background Bash executions cover the normal workflow, and workspace stdio MCP remains a separate supported path.

## Decision

`dsh-workspace-envrc` supports only:

- Agent-owned foreground and background Bash executions through the Host `shell` service;
- mapped workspace stdio MCP rows through the Host `workspaceMcp` manager.

The bundle does not support persistent shell or terminal creation. It does not export a terminal adapter, declare terminal/sandbox/subprocess peer dependencies, expose terminal configuration, or inject `terminals` from its Host integration row.

The bundle will not add preset augmentation or depend on DSH/Cordis internal preset-mount APIs solely to restore persistent-shell support.

## Consequences

- The bundle loads in the Web Host without requiring a Host-level `terminals` service.
- Presets that provide persistent shells run those shells without this bundle's direnv wrapper.
- Existing persistent shells and their environment remain entirely owned by the preset and terminal backend.
- The implementation and maintenance surface is limited to the two execution paths used by this deployment.
- Persistent-shell support may be reconsidered only after DSH exposes a documented public preset-contribution API and there is a concrete user need. A future decision must replace this ADR rather than silently reintroducing internal API coupling.
