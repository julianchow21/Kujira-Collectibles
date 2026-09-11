-- Collectibles protocol-2 CAS server candidate
-- Apply only after the production preflight and an approved backup. This candidate
-- contains schema and functions only, with no project URLs, credentials or data.
-- Primary draft reviewed: CAS Migration.sql
-- Primary draft SHA-256: 1433e387af653c08fa19569d3913f95c25bbcb610b7f26deabe36c8b5f1b1fc8

begin;

alter table public.singles        add column if not exists row_version bigint not null default 1;
alter table public.slabs          add column if not exists row_version bigint not null default 1;
alter table public.sales          add column if not exists row_version bigint not null default 1;
alter table public.etbs           add column if not exists row_version bigint not null default 1;
alter table public.booster_boxes  add column if not exists row_version bigint not null default 1;
alter table public.booster_packs  add column if not exists row_version bigint not null default 1;
alter table public.ebay_purchases add column if not exists row_version bigint not null default 1;
alter table public.trash          add column if not exists row_version bigint not null default 1;
alter table public.versions       add column if not exists row_version bigint not null default 1;

-- Make a repeat application safe for a legacy column that existed without the
-- protocol constraints. Existing positive revisions are preserved. Invalid
-- values fail the migration and require an explicit preflight repair.
do $row_version_bootstrap$
declare
  v_table text;
  v_invalid_count bigint;
begin
  foreach v_table in array ARRAY[
    'singles', 'slabs', 'sales', 'etbs', 'booster_boxes',
    'booster_packs', 'ebay_purchases', 'trash', 'versions'
  ] loop
    execute format(
      'select count(*) from public.%I where row_version is null or row_version < 1',
      v_table
    ) into v_invalid_count;
    if v_invalid_count > 0 then
      raise exception
        'CAS preflight required, % invalid row_version value(s) in table %',
        v_invalid_count, v_table
        using errcode = 'check_violation';
    end if;
    execute format(
      'alter table public.%I alter column row_version set default 1',
      v_table
    );
    execute format(
      'alter table public.%I alter column row_version set not null',
      v_table
    );
  end loop;
end;
$row_version_bootstrap$;

create table if not exists public.collectibles_tombstones (
  table_name text not null,
  row_id text not null,
  row_version bigint not null,
  deleted_at timestamptz not null default clock_timestamp(),
  mutation_id uuid not null,
  primary key (table_name, row_id),
  constraint collectibles_tombstones_table_check check (
    table_name in (
      'singles', 'slabs', 'sales', 'etbs', 'booster_boxes',
      'booster_packs', 'ebay_purchases', 'versions'
    )
  ),
  constraint collectibles_tombstones_version_check check (row_version > 0)
);

create index if not exists collectibles_tombstones_deleted_idx
  on public.collectibles_tombstones (deleted_at, table_name, row_id);

create table if not exists public.collectibles_mutation_receipts (
  mutation_id uuid primary key,
  request_fingerprint text not null,
  response jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);

alter table public.collectibles_tombstones enable row level security;
alter table public.collectibles_mutation_receipts enable row level security;

revoke all on table public.collectibles_tombstones from public, anon, authenticated;
revoke all on table public.collectibles_mutation_receipts from public, anon, authenticated;
grant select, insert, update, delete on table public.collectibles_tombstones to service_role;
grant select, insert, update, delete on table public.collectibles_mutation_receipts to service_role;


-- The Worker is the only application write boundary. Existing-table access for
-- anon/authenticated is denied at the database boundary as well. The configured
-- service_role is the single trusted owner identity used by the RPCs.
do $security$
declare
  v_table text;
begin
  foreach v_table in array ARRAY[
    'singles', 'slabs', 'sales', 'etbs', 'booster_boxes',
    'booster_packs', 'ebay_purchases', 'trash', 'versions',
    'collectibles_tombstones', 'collectibles_mutation_receipts'
  ] loop
    execute format('alter table public.%I enable row level security', v_table);
    execute format(
      'revoke all on table public.%I from public, anon, authenticated',
      v_table
    );
    execute format(
      'grant select, insert, update, delete on table public.%I to service_role',
      v_table
    );
  end loop;
end;
$security$;

create or replace function public.collectibles_clean_data(p_data jsonb)
returns jsonb
language sql
immutable
strict
set search_path = pg_catalog, public
as $function$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
  from jsonb_each(p_data)
  where left(key, 1) <> '_'
    and key not in ('row_version', 'updated_at');
$function$;

create or replace function public.collectibles_clean_trash_data(p_data jsonb)
returns jsonb
language sql
immutable
strict
set search_path = pg_catalog, public
as $function$
  select case
    when jsonb_typeof(p_data) = 'object'
     and jsonb_typeof(p_data->'item') = 'object' then
      jsonb_set(
        public.collectibles_clean_data(p_data),
        '{item}',
        (case when p_data->'item' ? 'id'
          then jsonb_build_object('id', p_data->'item'->'id')
          else '{}'::jsonb end)
          || public.collectibles_clean_data((p_data->'item') - 'id'::text),
        true
      )
    else public.collectibles_clean_data(p_data)
  end;
$function$;

create or replace function public.collectibles_set_row_version()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $function$
begin
  if tg_op = 'INSERT' then
    if new.row_version is null or new.row_version < 1 then
      new.row_version := 1;
    end if;
  else
    new.row_version := old.row_version + 1;
  end if;
  -- Every server-side insert and update owns the timestamp as well as the
  -- revision. A caller-supplied value is never accepted.
  new.updated_at := clock_timestamp();
  return new;
end;
$function$;

drop trigger if exists collectibles_row_version_guard on public.singles;
create trigger collectibles_row_version_guard before insert or update on public.singles
for each row execute function public.collectibles_set_row_version();
drop trigger if exists collectibles_row_version_guard on public.slabs;
create trigger collectibles_row_version_guard before insert or update on public.slabs
for each row execute function public.collectibles_set_row_version();
drop trigger if exists collectibles_row_version_guard on public.sales;
create trigger collectibles_row_version_guard before insert or update on public.sales
for each row execute function public.collectibles_set_row_version();
drop trigger if exists collectibles_row_version_guard on public.etbs;
create trigger collectibles_row_version_guard before insert or update on public.etbs
for each row execute function public.collectibles_set_row_version();
drop trigger if exists collectibles_row_version_guard on public.booster_boxes;
create trigger collectibles_row_version_guard before insert or update on public.booster_boxes
for each row execute function public.collectibles_set_row_version();
drop trigger if exists collectibles_row_version_guard on public.booster_packs;
create trigger collectibles_row_version_guard before insert or update on public.booster_packs
for each row execute function public.collectibles_set_row_version();
drop trigger if exists collectibles_row_version_guard on public.ebay_purchases;
create trigger collectibles_row_version_guard before insert or update on public.ebay_purchases
for each row execute function public.collectibles_set_row_version();
drop trigger if exists collectibles_row_version_guard on public.trash;
create trigger collectibles_row_version_guard before insert or update on public.trash
for each row execute function public.collectibles_set_row_version();
drop trigger if exists collectibles_row_version_guard on public.versions;
create trigger collectibles_row_version_guard before insert or update on public.versions
for each row execute function public.collectibles_set_row_version();

create or replace function public.collectibles_pull_v2(p_client_protocol integer)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
begin
  if p_client_protocol is null then
    return jsonb_build_object('ok', false, 'code', 'protocol_required');
  end if;
  if p_client_protocol <> 2 then
    return jsonb_build_object(
      'ok', false,
      'code', 'protocol_mismatch',
      'server_protocol', 2
    );
  end if;

  -- A single statement gives every table and tombstone the same MVCC snapshot.
  return (
    select jsonb_build_object(
      'ok', true,
      'client_protocol', 2,
      'tables', jsonb_build_object(
        'singles', coalesce((select jsonb_agg(jsonb_build_object(
          'id', id, 'data', public.collectibles_clean_data(data),
          'row_version', row_version, 'updated_at', updated_at
        ) order by updated_at, id) from public.singles), '[]'::jsonb),
        'slabs', coalesce((select jsonb_agg(jsonb_build_object(
          'id', id, 'data', public.collectibles_clean_data(data),
          'row_version', row_version, 'updated_at', updated_at
        ) order by updated_at, id) from public.slabs), '[]'::jsonb),
        'sales', coalesce((select jsonb_agg(jsonb_build_object(
          'id', id, 'data', public.collectibles_clean_data(data),
          'row_version', row_version, 'updated_at', updated_at
        ) order by updated_at, id) from public.sales), '[]'::jsonb),
        'etbs', coalesce((select jsonb_agg(jsonb_build_object(
          'id', id, 'data', public.collectibles_clean_data(data),
          'row_version', row_version, 'updated_at', updated_at
        ) order by updated_at, id) from public.etbs), '[]'::jsonb),
        'booster_boxes', coalesce((select jsonb_agg(jsonb_build_object(
          'id', id, 'data', public.collectibles_clean_data(data),
          'row_version', row_version, 'updated_at', updated_at
        ) order by updated_at, id) from public.booster_boxes), '[]'::jsonb),
        'booster_packs', coalesce((select jsonb_agg(jsonb_build_object(
          'id', id, 'data', public.collectibles_clean_data(data),
          'row_version', row_version, 'updated_at', updated_at
        ) order by updated_at, id) from public.booster_packs), '[]'::jsonb),
        'ebay_purchases', coalesce((select jsonb_agg(jsonb_build_object(
          'id', id, 'data', public.collectibles_clean_data(data),
          'row_version', row_version, 'updated_at', updated_at
        ) order by updated_at, id) from public.ebay_purchases), '[]'::jsonb),
        'trash', coalesce((select jsonb_agg(jsonb_build_object(
          'id', id, 'data', public.collectibles_clean_trash_data(data),
          'row_version', row_version, 'updated_at', updated_at
        ) order by updated_at, id) from public.trash), '[]'::jsonb)
      ),
      'tombstones', coalesce((select jsonb_agg(jsonb_build_object(
        'table', table_name,
        'id', row_id,
        'row_version', row_version,
        'deleted_at', deleted_at
      ) order by deleted_at, table_name, row_id)
        from public.collectibles_tombstones
        where table_name <> 'versions'), '[]'::jsonb)
    )
  );
end;
$function$;

create or replace function public.collectibles_mutate_v2(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  v_allowed_upsert constant text[] := array[
    'singles', 'slabs', 'sales', 'etbs', 'booster_boxes',
    'booster_packs', 'ebay_purchases', 'versions'
  ];
  v_allowed_delete constant text[] := array[
    'singles', 'slabs', 'sales', 'etbs', 'booster_boxes',
    'booster_packs', 'ebay_purchases', 'versions', 'trash'
  ];
  v_allowed_restore constant text[] := array[
    'singles', 'slabs', 'sales', 'etbs', 'booster_boxes',
    'booster_packs', 'ebay_purchases'
  ];
  v_mutation_id uuid;
  v_fingerprint text;
  v_receipt public.collectibles_mutation_receipts%rowtype;
  v_operation jsonb;
  v_type text;
  v_table text;
  v_id text;
  v_expected bigint;
  v_tombstone_expected bigint;
  v_current jsonb;
  v_tombstone jsonb;
  v_trash_current jsonb;
  v_trash_id text;
  v_trash_data jsonb;
  v_live_data jsonb;
  v_trash_version bigint;
  v_trash_updated_at timestamptz;
  v_client_table text;
  v_seen text[] := array[]::text[];
  v_conflicts jsonb := '[]'::jsonb;
  v_results jsonb := '[]'::jsonb;
  v_result jsonb;
  v_now timestamptz;
  v_next_version bigint;
begin
  if p_request is null or jsonb_typeof(p_request) <> 'object' then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_request) as keys(key_name)
    where key_name not in ('client_protocol', 'mutation_id', 'operations')
  ) then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  if not (p_request ? 'client_protocol') then
    return jsonb_build_object('ok', false, 'code', 'protocol_required');
  end if;
  if jsonb_typeof(p_request->'client_protocol') <> 'number'
     or p_request->>'client_protocol' <> '2' then
    return jsonb_build_object(
      'ok', false, 'code', 'protocol_mismatch', 'server_protocol', 2
    );
  end if;
  if not (p_request ? 'mutation_id') or jsonb_typeof(p_request->'mutation_id') <> 'string' then
    return jsonb_build_object('ok', false, 'code', 'invalid_mutation_id');
  end if;
  begin
    v_mutation_id := (p_request->>'mutation_id')::uuid;
  exception when invalid_text_representation then
    return jsonb_build_object('ok', false, 'code', 'invalid_mutation_id');
  end;
  if not (p_request ? 'operations')
     or jsonb_typeof(p_request->'operations') <> 'array' then
    return jsonb_build_object('ok', false, 'code', 'invalid_operations');
  end if;
  if jsonb_array_length(p_request->'operations') < 1
     or jsonb_array_length(p_request->'operations') > 100 then
    return jsonb_build_object('ok', false, 'code', 'invalid_operations');
  end if;

  v_fingerprint := md5(p_request::text);

  -- Single-owner writes are serialised. This removes absent-row races and
  -- opposite-order deadlocks while keeping each mutation group one transaction.
  perform pg_advisory_xact_lock(2026090402::bigint);

  select * into v_receipt
  from public.collectibles_mutation_receipts
  where mutation_id = v_mutation_id;
  if found then
    if v_receipt.request_fingerprint <> v_fingerprint then
      return jsonb_build_object('ok', false, 'code', 'mutation_id_reused');
    end if;
    return v_receipt.response;
  end if;

  -- Validate every operation and lock/check every target before changing data.
  -- Returning a conflict here leaves the whole group untouched.
  for v_operation in select value from jsonb_array_elements(p_request->'operations') loop
    if jsonb_typeof(v_operation) <> 'object' then
      return jsonb_build_object('ok', false, 'code', 'invalid_operation');
    end if;
    v_type := v_operation->>'type';
    v_table := v_operation->>'table';
    v_id := v_operation->>'id';

    if v_type is null or v_type not in ('upsert', 'delete', 'restore') then
      return jsonb_build_object('ok', false, 'code', 'invalid_operation');
    end if;
    if jsonb_typeof(v_operation->'table') <> 'string'
       or jsonb_typeof(v_operation->'id') <> 'string'
       or v_table is null or v_id is null or length(v_id) < 1 or length(v_id) > 256 then
      return jsonb_build_object('ok', false, 'code', 'invalid_operation');
    end if;
    if jsonb_build_array(v_table, v_id)::text = any(v_seen) then
      return jsonb_build_object('ok', false, 'code', 'duplicate_target');
    end if;
    v_seen := array_append(v_seen, jsonb_build_array(v_table, v_id)::text);

    if not (v_operation ? 'expected_version') then
      return jsonb_build_object('ok', false, 'code', 'missing_expected_version');
    end if;
    if jsonb_typeof(v_operation->'expected_version') <> 'number'
       or (v_operation->>'expected_version') !~ '^(0|[1-9][0-9]*)$'
       or length(v_operation->>'expected_version') > 19 then
      return jsonb_build_object('ok', false, 'code', 'invalid_expected_version');
    end if;
    begin
      v_expected := (v_operation->>'expected_version')::bigint;
    exception when numeric_value_out_of_range then
      return jsonb_build_object('ok', false, 'code', 'invalid_expected_version');
    end;
    if v_expected > 9223372036854775806 then
      return jsonb_build_object('ok', false, 'code', 'invalid_expected_version');
    end if;

    if v_type = 'upsert' then
      if v_table <> all(v_allowed_upsert) then
        return jsonb_build_object('ok', false, 'code', 'invalid_table');
      end if;
      if exists (
        select 1 from jsonb_object_keys(v_operation) as keys(key_name)
        where key_name not in ('type', 'table', 'id', 'expected_version', 'data')
      ) or not (v_operation ? 'data')
        or jsonb_typeof(v_operation->'data') <> 'object' then
        return jsonb_build_object('ok', false, 'code', 'invalid_operation');
      end if;
      if exists (
        select 1 from jsonb_object_keys(v_operation->'data') as keys(key_name)
        where left(key_name, 1) = '_' or key_name in ('id', 'row_version', 'updated_at')
      ) then
        return jsonb_build_object('ok', false, 'code', 'reserved_field');
      end if;
    elsif v_type = 'delete' then
      if v_table <> all(v_allowed_delete) then
        return jsonb_build_object('ok', false, 'code', 'invalid_table');
      end if;
      if v_expected = 0 then
        return jsonb_build_object('ok', false, 'code', 'invalid_expected_version');
      end if;
      if v_table in ('versions', 'trash') then
        if exists (
          select 1 from jsonb_object_keys(v_operation) as keys(key_name)
          where key_name not in ('type', 'table', 'id', 'expected_version')
        ) then
          return jsonb_build_object('ok', false, 'code', 'invalid_operation');
        end if;
      else
        if not (v_operation ? 'trash')
           or jsonb_typeof(v_operation->'trash') <> 'object' then
          return jsonb_build_object('ok', false, 'code', 'invalid_operation');
        end if;
        if exists (
          select 1 from jsonb_object_keys(v_operation) as keys(key_name)
          where key_name not in ('type', 'table', 'id', 'expected_version', 'trash')
        ) then
          return jsonb_build_object('ok', false, 'code', 'invalid_operation');
        end if;
        if not (v_operation->'trash' ? 'id')
           or not (v_operation->'trash' ? 'data')
           or jsonb_typeof(v_operation->'trash'->'id') <> 'string'
           or jsonb_typeof(v_operation->'trash'->'data') <> 'object' then
          return jsonb_build_object('ok', false, 'code', 'invalid_trash');
        end if;
        if exists (
          select 1 from jsonb_object_keys(v_operation->'trash') as keys(key_name)
          where key_name not in ('id', 'data')
        ) then
          return jsonb_build_object('ok', false, 'code', 'invalid_trash');
        end if;
        v_trash_id := v_operation->'trash'->>'id';
        v_trash_data := v_operation->'trash'->'data';
        if length(v_trash_id) < 1 or length(v_trash_id) > 256
           or not (v_trash_data ?& array['originalTable', 'originalId', 'item'])
           or exists (
             select 1 from jsonb_object_keys(v_trash_data) as keys(key_name)
             where key_name not in ('originalTable', 'originalId', 'item', 'reason', 'deletedAt')
           )
           or jsonb_typeof(v_trash_data->'originalTable') <> 'string'
           or jsonb_typeof(v_trash_data->'originalId') <> 'string'
           or jsonb_typeof(v_trash_data->'item') <> 'object'
           or v_trash_data->>'originalId' <> v_id then
          return jsonb_build_object('ok', false, 'code', 'invalid_trash');
        end if;
        v_client_table := case v_table
          when 'booster_boxes' then 'boosterBoxes'
          when 'booster_packs' then 'boosterPacks'
          when 'ebay_purchases' then 'ebayPurchases'
          else v_table
        end;
        if v_trash_data->>'originalTable' not in (v_table, v_client_table) then
          return jsonb_build_object('ok', false, 'code', 'invalid_trash');
        end if;
        if jsonb_build_array('trash', v_trash_id)::text = any(v_seen) then
          return jsonb_build_object('ok', false, 'code', 'duplicate_target');
        end if;
        v_seen := array_append(v_seen, jsonb_build_array('trash', v_trash_id)::text);
      end if;
    else
      if v_table <> all(v_allowed_restore) then
        return jsonb_build_object('ok', false, 'code', 'invalid_table');
      end if;
      if exists (
        select 1 from jsonb_object_keys(v_operation) as keys(key_name)
        where key_name not in (
          'type', 'table', 'id', 'expected_version',
          'tombstone_version', 'data', 'trash_id'
        )
      ) or not (v_operation ? 'data')
        or not (v_operation ? 'trash_id')
        or v_expected <> 0
        or jsonb_typeof(v_operation->'data') <> 'object'
        or jsonb_typeof(v_operation->'trash_id') <> 'string' then
        return jsonb_build_object('ok', false, 'code', 'invalid_operation');
      end if;
      if exists (
        select 1 from jsonb_object_keys(v_operation->'data') as keys(key_name)
        where left(key_name, 1) = '_' or key_name in ('id', 'row_version', 'updated_at')
      ) then
        return jsonb_build_object('ok', false, 'code', 'reserved_field');
      end if;
      if not (v_operation ? 'tombstone_version') then
        return jsonb_build_object('ok', false, 'code', 'missing_expected_version');
      end if;
      if jsonb_typeof(v_operation->'tombstone_version') <> 'number'
         or (v_operation->>'tombstone_version') !~ '^[1-9][0-9]*$'
         or length(v_operation->>'tombstone_version') > 19 then
        return jsonb_build_object('ok', false, 'code', 'invalid_expected_version');
      end if;
      begin
        v_tombstone_expected := (v_operation->>'tombstone_version')::bigint;
      exception when numeric_value_out_of_range then
        return jsonb_build_object('ok', false, 'code', 'invalid_expected_version');
      end;
      if v_tombstone_expected > 9223372036854775806 then
        return jsonb_build_object('ok', false, 'code', 'invalid_expected_version');
      end if;
      v_trash_id := v_operation->>'trash_id';
      if length(v_trash_id) < 1 or length(v_trash_id) > 256 then
        return jsonb_build_object('ok', false, 'code', 'invalid_trash');
      end if;
      if jsonb_build_array('trash', v_trash_id)::text = any(v_seen) then
        return jsonb_build_object('ok', false, 'code', 'duplicate_target');
      end if;
      v_seen := array_append(v_seen, jsonb_build_array('trash', v_trash_id)::text);
    end if;

    -- The identifier is formatted only after passing a hard-coded table allowlist.
    execute format(
      'select jsonb_build_object(''id'', id, ''data'', '
      || 'case when $2 then public.collectibles_clean_trash_data(data) '
      || 'else public.collectibles_clean_data(data) end, '
      || '''row_version'', row_version, ''updated_at'', updated_at) '
      || 'from public.%I where id = $1 for update',
      v_table
    ) into v_current using v_id, (v_table = 'trash');

    v_tombstone := null;
    if v_table <> 'trash' then
      select jsonb_build_object(
        'table', table_name, 'id', row_id,
        'row_version', row_version, 'deleted_at', deleted_at
      ) into v_tombstone
      from public.collectibles_tombstones
      where table_name = v_table and row_id = v_id
      for update;
    end if;

    if v_type = 'upsert' then
      if (v_expected = 0 and (v_current is not null or v_tombstone is not null))
         or (v_expected > 0 and (
           v_current is null
           or (v_current->>'row_version')::bigint <> v_expected
           or v_tombstone is not null
         )) then
        v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
          'table', v_table, 'id', v_id,
          'current', v_current, 'tombstone', v_tombstone
        ));
      end if;
    elsif v_type = 'delete' then
      if v_current is null or (v_current->>'row_version')::bigint <> v_expected
         or v_tombstone is not null then
        v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
          'table', v_table, 'id', v_id,
          'current', v_current, 'tombstone', v_tombstone
        ));
      elsif v_table not in ('versions', 'trash') then
        v_trash_id := v_operation->'trash'->>'id';
        select jsonb_build_object(
          'id', id, 'data', public.collectibles_clean_trash_data(data),
          'row_version', row_version, 'updated_at', updated_at
        ) into v_trash_current
        from public.trash where id = v_trash_id for update;
        if v_trash_current is not null and (
          not (v_trash_current->'data' ?& array['originalTable', 'originalId', 'item'])
          or jsonb_typeof(v_trash_current->'data'->'item') <> 'object'
          or v_trash_current->'data'->>'originalId' <> v_id
          or v_trash_current->'data'->>'originalTable' not in (v_table, v_client_table)
        ) then
          v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
            'table', 'trash', 'id', v_trash_id,
            'current', v_trash_current, 'tombstone', null
          ));
        end if;
      end if;
    else
      v_client_table := case v_table
        when 'booster_boxes' then 'boosterBoxes'
        when 'booster_packs' then 'boosterPacks'
        when 'ebay_purchases' then 'ebayPurchases'
        else v_table
      end;
      select jsonb_build_object(
        'id', id, 'data', public.collectibles_clean_trash_data(data),
        'row_version', row_version, 'updated_at', updated_at
      ) into v_trash_current
      from public.trash where id = v_trash_id for update;
      if v_current is not null or v_tombstone is null
         or (v_tombstone->>'row_version')::bigint <> v_tombstone_expected
         or v_trash_current is null
         or not (v_trash_current->'data' ?& array['originalTable', 'originalId', 'item'])
         or jsonb_typeof(v_trash_current->'data'->'item') <> 'object'
         or v_trash_current->'data'->>'originalId' <> v_id
         or v_trash_current->'data'->>'originalTable' not in (v_table, v_client_table)
         or public.collectibles_clean_data((v_trash_current->'data'->'item') - 'id'::text)
              <> public.collectibles_clean_data(v_operation->'data') then
        v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
          'table', v_table, 'id', v_id,
          'current', v_current, 'tombstone', v_tombstone
        ));
      end if;
    end if;
  end loop;

  if jsonb_array_length(v_conflicts) > 0 then
    return jsonb_build_object(
      'ok', false, 'code', 'version_conflict', 'conflicts', v_conflicts
    );
  end if;

  for v_operation in select value from jsonb_array_elements(p_request->'operations') loop
    v_type := v_operation->>'type';
    v_table := v_operation->>'table';
    v_id := v_operation->>'id';
    v_expected := (v_operation->>'expected_version')::bigint;
    v_now := clock_timestamp();

    if v_type = 'upsert' then
      if v_expected = 0 then
        execute format(
          'insert into public.%I (id, data, row_version, updated_at) values ($1, $2, 1, $3) '
          || 'returning row_version, updated_at',
          v_table
        ) into v_next_version, v_now
          using v_id, public.collectibles_clean_data(v_operation->'data'), v_now;
      else
        v_next_version := v_expected + 1;
        execute format(
          'update public.%I set data = $2, row_version = $3, updated_at = $4 where id = $1 '
          || 'returning row_version, updated_at',
          v_table
        ) into v_next_version, v_now
          using v_id, public.collectibles_clean_data(v_operation->'data'), v_next_version, v_now;
      end if;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'type', 'upsert', 'table', v_table, 'id', v_id,
        'row_version', v_next_version, 'updated_at', v_now
      ));
    elsif v_type = 'delete' then
      v_next_version := v_expected + 1;
      if v_table not in ('versions', 'trash') then
        v_trash_id := v_operation->'trash'->>'id';
        v_trash_data := v_operation->'trash'->'data';
        execute format('select data from public.%I where id = $1', v_table)
          into v_live_data using v_id;
        v_trash_data := jsonb_set(
          jsonb_set(
            v_trash_data,
            '{item}',
            jsonb_build_object('id', v_id)
              || public.collectibles_clean_data(v_live_data),
            true
          ),
          '{deletedAt}', to_jsonb(v_now::text), true
        );
        insert into public.trash (id, data, row_version, updated_at)
        values (v_trash_id, v_trash_data, 1, v_now)
        on conflict (id) do update
          set data = excluded.data,
              row_version = public.trash.row_version + 1,
              updated_at = excluded.updated_at
        returning row_version, updated_at into v_trash_version, v_trash_updated_at;
        v_results := v_results || jsonb_build_array(jsonb_build_object(
          'type', 'upsert', 'table', 'trash', 'id', v_trash_id,
          'row_version', v_trash_version, 'updated_at', v_trash_updated_at
        ));
      end if;

      if v_table <> 'trash' then
        insert into public.collectibles_tombstones (
          table_name, row_id, row_version, deleted_at, mutation_id
        ) values (v_table, v_id, v_next_version, v_now, v_mutation_id)
        on conflict (table_name, row_id) do update
          set row_version = excluded.row_version,
              deleted_at = excluded.deleted_at,
              mutation_id = excluded.mutation_id;
      end if;
      execute format('delete from public.%I where id = $1', v_table) using v_id;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'type', 'delete', 'table', v_table, 'id', v_id,
        'row_version', v_next_version, 'updated_at', v_now,
        'deleted_at', v_now
      ));
    else
      v_tombstone_expected := (v_operation->>'tombstone_version')::bigint;
      v_next_version := v_tombstone_expected + 1;
      v_trash_id := v_operation->>'trash_id';
      select data into v_trash_data from public.trash where id = v_trash_id;
      execute format(
        'insert into public.%I (id, data, row_version, updated_at) values ($1, $2, $3, $4) '
        || 'returning row_version, updated_at',
        v_table
      ) into v_next_version, v_now using v_id,
          public.collectibles_clean_data((v_trash_data->'item') - 'id'::text),
          v_next_version, v_now;
      delete from public.collectibles_tombstones
      where table_name = v_table and row_id = v_id and row_version = v_tombstone_expected;
      delete from public.trash where id = v_trash_id;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'type', 'restore', 'table', v_table, 'id', v_id,
        'row_version', v_next_version, 'updated_at', v_now
      ));
    end if;
  end loop;

  v_result := jsonb_build_object(
    'ok', true,
    'mutation_id', v_mutation_id::text,
    'results', v_results
  );
  insert into public.collectibles_mutation_receipts (
    mutation_id, request_fingerprint, response
  ) values (v_mutation_id, v_fingerprint, v_result);
  return v_result;
end;
$function$;

revoke all on function public.collectibles_clean_data(jsonb) from public, anon, authenticated;
revoke all on function public.collectibles_clean_trash_data(jsonb) from public, anon, authenticated;
revoke all on function public.collectibles_set_row_version() from public, anon, authenticated;
revoke all on function public.collectibles_pull_v2(integer) from public, anon, authenticated;
revoke all on function public.collectibles_mutate_v2(jsonb) from public, anon, authenticated;
grant execute on function public.collectibles_clean_data(jsonb) to service_role;
grant execute on function public.collectibles_clean_trash_data(jsonb) to service_role;
grant execute on function public.collectibles_set_row_version() to service_role;
grant execute on function public.collectibles_pull_v2(integer) to service_role;
grant execute on function public.collectibles_mutate_v2(jsonb) to service_role;

commit;
