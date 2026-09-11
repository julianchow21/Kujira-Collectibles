# CAS Candidate Recovery Note

*Disposable technical verification note for the server candidate. This is not the
production runbook.*

The candidate keeps one owner boundary. The Worker checks the exact browser
Origin, verifies the bearer with Supabase Auth, compares the returned user id
with COLLECTIBLES_OWNER_USER_ID, then calls the protocol-2 RPC with the
service-role credential. The SQL migration denies table privileges and RPC
execution to anon and authenticated, grants the RPC boundary to service_role,
and keeps tombstones and mutation receipts under RLS.

Legacy flags never bypass the owner check. ALLOW_LEGACY_DB may remain in
configuration while old clients are retired, but every compatibility GET first
requires the verified owner. POST, PATCH and DELETE remain denied even when
that flag or a stale ALLOW_LEGACY_DB_MUTATIONS setting is present.

A migration failure is a rollback of the migration transaction. In particular,
an existing NULL or non-positive row_version fails the preflight check, so the
candidate does not rewrite concurrency history. Repair requires an approved
row-by-row mapping and a fresh backup check.

The safe rollback sequence is:

1. Stop new protocol-2 writes and put the Worker into maintenance mode, while
   retaining the CAS and owner-authenticated write guard. An explicitly
   read-only backend is also acceptable for recovery reads
2. If the client must be rolled back, use only a known protocol-2-compatible
   v3.48 client. Never roll back the Worker to a version or flag that permits
   direct legacy mutations while tombstones or receipts exist, metadata
   retention alone does not protect against stale writers
3. Leave row_version, tombstones, and mutation receipts in place, older reads
   can ignore the additional metadata
4. Reconcile any in-flight synthetic or production mutations from the receipt
   and tombstone rows before the next cutover
5. Re-run the preflight and retain the backup evidence before another attempt

This candidate contains no schema-drop rollback. Never remove tombstones or
mutation receipts as a rollback shortcut. Any later schema removal needs a
separate approved migration, an export, and a verified recovery plan.

Synthetic gates run with:

node --test tests/worker-server.test.mjs

KJ_CAS_RUN_DOCKER=1 node --test tests/cas-database.test.js

The database gate uses the local postgres:17-alpine image in one uniquely named
container with --network none, no host mounts, and tmpfs data. It restarts the
PostgreSQL process inside that container so the durability check does not
create a second database.

*Disposable point-in-time doc. Delete once fully actioned (see AGENTS.md, Folder cleanliness).*
