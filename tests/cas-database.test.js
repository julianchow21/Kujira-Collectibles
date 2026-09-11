import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';

const IMAGE = 'postgres:17-alpine';
const RUN_DOCKER = process.env.KJ_CAS_RUN_DOCKER === '1';
const DOCKER_SKIP = RUN_DOCKER ? false : 'set KJ_CAS_RUN_DOCKER=1 to run the disposable PostgreSQL gate';
const TABLES = [
  'singles',
  'slabs',
  'sales',
  'etbs',
  'booster_boxes',
  'booster_packs',
  'ebay_purchases',
  'trash',
  'versions'
];

function safeSqlLiteral(value) {
  return "'" + String(value).replaceAll("'", "''") + "'";
}

function psqlArgs(container) {
  return [
    'exec', '-i', container, 'psql', '-X',
    '-v', 'ON_ERROR_STOP=1',
    '-U', 'postgres',
    '-d', 'postgres',
    '-At', '-q'
  ];
}

function runPsql(container, sql, role = 'postgres') {
  const roleSql = role === 'postgres' ? '' : 'set role ' + role + ';\n';
  return spawnSync('docker', psqlArgs(container), {
    input: roleSql + sql,
    encoding: 'utf8'
  });
}

function query(container, sql, role = 'postgres') {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = runPsql(container, sql, role);
    if (result.status === 0) return result.stdout.trim();
    if (!/Is the server running|database system is starting|No such file/.test(result.stderr)) {
      throw new Error(
        'psql failed as ' + role + ': ' + result.stderr + '\n' + result.stdout
      );
    }
    spawnSync('sleep', ['0.1']);
  }
  throw new Error('psql did not become ready for ' + role);
}

function expectSqlFailure(container, sql, role, label) {
  const result = runPsql(container, sql, role);
  assert.notEqual(result.status, 0, label + ' unexpectedly succeeded');
  return result.stderr + result.stdout;
}

function runPsqlAsync(container, sql, role = 'postgres') {
  const roleSql = role === 'postgres' ? '' : 'set role ' + role + ';\n';
  return new Promise((resolve, reject) => {
    const child = spawn('docker', psqlArgs(container), {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ status: code, stdout, stderr }));
    child.stdin.end(roleSql + sql);
  });
}

async function queryAsync(container, sql, role = 'postgres') {
  const result = await runPsqlAsync(container, sql, role);
  if (result.status !== 0) {
    throw new Error(
      'async psql failed as ' + role + ': ' + result.stderr + '\n' + result.stdout
    );
  }
  return result.stdout.trim();
}

function mutation(id, operations) {
  return {
    client_protocol: 2,
    mutation_id: id,
    operations
  };
}

function upsert(table, id, expectedVersion, data) {
  return {
    type: 'upsert',
    table,
    id,
    expected_version: expectedVersion,
    data
  };
}

function deleteOperation(table, id, expectedVersion, trashId, data) {
  return {
    type: 'delete',
    table,
    id,
    expected_version: expectedVersion,
    trash: {
      id: trashId,
      data: {
        originalTable: table,
        originalId: id,
        item: data,
        reason: 'synthetic test'
      }
    }
  };
}

function restoreOperation(table, id, tombstoneVersion, trashId, data) {
  return {
    type: 'restore',
    table,
    id,
    expected_version: 0,
    tombstone_version: tombstoneVersion,
    data,
    trash_id: trashId
  };
}

let mutationCounter = 1;
function nextMutationId() {
  const suffix = String(mutationCounter++).padStart(12, '0');
  return '00000000-0000-4000-8000-' + suffix;
}

function mutateSql(request) {
  return 'select public.collectibles_mutate_v2('
    + safeSqlLiteral(JSON.stringify(request)) + '::jsonb);';
}

function mutate(container, request, role = 'service_role') {
  return JSON.parse(query(container, mutateSql(request), role));
}

async function mutateAsync(container, request, role = 'service_role') {
  return JSON.parse(await queryAsync(container, mutateSql(request), role));
}

function pull(container, protocol = 2) {
  return JSON.parse(query(
    container,
    'select public.collectibles_pull_v2(' + String(protocol) + ');',
    'service_role'
  ));
}

function tableRow(container, table, id) {
  const result = query(
    container,
    'select jsonb_build_object('
      + "'id', id, 'data', data, 'row_version', row_version, "
      + "'updated_at', updated_at"
      + ') from public.' + table + ' where id = ' + safeSqlLiteral(id) + ';',
    'service_role'
  );
  return result ? JSON.parse(result) : null;
}

function tombstone(container, table, id) {
  const result = query(
    container,
    'select jsonb_build_object('
      + "'table', table_name, 'id', row_id, 'row_version', row_version, "
      + "'deleted_at', deleted_at"
      + ') from public.collectibles_tombstones where table_name = '
      + safeSqlLiteral(table) + ' and row_id = ' + safeSqlLiteral(id) + ';',
    'service_role'
  );
  return result ? JSON.parse(result) : null;
}

function trashRow(container, id) {
  const result = query(
    container,
    'select jsonb_build_object('
      + "'id', id, 'data', data, 'row_version', row_version, "
      + "'updated_at', updated_at"
      + ') from public.trash where id = ' + safeSqlLiteral(id) + ';',
    'service_role'
  );
  return result ? JSON.parse(result) : null;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function startContainer(container) {
  const supervisor = [
    'set -eu',
    'mkdir -p /var/lib/postgresql/data /var/run/postgresql',
    'chown -R postgres:postgres /var/lib/postgresql/data /var/run/postgresql',
    "if [ ! -s /var/lib/postgresql/data/PG_VERSION ]; then su postgres -s /bin/sh -c 'initdb -D /var/lib/postgresql/data -A trust --no-locale'; fi",
    "while :; do su postgres -s /bin/sh -c 'postgres -D /var/lib/postgresql/data -k /var/run/postgresql' & server_pid=$!; wait $server_pid; sleep 0.1; done"
  ].join('; ');
  const result = spawnSync('docker', [
    'run', '--pull=never', '--detach', '--rm',
    '--name', container,
    '--network', 'none',
    '--tmpfs', '/var/lib/postgresql/data',
    '--tmpfs', '/tmp',
    '--env', 'POSTGRES_PASSWORD=synthetic-dummy-password',
    '--entrypoint', '/bin/sh',
    IMAGE, '-c', supervisor
  ], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error('docker run failed: ' + result.stderr + result.stdout);
  }

  for (let attempt = 0; attempt < 80; attempt += 1) {
    const ready = spawnSync('docker', [
      'exec', container, 'pg_isready', '-U', 'postgres', '-d', 'postgres'
    ], { encoding: 'utf8' });
    if (ready.status === 0) {
      const smoke = spawnSync('docker', [
        'exec', container, 'psql', '-X', '-U', 'postgres', '-d', 'postgres',
        '-c', 'select 1;'
      ], { encoding: 'utf8' });
      if (smoke.status === 0) return;
    }
    await wait(250);
  }
  throw new Error('PostgreSQL did not become ready');
}

async function restartContainer(container) {
  // Restart the PostgreSQL process inside the running tmpfs container. Docker
  // restarting the container would clear its tmpfs and test a new database.
  const result = spawnSync('docker', [
    'exec', container, 'su', 'postgres', '-s', '/bin/sh', '-c',
    'pg_ctl -D /var/lib/postgresql/data -m fast -w stop'
  ], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error('postgres restart failed: ' + result.stderr + result.stdout);
  }
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const ready = spawnSync('docker', [
      'exec', container, 'pg_isready', '-U', 'postgres', '-d', 'postgres'
    ], { encoding: 'utf8' });
    if (ready.status === 0) {
      const smoke = spawnSync('docker', [
        'exec', container, 'psql', '-X', '-U', 'postgres', '-d', 'postgres',
        '-c', 'select 1;'
      ], { encoding: 'utf8' });
      if (smoke.status === 0) return;
    }
    await wait(250);
  }
  throw new Error('PostgreSQL did not become ready after restart');
}

function stopContainer(container) {
  spawnSync('docker', ['rm', '--force', container], { encoding: 'utf8' });
}

function setupSql() {
  const roles = [
    'create role anon nologin;',
    'create role authenticated nologin;',
    'create role service_role nologin bypassrls;',
    'grant usage on schema public to anon, authenticated, service_role;'
  ];
  const tables = TABLES.map(table => (
    'create table public.' + table + ' ('
      + 'id text primary key, '
      + 'data jsonb not null, '
      + 'updated_at timestamptz not null default clock_timestamp()'
      + ');'
  ));
  return roles.concat(tables).join('\n');
}

function assertCode(result, code) {
  assert.equal(result.ok, false);
  assert.equal(result.code, code);
}

test('protocol-2 CAS migration and lifecycle gates execute in disposable PostgreSQL', {
  skip: DOCKER_SKIP
}, async () => {
  const suffix = String(process.pid) + '-' + String(Date.now());
  const container = 'kjr-cas-' + suffix;
  const migration = fs.readFileSync(
    new URL('../Server/CAS.sql', import.meta.url),
    'utf8'
  );

  try {
    await startContainer(container);
    query(container, setupSql());
    query(container, migration);
    query(container, migration);

    assert.equal(
      Number(query(
        container,
        "select count(*) from information_schema.columns where table_schema = 'public' "
          + "and table_name in ('singles','slabs','sales','etbs','booster_boxes',"
          + "'booster_packs','ebay_purchases','trash','versions') "
          + "and column_name = 'row_version';"
      )),
      9
    );
    assert.equal(
      Number(query(
        container,
        "select count(*) from pg_class where relnamespace = 'public'::regnamespace "
          + "and relname in ('singles','slabs','sales','etbs','booster_boxes',"
          + "'booster_packs','ebay_purchases','trash','versions',"
          + "'collectibles_tombstones','collectibles_mutation_receipts') "
          + "and relrowsecurity;"
      )),
      11
    );
    assert.equal(
      Number(query(
        container,
        "select count(distinct event_object_table) from information_schema.triggers where trigger_schema = 'public' "
          + "and trigger_name = 'collectibles_row_version_guard';"
      )),
      9
    );
    assert.equal(
      query(
        container,
        "select has_table_privilege('anon', 'public.singles', 'insert') "
          + "and has_table_privilege('authenticated', 'public.singles', 'update') "
          + "and has_function_privilege('anon', "
          + "'public.collectibles_mutate_v2(jsonb)', 'execute');"
      ),
      'f'
    );
    assert.equal(
      query(
        container,
        "select has_table_privilege('service_role', 'public.singles', 'select') "
          + "and has_table_privilege('service_role', 'public.collectibles_tombstones', 'insert') "
          + "and has_function_privilege('service_role', "
          + "'public.collectibles_mutate_v2(jsonb)', 'execute');"
      ),
      't'
    );

    query(
      container,
      "alter table public.versions disable trigger collectibles_row_version_guard; "
        + "insert into public.versions (id, data, row_version) "
        + "values ('invalid-revision', '{\"proof\":true}'::jsonb, 0); "
        + "alter table public.versions enable trigger collectibles_row_version_guard;"
    );
    expectSqlFailure(
      container,
      migration,
      'postgres',
      'invalid pre-existing row_version migration'
    );
    assert.deepEqual(tableRow(container, 'versions', 'invalid-revision').data, { proof: true });
    assert.equal(tableRow(container, 'versions', 'invalid-revision').row_version, 0);

    expectSqlFailure(
      container,
      "insert into public.singles (id, data) values ('anon-direct', '{}'::jsonb);",
      'anon',
      'anon direct insert'
    );
    expectSqlFailure(
      container,
      "update public.singles set data = '{}'::jsonb where id = 'anon-direct';",
      'authenticated',
      'authenticated direct update'
    );
    expectSqlFailure(
      container,
      "delete from public.singles where id = 'anon-direct';",
      'authenticated',
      'authenticated direct delete'
    );
    expectSqlFailure(
      container,
      "select * from public.singles;",
      'anon',
      'anon direct select'
    );
    expectSqlFailure(
      container,
      "select public.collectibles_mutate_v2('{}'::jsonb);",
      'anon',
      'anon RPC call'
    );

    const triggerRaw = query(
      container,
      "insert into public.slabs (id, data, row_version, updated_at) "
        + "values ('trigger-row', '{\"x\":1,\"_private\":\"drop\"}'::jsonb, 99, "
        + "'2000-01-01T00:00:00Z'::timestamptz) "
        + "returning jsonb_build_object('row_version', row_version, "
        + "'updated_at', updated_at);",
      'service_role'
    );
    const triggerInsert = JSON.parse(triggerRaw);
    assert.equal(triggerInsert.row_version, 99);
    assert.notEqual(triggerInsert.updated_at, '2000-01-01T00:00:00+00:00');
    const triggerUpdate = JSON.parse(query(
      container,
      "update public.slabs set data = '{\"x\":2,\"_private\":\"drop-update\"}'::jsonb, row_version = 999, "
        + "updated_at = '2000-01-01T00:00:00Z'::timestamptz "
        + "where id = 'trigger-row' "
        + "returning jsonb_build_object('row_version', row_version, "
        + "'updated_at', updated_at);",
      'service_role'
    ));
    assert.equal(triggerUpdate.row_version, 100);
    assert.notEqual(triggerUpdate.updated_at, '2000-01-01T00:00:00+00:00');

    assertCode(
      mutate(container, { client_protocol: 1, mutation_id: nextMutationId(), operations: [] }),
      'protocol_mismatch'
    );
    assertCode(
      mutate(container, { client_protocol: 2, mutation_id: nextMutationId(), operations: [] }),
      'invalid_operations'
    );
    assertCode(mutate(container, null), 'invalid_request');

    const idemId = nextMutationId();
    const idemRequest = mutation(
      idemId,
      [upsert('singles', 'idem-row', 0, { name: 'idempotent', quantity: 1 })]
    );
    const idemFirst = mutate(container, idemRequest);
    assert.equal(idemFirst.ok, true);
    assert.equal(idemFirst.results[0].row_version, 1);
    const idemRetry = mutate(container, idemRequest);
    assert.deepEqual(idemRetry, idemFirst);
    assert.equal(Number(query(
      container,
      "select count(*) from public.singles where id = 'idem-row';"
    )), 1);
    const idemReuse = mutate(container, mutation(
      idemId,
      [upsert('singles', 'idem-row', 0, { name: 'changed payload' })]
    ));
    assertCode(idemReuse, 'mutation_id_reused');

    const raceId = 'race-update';
    const raceSeed = mutate(container, mutation(
      nextMutationId(),
      [upsert('singles', raceId, 0, { name: 'race', value: 1 })]
    ));
    assert.equal(raceSeed.results[0].row_version, 1);
    const raceA = mutation(
      nextMutationId(),
      [upsert('singles', raceId, 1, { name: 'winner-a', value: 2 })]
    );
    const raceB = mutation(
      nextMutationId(),
      [upsert('singles', raceId, 1, { name: 'winner-b', value: 3 })]
    );
    const raceResults = await Promise.all([
      mutateAsync(container, raceA),
      mutateAsync(container, raceB)
    ]);
    assert.equal(raceResults.filter(result => result.ok).length, 1);
    assert.equal(
      raceResults.filter(result => result.code === 'version_conflict').length,
      1
    );
    const raceRow = tableRow(container, 'singles', raceId);
    assert.equal(raceRow.row_version, 2);
    assert.ok(['winner-a', 'winner-b'].includes(raceRow.data.name));

    const groupId = 'group-inventory';
    mutate(container, mutation(
      nextMutationId(),
      [upsert('singles', groupId, 0, { name: 'inventory', quantity: 1 })]
    ));
    const groupedConflict = mutate(container, mutation(
      nextMutationId(),
      [
        upsert('singles', groupId, 0, { name: 'stale inventory', quantity: 2 }),
        upsert('sales', 'group-sale-conflict', 0, { name: 'sale', quantity: 1 })
      ]
    ));
    assertCode(groupedConflict, 'version_conflict');
    assert.equal(tableRow(container, 'singles', groupId).data.quantity, 1);
    assert.equal(tableRow(container, 'sales', 'group-sale-conflict'), null);

    const groupedSuccess = mutate(container, mutation(
      nextMutationId(),
      [
        upsert('singles', groupId, 1, { name: 'inventory sold', quantity: 0 }),
        upsert('sales', 'group-sale-success', 0, { name: 'sale', quantity: 1 })
      ]
    ));
    assert.equal(groupedSuccess.ok, true);
    assert.equal(tableRow(container, 'singles', groupId).row_version, 2);
    assert.equal(tableRow(container, 'sales', 'group-sale-success').row_version, 1);

    const updateDeleteId = 'race-update-delete';
    const updateDeleteData = { name: 'update-delete', quantity: 1 };
    mutate(container, mutation(
      nextMutationId(),
      [upsert('singles', updateDeleteId, 0, updateDeleteData)]
    ));
    const updateDeleteUpdate = mutation(
      nextMutationId(),
      [upsert('singles', updateDeleteId, 1, { name: 'updated', quantity: 2 })]
    );
    const updateDeleteDelete = mutation(
      nextMutationId(),
      [deleteOperation(
        'singles', updateDeleteId, 1, 'trash-update-delete', updateDeleteData
      )]
    );
    const updateDeleteResults = await Promise.all([
      mutateAsync(container, updateDeleteUpdate),
      mutateAsync(container, updateDeleteDelete)
    ]);
    assert.equal(updateDeleteResults.filter(result => result.ok).length, 1);
    assert.equal(
      updateDeleteResults.filter(result => result.code === 'version_conflict').length,
      1
    );
    const updateDeleteRow = tableRow(container, 'singles', updateDeleteId);
    const updateDeleteTombstone = tombstone(container, 'singles', updateDeleteId);
    assert.ok(
      (updateDeleteRow && updateDeleteRow.row_version === 2)
      || (!updateDeleteRow && updateDeleteTombstone.row_version === 2)
    );
    if (updateDeleteRow) {
      const cleanupDelete = mutate(container, mutation(
        nextMutationId(),
        [deleteOperation(
          'singles', updateDeleteId, 2, 'trash-update-delete-cleanup',
          updateDeleteRow.data
        )]
      ));
      assert.equal(cleanupDelete.ok, true);
      assert.equal(tombstone(container, 'singles', updateDeleteId).row_version, 3);
    }

    const lifecycleId = 'lifecycle-row';
    const lifecycleData = { name: 'lifecycle', nested: { keep: true } };
    mutate(container, mutation(
      nextMutationId(),
      [upsert('singles', lifecycleId, 0, lifecycleData)]
    ));
    const firstDelete = mutation(
      nextMutationId(),
      [deleteOperation('singles', lifecycleId, 1, 'trash-lifecycle-1', lifecycleData)]
    );
    const firstDeleteResult = mutate(container, firstDelete);
    assert.equal(firstDeleteResult.ok, true);
    assert.equal(firstDeleteResult.results.find(result => result.table === 'singles').row_version, 2);
    assert.equal(tableRow(container, 'singles', lifecycleId), null);
    assert.equal(tombstone(container, 'singles', lifecycleId).row_version, 2);
    assert.equal(trashRow(container, 'trash-lifecycle-1').data.originalId, lifecycleId);
    const deletedPull = pull(container);
    assert.equal(
      deletedPull.tombstones.some(item => item.table === 'singles' && item.id === lifecycleId),
      true
    );
    assertCode(mutate(container, mutation(
      nextMutationId(),
      [upsert('singles', lifecycleId, 0, { name: 'stale resurrection' })]
    )), 'version_conflict');
    assertCode(mutate(container, mutation(
      nextMutationId(),
      [restoreOperation(
        'singles', lifecycleId, 2, 'trash-lifecycle-1',
        { name: 'wrong payload' }
      )]
    )), 'version_conflict');

    const restoreA = mutation(
      nextMutationId(),
      [restoreOperation('singles', lifecycleId, 2, 'trash-lifecycle-1', lifecycleData)]
    );
    const restoreB = mutation(
      nextMutationId(),
      [restoreOperation('singles', lifecycleId, 2, 'trash-lifecycle-1', lifecycleData)]
    );
    const restoreResults = await Promise.all([
      mutateAsync(container, restoreA),
      mutateAsync(container, restoreB)
    ]);
    assert.equal(restoreResults.filter(result => result.ok).length, 1);
    assert.equal(
      restoreResults.filter(result => result.code === 'version_conflict').length,
      1
    );
    assert.equal(tableRow(container, 'singles', lifecycleId).row_version, 3);
    assert.equal(tombstone(container, 'singles', lifecycleId), null);
    assert.equal(trashRow(container, 'trash-lifecycle-1'), null);

    const staleRestore = mutate(container, mutation(
      nextMutationId(),
      [restoreOperation('singles', lifecycleId, 2, 'trash-lifecycle-1', lifecycleData)]
    ));
    assertCode(staleRestore, 'version_conflict');

    const secondData = { name: 'second lifecycle', quantity: 4 };
    const lifecycleUpdate = mutate(container, mutation(
      nextMutationId(),
      [upsert('singles', lifecycleId, 3, secondData)]
    ));
    assert.equal(lifecycleUpdate.ok, true);
    assert.equal(lifecycleUpdate.results[0].row_version, 4);
    const secondDelete = mutation(
      nextMutationId(),
      [deleteOperation('singles', lifecycleId, 4, 'trash-lifecycle-2', secondData)]
    );
    const secondDeleteResult = mutate(container, secondDelete);
    assert.equal(secondDeleteResult.ok, true);
    assert.equal(tombstone(container, 'singles', lifecycleId).row_version, 5);
    const secondRestore = mutation(
      nextMutationId(),
      [restoreOperation('singles', lifecycleId, 5, 'trash-lifecycle-2', secondData)]
    );
    const secondRestoreResult = mutate(container, secondRestore);
    assert.equal(secondRestoreResult.ok, true);
    assert.equal(tableRow(container, 'singles', lifecycleId).row_version, 6);
    assert.equal(tombstone(container, 'singles', lifecycleId), null);
    assert.equal(trashRow(container, 'trash-lifecycle-2'), null);

    assertCode(mutate(container, mutation(
      nextMutationId(),
      [upsert('singles', lifecycleId, 1, { name: 'stale update' })]
    )), 'version_conflict');
    assertCode(mutate(container, mutation(
      nextMutationId(),
      [deleteOperation(
        'singles', lifecycleId, 1, 'trash-stale-delete', lifecycleData
      )]
    )), 'version_conflict');
    const firstDeleteReplay = mutate(container, firstDelete);
    assert.deepEqual(firstDeleteReplay, firstDeleteResult);
    assert.equal(tableRow(container, 'singles', lifecycleId).row_version, 6);

    const durableData = { name: 'restart durable', quantity: 1 };
    mutate(container, mutation(
      nextMutationId(),
      [upsert('singles', 'restart-row', 0, durableData)]
    ));
    const durableDelete = mutation(
      nextMutationId(),
      [deleteOperation('singles', 'restart-row', 1, 'trash-restart', durableData)]
    );
    const durableDeleteResult = mutate(container, durableDelete);
    assert.equal(durableDeleteResult.ok, true);
    assert.equal(tombstone(container, 'singles', 'restart-row').row_version, 2);
    await restartContainer(container);
    assert.deepEqual(mutate(container, durableDelete), durableDeleteResult);
    assert.equal(tombstone(container, 'singles', 'restart-row').row_version, 2);
    const durableRestore = mutate(container, mutation(
      nextMutationId(),
      [restoreOperation('singles', 'restart-row', 2, 'trash-restart', durableData)]
    ));
    assert.equal(durableRestore.ok, true);
    assert.equal(tableRow(container, 'singles', 'restart-row').row_version, 3);
    assert.equal(tombstone(container, 'singles', 'restart-row'), null);
    assert.equal(trashRow(container, 'trash-restart'), null);

    assertCode(mutate(container, {
      client_protocol: 2,
      mutation_id: nextMutationId(),
      operations: [{
        type: 'upsert',
        table: 'singles',
        id: 'reserved-data',
        expected_version: 0,
        data: { row_version: 9 }
      }]
    }), 'reserved_field');
    assertCode(mutate(container, {
      client_protocol: 2,
      mutation_id: nextMutationId(),
      operations: [upsert(
        'singles', 'reserved-id', 0, { id: 'caller-controlled-id' }
      )]
    }), 'reserved_field');
    assertCode(mutate(container, {
      client_protocol: 2,
      mutation_id: nextMutationId(),
      operations: [{
        type: 'upsert',
        table: 'not_allowed',
        id: 'bad-table',
        expected_version: 0,
        data: {}
      }]
    }), 'invalid_table');
    assertCode(mutate(container, {
      client_protocol: 2,
      mutation_id: nextMutationId(),
      operations: [{
        type: 'upsert',
        table: 'singles',
        id: 'missing-version',
        data: {}
      }]
    }), 'missing_expected_version');

    const finalPull = pull(container);
    assert.equal(finalPull.ok, true);
    assert.equal(finalPull.client_protocol, 2);
    assert.deepEqual(
      Object.keys(finalPull.tables).sort(),
      ['booster_boxes', 'booster_packs', 'ebay_purchases', 'etbs', 'sales', 'singles', 'slabs', 'trash'].sort()
    );
    assert.equal(finalPull.tombstones.length, 1);
    assert.equal(finalPull.tombstones[0].id, updateDeleteId);
    const pulledTrigger = finalPull.tables.slabs.find(item => item.id === 'trigger-row');
    assert.deepEqual(pulledTrigger.data, { x: 2 });
  } finally {
    stopContainer(container);
  }
});
