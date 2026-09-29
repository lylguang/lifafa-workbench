# Product Contracts

LWB is a local, single-user workbench. Its extension boundary is a dynamically
loaded capability pack: each pack contributes pages, business services and
workflows while using the shared DSH runtime.

The host owns pack workspace identity and task admission. Business requests use
the host-issued data context; the browser does not choose arbitrary storage
paths. Internal execution uses native DSH Agents and Sessions. These ownership
boundaries are not a sandbox for untrusted JavaScript plugins.

LWB does not define a parallel model API, session format or credentials backend.
Model calls, tools, events and authentication use DSH services. Pack-specific
media connections use separate settings and credential namespaces.

Current contracts:

- [Capability pack manifest and lifecycle](../../docs/12-capability-packs.md)
- [Workspace, execution scope and credentials](../../docs/29-pack-owned-workspaces.md)
- [Runtime data layout](../../docs/31-runtime-data-layout.md)
- [Build your first pack](../../docs/develop-a-pack.md)

Multi-user authentication, shared workspaces and an online package marketplace
are not provided by the current implementation. No `ownerId` / `teamId` schema
contract is promised for existing business records.
