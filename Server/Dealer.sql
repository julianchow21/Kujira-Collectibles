-- Collectibles Dealer Desk production integration
--
-- This migration is additive. It stores Dealer workflow state separately from
-- the canonical inventory and sales ledger. The Worker supplies the verified
-- owner UUID, while these security-definer RPCs enforce owner, version,
-- idempotency and financial rules inside one PostgreSQL transaction.

begin;

create table if not exists public.dealer_records (
  entity_type text not null,
  id text not null,
  owner_user_id uuid not null,
  candidate_id text,
  state text not null default 'draft',
  data jsonb not null default '{}'::jsonb,
  row_version bigint not null default 1,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (entity_type, id),
  constraint dealer_records_entity_check check (
    entity_type in ('candidate', 'evidence', 'plan', 'copy', 'listing', 'outcome', 'review')
  ),
  constraint dealer_records_state_check check (length(state) between 1 and 64),
  constraint dealer_records_version_check check (row_version > 0),
  constraint dealer_records_data_check check (jsonb_typeof(data) = 'object')
);

create index if not exists dealer_records_owner_updated_idx
  on public.dealer_records (owner_user_id, updated_at, entity_type, id);
create index if not exists dealer_records_owner_candidate_idx
  on public.dealer_records (owner_user_id, candidate_id, entity_type, updated_at, id);

create table if not exists public.dealer_canonical_links (
  owner_user_id uuid not null,
  copy_id text not null,
  candidate_id text not null,
  inventory_table text not null,
  inventory_id text not null,
  canonical_row_version bigint not null,
  sale_id text,
  sale_row_version bigint,
  row_version bigint not null default 1,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (owner_user_id, copy_id),
  unique (owner_user_id, inventory_table, inventory_id),
  constraint dealer_links_table_check check (
    inventory_table in ('singles', 'slabs', 'etbs', 'booster_boxes', 'booster_packs', 'ebay_purchases')
  ),
  constraint dealer_links_version_check check (canonical_row_version > 0 and row_version > 0 and (sale_row_version is null or sale_row_version > 0))
);

alter table public.dealer_canonical_links
  add column if not exists sale_row_version bigint;

create index if not exists dealer_links_owner_candidate_idx
  on public.dealer_canonical_links (owner_user_id, candidate_id, updated_at, copy_id);
create index if not exists dealer_links_owner_sale_idx
  on public.dealer_canonical_links (owner_user_id, sale_id)
  where sale_id is not null;

create table if not exists public.dealer_command_receipts (
  command_id uuid primary key,
  owner_user_id uuid not null,
  request_fingerprint text not null,
  request_json jsonb not null default '{}'::jsonb,
  response jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);

alter table public.dealer_command_receipts
  add column if not exists request_json jsonb not null default '{}'::jsonb;

create index if not exists dealer_receipts_owner_created_idx
  on public.dealer_command_receipts (owner_user_id, created_at, command_id);

do $dealer_security$
declare
  v_table text;
begin
  foreach v_table in array ARRAY[
    'dealer_records', 'dealer_canonical_links', 'dealer_command_receipts'
  ] loop
    execute format('alter table public.%I enable row level security', v_table);
    execute format('revoke all on table public.%I from public, anon, authenticated', v_table);
    execute format(
      'grant select, insert, update, delete on table public.%I to service_role',
      v_table
    );
  end loop;
end;
$dealer_security$;

create or replace function public.dealer_record_revision_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $function$
begin
  if tg_op = 'INSERT' then
    if new.row_version is null or new.row_version < 1 then
      new.row_version := 1;
    end if;
    if new.data is null or jsonb_typeof(new.data) <> 'object' then
      raise exception 'dealer data must be an object' using errcode = 'check_violation';
    end if;
  else
    if old.owner_user_id <> new.owner_user_id
       or old.entity_type <> new.entity_type
       or old.id <> new.id then
      raise exception 'dealer identity is immutable' using errcode = 'check_violation';
    end if;
    if old.entity_type = 'plan'
       and coalesce(old.data->>'status', old.state) = 'approved'
       and (new.data is distinct from old.data or new.state is distinct from old.state
            or new.candidate_id is distinct from old.candidate_id) then
      raise exception 'approved dealer plan is immutable' using errcode = 'P0001';
    end if;
    new.row_version := old.row_version + 1;
  end if;
  new.updated_at := clock_timestamp();
  return new;
end;
$function$;

drop trigger if exists dealer_record_revision_guard on public.dealer_records;
create trigger dealer_record_revision_guard
before insert or update on public.dealer_records
for each row execute function public.dealer_record_revision_guard();

create or replace function public.dealer_link_revision_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $function$
begin
  if tg_op = 'INSERT' then
    if new.row_version is null or new.row_version < 1 then new.row_version := 1; end if;
  else
    if old.owner_user_id <> new.owner_user_id
       or old.copy_id <> new.copy_id then
      raise exception 'dealer canonical identity is immutable' using errcode = 'check_violation';
    end if;
    new.row_version := old.row_version + 1;
  end if;
  new.updated_at := clock_timestamp();
  return new;
end;
$function$;

drop trigger if exists dealer_link_revision_guard on public.dealer_canonical_links;
create trigger dealer_link_revision_guard
before insert or update on public.dealer_canonical_links
for each row execute function public.dealer_link_revision_guard();

create or replace function public.dealer_record_json(p_record public.dealer_records)
returns jsonb
language sql
immutable
strict
set search_path = pg_catalog, public
as $function$
  select jsonb_build_object(
    'id', p_record.id,
    'entity_type', p_record.entity_type,
    'candidateId', p_record.candidate_id,
    'state', p_record.state,
    'data', p_record.data,
    'row_version', p_record.row_version,
    'updated_at', p_record.updated_at
  );
$function$;

create or replace function public.dealer_payload_keys_valid(
  p_command text,
  p_payload jsonb
)
returns boolean
language sql
immutable
strict
set search_path = pg_catalog, public
as $function$
  select jsonb_typeof(p_payload) = 'object'
    and not exists (
      select 1
      from jsonb_object_keys(p_payload) as keys(key_name)
      where key_name not in (
        'id', 'candidateId', 'candidate_id', 'candidate', 'identity', 'title', 'name',
        'set', 'number', 'language', 'variant', 'condition', 'grading', 'ownership',
        'evidence', 'evidenceId', 'evidence_id', 'metadata', 'source', 'sourceRefs',
        'source_refs', 'status', 'target', 'targets', 'notes', 'currency', 'plan',
        'planId', 'plan_id', 'approvedBy', 'approved_by', 'approvedAt', 'approved_at',
        'approval', 'copyId', 'copy_id', 'inventoryTable', 'inventory_table',
        'inventoryId', 'inventory_id', 'table', 'itemRef', 'item_ref', 'canonical',
        'row', 'costBasis', 'cost_basis', 'reviewedCost', 'reviewed_cost', 'cost',
        'componentCost', 'component_cost', 'listingId', 'listing_id', 'listing',
        'platform', 'channel', 'asking', 'askingPrice', 'asking_price', 'outcomeId',
        'outcome_id', 'saleId', 'sale_id', 'sale', 'paymentStatus', 'payment_status',
        'payment', 'agreedAmount', 'agreed_amount', 'amount', 'soldAt', 'sold_at',
        'settlement', 'settlementEvidence', 'settlement_evidence', 'cashSettledAt',
        'cash_settled_at', 'settledAt', 'settled_at', 'proceeds', 'sellingFee',
        'selling_fee', 'outboundShipping', 'outbound_shipping', 'shipping', 'fees',
        'canonicalLandedCost', 'canonical_landed_cost',
        'actual', 'posted', 'nonSale', 'non_sale', 'reason', 'returnedAt', 'returned_at',
        'review', 'reviewer', 'reviewedAt', 'reviewed_at', 'variance', 'patch',
        'revisionReason', 'revision_reason', 'supersedesPlanId', 'supersedes_plan_id', 'supersedes',
        'expected', 'fxDirection', 'fx_direction', 'fxRate', 'fx_rate', 'fxSource',
        'fx_source', 'fxAt', 'fx_at', 'sourceTime', 'source_time', 'canonicalRowVersion',
        'canonical_row_version', 'ownershipReviewed',
        'ownership_reviewed', 'costStatus', 'cost_status', 'dateAcquired',
        'date_acquired', 'hold', 'reviewId', 'review_id', 'cause',
        'restockDecision', 'restock_decision', 'evidenceClass', 'evidence_class',
        'published', 'localOnly', 'local_only', 'itemCost', 'item_cost',
        'settledItemCost', 'settled_item_cost', 'confirmed', 'reviewed'
        , 'fx', 'fxMetadata', 'fx_metadata', 'originalAmount', 'originalCurrency',
        'settledAmount', 'settledCurrency', 'settlementCurrency', 'settlement_currency',
        'observedAt', 'observed_at', 'reportingCurrency', 'destinationCurrency',
        'expectedSaleAmount', 'saleAmount', 'expectedSale', 'expectedSellingFee',
        'sellingFee', 'fee', 'expectedOutboundShipping', 'outboundShipping',
        'shipping', 'expectedRefundAllowance', 'refundAllowance',
        'otherExpectedDeductions', 'otherDeductions', 'targetContribution',
        'targetMargin', 'riskAllowance', 'knownNonItemAcquisitionCosts',
        'knownNonItemCosts', 'nonItemAcquisitionCosts', 'plannedItemCost',
        'planned_item_cost', 'plannedLandedCost', 'planned_landed_cost',
        'evidenceRefs', 'evidence_refs', 'scenario', 'certainty', 'conditionScenario',
        'format', 'rawOrSlab', 'raw_or_slab', 'grader', 'grade', 'gradeCertainty',
        'grade_certainty', 'certificateNumber', 'certificate_number', 'certificate',
        'certNo', 'cert_no', 'frontRef', 'front_ref', 'backRef', 'back_ref', 'holdReason',
        'hold_reason', 'expectedGrade', 'expected_grade', 'gradeScenario', 'grade_scenario',
        'resaleGrade', 'resale_grade'
      )
    );
$function$;

-- Nested objects are data-bearing parts of the command, so they have their own
-- allowlists. Free-form metadata and source references remain user data, while
-- server-derived identity, money and state fields are handled by the guard
-- below and by the command branches.
create or replace function public.dealer_nested_keys_valid(
  p_command text,
  p_payload jsonb
)
returns boolean
language plpgsql
immutable
strict
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  v_nested record;
  v_key text;
  v_allowed text[];
  v_command_allowed text[];
begin
  if jsonb_typeof(p_payload) <> 'object' then return false; end if;
  v_command_allowed := case p_command
    when 'create_candidate' then array['identity','grading','evidence','metadata','sourceRefs','source_refs']
    when 'update_candidate' then array['candidate','identity','grading','patch','metadata','sourceRefs','source_refs']
    when 'add_evidence' then array['evidence','metadata','sourceRefs','source_refs']
    when 'create_plan' then array['plan','metadata','sourceRefs','source_refs','supersedes']
    when 'approve_buy' then array['approval','supersedes']
    when 'acquire_copy' then array['reviewedCost','reviewed_cost','itemRef','item_ref','canonical','metadata','fx','fxMetadata','fx_metadata']
    when 'link_copy' then array['reviewedCost','reviewed_cost','itemRef','item_ref','canonical','metadata','fx','fxMetadata','fx_metadata']
    when 'set_asking' then array['listing']
    when 'prepare_listing' then array['listing']
    when 'record_sale' then array['sale','metadata']
    when 'settle_sale' then array['settlement','settlementEvidence','settlement_evidence','actual','posted','fx','fxMetadata','fx_metadata']
    when 'record_non_sale' then array['nonSale','non_sale']
    when 'review_outcome' then array['review','restockDecision','restock_decision']
    else array[]::text[]
  end;
  for v_nested in select key, value from jsonb_each(p_payload)
    where key in (
      'candidate','identity','grading','evidence','plan','reviewedCost','reviewed_cost',
      'settlement','settlementEvidence','settlement_evidence','sale','listing',
      'itemRef','item_ref','canonical','row','patch','review','actual','posted',
      'nonSale','non_sale','approval','restockDecision','restock_decision','fx',
      'fxMetadata','fx_metadata','metadata','sourceRefs','source_refs','supersedes'
    )
  loop
    if not (v_nested.key = any(v_command_allowed)) then return false; end if;
    if v_nested.key in ('metadata','sourceRefs','source_refs') then
      if v_nested.key = 'metadata' and jsonb_typeof(v_nested.value) not in ('object','null') then return false; end if;
      if v_nested.key <> 'metadata' and jsonb_typeof(v_nested.value) not in ('array','object','null') then return false; end if;
      continue;
    end if;
    if jsonb_typeof(v_nested.value) <> 'object' then return false; end if;
    v_allowed := case v_nested.key
      when 'candidate' then array['name','title','set','number','language','variant','condition','grading','ownership','notes','source','sourceRefs','source_refs','metadata']
      when 'identity' then array['name','title','set','number','language','variant','condition','grading','ownership','notes']
      when 'grading' then array['grader','grade','certainty','gradeCertainty','grade_certainty','certNo','cert_no','certificateNumber','certificate_number','certificate']
      when 'evidence' then array['id','type','kind','class','source','sourceRefs','source_refs','reference','referenceUrl','reference_url','url','note','notes','observedAt','observed_at','date','evidenceClass','evidence_class','match','identityMatch','matchResult','confidence','confidenceLevel','rationale','metadata']
      when 'plan' then array['reason','expected','targets','target','fees','shipping','currency','amount','price','expectedSaleAmount','saleAmount','expectedSale','expectedSellingFee','sellingFee','fee','expectedOutboundShipping','outboundShipping','expectedRefundAllowance','refundAllowance','otherExpectedDeductions','otherDeductions','targetContribution','targetMargin','riskAllowance','knownNonItemAcquisitionCosts','knownNonItemCosts','nonItemAcquisitionCosts','plannedItemCost','planned_item_cost','plannedLandedCost','planned_landed_cost','reportingCurrency','destinationCurrency','maximumAllIn','itemPriceCeiling','notes','source','sourceRefs','source_refs','metadata','evidenceRefs','evidence_refs','scenario','certainty','conditionScenario','revisionReason','revision_reason','supersedesPlanId','supersedes_plan_id']
      when 'reviewedCost' then array['confirmed','currency','itemCost','item_cost','settledItemCost','settled_item_cost','settledAmount','settled_amount','settledCurrency','settled_currency','nonItemAcquisitionCosts','non_item_acquisition_costs','nonItemCurrency','non_item_currency','settledNonItemAcquisitionCosts','settled_non_item_acquisition_costs','fx','fxMetadata','fx_metadata','fxDirection','fx_direction','fxRate','fx_rate','fxSource','fx_source','fxAt','fx_at','sourceTime','source_time','originalAmount','originalCurrency','reviewedAt','date','reason']
      when 'reviewed_cost' then array['confirmed','currency','itemCost','item_cost','settledItemCost','settled_item_cost','settledAmount','settled_amount','settledCurrency','settled_currency','nonItemAcquisitionCosts','non_item_acquisition_costs','nonItemCurrency','non_item_currency','settledNonItemAcquisitionCosts','settled_non_item_acquisition_costs','fx','fxMetadata','fx_metadata','fxDirection','fx_direction','fxRate','fx_rate','fxSource','fx_source','fxAt','fx_at','sourceTime','source_time','originalAmount','originalCurrency','reviewedAt','date','reason']
      when 'settlement' then array['proof','source','reference','url','note','class','type','date','at','observedAt','observed_at']
      when 'settlementEvidence' then array['proof','source','reference','url','note','class','type','date','at','observedAt','observed_at']
      when 'settlement_evidence' then array['proof','source','reference','url','note','class','type','date','at','observedAt','observed_at']
      when 'sale' then array['agreedAmount','agreed_amount','currency','amount','soldAt','sold_at','buyer','channel','notes']
      when 'listing' then array['platform','channel','asking','askingPrice','asking_price','notes','source','url']
      when 'itemRef' then array['table','inventoryTable','inventory_table']
      when 'item_ref' then array['table','inventoryTable','inventory_table']
      when 'canonical' then array['table','inventoryTable','inventory_table']
      when 'row' then array['table','inventoryTable','inventory_table']
      when 'patch' then array['notes','metadata','evidence','source','sourceRefs','source_refs','review','title','name','set','number','language','variant','condition','grading','ownership']
      when 'review' then array['cause','reason','notes','restockDecision','restock_decision']
      when 'actual' then array['proceeds','sellingFee','selling_fee','outboundShipping','outbound_shipping','shipping','fees']
      when 'posted' then array['proceeds','sellingFee','selling_fee','outboundShipping','outbound_shipping','shipping','fees']
      when 'nonSale' then array['reason','type','note','notes','returnedAt','returned_at']
      when 'non_sale' then array['reason','type','note','notes','returnedAt','returned_at']
      when 'approval' then array['reason','source','notes']
      when 'restockDecision' then array['decision','reason','notes','date','at','reviewedAt']
      when 'restock_decision' then array['decision','reason','notes','date','at','reviewedAt']
      when 'supersedes' then array['planId','plan_id']
      when 'fx' then array['base','quote','rate','source','observedAt','observed_at','settledBaseAmount','settledCurrency','precision']
      when 'fxMetadata' then array['base','quote','rate','source','observedAt','observed_at','settledBaseAmount','settledCurrency','precision']
      when 'fx_metadata' then array['base','quote','rate','source','observedAt','observed_at','settledBaseAmount','settledCurrency','precision']
      else null
    end;
    if v_allowed is null then return false; end if;
    for v_key in select key from jsonb_object_keys(v_nested.value) as keys(key) loop
      if not (v_key = any(v_allowed)) then return false; end if;
    end loop;
  end loop;
  return true;
end;
$function$;

create or replace function public.dealer_command_payload_keys_valid(
  p_command text,
  p_payload jsonb
)
returns boolean
language sql
immutable
strict
set search_path = pg_catalog, public
as $function$
  select jsonb_typeof(p_payload) = 'object'
    and not exists (
      select 1
      from jsonb_object_keys(p_payload) as keys(key_name)
      where key_name <> all(case p_command
        when 'create_candidate' then array['id','candidateId','candidate_id','identity','title','name','set','number','language','variant','condition','grading','ownership','ownershipReviewed','ownership_reviewed','evidence','evidenceId','evidence_id','metadata','source','sourceRefs','source_refs','status','notes','localOnly','local_only','certainty','conditionScenario','format','rawOrSlab','raw_or_slab','grader','grade','gradeCertainty','grade_certainty','certificateNumber','certificate_number','certificate','certNo','cert_no','frontRef','front_ref','backRef','back_ref','hold','holdReason','hold_reason']
        when 'update_candidate' then array['candidateId','candidate_id','patch','candidate','identity','title','name','set','number','language','variant','condition','grading','ownership','metadata','source','sourceRefs','source_refs','notes','status','format','rawOrSlab','raw_or_slab','grader','grade','gradeCertainty','grade_certainty','certificateNumber','certificate_number','certificate','certNo','cert_no','frontRef','front_ref','backRef','back_ref','hold','holdReason','hold_reason']
        when 'add_evidence' then array['candidateId','candidate_id','id','evidence','evidenceId','evidence_id','metadata','source','sourceRefs','source_refs','notes']
        when 'create_plan' then array['candidateId','candidate_id','planId','plan_id','plan','reason','revisionReason','revision_reason','supersedesPlanId','supersedes_plan_id','supersedes','source','sourceRefs','source_refs','notes','reportingCurrency','destinationCurrency','currency','expectedSaleAmount','saleAmount','expectedSale','expectedSellingFee','sellingFee','fee','expectedOutboundShipping','outboundShipping','shipping','expectedRefundAllowance','refundAllowance','otherExpectedDeductions','otherDeductions','targetContribution','targetMargin','riskAllowance','knownNonItemAcquisitionCosts','knownNonItemCosts','nonItemAcquisitionCosts','plannedItemCost','planned_item_cost','plannedLandedCost','planned_landed_cost','evidenceRefs','evidence_refs','scenario','certainty','conditionScenario']
        when 'approve_buy' then array['candidateId','candidate_id','planId','plan_id','reason','approval','supersedesPlanId','supersedes_plan_id','supersedes','notes']
        when 'acquire_copy' then array['candidateId','candidate_id','copyId','copy_id','inventoryTable','inventory_table','inventoryId','inventory_id','table','itemRef','item_ref','canonical','reviewedCost','reviewed_cost','cost','ownershipReviewed','ownership_reviewed','notes','fx','fxMetadata','fx_metadata','fxDirection','fx_direction','fxRate','fx_rate','fxSource','fx_source','fxAt','fx_at','sourceTime','source_time']
        when 'link_copy' then array['candidateId','candidate_id','copyId','copy_id','inventoryTable','inventory_table','inventoryId','inventory_id','table','itemRef','item_ref','canonical','reviewedCost','reviewed_cost','cost','ownershipReviewed','ownership_reviewed','notes','fx','fxMetadata','fx_metadata','fxDirection','fx_direction','fxRate','fx_rate','fxSource','fx_source','fxAt','fx_at','sourceTime','source_time']
        when 'set_asking' then array['copyId','copy_id','listingId','listing_id','listing','platform','channel','asking','askingPrice','asking_price','notes']
        when 'prepare_listing' then array['candidateId','candidate_id','copyId','copy_id','listingId','listing_id','listing','platform','channel','asking','askingPrice','asking_price','notes']
        when 'record_sale' then array['candidateId','candidate_id','copyId','copy_id','listingId','listing_id','saleId','sale_id','outcomeId','outcome_id','sale','agreedAmount','agreed_amount','amount','currency','soldAt','sold_at','buyer','channel','notes']
        when 'settle_sale' then array['outcomeId','outcome_id','saleId','sale_id','settlement','settlementEvidence','settlement_evidence','cashSettledAt','cash_settled_at','settledAt','settled_at','currency','settlementCurrency','settlement_currency','proceeds','sellingFee','selling_fee','outboundShipping','outbound_shipping','shipping','fees','actual','posted','canonicalLandedCost','canonical_landed_cost','fx','fxMetadata','fx_metadata','fxDirection','fx_direction','fxRate','fx_rate','fxSource','fx_source','fxAt','fx_at','sourceTime','source_time']
        when 'record_non_sale' then array['candidateId','candidate_id','copyId','copy_id','outcomeId','outcome_id','nonSale','non_sale','reason','returnedAt','returned_at','notes']
        when 'review_outcome' then array['outcomeId','outcome_id','reviewId','review_id','review','reviewer','reviewedAt','reviewed_at','restockDecision','restock_decision','cause','reason','notes']
        else array[]::text[]
      end)
    );
$function$;

create or replace function public.dealer_nested_protected(p_value jsonb)
returns boolean
language plpgsql
immutable
strict
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  v_pair record;
begin
  if jsonb_typeof(p_value) = 'object' then
    for v_pair in select key, value from jsonb_each(p_value) loop
      if v_pair.key like '_dealer%'
         or v_pair.key in (
           'ownerId', 'owner_id', 'owner_user_id', 'row_version', 'updated_at',
           'created_at', 'candidateId', 'candidate_id', 'copyId', 'copy_id',
           'listingId', 'listing_id', 'outcomeId', 'outcome_id', 'saleId', 'sale_id',
           'dealerCostBasis', 'dealerActual', 'dealerPaymentStatus', 'contribution',
           'profit', 'margin', 'paymentStatus', 'approvedPlanId',
           'expected', 'expectedNetProceeds', 'maximumAllIn',
           'maximumAllInAcquisitionCost', 'maximumAllInAcquisitionCostRounded',
           'rawItemPriceCeiling', 'itemPriceCeiling', 'itemCeiling',
           'plannedLandedCost', 'plannedContribution', 'plannedContributionStatus'
         ) then
        return true;
      end if;
      if public.dealer_nested_protected(v_pair.value) then return true; end if;
    end loop;
  elsif jsonb_typeof(p_value) = 'array' then
    for v_pair in select value from jsonb_array_elements(p_value) loop
      if public.dealer_nested_protected(v_pair.value) then return true; end if;
    end loop;
  end if;
  return false;
end;
$function$;

create or replace function public.dealer_expected_version(
  p_expected jsonb,
  p_key text
)
returns bigint
language plpgsql
immutable
strict
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  v_value jsonb;
  v_text text;
begin
  if p_expected is null or jsonb_typeof(p_expected) <> 'object' then return -1; end if;
  v_value := case p_key
    when 'candidate' then coalesce(p_expected->'candidate', p_expected->'candidateVersion')
    when 'plan' then coalesce(p_expected->'plan', p_expected->'planVersion')
    when 'copy' then coalesce(p_expected->'copy', p_expected->'copyVersion')
    when 'listing' then coalesce(p_expected->'listing', p_expected->'listingVersion')
    when 'outcome' then coalesce(p_expected->'outcome', p_expected->'outcomeVersion')
    when 'canonical' then coalesce(p_expected->'canonical', p_expected->'canonicalRowVersion')
    when 'sale' then coalesce(p_expected->'sale', p_expected->'saleVersion')
    else null
  end;
  if v_value is null then return 0; end if;
  if jsonb_typeof(v_value) <> 'number' or (v_value::text) !~ '^(0|[1-9][0-9]*)$' then
    return -1;
  end if;
  v_text := v_value #>> '{}';
  if length(v_text) > 18 then return -1; end if;
  begin return v_text::bigint; exception when numeric_value_out_of_range then return -1; end;
end;
$function$;

create or replace function public.dealer_parse_money(p_value jsonb)
returns numeric
language plpgsql
immutable
strict
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  v_text text;
begin
  if jsonb_typeof(p_value) = 'null' then return null; end if;
  if jsonb_typeof(p_value) = 'string' then
    v_text := btrim(p_value #>> '{}');
  elsif jsonb_typeof(p_value) = 'number' then
    v_text := p_value::text;
  else
    raise exception 'money value must be a decimal string or number' using errcode = '22023';
  end if;
  if v_text !~ '^-?(0|[1-9][0-9]*)(\.[0-9]{1,2})?$' then
    raise exception 'money value has invalid precision or format' using errcode = '22023';
  end if;
  return v_text::numeric;
end;
$function$;

create or replace function public.dealer_parse_plan_number(p_value jsonb)
returns numeric
language plpgsql
immutable
strict
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  v_text text;
begin
  if jsonb_typeof(p_value) = 'null' then return null; end if;
  if jsonb_typeof(p_value) = 'string' then v_text := btrim(p_value #>> '{}');
  elsif jsonb_typeof(p_value) = 'number' then v_text := p_value::text;
  else raise exception 'plan amount must be a decimal string or number' using errcode = '22023'; end if;
  if v_text !~ '^-?(0|[1-9][0-9]*)(\.[0-9]{1,6})?$' then
    raise exception 'plan amount has invalid precision or format' using errcode = '22023';
  end if;
  return v_text::numeric;
end;
$function$;

create or replace function public.dealer_normalise_fx(p_fx jsonb, p_currency text)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  v_base text;
  v_quote text;
  v_rate numeric;
  v_source text;
  v_observed text;
  v_settled numeric;
  v_settled_currency text;
begin
  if p_fx is null or jsonb_typeof(p_fx) = 'null' then return null; end if;
  if jsonb_typeof(p_fx) <> 'object' then raise exception 'FX metadata must be an object' using errcode = '22023'; end if;
  v_base := upper(btrim(coalesce(p_fx->>'base','')));
  v_quote := upper(btrim(coalesce(p_fx->>'quote','')));
  if v_base is null or v_quote is null or v_base !~ '^[A-Z]{3}$' or v_quote !~ '^[A-Z]{3}$' or v_base = v_quote then raise exception 'FX direction is invalid' using errcode = '22023'; end if;
  begin v_rate := (p_fx->>'rate')::numeric; exception when others then raise exception 'FX rate is invalid' using errcode = '22023'; end;
  if v_rate is null or v_rate <= 0 then raise exception 'FX rate must be positive' using errcode = '22023'; end if;
  v_source := btrim(coalesce(p_fx->>'source',''));
  if v_source = '' then raise exception 'FX source is required' using errcode = '22023'; end if;
  v_observed := coalesce(p_fx->>'observedAt',p_fx->>'observed_at');
  if v_observed is null or v_observed = '' then raise exception 'FX observed time is required' using errcode = '22023'; end if;
  begin perform v_observed::timestamptz; exception when others then raise exception 'FX observed time is invalid' using errcode = '22023'; end;
  if p_currency is not null and (upper(p_currency) !~ '^[A-Z]{3}$' or upper(p_currency) not in (v_base,v_quote)) then raise exception 'FX direction does not describe the currency' using errcode = '22023'; end if;
  if p_fx ? 'settledBaseAmount' then
    begin v_settled := public.dealer_parse_money(p_fx->'settledBaseAmount'); exception when others then raise exception 'FX settled amount is invalid' using errcode = '22023'; end;
    if v_settled is null or v_settled < 0 then raise exception 'FX settled amount is invalid' using errcode = '22023'; end if;
    v_settled_currency := upper(btrim(coalesce(p_fx->>'settledCurrency','')));
    if v_settled_currency is null or v_settled_currency !~ '^[A-Z]{3}$' then raise exception 'FX settled currency is required' using errcode = '22023'; end if;
  end if;
  return jsonb_build_object(
    'base',v_base,'quote',v_quote,'rate',v_rate,'source',v_source,'observedAt',v_observed
  ) || case when v_settled is not null then jsonb_build_object('settledBaseAmount',v_settled,'settledCurrency',v_settled_currency) else '{}'::jsonb end;
end;
$function$;

create or replace function public.dealer_fx_to_sgd(p_amount numeric, p_currency text, p_fx jsonb)
returns numeric
language plpgsql
stable
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  v_currency text := upper(coalesce(p_currency,''));
  v_base text;
  v_quote text;
  v_rate numeric;
begin
  if p_amount is null then return null; end if;
  if v_currency = 'SGD' then return p_amount; end if;
  if p_fx is null or jsonb_typeof(p_fx) <> 'object' then raise exception 'FX metadata is required' using errcode = '22023'; end if;
  v_base := upper(p_fx->>'base');
  v_quote := upper(p_fx->>'quote');
  v_rate := (p_fx->>'rate')::numeric;
  if v_base = v_currency and v_quote = 'SGD' then return p_amount * v_rate; end if;
  if v_quote = v_currency and v_base = 'SGD' then return p_amount / v_rate; end if;
  raise exception 'FX direction does not convert to SGD' using errcode = '22023';
end;
$function$;

create or replace function public.dealer_plan_component(
  p_input jsonb,
  p_aliases text[]
)
returns jsonb
language plpgsql
stable
strict
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  v_alias text;
  v_value jsonb;
  v_amount numeric;
  v_amount_value jsonb;
  v_status text;
  v_currency text;
  v_fx jsonb;
begin
  foreach v_alias in array p_aliases loop
    if p_input ? v_alias then
      v_value := p_input->v_alias;
      exit;
    end if;
  end loop;
  if v_value is null or jsonb_typeof(v_value) = 'null' then
    return jsonb_build_object('status','Unknown','amount',null,'reason',p_aliases[1] || '_unknown');
  end if;

  if jsonb_typeof(v_value) = 'object' then
    v_status := lower(btrim(coalesce(v_value->>'status','')));
    v_amount_value := coalesce(v_value->'reportingAmount',v_value->'convertedAmount',v_value->'amount');
    if v_status in ('unknown','not known') then
      if v_amount_value is not null and jsonb_typeof(v_amount_value) <> 'null'
         and public.dealer_parse_plan_number(v_amount_value) <> 0 then
        raise exception 'unknown plan component carries a known amount' using errcode = '22023';
      end if;
      return jsonb_build_object('status','Unknown','amount',null,'reason',p_aliases[1] || '_unknown');
    end if;
    if v_status in ('not applicable','not_applicable','n/a') then
      if v_amount_value is not null and jsonb_typeof(v_amount_value) <> 'null'
         and public.dealer_parse_plan_number(v_amount_value) <> 0 then
        raise exception 'not applicable plan component must be zero' using errcode = '22023';
      end if;
      return jsonb_build_object('status','Known','amount',0,'notApplicable',true);
    end if;
    if v_amount_value is null or jsonb_typeof(v_amount_value) = 'null' then
      return jsonb_build_object('status','Unknown','amount',null,'reason',p_aliases[1] || '_unknown');
    end if;
    v_amount := public.dealer_parse_plan_number(v_amount_value);
    if v_amount < 0 then raise exception 'plan money must be non-negative' using errcode = '22023'; end if;
    v_currency := upper(btrim(coalesce(v_value->>'currency',p_input->>'reportingCurrency',p_input->>'destinationCurrency','SGD')));
    if v_currency !~ '^[A-Z]{3}$' then raise exception 'plan currency is invalid' using errcode = '22023'; end if;
    v_fx := coalesce(v_value->'fx',p_input->'fx',p_input->'fxMetadata',p_input->'fx_metadata');
    if v_currency <> 'SGD' then
      v_fx := public.dealer_normalise_fx(v_fx,v_currency);
      if v_fx is null then raise exception 'plan FX metadata is required' using errcode = '22023'; end if;
      v_amount := public.dealer_fx_to_sgd(v_amount,v_currency,v_fx);
    end if;
    return jsonb_build_object('status','Known','amount',v_amount,'currency','SGD','sourceCurrency',v_currency)
      || case when v_fx is null then '{}'::jsonb else jsonb_build_object('fx',v_fx) end;
  end if;

  v_amount := public.dealer_parse_plan_number(v_value);
  if v_amount < 0 then raise exception 'plan money must be non-negative' using errcode = '22023'; end if;
  return jsonb_build_object('status','Known','amount',v_amount,'currency','SGD','sourceCurrency','SGD');
end;
$function$;

create or replace function public.dealer_plan_economics(p_input jsonb)
returns jsonb
language plpgsql
stable
strict
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  v_reporting text := upper(coalesce(p_input->>'reportingCurrency',p_input->>'destinationCurrency',p_input->>'currency','SGD'));
  v_sale jsonb;
  v_fee jsonb;
  v_shipping jsonb;
  v_refund jsonb;
  v_other jsonb;
  v_target jsonb;
  v_risk jsonb;
  v_non_item jsonb;
  v_components jsonb;
  v_unknown jsonb := '[]'::jsonb;
  v_expected_net numeric := null;
  v_maximum_all_in numeric := null;
  v_item_ceiling numeric := null;
  v_raw_item numeric := null;
begin
  if jsonb_typeof(p_input) <> 'object' then raise exception 'plan input must be an object' using errcode = '22023'; end if;
  if v_reporting <> 'SGD' then raise exception 'only SGD reporting is supported' using errcode = '22023'; end if;
  v_sale := public.dealer_plan_component(p_input,array['expectedSaleAmount','saleAmount','expectedSale']);
  v_fee := public.dealer_plan_component(p_input,array['expectedSellingFee','sellingFee','fee']);
  v_shipping := public.dealer_plan_component(p_input,array['expectedOutboundShipping','outboundShipping','shipping']);
  v_refund := public.dealer_plan_component(p_input,array['expectedRefundAllowance','refundAllowance']);
  v_other := public.dealer_plan_component(p_input,array['otherExpectedDeductions','otherDeductions']);
  v_target := public.dealer_plan_component(p_input,array['targetContribution','targetMargin']);
  v_risk := public.dealer_plan_component(p_input,array['riskAllowance']);
  v_non_item := public.dealer_plan_component(p_input,array['knownNonItemAcquisitionCosts','knownNonItemCosts','nonItemAcquisitionCosts']);
  v_components := jsonb_build_object(
    'expectedSaleAmount',v_sale,'sellingFee',v_fee,'outboundShipping',v_shipping,
    'refundAllowance',v_refund,'otherDeductions',v_other,'targetContribution',v_target,
    'riskAllowance',v_risk,'knownNonItemAcquisitionCosts',v_non_item
  );
  if v_sale->>'status' <> 'Known' then v_unknown := v_unknown || jsonb_build_array('expectedSaleAmount'); end if;
  if v_fee->>'status' <> 'Known' then v_unknown := v_unknown || jsonb_build_array('sellingFee'); end if;
  if v_shipping->>'status' <> 'Known' then v_unknown := v_unknown || jsonb_build_array('outboundShipping'); end if;
  if v_refund->>'status' <> 'Known' then v_unknown := v_unknown || jsonb_build_array('refundAllowance'); end if;
  if v_other->>'status' <> 'Known' then v_unknown := v_unknown || jsonb_build_array('otherDeductions'); end if;
  if v_target->>'status' <> 'Known' then v_unknown := v_unknown || jsonb_build_array('targetContribution'); end if;
  if v_risk->>'status' <> 'Known' then v_unknown := v_unknown || jsonb_build_array('riskAllowance'); end if;
  if v_non_item->>'status' <> 'Known' then v_unknown := v_unknown || jsonb_build_array('knownNonItemAcquisitionCosts'); end if;
  if jsonb_array_length(v_unknown) = 0 then
    v_expected_net := (v_sale->>'amount')::numeric - (v_fee->>'amount')::numeric - (v_shipping->>'amount')::numeric - (v_refund->>'amount')::numeric - (v_other->>'amount')::numeric;
    v_maximum_all_in := v_expected_net - (v_target->>'amount')::numeric - (v_risk->>'amount')::numeric;
    v_raw_item := v_maximum_all_in - (v_non_item->>'amount')::numeric;
    v_item_ceiling := greatest(0, floor(v_raw_item * 100) / 100);
  end if;
  return jsonb_build_object(
    'reportingCurrency',v_reporting,
    'status',case when jsonb_array_length(v_unknown)=0 then 'Known' else 'Unknown' end,
    'unknownFields',v_unknown,
    'expectedSaleAmount',v_sale->'amount',
    'sellingFee',v_fee->'amount',
    'outboundShipping',v_shipping->'amount',
    'refundAllowance',v_refund->'amount',
    'otherDeductions',v_other->'amount',
    'targetContribution',v_target->'amount',
    'riskAllowance',v_risk->'amount',
    'knownNonItemAcquisitionCosts',v_non_item->'amount',
    'expectedNetProceeds',v_expected_net,
    'maximumAllInAcquisitionCost',v_maximum_all_in,
    'maximumAllInAcquisitionCostRounded',case when v_maximum_all_in is null then null else floor(v_maximum_all_in * 100) / 100 end,
    'rawItemPriceCeiling',v_raw_item,
    'itemPriceCeiling',v_item_ceiling,
    'itemCeiling',v_item_ceiling,
    'componentStatuses',jsonb_build_object(
      'expectedSaleAmount',v_sale->>'status','sellingFee',v_fee->>'status','outboundShipping',v_shipping->>'status',
      'refundAllowance',v_refund->>'status','otherDeductions',v_other->>'status','targetContribution',v_target->>'status',
      'riskAllowance',v_risk->>'status','knownNonItemAcquisitionCosts',v_non_item->>'status'
    ),
    'refundAllowanceCountedOnce',true,
    'formula','expected sale - selling fee - outbound shipping - refund allowance - other deductions',
    'ceilingFormula','expected net proceeds - target contribution - risk allowance - known non-item acquisition costs'
  );
end;
$function$;

create or replace function public.dealer_candidate_readiness(
  p_owner uuid,
  p_candidate_id text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  v_candidate public.dealer_records%rowtype;
  v_identity jsonb;
  v_condition jsonb;
  v_ownership text;
  v_ownership_reviewed boolean := false;
  v_format text;
  v_grader text;
  v_grade text;
  v_certificate text;
  v_grade_certainty text;
  v_blockers jsonb := '[]'::jsonb;
  v_evidence_count integer := 0;
  v_evidence public.dealer_records%rowtype;
  v_class text;
  v_source text;
  v_match text;
  v_confidence text;
  v_rationale text;
  v_observed text;
begin
  select * into v_candidate
  from public.dealer_records
  where owner_user_id = p_owner and entity_type = 'candidate' and id = p_candidate_id;
  if not found then
    return jsonb_build_object('ready',false,'blockers',jsonb_build_array('candidate_not_found'));
  end if;
  v_identity := case when jsonb_typeof(v_candidate.data->'identity') = 'object'
    then v_candidate.data->'identity' else v_candidate.data end;
  foreach v_source in array ARRAY['name','set','language','variant','number'] loop
    if nullif(btrim(coalesce(v_identity->>v_source,'')),'') is null
       or lower(btrim(coalesce(v_identity->>v_source,''))) in ('unknown','tbc','tbd') then
      v_blockers := v_blockers || jsonb_build_array('identity_' || v_source || '_required');
    end if;
  end loop;
  v_ownership := case when jsonb_typeof(v_candidate.data->'ownership') = 'object' then v_candidate.data->'ownership'->>'class' else v_candidate.data->>'ownership' end;
  v_ownership_reviewed := lower(coalesce(v_candidate.data->>'ownershipReviewed','')) = 'true'
    or lower(coalesce(v_candidate.data->>'ownership_reviewed','')) = 'true'
    or lower(coalesce(v_candidate.data->'ownership'->>'reviewed','')) = 'true';
  if v_ownership <> 'Business' or not v_ownership_reviewed then
    v_blockers := v_blockers || jsonb_build_array('business_ownership_review_required');
  end if;
  v_format := lower(btrim(coalesce(v_candidate.data->>'format',v_candidate.data->>'rawOrSlab',v_candidate.data->>'raw_or_slab','')));
  v_grader := nullif(btrim(coalesce(v_candidate.data->>'grader',v_candidate.data->'grading'->>'grader')),'');
  v_grade := nullif(btrim(coalesce(v_candidate.data->>'grade',v_candidate.data->'grading'->>'grade')),'');
  v_certificate := nullif(btrim(coalesce(
    v_candidate.data->>'certificateNumber',v_candidate.data->>'certificate_number',
    v_candidate.data->>'certificate',v_candidate.data->>'certNo',v_candidate.data->>'cert_no',
    v_candidate.data->'grading'->>'certificateNumber',v_candidate.data->'grading'->>'certNo'
  )), '');
  v_grade_certainty := lower(btrim(coalesce(
    v_candidate.data->>'gradeCertainty',v_candidate.data->>'grade_certainty',
    v_candidate.data->'grading'->>'gradeCertainty',v_candidate.data->'grading'->>'certainty',''
  )));
  if v_format in ('slab','graded') then
    if v_grader is null then v_blockers := v_blockers || jsonb_build_array('slab_grader_required'); end if;
    if v_grade is null then v_blockers := v_blockers || jsonb_build_array('slab_grade_required'); end if;
    if v_certificate is null then v_blockers := v_blockers || jsonb_build_array('slab_certificate_required'); end if;
  end if;
  if v_grade is not null and v_grade_certainty in ('unknown','uncertain','estimated','') then
    v_blockers := v_blockers || jsonb_build_array('grade_certainty_required');
  end if;
  v_condition := case when jsonb_typeof(v_candidate.data->'condition') = 'object'
    then v_candidate.data->'condition' else jsonb_build_object('value',v_candidate.data->>'condition','certainty',v_candidate.data->>'certainty') end;
  if nullif(btrim(coalesce(v_condition->>'value','')),'') is null
     or lower(btrim(coalesce(v_condition->>'value',''))) in ('unknown','tbc','tbd') then
    v_blockers := v_blockers || jsonb_build_array('condition_required');
  end if;
  if lower(coalesce(v_condition->>'certainty','')) in ('estimated','uncertain','unknown')
     and nullif(btrim(coalesce(v_condition->>'scenario',v_candidate.data->>'conditionScenario')),'') is null then
    v_blockers := v_blockers || jsonb_build_array('condition_scenario_required');
  end if;
  if lower(coalesce(v_candidate.data->>'hold','')) = 'true' then
    v_blockers := v_blockers || jsonb_build_array('candidate_on_hold');
  end if;

  select count(*) into v_evidence_count
  from public.dealer_records
  where owner_user_id = p_owner and entity_type = 'evidence' and candidate_id = p_candidate_id;
  if v_evidence_count = 0 then
    v_blockers := v_blockers || jsonb_build_array('evidence_required');
  else
    for v_evidence in
      select * from public.dealer_records
      where owner_user_id = p_owner and entity_type = 'evidence' and candidate_id = p_candidate_id
    loop
      v_class := lower(btrim(coalesce(v_evidence.data->>'class',v_evidence.data->>'kind',v_evidence.data->>'evidenceClass','')));
      v_source := btrim(coalesce(v_evidence.data->>'source',v_evidence.data->>'reference',v_evidence.data->>'url',''));
      v_match := btrim(coalesce(v_evidence.data->>'match',v_evidence.data->>'identityMatch',v_evidence.data->>'matchResult',''));
      v_confidence := btrim(coalesce(v_evidence.data->>'confidence',v_evidence.data->>'confidenceLevel',''));
      v_rationale := btrim(coalesce(v_evidence.data->>'rationale',v_evidence.data->>'note',v_evidence.data->>'notes',''));
      v_observed := coalesce(v_evidence.data->>'observedAt',v_evidence.data->>'observed_at',v_evidence.data->>'date');
      if v_class not in ('identity','purchase','receipt','listing','condition','market','photo','source') then
        v_blockers := v_blockers || jsonb_build_array('evidence_class_required');
      end if;
      if v_source = '' or v_match = '' or lower(v_match) = 'unknown' or v_confidence = ''
         or lower(v_confidence) = 'unknown' or v_rationale = '' or v_observed = '' then
        v_blockers := v_blockers || jsonb_build_array('evidence_detail_required');
      else
        begin perform v_observed::timestamptz; exception when others then v_blockers := v_blockers || jsonb_build_array('evidence_date_invalid'); end;
      end if;
    end loop;
  end if;
  return jsonb_build_object(
    'ready',jsonb_array_length(v_blockers)=0,
    'blockers',v_blockers,
    'identity',v_identity,
    'ownership','Business',
    'ownershipReviewed',v_ownership_reviewed,
    'format',coalesce(nullif(v_format,''),'raw'),
    'grader',v_grader,
    'grade',v_grade,
    'certificateNumber',v_certificate,
    'gradeCertainty',nullif(v_grade_certainty,''),
    'condition',v_condition,
    'evidenceCount',v_evidence_count
  );
end;
$function$;

create or replace function public.dealer_canonical_marker(p_data jsonb)
returns boolean
language sql
immutable
strict
set search_path = pg_catalog, public
as $function$
  select jsonb_typeof(p_data) = 'object'
    and exists (
      select 1 from jsonb_object_keys(p_data) as keys(key_name)
      where key_name like '_dealer%'
         or key_name in (
           'dealerOwnerId', 'dealerCopyId', 'dealerCandidateId', 'dealerCostBasis',
           'dealerOutcomeId', 'dealerPaymentStatus', 'dealerRelease'
         )
    );
$function$;

-- CAS calls this hook before every generic upsert, delete and restore. It also
-- rejects forged Dealer markers even when a link row has not yet been made.
create or replace function public.collectibles_dealer_blocks_generic(
  p_table text,
  p_id text,
  p_data jsonb default null
)
returns boolean
language plpgsql
security definer
stable
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  v_data jsonb;
begin
  if public.dealer_canonical_marker(p_data) then return true; end if;
  if p_table not in (
    'singles', 'slabs', 'etbs', 'booster_boxes', 'booster_packs', 'ebay_purchases', 'sales'
  ) then return false; end if;

  if p_table <> 'sales' and exists (
    select 1 from public.dealer_canonical_links
    where inventory_table = p_table and inventory_id = p_id
  ) then return true; end if;
  if p_table = 'sales' and exists (
    select 1 from public.dealer_canonical_links where sale_id = p_id
  ) then return true; end if;

  execute format('select data from public.%I where id = $1', p_table)
    into v_data using p_id;
  return public.dealer_canonical_marker(v_data);
end;
$function$;

create or replace function public.collectibles_dealer_pull_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  v_owner uuid;
  v_owner_text text;
  v_limit integer := 50;
  v_offset integer := 0;
  v_cursor text;
  v_candidate_id text;
  v_candidate public.dealer_records%rowtype;
  v_candidates jsonb := '[]'::jsonb;
  v_plans jsonb := '[]'::jsonb;
  v_evidence jsonb := '[]'::jsonb;
  v_copies jsonb := '[]'::jsonb;
  v_listings jsonb := '[]'::jsonb;
  v_outcomes jsonb := '[]'::jsonb;
  v_reviews jsonb := '[]'::jsonb;
  v_refs jsonb := '[]'::jsonb;
  v_selected jsonb := null;
  v_next_cursor text := null;
  v_count integer;
begin
  if p_request is null or jsonb_typeof(p_request) <> 'object' then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_request) as keys(key_name)
    where key_name not in ('owner_user_id', 'client_protocol', 'schema_version', 'limit', 'cursor', 'candidateId', 'candidate_id')
  ) then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  if not (p_request ? 'client_protocol') or p_request->>'client_protocol' <> '2' then
    return jsonb_build_object('ok', false, 'code', 'protocol_mismatch', 'server_protocol', 2);
  end if;
  if not (p_request ? 'schema_version') or p_request->>'schema_version' <> '1' then
    return jsonb_build_object('ok', false, 'code', 'schema_mismatch', 'server_schema_version', 1);
  end if;
  v_owner_text := p_request->>'owner_user_id';
  if v_owner_text is null then return jsonb_build_object('ok', false, 'code', 'owner_required'); end if;
  begin v_owner := v_owner_text::uuid; exception when invalid_text_representation then return jsonb_build_object('ok', false, 'code', 'owner_required'); end;
  if p_request ? 'limit' then
    if jsonb_typeof(p_request->'limit') <> 'number' or (p_request->>'limit') !~ '^[1-9][0-9]*$' then
      return jsonb_build_object('ok', false, 'code', 'invalid_limit');
    end if;
    v_limit := least((p_request->>'limit')::integer, 50);
  end if;
  if p_request ? 'cursor' and jsonb_typeof(p_request->'cursor') <> 'null' then
    if jsonb_typeof(p_request->'cursor') <> 'string' or (p_request->>'cursor') !~ '^[0-9]+$' then
      return jsonb_build_object('ok', false, 'code', 'invalid_cursor');
    end if;
    begin v_offset := (p_request->>'cursor')::integer; exception when numeric_value_out_of_range then return jsonb_build_object('ok', false, 'code', 'invalid_cursor'); end;
  end if;
  v_candidate_id := coalesce(p_request->>'candidateId', p_request->>'candidate_id');

  select coalesce(jsonb_agg(public.dealer_record_json(r) order by r.updated_at desc, r.id desc), '[]'::jsonb), count(*)
    into v_candidates, v_count
    from (
      select * from public.dealer_records r
      where r.owner_user_id = v_owner and r.entity_type = 'candidate'
      order by r.updated_at desc, r.id desc offset v_offset limit v_limit
    ) r;
  if v_offset + v_count < (
    select count(*) from public.dealer_records where owner_user_id = v_owner and entity_type = 'candidate'
  ) then v_next_cursor := (v_offset + v_count)::text; end if;

  if v_candidate_id is not null then
    select * into v_candidate
    from public.dealer_records
    where owner_user_id = v_owner and entity_type = 'candidate' and id = v_candidate_id;
    if found then
      select coalesce(jsonb_agg(public.dealer_record_json(r) order by r.updated_at desc, r.id desc), '[]'::jsonb) into v_plans from public.dealer_records r where r.owner_user_id=v_owner and r.entity_type='plan' and r.candidate_id=v_candidate_id;
      select coalesce(jsonb_agg(public.dealer_record_json(r) order by r.updated_at desc, r.id desc), '[]'::jsonb) into v_evidence from public.dealer_records r where r.owner_user_id=v_owner and r.entity_type='evidence' and r.candidate_id=v_candidate_id;
      select coalesce(jsonb_agg(public.dealer_record_json(r) order by r.updated_at desc, r.id desc), '[]'::jsonb) into v_copies from public.dealer_records r where r.owner_user_id=v_owner and r.entity_type='copy' and r.candidate_id=v_candidate_id;
      select coalesce(jsonb_agg(public.dealer_record_json(r) order by r.updated_at desc, r.id desc), '[]'::jsonb) into v_listings from public.dealer_records r where r.owner_user_id=v_owner and r.entity_type='listing' and r.candidate_id=v_candidate_id;
      select coalesce(jsonb_agg(public.dealer_record_json(r) order by r.updated_at desc, r.id desc), '[]'::jsonb) into v_outcomes from public.dealer_records r where r.owner_user_id=v_owner and r.entity_type='outcome' and r.candidate_id=v_candidate_id;
      select coalesce(jsonb_agg(public.dealer_record_json(r) order by r.updated_at desc, r.id desc), '[]'::jsonb) into v_reviews from public.dealer_records r where r.owner_user_id=v_owner and r.entity_type='review' and r.candidate_id=v_candidate_id;
      select coalesce(jsonb_agg(jsonb_build_object(
        'copyId', l.copy_id, 'inventoryTable', l.inventory_table, 'inventoryId', l.inventory_id,
        'canonicalRowVersion', l.canonical_row_version, 'saleId', l.sale_id, 'saleRowVersion', l.sale_row_version, 'row_version', l.row_version
      ) order by l.copy_id), '[]'::jsonb) into v_refs from public.dealer_canonical_links l where l.owner_user_id=v_owner and l.candidate_id=v_candidate_id;
      v_selected := jsonb_build_object(
        'candidate', public.dealer_record_json(v_candidate),
        'plans', v_plans, 'evidence', v_evidence, 'copy', v_copies,
        'listings', v_listings, 'outcomes', v_outcomes, 'reviews', v_reviews,
        'readiness', public.dealer_candidate_readiness(v_owner,v_candidate_id) || jsonb_build_object(
          'hasApprovedPlan', exists(select 1 from public.dealer_records r where r.owner_user_id=v_owner and r.entity_type='plan' and r.candidate_id=v_candidate_id and coalesce(r.data->>'status',r.state)='approved'),
          'hasCopy', jsonb_array_length(v_copies) > 0,
          'hasPreparedListing', exists(select 1 from public.dealer_records r where r.owner_user_id=v_owner and r.entity_type='listing' and r.candidate_id=v_candidate_id and coalesce(r.data->>'status',r.state)='prepared')
        )
      );
    end if;
  end if;

  return jsonb_build_object(
    'ok', true, 'client_protocol', 2, 'schema_version', 1,
    'candidates', v_candidates, 'nextCursor', v_next_cursor,
    'selected', v_selected, 'canonicalRefs', v_refs
  );
end;
$function$;

create or replace function public.collectibles_dealer_command_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  v_owner uuid;
  v_owner_text text;
  v_command_id uuid;
  v_command_id_text text;
  v_command text;
  v_payload jsonb;
  v_expected jsonb;
  v_fingerprint text;
  v_receipt public.dealer_command_receipts%rowtype;
  v_record public.dealer_records%rowtype;
  v_candidate public.dealer_records%rowtype;
  v_plan public.dealer_records%rowtype;
  v_copy public.dealer_records%rowtype;
  v_listing public.dealer_records%rowtype;
  v_outcome public.dealer_records%rowtype;
  v_id text;
  v_candidate_id text;
  v_plan_id text;
  v_copy_id text;
  v_listing_id text;
  v_outcome_id text;
  v_sale_id text;
  v_table text;
  v_inventory_id text;
  v_state text;
  v_data jsonb;
  v_patch jsonb;
  v_canonical jsonb;
  v_canonical_version bigint;
  v_inventory_version bigint;
  v_expected_candidate bigint;
  v_expected_plan bigint;
  v_expected_copy bigint;
  v_expected_listing bigint;
  v_expected_outcome bigint;
  v_expected_canonical bigint;
  v_expected_sale bigint;
  v_cost numeric;
  v_item_cost_sgd numeric;
  v_non_item_cost numeric := 0;
  v_cost_value jsonb;
  v_reviewed_cost jsonb;
  v_existing_cost numeric;
  v_ownership text;
  v_format text;
  v_grader text;
  v_grade text;
  v_certificate text;
  v_grade_certainty text;
  v_grade_scenario text;
  v_ceiling numeric;
  v_agreed numeric;
  v_original_amount numeric;
  v_fx_rate numeric;
  v_cost_currency text;
  v_cost_component jsonb;
  v_fx jsonb;
  v_proceeds numeric;
  v_selling_fee numeric;
  v_shipping numeric;
  v_posted_proceeds numeric;
  v_posted_selling_fee numeric;
  v_posted_shipping numeric;
  v_landed_cost numeric;
  v_contribution numeric;
  v_settled_at timestamptz;
  v_settlement_currency text;
  v_original_currency text;
  v_supersedes text;
  v_previous_plan_id text;
  v_revision jsonb;
  v_plan_input jsonb;
  v_plan_economics jsonb;
  v_planned_item jsonb;
  v_planned_landed jsonb;
  v_readiness jsonb;
  v_review_actual jsonb;
  v_plan_variance jsonb;
  v_target_variance jsonb;
  v_sale_data jsonb;
  v_identity jsonb;
  v_review_input jsonb;
  v_restock jsonb;
  v_manual_proof text;
  v_sale_time timestamptz;
  v_acquired_at timestamptz;
  v_days_held integer;
  v_revisions jsonb := '[]'::jsonb;
  v_result jsonb;
  v_response jsonb;
  v_now timestamptz := clock_timestamp();
  v_link public.dealer_canonical_links%rowtype;
  v_marker jsonb;
  v_evidence jsonb;
  v_existing_link boolean;
begin
  if p_request is null or jsonb_typeof(p_request) <> 'object' then return jsonb_build_object('ok', false, 'code', 'invalid_request'); end if;
  if exists (select 1 from jsonb_object_keys(p_request) as keys(key_name) where key_name not in ('owner_user_id','client_protocol','schema_version','command_id','command','expected','payload')) then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  if not (p_request ? 'client_protocol') or p_request->>'client_protocol' <> '2' then return jsonb_build_object('ok', false, 'code', 'protocol_mismatch', 'server_protocol', 2); end if;
  if not (p_request ? 'schema_version') or p_request->>'schema_version' <> '1' then return jsonb_build_object('ok', false, 'code', 'schema_mismatch', 'server_schema_version', 1); end if;
  v_owner_text := p_request->>'owner_user_id';
  if v_owner_text is null then return jsonb_build_object('ok', false, 'code', 'owner_required'); end if;
  begin v_owner := v_owner_text::uuid; exception when invalid_text_representation then return jsonb_build_object('ok', false, 'code', 'owner_required'); end;
  v_command := p_request->>'command';
  if v_command not in ('create_candidate','update_candidate','add_evidence','create_plan','approve_buy','acquire_copy','link_copy','set_asking','prepare_listing','record_sale','settle_sale','record_non_sale','review_outcome') then
    return jsonb_build_object('ok', false, 'code', 'invalid_command');
  end if;
  v_command_id_text := p_request->>'command_id';
  begin v_command_id := v_command_id_text::uuid; exception when invalid_text_representation then return jsonb_build_object('ok', false, 'code', 'invalid_command_id'); end;
  v_payload := coalesce(p_request->'payload', '{}'::jsonb);
  v_expected := coalesce(p_request->'expected', '{}'::jsonb);
  if jsonb_typeof(v_payload) <> 'object' or jsonb_typeof(v_expected) <> 'object' then return jsonb_build_object('ok', false, 'code', 'invalid_request'); end if;
  if exists (
    select 1 from jsonb_object_keys(v_expected) as keys(key_name)
    where key_name not in ('candidate','candidateVersion','plan','planVersion','copy','copyVersion','listing','listingVersion','outcome','outcomeVersion','canonical','canonicalRowVersion','sale','saleVersion')
  ) then return jsonb_build_object('ok', false, 'code', 'unknown_property'); end if;
  if exists (
    select 1
    from unnest(array['plan','identity','evidence','reviewedCost','reviewed_cost','settlement','settlementEvidence','settlement_evidence','sale','listing','itemRef','item_ref','canonical','row','patch','review','actual','posted','nonSale','non_sale','approval','restockDecision','restock_decision']) as nested(key_name)
    where v_payload ? nested.key_name
      and public.dealer_nested_protected(v_payload->nested.key_name)
  ) then return jsonb_build_object('ok', false, 'code', 'protected_property'); end if;
  if not public.dealer_payload_keys_valid(v_command, v_payload) then return jsonb_build_object('ok', false, 'code', 'unknown_property'); end if;
  if not public.dealer_command_payload_keys_valid(v_command, v_payload) then return jsonb_build_object('ok', false, 'code', 'unknown_property'); end if;
  if not public.dealer_nested_keys_valid(v_command, v_payload) then return jsonb_build_object('ok', false, 'code', 'unknown_property'); end if;
  v_expected_candidate := public.dealer_expected_version(v_expected, 'candidate');
  v_expected_plan := public.dealer_expected_version(v_expected, 'plan');
  v_expected_copy := public.dealer_expected_version(v_expected, 'copy');
  v_expected_listing := public.dealer_expected_version(v_expected, 'listing');
  v_expected_outcome := public.dealer_expected_version(v_expected, 'outcome');
  v_expected_canonical := public.dealer_expected_version(v_expected, 'canonical');
  v_expected_sale := public.dealer_expected_version(v_expected, 'sale');
  if least(v_expected_candidate,v_expected_plan,v_expected_copy,v_expected_listing,v_expected_outcome,v_expected_canonical,v_expected_sale) < 0 then return jsonb_build_object('ok', false, 'code', 'invalid_expected_version'); end if;

  v_fingerprint := md5(p_request::text);
  perform pg_advisory_xact_lock(2026090402::bigint);
  select * into v_receipt from public.dealer_command_receipts where command_id = v_command_id for update;
  if found then
    if v_receipt.owner_user_id <> v_owner
       or v_receipt.request_fingerprint <> v_fingerprint
       or v_receipt.request_json is distinct from p_request then
      return jsonb_build_object('ok', false, 'code', 'mutation_id_reused');
    end if;
    return v_receipt.response;
  end if;

  if v_command in ('create_candidate','update_candidate','add_evidence','create_plan','approve_buy','acquire_copy','link_copy','set_asking','prepare_listing','record_sale','settle_sale','record_non_sale','review_outcome') then
    v_candidate_id := coalesce(v_payload->>'candidateId', v_payload->>'candidate_id');
  end if;

  if v_command = 'create_candidate' then
    v_id := coalesce(v_payload->>'candidateId', v_payload->>'candidate_id', v_payload->>'id', v_command_id_text);
    if v_id is null or length(v_id) < 1 or length(v_id) > 256 then return jsonb_build_object('ok', false, 'code', 'invalid_candidate'); end if;
    if exists (select 1 from public.dealer_records where owner_user_id=v_owner and entity_type='candidate' and id=v_id) then return jsonb_build_object('ok', false, 'code', 'state_conflict'); end if;
    v_state := coalesce(v_payload->>'status','draft');
    if v_state not in ('Draft','Review','draft','review') then return jsonb_build_object('ok', false, 'code', 'invalid_transition'); end if;
    v_data := v_payload || jsonb_build_object('candidateId', v_id, 'status', v_state);
    insert into public.dealer_records(entity_type,id,owner_user_id,candidate_id,state,data) values ('candidate',v_id,v_owner,v_id,v_state,v_data) returning * into v_record;
    v_result := jsonb_build_object('candidate', public.dealer_record_json(v_record));
    v_revisions := v_revisions || jsonb_build_array(jsonb_build_object('entity_type','candidate','id',v_id,'row_version',v_record.row_version));

  elsif v_command = 'update_candidate' then
    if v_candidate_id is null then return jsonb_build_object('ok', false, 'code', 'candidate_required'); end if;
    select * into v_candidate from public.dealer_records where owner_user_id=v_owner and entity_type='candidate' and id=v_candidate_id for update;
    if not found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
    if v_expected_candidate = 0 or v_expected_candidate <> v_candidate.row_version then return jsonb_build_object('ok', false, 'code', 'version_conflict', 'current', public.dealer_record_json(v_candidate)); end if;
    v_patch := coalesce(v_payload->'patch', v_payload - 'candidateId' - 'candidate_id');
    if jsonb_typeof(v_patch) <> 'object' then return jsonb_build_object('ok', false, 'code', 'invalid_payload'); end if;
    if coalesce(v_candidate.data->>'status',v_candidate.state) in ('Buy approved','Acquired')
       and exists (
         select 1 from jsonb_object_keys(v_patch) as keys(key_name)
         where key_name not in ('notes','metadata','source','sourceRefs','source_refs','review')
       ) then
      return jsonb_build_object('ok', false, 'code', 'frozen_candidate');
    end if;
    if v_patch ? 'status' and v_patch->>'status' not in ('Draft','Review','draft','review') then
      return jsonb_build_object('ok', false, 'code', 'invalid_transition');
    end if;
    v_data := v_candidate.data || v_patch;
    update public.dealer_records set data=v_data, state=coalesce(v_data->>'status',v_candidate.state) where entity_type='candidate' and id=v_candidate_id and owner_user_id=v_owner returning * into v_record;
    v_result := jsonb_build_object('candidate', public.dealer_record_json(v_record));
    v_revisions := v_revisions || jsonb_build_array(jsonb_build_object('entity_type','candidate','id',v_candidate_id,'row_version',v_record.row_version));

  elsif v_command = 'add_evidence' then
    if v_candidate_id is null then return jsonb_build_object('ok', false, 'code', 'candidate_required'); end if;
    select * into v_candidate from public.dealer_records where owner_user_id=v_owner and entity_type='candidate' and id=v_candidate_id for update;
    if not found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
    if v_expected_candidate = 0 then return jsonb_build_object('ok', false, 'code', 'missing_expected_version'); end if;
    if v_expected_candidate <> v_candidate.row_version then return jsonb_build_object('ok', false, 'code', 'version_conflict', 'current', public.dealer_record_json(v_candidate)); end if;
    v_id := coalesce(v_payload->>'evidenceId', v_payload->>'evidence_id', v_command_id_text);
    v_data := coalesce(v_payload->'evidence', v_payload);
    if jsonb_typeof(v_data) <> 'object' then return jsonb_build_object('ok', false, 'code', 'invalid_evidence'); end if;
    if lower(btrim(coalesce(v_data->>'class',v_data->>'kind',v_data->>'evidenceClass',''))) not in ('identity','purchase','receipt','listing','condition','market','photo','source')
       or nullif(btrim(coalesce(v_data->>'source',v_data->>'reference',v_data->>'url','')),'') is null
       or nullif(btrim(coalesce(v_data->>'match',v_data->>'identityMatch',v_data->>'matchResult','')),'') is null
       or nullif(btrim(coalesce(v_data->>'confidence',v_data->>'confidenceLevel','')),'') is null
       or nullif(btrim(coalesce(v_data->>'rationale',v_data->>'note',v_data->>'notes','')),'') is null
       or nullif(btrim(coalesce(v_data->>'observedAt',v_data->>'observed_at',v_data->>'date','')),'') is null then
      return jsonb_build_object('ok', false, 'code', 'evidence_detail_required');
    end if;
    begin perform coalesce(v_data->>'observedAt',v_data->>'observed_at',v_data->>'date')::timestamptz; exception when others then return jsonb_build_object('ok', false, 'code', 'evidence_date_invalid'); end;
    insert into public.dealer_records(entity_type,id,owner_user_id,candidate_id,state,data) values ('evidence',v_id,v_owner,v_candidate_id,'recorded',v_data || jsonb_build_object('evidenceId',v_id)) returning * into v_record;
    v_result := jsonb_build_object('evidence', public.dealer_record_json(v_record));
    v_revisions := v_revisions || jsonb_build_array(jsonb_build_object('entity_type','evidence','id',v_id,'row_version',v_record.row_version));

  elsif v_command = 'create_plan' then
    if v_candidate_id is null then return jsonb_build_object('ok', false, 'code', 'candidate_required'); end if;
    select * into v_candidate from public.dealer_records where owner_user_id=v_owner and entity_type='candidate' and id=v_candidate_id for update;
    if not found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
    if v_expected_candidate = 0 then return jsonb_build_object('ok', false, 'code', 'missing_expected_version'); end if;
    if v_expected_candidate <> v_candidate.row_version then return jsonb_build_object('ok', false, 'code', 'version_conflict', 'current', public.dealer_record_json(v_candidate)); end if;
    v_id := coalesce(v_payload->>'planId', v_payload->>'plan_id', v_command_id_text);
    if exists (select 1 from public.dealer_records where owner_user_id=v_owner and entity_type='plan' and id=v_id) then return jsonb_build_object('ok', false, 'code', 'state_conflict'); end if;
    select r.id into v_previous_plan_id
    from public.dealer_records r
    where r.owner_user_id=v_owner and r.entity_type='plan' and r.candidate_id=v_candidate_id
      and coalesce(r.data->>'status',r.state)='approved'
    order by r.updated_at desc, r.id desc
    limit 1;
    if v_previous_plan_id is not null then
      if exists (select 1 from public.dealer_records where owner_user_id=v_owner and entity_type='copy' and candidate_id=v_candidate_id) then
        return jsonb_build_object('ok', false, 'code', 'plan_revision_blocked');
      end if;
      if not (v_payload ? 'revisionReason') and not (v_payload ? 'revision_reason')
         and not coalesce(v_payload->'plan' ? 'revisionReason',false)
         and not coalesce(v_payload->'plan' ? 'revision_reason',false) then
        return jsonb_build_object('ok', false, 'code', 'plan_revision_reason_required');
      end if;
      v_supersedes := coalesce(v_payload->>'supersedesPlanId',v_payload->>'supersedes_plan_id',v_payload->'supersedes'->>'planId',v_payload->'supersedes'->>'plan_id',v_plan.data->>'supersedesPlanId');
      if v_supersedes is null or v_supersedes <> v_previous_plan_id then
        return jsonb_build_object('ok', false, 'code', 'plan_revision_supersedes_required');
      end if;
    end if;
    v_plan_input := coalesce(v_payload->'plan','{}'::jsonb) || (v_payload - 'plan' - 'candidateId' - 'candidate_id' - 'planId' - 'plan_id' - 'revisionReason' - 'revision_reason' - 'supersedesPlanId' - 'supersedes_plan_id' - 'supersedes');
    begin
      v_plan_economics := public.dealer_plan_economics(v_plan_input);
    exception when others then
      return jsonb_build_object('ok', false, 'code', 'plan_invalid');
    end;
    begin
      if v_plan_input ? 'plannedItemCost' then
        v_planned_item := jsonb_build_object('status','Known','amount',public.dealer_parse_money(v_plan_input->'plannedItemCost'),'currency','SGD');
      elsif v_plan_input ? 'planned_item_cost' then
        v_planned_item := jsonb_build_object('status','Known','amount',public.dealer_parse_money(v_plan_input->'planned_item_cost'),'currency','SGD');
      elsif v_plan_input ? 'itemCost' then
        v_planned_item := jsonb_build_object('status','Known','amount',public.dealer_parse_money(v_plan_input->'itemCost'),'currency','SGD');
      else
        v_planned_item := jsonb_build_object('status','Unknown','amount',null,'currency','SGD');
      end if;
      if v_planned_item->>'amount' is not null and (v_planned_item->>'amount')::numeric < 0 then
        return jsonb_build_object('ok', false, 'code', 'invalid_money');
      end if;
      if v_plan_input ? 'plannedLandedCost' then
        v_planned_landed := jsonb_build_object('status','Known','amount',public.dealer_parse_money(v_plan_input->'plannedLandedCost'),'currency','SGD');
      elsif v_plan_input ? 'planned_landed_cost' then
        v_planned_landed := jsonb_build_object('status','Known','amount',public.dealer_parse_money(v_plan_input->'planned_landed_cost'),'currency','SGD');
      elsif v_planned_item->>'status' = 'Known' and v_plan_economics->>'knownNonItemAcquisitionCosts' is not null then
        v_planned_landed := jsonb_build_object('status','Known','amount',((v_planned_item->>'amount')::numeric + (v_plan_economics->>'knownNonItemAcquisitionCosts')::numeric),'currency','SGD');
      else
        v_planned_landed := jsonb_build_object('status','Unknown','amount',null,'currency','SGD');
      end if;
      if v_planned_landed->>'amount' is not null and (v_planned_landed->>'amount')::numeric < 0 then
        return jsonb_build_object('ok', false, 'code', 'invalid_money');
      end if;
    exception when others then
      return jsonb_build_object('ok', false, 'code', 'invalid_money');
    end;
    if v_plan_economics->>'expectedNetProceeds' is not null and v_planned_landed->>'amount' is not null then
      v_plan_economics := v_plan_economics || jsonb_build_object('plannedContribution',((v_plan_economics->>'expectedNetProceeds')::numeric - (v_planned_landed->>'amount')::numeric),'plannedContributionStatus','Known');
    else
      v_plan_economics := v_plan_economics || jsonb_build_object('plannedContribution',null,'plannedContributionStatus','Unknown');
    end if;
    v_data := v_plan_input || jsonb_build_object(
      'status','draft','planId',v_id,'expected',v_plan_economics,
      'plannedItemCost',v_planned_item,'plannedLandedCost',v_planned_landed,
      'candidateSnapshot',jsonb_build_object('identity',coalesce(v_candidate.data->'identity',jsonb_build_object('name',v_candidate.data->>'name','set',v_candidate.data->>'set','number',v_candidate.data->>'number','language',v_candidate.data->>'language','variant',v_candidate.data->>'variant')),'ownership',case when jsonb_typeof(v_candidate.data->'ownership') = 'object' then v_candidate.data->'ownership'->>'class' else v_candidate.data->>'ownership' end,'condition',v_candidate.data->'condition'),'snapshotAt',v_now)
      || case when v_previous_plan_id is not null then jsonb_build_object(
        'revisionReason',coalesce(v_payload->>'revisionReason',v_payload->>'revision_reason',v_payload->'plan'->>'revisionReason',v_payload->'plan'->>'revision_reason'),
        'supersedesPlanId',v_previous_plan_id
      ) else '{}'::jsonb end;
    insert into public.dealer_records(entity_type,id,owner_user_id,candidate_id,state,data) values ('plan',v_id,v_owner,v_candidate_id,'draft',v_data) returning * into v_record;
    v_result := jsonb_build_object('plan', public.dealer_record_json(v_record));
    v_revisions := v_revisions || jsonb_build_array(jsonb_build_object('entity_type','plan','id',v_id,'row_version',v_record.row_version));

  elsif v_command = 'approve_buy' then
    v_plan_id := coalesce(v_payload->>'planId', v_payload->>'plan_id');
    if v_plan_id is null then return jsonb_build_object('ok', false, 'code', 'plan_required'); end if;
    select * into v_plan from public.dealer_records where owner_user_id=v_owner and entity_type='plan' and id=v_plan_id for update;
    if not found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
    if v_expected_plan = 0 or v_expected_plan <> v_plan.row_version then return jsonb_build_object('ok', false, 'code', 'version_conflict', 'current', public.dealer_record_json(v_plan)); end if;
    if coalesce(v_plan.data->>'status',v_plan.state) = 'approved' then return jsonb_build_object('ok', false, 'code', 'state_conflict'); end if;
    v_candidate_id := v_plan.candidate_id;
    select * into v_candidate from public.dealer_records where owner_user_id=v_owner and entity_type='candidate' and id=v_candidate_id for update;
    if not found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
    if v_expected_candidate = 0 or v_expected_candidate <> v_candidate.row_version then return jsonb_build_object('ok', false, 'code', 'version_conflict', 'current', public.dealer_record_json(v_candidate)); end if;
    v_readiness := public.dealer_candidate_readiness(v_owner,v_candidate_id);
    if v_readiness->>'ready' <> 'true' then return jsonb_build_object('ok', false, 'code', 'buy_not_ready', 'current', jsonb_build_object('readiness',v_readiness)); end if;
    if coalesce(v_plan.data->'expected'->>'status','Unknown') <> 'Known'
       or v_plan.data->'expected'->>'itemPriceCeiling' is null
       or coalesce(v_plan.data->'plannedItemCost'->>'status','Unknown') <> 'Known'
       or coalesce(v_plan.data->'plannedLandedCost'->>'status','Unknown') <> 'Known' then
      return jsonb_build_object('ok', false, 'code', 'plan_not_ready', 'current', public.dealer_record_json(v_plan));
    end if;
    v_format := lower(btrim(coalesce(v_candidate.data->>'format',v_candidate.data->>'rawOrSlab',v_candidate.data->>'raw_or_slab','raw')));
    v_grade := nullif(btrim(coalesce(v_candidate.data->>'grade',v_candidate.data->'grading'->>'grade')),'');
    v_grade_certainty := lower(btrim(coalesce(
      v_candidate.data->>'gradeCertainty',v_candidate.data->>'grade_certainty',
      v_candidate.data->'grading'->>'gradeCertainty',v_candidate.data->'grading'->>'certainty',''
    )));
    v_grade_scenario := lower(btrim(coalesce(
      v_plan.data->>'expectedGrade',v_plan.data->>'expected_grade',
      v_plan.data->>'gradeScenario',v_plan.data->>'grade_scenario',
      v_plan.data->>'resaleGrade',v_plan.data->>'resale_grade',
      v_plan.data->>'conditionScenario',v_plan.data->>'scenario',''
    )));
    if v_grade_scenario ~ '(top|highest|psa[ _-]*10|gem[ _-]*mint|grade[ _-]*10)' then
      if v_format in ('raw','') or v_grade is null or v_grade_certainty not in ('known','verified') then
        v_readiness := v_readiness || jsonb_build_object(
          'ready',false,
          'blockers',coalesce(v_readiness->'blockers','[]'::jsonb) || jsonb_build_array('grade_basis_required')
        );
        return jsonb_build_object('ok', false, 'code', 'buy_not_ready', 'current', jsonb_build_object('readiness',v_readiness));
      end if;
      if not exists (
        select 1 from public.dealer_records e
        where e.owner_user_id=v_owner and e.entity_type='evidence' and e.candidate_id=v_candidate_id
          and lower(coalesce(e.data->>'class',e.data->>'kind',e.data->>'evidenceClass','')) in ('condition','photo','source','market')
          and lower(coalesce(e.data->>'confidence',e.data->>'confidenceLevel','')) in ('high','verified')
          and lower(coalesce(e.data->>'match',e.data->>'identityMatch',e.data->>'matchResult','')) in ('exact','confirmed','full')
      ) then
        v_readiness := v_readiness || jsonb_build_object(
          'ready',false,
          'blockers',coalesce(v_readiness->'blockers','[]'::jsonb) || jsonb_build_array('grade_evidence_required')
        );
        return jsonb_build_object('ok', false, 'code', 'buy_not_ready', 'current', jsonb_build_object('readiness',v_readiness));
      end if;
    end if;
    if coalesce(v_candidate.data->>'status',v_candidate.state) in ('Buy approved','Acquired') then
      v_supersedes := coalesce(v_payload->>'supersedesPlanId',v_payload->>'supersedes_plan_id',v_payload->'supersedes'->>'planId',v_payload->'supersedes'->>'plan_id',v_plan.data->>'supersedesPlanId');
      if v_supersedes is null or v_supersedes <> v_candidate.data->>'approvedPlanId' then
        return jsonb_build_object('ok', false, 'code', 'plan_revision_supersedes_required');
      end if;
      if coalesce(v_candidate.data->>'status',v_candidate.state) = 'Acquired'
         or exists (select 1 from public.dealer_records where owner_user_id=v_owner and entity_type='copy' and candidate_id=v_candidate_id) then
        return jsonb_build_object('ok', false, 'code', 'plan_revision_blocked');
      end if;
    end if;
    v_data := v_plan.data || jsonb_build_object(
      'status','approved', 'approvedAt', to_jsonb(v_now::text),
      'approvedBy', to_jsonb(v_owner_text), 'approvedPlanHash', md5(v_plan.data::text)
    );
    update public.dealer_records set data=v_data,state='approved' where owner_user_id=v_owner and entity_type='plan' and id=v_plan_id returning * into v_record;
    update public.dealer_records
      set data = v_candidate.data || jsonb_build_object('status','Buy approved','approvedPlanId',v_plan_id,'approvedAt',to_jsonb(v_now::text)), state='Buy approved'
      where owner_user_id=v_owner and entity_type='candidate' and id=v_candidate_id
      returning * into v_candidate;
    v_result := jsonb_build_object('candidate',public.dealer_record_json(v_candidate),'plan', public.dealer_record_json(v_record));
    v_revisions := v_revisions || jsonb_build_array(jsonb_build_object('entity_type','candidate','id',v_candidate_id,'row_version',v_candidate.row_version),jsonb_build_object('entity_type','plan','id',v_plan_id,'row_version',v_record.row_version));

  elsif v_command in ('acquire_copy','link_copy') then
    if v_candidate_id is null then return jsonb_build_object('ok', false, 'code', 'candidate_required'); end if;
    select * into v_candidate from public.dealer_records where owner_user_id=v_owner and entity_type='candidate' and id=v_candidate_id for update;
    if not found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
    if v_expected_candidate = 0 then return jsonb_build_object('ok', false, 'code', 'missing_expected_version'); end if;
    if v_expected_candidate <> v_candidate.row_version then return jsonb_build_object('ok', false, 'code', 'version_conflict', 'current', public.dealer_record_json(v_candidate)); end if;
    if coalesce(v_candidate.data->>'status',v_candidate.state) = 'Acquired'
       or exists (
         select 1 from public.dealer_records
         where owner_user_id=v_owner and entity_type='copy' and candidate_id=v_candidate_id
       ) then
      return jsonb_build_object('ok', false, 'code', 'state_conflict');
    end if;
    if coalesce(v_candidate.data->>'status',v_candidate.state) <> 'Buy approved' then
      return jsonb_build_object('ok', false, 'code', 'buy_approval_required');
    end if;
    if (case when jsonb_typeof(v_candidate.data->'ownership') = 'object' then v_candidate.data->'ownership'->>'class' else v_candidate.data->>'ownership' end) <> 'Business' then return jsonb_build_object('ok', false, 'code', 'business_ownership_required'); end if;
    if v_candidate.data->>'approvedPlanId' is null
       or not exists (
         select 1 from public.dealer_records
         where owner_user_id=v_owner and entity_type='plan' and candidate_id=v_candidate_id
           and id=v_candidate.data->>'approvedPlanId' and coalesce(data->>'status',state)='approved'
       ) then
      return jsonb_build_object('ok', false, 'code', 'plan_required');
    end if;
    v_copy_id := coalesce(v_payload->>'copyId',v_payload->>'copy_id',v_command_id_text);
    v_table := coalesce(v_payload->>'inventoryTable',v_payload->>'inventory_table',v_payload->>'table');
    v_inventory_id := coalesce(v_payload->>'inventoryId',v_payload->>'inventory_id');
    if v_table not in ('singles','slabs','etbs','booster_boxes','booster_packs','ebay_purchases') then return jsonb_build_object('ok', false, 'code', 'canonical_required'); end if;
    if v_command = 'link_copy' and v_inventory_id is null then return jsonb_build_object('ok', false, 'code', 'canonical_required'); end if;
    if v_command = 'acquire_copy' and v_inventory_id is null then v_inventory_id := 'dealer-' || v_copy_id; end if;
    if exists (select 1 from public.dealer_canonical_links where owner_user_id=v_owner and copy_id=v_copy_id) then return jsonb_build_object('ok', false, 'code', 'state_conflict'); end if;
    if exists (select 1 from public.dealer_canonical_links where owner_user_id=v_owner and inventory_table=v_table and inventory_id=v_inventory_id) then return jsonb_build_object('ok', false, 'code', 'canonical_already_linked'); end if;
    execute format('select jsonb_build_object(''id'',id,''data'',data,''row_version'',row_version) from public.%I where id=$1 for update',v_table) into v_canonical using v_inventory_id;
    if v_canonical is null and v_command = 'link_copy' then return jsonb_build_object('ok', false, 'code', 'canonical_not_found'); end if;
    if v_canonical is not null and v_command = 'acquire_copy' then return jsonb_build_object('ok', false, 'code', 'canonical_already_exists'); end if;
    if v_canonical is null then
      if v_expected_canonical <> 0 then return jsonb_build_object('ok', false, 'code', 'version_conflict'); end if;
      v_canonical_version := 0;
    else
      v_canonical_version := (v_canonical->>'row_version')::bigint;
      if v_expected_canonical = 0 then return jsonb_build_object('ok', false, 'code', 'missing_expected_version'); end if;
      if v_expected_canonical <> v_canonical_version then return jsonb_build_object('ok', false, 'code', 'version_conflict', 'current', v_canonical); end if;
      if coalesce(lower(v_canonical->'data'->>'status'),'available') = 'sold' then return jsonb_build_object('ok', false, 'code', 'already_sold'); end if;
      if (v_canonical->'data' ? 'qty') and (v_canonical->'data'->>'qty') !~ '^1$' then return jsonb_build_object('ok', false, 'code', 'single_physical_copy_required'); end if;
      if coalesce(v_canonical->'data'->>'ownerId',v_canonical->'data'->>'_dealerOwnerId',v_canonical->'data'->>'inventoryOwnerId') is not null and coalesce(v_canonical->'data'->>'ownerId',v_canonical->'data'->>'_dealerOwnerId',v_canonical->'data'->>'inventoryOwnerId') <> v_owner_text then return jsonb_build_object('ok', false, 'code', 'cross_owner'); end if;
      v_ownership := coalesce(v_canonical->'data'->>'ownership',v_canonical->'data'->>'ownershipClass',v_canonical->'data'->>'inventoryClass');
      if v_ownership is not null and v_ownership <> 'Business' then return jsonb_build_object('ok', false, 'code', 'business_ownership_required'); end if;
      if v_ownership is null
         and lower(coalesce(v_payload->>'ownershipReviewed',v_payload->>'ownership_reviewed','')) <> 'true' then
        return jsonb_build_object('ok', false, 'code', 'ownership_review_required');
      end if;
      v_identity := coalesce(v_candidate.data->'identity',v_candidate.data);
      if nullif(v_canonical->'data'->>'name','') is not null and v_canonical->'data'->>'name' is distinct from v_identity->>'name' then return jsonb_build_object('ok', false, 'code', 'identity_conflict'); end if;
      if nullif(v_canonical->'data'->>'set','') is not null and v_canonical->'data'->>'set' is distinct from v_identity->>'set' then return jsonb_build_object('ok', false, 'code', 'identity_conflict'); end if;
      if nullif(v_canonical->'data'->>'number','') is not null and v_canonical->'data'->>'number' is distinct from v_identity->>'number' then return jsonb_build_object('ok', false, 'code', 'identity_conflict'); end if;
      if nullif(v_canonical->'data'->>'language','') is not null and v_canonical->'data'->>'language' is distinct from v_identity->>'language' then return jsonb_build_object('ok', false, 'code', 'identity_conflict'); end if;
      v_format := lower(btrim(coalesce(v_candidate.data->>'format',v_candidate.data->>'rawOrSlab',v_candidate.data->>'raw_or_slab','')));
      v_grader := nullif(btrim(coalesce(v_candidate.data->>'grader',v_candidate.data->'grading'->>'grader')),'');
      v_grade := nullif(btrim(coalesce(v_candidate.data->>'grade',v_candidate.data->'grading'->>'grade')),'');
      v_certificate := nullif(btrim(coalesce(
        v_candidate.data->>'certificateNumber',v_candidate.data->>'certificate_number',
        v_candidate.data->>'certificate',v_candidate.data->>'certNo',v_candidate.data->>'cert_no',
        v_candidate.data->'grading'->>'certificateNumber',v_candidate.data->'grading'->>'certNo'
      )), '');
      if v_format in ('slab','graded') and v_table <> 'slabs' then
        return jsonb_build_object('ok', false, 'code', 'canonical_format_conflict');
      end if;
      if v_table = 'slabs' then
        if v_grader is null or v_grade is null or v_certificate is null then
          return jsonb_build_object('ok', false, 'code', 'slab_identity_required');
        end if;
        if coalesce(v_canonical->'data'->>'grader','') is distinct from v_grader
           or coalesce(v_canonical->'data'->>'grade','') is distinct from v_grade
           or coalesce(v_canonical->'data'->>'certNo',v_canonical->'data'->>'certificateNumber','') is distinct from v_certificate then
          return jsonb_build_object('ok', false, 'code', 'identity_conflict');
        end if;
      end if;
    end if;
    v_reviewed_cost := coalesce(v_payload->'reviewedCost',v_payload->'reviewed_cost');
    if v_reviewed_cost is null or jsonb_typeof(v_reviewed_cost) = 'null'
       or jsonb_typeof(v_reviewed_cost) <> 'object'
       or coalesce(v_reviewed_cost->>'confirmed','false') <> 'true' then
      return jsonb_build_object('ok', false, 'code', 'cost_review_required');
    end if;
    if nullif(btrim(coalesce(v_reviewed_cost->>'reason','')),'') is null then
      return jsonb_build_object('ok', false, 'code', 'cost_review_reason_required');
    end if;
    begin
      v_sale_time := coalesce(v_reviewed_cost->>'reviewedAt',v_reviewed_cost->>'date',v_now::text)::timestamptz;
    exception when others then return jsonb_build_object('ok', false, 'code', 'cost_review_date_required'); end;
    if v_sale_time > v_now then return jsonb_build_object('ok', false, 'code', 'cost_review_date_future'); end if;
    v_cost_currency := upper(coalesce(v_reviewed_cost->>'currency',v_reviewed_cost->>'originalCurrency',''));
    if v_cost_currency !~ '^[A-Z]{3}$' then return jsonb_build_object('ok', false, 'code', 'currency_required'); end if;
    begin
      v_original_amount := public.dealer_parse_money(coalesce(v_reviewed_cost->'itemCost',v_reviewed_cost->'item_cost'));
    exception when others then return jsonb_build_object('ok', false, 'code', 'invalid_money'); end;
    if v_original_amount is null or v_original_amount < 0 then return jsonb_build_object('ok', false, 'code', 'cost_price_required'); end if;
    v_fx := coalesce(
      v_reviewed_cost->'fx', v_reviewed_cost->'fxMetadata', v_reviewed_cost->'fx_metadata',
      v_payload->'fx', v_payload->'fxMetadata', v_payload->'fx_metadata'
    );
    if v_fx is null and coalesce(v_reviewed_cost->>'fxDirection',v_reviewed_cost->>'fx_direction',v_payload->>'fxDirection',v_payload->>'fx_direction') is not null then
      v_fx := jsonb_build_object(
        'base',split_part(upper(coalesce(v_reviewed_cost->>'fxDirection',v_reviewed_cost->>'fx_direction',v_payload->>'fxDirection',v_payload->>'fx_direction')),'_',1),
        'quote',split_part(upper(coalesce(v_reviewed_cost->>'fxDirection',v_reviewed_cost->>'fx_direction',v_payload->>'fxDirection',v_payload->>'fx_direction')),'_',2),
        'rate',coalesce(v_reviewed_cost->'fxRate',v_reviewed_cost->'fx_rate',v_payload->'fxRate',v_payload->'fx_rate'),
        'source',coalesce(v_reviewed_cost->>'fxSource',v_reviewed_cost->>'fx_source',v_payload->>'fxSource',v_payload->>'fx_source'),
        'observedAt',coalesce(v_reviewed_cost->>'fxAt',v_reviewed_cost->>'fx_at',v_reviewed_cost->>'sourceTime',v_reviewed_cost->>'source_time',v_payload->>'fxAt',v_payload->>'fx_at',v_payload->>'sourceTime',v_payload->>'source_time')
      );
    end if;
    if v_cost_currency = 'SGD' then
      v_cost_value := coalesce(v_reviewed_cost->'itemCost',v_reviewed_cost->'item_cost');
      if v_fx is not null then
        begin
          v_fx := public.dealer_normalise_fx(v_fx, v_cost_currency);
        exception when others then return jsonb_build_object('ok', false, 'code', 'fx_metadata_invalid'); end;
      end if;
    else
      begin
        v_fx := public.dealer_normalise_fx(v_fx, v_cost_currency);
      exception when others then return jsonb_build_object('ok', false, 'code', 'fx_metadata_required'); end;
      if v_fx is null then return jsonb_build_object('ok', false, 'code', 'fx_metadata_required'); end if;
      if (v_reviewed_cost ? 'settledCurrency') and upper(coalesce(v_reviewed_cost->>'settledCurrency','')) <> 'SGD' then
        return jsonb_build_object('ok', false, 'code', 'settled_currency_invalid');
      end if;
      if (v_reviewed_cost ? 'settled_currency') and upper(coalesce(v_reviewed_cost->>'settled_currency','')) <> 'SGD' then
        return jsonb_build_object('ok', false, 'code', 'settled_currency_invalid');
      end if;
      if not ((v_reviewed_cost ? 'settledItemCost') or (v_reviewed_cost ? 'settled_item_cost')) then
        return jsonb_build_object('ok', false, 'code', 'settled_cost_required');
      end if;
      if not ((v_reviewed_cost ? 'settledAmount') or (v_reviewed_cost ? 'settled_amount'))
         or not ((v_reviewed_cost ? 'settledNonItemAcquisitionCosts') or (v_reviewed_cost ? 'settled_non_item_acquisition_costs')) then
        return jsonb_build_object('ok', false, 'code', 'settled_non_item_cost_required');
      end if;
      if (v_reviewed_cost ? 'settledItemCost') or (v_reviewed_cost ? 'settled_item_cost') then
        v_cost_value := coalesce(v_reviewed_cost->'settledItemCost',v_reviewed_cost->'settled_item_cost');
      end if;
    end if;
    begin
      v_cost := public.dealer_parse_money(v_cost_value);
    exception when others then return jsonb_build_object('ok', false, 'code', 'invalid_money'); end;
    if v_cost is null then return jsonb_build_object('ok', false, 'code', 'cost_price_required'); end if;
    if v_cost < 0 then return jsonb_build_object('ok', false, 'code', 'invalid_money'); end if;
    if v_cost_currency <> 'SGD' then
      begin
        if round(public.dealer_fx_to_sgd(v_original_amount,v_cost_currency,v_fx),2) is distinct from v_cost then
          return jsonb_build_object('ok', false, 'code', 'settled_cost_conflict');
        end if;
      exception when others then return jsonb_build_object('ok', false, 'code', 'fx_conversion_invalid'); end;
    end if;
    begin
      if not ((v_reviewed_cost ? 'nonItemAcquisitionCosts') or (v_reviewed_cost ? 'non_item_acquisition_costs') or (v_reviewed_cost ? 'settledNonItemAcquisitionCosts') or (v_reviewed_cost ? 'settled_non_item_acquisition_costs')) then
        return jsonb_build_object('ok', false, 'code', 'non_item_cost_required');
      elsif v_cost_currency = 'SGD' then
        v_non_item_cost := coalesce(public.dealer_parse_money(coalesce(v_reviewed_cost->'nonItemAcquisitionCosts',v_reviewed_cost->'non_item_acquisition_costs')),0);
      elsif (v_reviewed_cost ? 'settledNonItemAcquisitionCosts') or (v_reviewed_cost ? 'settled_non_item_acquisition_costs') then
        v_non_item_cost := coalesce(public.dealer_parse_money(coalesce(v_reviewed_cost->'settledNonItemAcquisitionCosts',v_reviewed_cost->'settled_non_item_acquisition_costs')),0);
      else
        return jsonb_build_object('ok', false, 'code', 'settled_non_item_cost_required');
      end if;
    exception when others then return jsonb_build_object('ok', false, 'code', 'invalid_money'); end;
    if v_non_item_cost < 0 then return jsonb_build_object('ok', false, 'code', 'invalid_money'); end if;
    v_item_cost_sgd := v_cost;
    v_cost := v_item_cost_sgd + v_non_item_cost;
    if v_cost_currency <> 'SGD' then
      begin
        if round(public.dealer_parse_money(coalesce(v_reviewed_cost->'settledAmount',v_reviewed_cost->'settled_amount')),2) is distinct from v_cost then
          return jsonb_build_object('ok', false, 'code', 'settled_total_conflict');
        end if;
      exception when others then return jsonb_build_object('ok', false, 'code', 'invalid_money'); end;
    end if;
    v_cost_component := v_reviewed_cost || jsonb_build_object(
      'originalAmount', v_original_amount,
      'originalCurrency', v_cost_currency,
      'itemCost', v_item_cost_sgd,
      'nonItemAcquisitionCosts', v_non_item_cost,
      'settledAmount', v_cost,
      'settledCurrency', 'SGD'
    );
    if v_fx is not null then
      v_cost_component := v_cost_component || jsonb_build_object('fx', v_fx);
      if coalesce(v_reviewed_cost->>'fxDirection',v_reviewed_cost->>'fx_direction',v_payload->>'fxDirection',v_payload->>'fx_direction') is not null then
        v_cost_component := v_cost_component || jsonb_build_object(
          'fxDirection',coalesce(v_reviewed_cost->>'fxDirection',v_reviewed_cost->>'fx_direction',v_payload->>'fxDirection',v_payload->>'fx_direction'),
          'fxRate',coalesce(v_reviewed_cost->>'fxRate',v_reviewed_cost->>'fx_rate',v_payload->>'fxRate',v_payload->>'fx_rate'),
          'fxSource',coalesce(v_reviewed_cost->>'fxSource',v_reviewed_cost->>'fx_source',v_payload->>'fxSource',v_payload->>'fx_source'),
          'fxAt',coalesce(v_reviewed_cost->>'fxAt',v_reviewed_cost->>'fx_at',v_reviewed_cost->>'sourceTime',v_reviewed_cost->>'source_time',v_payload->>'fxAt',v_payload->>'fx_at',v_payload->>'sourceTime',v_payload->>'source_time')
        );
      end if;
    end if;
    if v_canonical is not null then
      begin
        if v_canonical->'data' ? 'costPrice' then
          v_existing_cost := public.dealer_parse_money(v_canonical->'data'->'costPrice');
          if v_existing_cost is distinct from v_item_cost_sgd then return jsonb_build_object('ok', false, 'code', 'cost_basis_conflict'); end if;
          if v_canonical->'data' ? 'nonItemAcquisitionCosts' then
            v_existing_cost := public.dealer_parse_money(v_canonical->'data'->'nonItemAcquisitionCosts');
            if v_existing_cost is distinct from v_non_item_cost then return jsonb_build_object('ok', false, 'code', 'non_item_cost_conflict'); end if;
          end if;
        elsif v_canonical->'data' ? 'dealerCostBasis' then
          v_existing_cost := public.dealer_parse_money(coalesce(v_canonical->'data'->'dealerCostBasis'->'settledAmount',v_canonical->'data'->'dealerCostBasis'->'amount',v_canonical->'data'->'dealerCostBasis'->'itemCost',v_canonical->'data'->'dealerCostBasis'));
          if v_existing_cost is distinct from v_cost then return jsonb_build_object('ok', false, 'code', 'cost_basis_conflict'); end if;
        else
          return jsonb_build_object('ok', false, 'code', 'canonical_cost_required');
        end if;
      exception when others then return jsonb_build_object('ok', false, 'code', 'cost_basis_conflict'); end;
    end if;
    v_marker := jsonb_build_object('_dealerOwnerId',v_owner_text,'_dealerCopyId',v_copy_id,'_dealerCandidateId',v_candidate_id,'dealerCostBasis',v_cost_component);
    if v_canonical is null then
      v_identity := coalesce(v_candidate.data->'identity',jsonb_build_object('name',v_candidate.data->>'name','set',v_candidate.data->>'set','number',v_candidate.data->>'number','language',v_candidate.data->>'language','variant',v_candidate.data->>'variant'));
      v_data := jsonb_build_object(
        'name',v_identity->>'name','set',v_identity->>'set','number',v_identity->>'number','language',v_identity->>'language','variant',v_identity->>'variant',
        'ownership','Business','status','Available','qty',1,'dateAcquired',v_now,'costPrice',v_item_cost_sgd,'condition',v_candidate.data->'condition','grading',v_candidate.data->'grading'
      ) || case when v_table = 'slabs' then jsonb_build_object(
        'grader',coalesce(v_candidate.data->'grading'->>'grader',v_candidate.data->>'grader'),
        'grade',coalesce(v_candidate.data->'grading'->>'grade',v_candidate.data->>'grade'),
        'certNo',coalesce(
          v_candidate.data->'grading'->>'certNo',
          v_candidate.data->'grading'->>'certificateNumber',
          v_candidate.data->'grading'->>'certificationNumber',
          v_candidate.data->>'certNo',
          v_candidate.data->>'certificateNumber',
          v_candidate.data->>'certificate_number',
          v_candidate.data->>'certificationNumber'
        )
      ) else '{}'::jsonb end || v_marker;
      execute format('insert into public.%I(id,data,row_version,updated_at) values ($1,$2,1,$3) returning row_version',v_table) into v_canonical_version using v_inventory_id,v_data,v_now;
      v_canonical := jsonb_build_object('id',v_inventory_id,'data',v_data,'row_version',v_canonical_version);
    else
      v_data := (v_canonical->'data') || v_marker;
      execute format('update public.%I set data=$2 where id=$1 returning row_version',v_table) into v_canonical_version using v_inventory_id,v_data;
    end if;
    v_data := v_payload || jsonb_build_object('copyId',v_copy_id,'itemRef',jsonb_build_object('table',v_table,'id',v_inventory_id),'costComponent',v_cost_component,'acquisitionType',case when v_command='acquire_copy' then 'acquired' else 'linked' end,'canonicalRowVersion',v_canonical_version,'candidateId',v_candidate_id,'approvedPlanId',v_candidate.data->>'approvedPlanId');
    insert into public.dealer_records(entity_type,id,owner_user_id,candidate_id,state,data) values ('copy',v_copy_id,v_owner,v_candidate_id,case when v_command='acquire_copy' then 'acquired' else 'linked' end,v_data) returning * into v_record;
    insert into public.dealer_canonical_links(owner_user_id,copy_id,candidate_id,inventory_table,inventory_id,canonical_row_version) values (v_owner,v_copy_id,v_candidate_id,v_table,v_inventory_id,v_canonical_version) returning * into v_link;
    update public.dealer_records set data=v_candidate.data || jsonb_build_object('status','Acquired','copyId',v_copy_id,'acquiredAt',to_jsonb(v_now::text)),state='Acquired' where owner_user_id=v_owner and entity_type='candidate' and id=v_candidate_id returning * into v_candidate;
    update public.dealer_canonical_links set canonical_row_version=v_canonical_version where owner_user_id=v_owner and copy_id=v_copy_id returning * into v_link;
    v_result := jsonb_build_object('candidate',public.dealer_record_json(v_candidate),'copy',public.dealer_record_json(v_record),'canonicalRef',jsonb_build_object('table',v_table,'id',v_inventory_id,'row_version',v_canonical_version));
    v_revisions := v_revisions || jsonb_build_array(jsonb_build_object('entity_type','candidate','id',v_candidate_id,'row_version',v_candidate.row_version),jsonb_build_object('entity_type','copy','id',v_copy_id,'row_version',v_record.row_version),jsonb_build_object('table',v_table,'id',v_inventory_id,'row_version',v_canonical_version));

  elsif v_command in ('set_asking','prepare_listing') then
    v_copy_id := coalesce(v_payload->>'copyId',v_payload->>'copy_id');
    if v_copy_id is null then return jsonb_build_object('ok', false, 'code', 'copy_required'); end if;
    select * into v_copy from public.dealer_records where owner_user_id=v_owner and entity_type='copy' and id=v_copy_id for update;
    if not found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
    if v_expected_copy = 0 then return jsonb_build_object('ok', false, 'code', 'missing_expected_version'); end if;
    if v_expected_copy <> v_copy.row_version then return jsonb_build_object('ok', false, 'code', 'version_conflict', 'current', public.dealer_record_json(v_copy)); end if;
    v_candidate_id := v_copy.candidate_id;
    select * into v_candidate from public.dealer_records where owner_user_id=v_owner and entity_type='candidate' and id=v_candidate_id for update;
    if not found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
    if v_command = 'prepare_listing' and (v_expected_candidate = 0 or v_expected_candidate <> v_candidate.row_version) then return jsonb_build_object('ok', false, 'code', case when v_expected_candidate = 0 then 'missing_expected_version' else 'version_conflict' end, 'current', public.dealer_record_json(v_candidate)); end if;
    if coalesce(v_candidate.data->>'status',v_candidate.state) <> 'Acquired' then return jsonb_build_object('ok', false, 'code', 'acquired_copy_required'); end if;
    v_listing_id := coalesce(v_payload->>'listingId',v_payload->>'listing_id',v_command_id_text);
    select * into v_listing from public.dealer_records where owner_user_id=v_owner and entity_type='listing' and id=v_listing_id for update;
    v_data := coalesce(v_listing.data,'{}'::jsonb) || v_payload || jsonb_build_object('listingId',v_listing_id,'copyId',v_copy_id,'status',case when v_command='prepare_listing' then 'prepared' else 'asking_set' end);
    if found then
      if v_expected_listing = 0 or v_expected_listing <> v_listing.row_version then return jsonb_build_object('ok', false, 'code', 'version_conflict', 'current', public.dealer_record_json(v_listing)); end if;
      update public.dealer_records set data=v_data,state=case when v_command='prepare_listing' then 'prepared' else 'asking_set' end where owner_user_id=v_owner and entity_type='listing' and id=v_listing_id returning * into v_record;
    else
      if v_expected_listing > 0 then return jsonb_build_object('ok', false, 'code', 'version_conflict'); end if;
      insert into public.dealer_records(entity_type,id,owner_user_id,candidate_id,state,data) values ('listing',v_listing_id,v_owner,v_candidate_id,case when v_command='prepare_listing' then 'prepared' else 'asking_set' end,v_data) returning * into v_record;
    end if;
    v_result := jsonb_build_object('listing',public.dealer_record_json(v_record));
    v_revisions := v_revisions || jsonb_build_array(jsonb_build_object('entity_type','listing','id',v_listing_id,'row_version',v_record.row_version));

  elsif v_command = 'record_sale' then
    v_copy_id := coalesce(v_payload->>'copyId',v_payload->>'copy_id');
    if v_copy_id is null then return jsonb_build_object('ok', false, 'code', 'copy_required'); end if;
    select * into v_copy from public.dealer_records where owner_user_id=v_owner and entity_type='copy' and id=v_copy_id for update;
    if not found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
    v_candidate_id := v_copy.candidate_id;
    select * into v_candidate from public.dealer_records where owner_user_id=v_owner and entity_type='candidate' and id=v_candidate_id for update;
    if not found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
    if v_expected_candidate = 0 then return jsonb_build_object('ok', false, 'code', 'missing_expected_version'); end if;
    if v_expected_candidate <> v_candidate.row_version then return jsonb_build_object('ok', false, 'code', 'version_conflict', 'current', public.dealer_record_json(v_candidate)); end if;
    if coalesce(v_candidate.data->>'status',v_candidate.state) <> 'Acquired' then return jsonb_build_object('ok', false, 'code', 'acquired_copy_required'); end if;
    select * into v_link from public.dealer_canonical_links where owner_user_id=v_owner and copy_id=v_copy_id for update;
    if not found then return jsonb_build_object('ok', false, 'code', 'canonical_required'); end if;
    if v_link.sale_id is not null then return jsonb_build_object('ok', false, 'code', 'sale_already_recorded'); end if;
    v_table := v_link.inventory_table;
    v_inventory_id := v_link.inventory_id;
    execute format('select jsonb_build_object(''id'',id,''data'',data,''row_version'',row_version) from public.%I where id=$1 for update',v_table) into v_canonical using v_inventory_id;
    if v_canonical is null then return jsonb_build_object('ok', false, 'code', 'canonical_not_found'); end if;
    -- A new sale mutates the linked inventory row. The sale version does not
    -- exist until this command completes, so this boundary always uses the
    -- inventory reference explicitly.
    if v_expected_canonical = 0 then return jsonb_build_object('ok', false, 'code', 'missing_expected_version'); end if;
    if v_expected_canonical <> (v_canonical->>'row_version')::bigint then return jsonb_build_object('ok', false, 'code', 'version_conflict', 'current', v_canonical); end if;
    if coalesce(lower(v_canonical->'data'->>'status'),'available') = 'sold' then return jsonb_build_object('ok', false, 'code', 'already_sold'); end if;
    if (v_canonical->'data' ? 'qty') and (v_canonical->'data'->>'qty') !~ '^1$' then return jsonb_build_object('ok', false, 'code', 'single_physical_copy_required'); end if;
    v_sale_id := coalesce(v_payload->>'saleId',v_payload->>'sale_id',v_payload->>'outcomeId',v_payload->>'outcome_id',v_command_id_text);
    v_outcome_id := coalesce(v_payload->>'outcomeId',v_payload->>'outcome_id',v_sale_id);
    if exists (select 1 from public.dealer_records where owner_user_id=v_owner and entity_type='outcome' and id=v_outcome_id) then return jsonb_build_object('ok', false, 'code', 'state_conflict'); end if;
    if exists (select 1 from public.sales where id=v_sale_id) then return jsonb_build_object('ok', false, 'code', 'sale_id_conflict'); end if;
    begin
      v_cost := public.dealer_parse_money(coalesce(v_copy.data->'costComponent'->'settledAmount',v_copy.data->'costComponent'->'amount',v_copy.data->'costComponent'->'itemCost',v_copy.data->'costComponent'));
      v_agreed := public.dealer_parse_money(coalesce(
        v_payload->'agreedAmount',v_payload->'agreed_amount',v_payload->'amount',
        v_payload->'sale'->'agreedAmount',v_payload->'sale'->'agreed_amount',v_payload->'sale'->'amount'
      ));
    exception when others then return jsonb_build_object('ok', false, 'code', 'invalid_money'); end;
    if v_agreed is null then return jsonb_build_object('ok', false, 'code', 'sale_amount_required'); end if;
    if v_cost < 0 or v_agreed < 0 then return jsonb_build_object('ok', false, 'code', 'invalid_money'); end if;
    v_original_currency := upper(coalesce(v_payload->>'currency',v_payload->'sale'->>'currency','SGD'));
    if v_original_currency !~ '^[A-Z]{3}$' then return jsonb_build_object('ok', false, 'code', 'currency_invalid'); end if;
    begin
      v_sale_time := coalesce(v_payload->>'soldAt',v_payload->>'sold_at',v_payload->'sale'->>'soldAt',v_payload->'sale'->>'sold_at',v_now::text)::timestamptz;
    exception when others then return jsonb_build_object('ok', false, 'code', 'sale_date_invalid'); end;
    if v_sale_time > v_now then return jsonb_build_object('ok', false, 'code', 'sale_date_future'); end if;
    v_acquired_at := null;
    begin
      v_acquired_at := coalesce(v_canonical->'data'->>'dateAcquired',v_canonical->'data'->>'datePurchased',v_canonical->'data'->>'date')::timestamptz;
    exception when others then
      v_acquired_at := null;
    end;
    if v_acquired_at is not null and v_sale_time < v_acquired_at then
      return jsonb_build_object('ok', false, 'code', 'sale_before_acquisition');
    end if;
    v_days_held := case
      when v_acquired_at is null then null
      else floor(extract(epoch from (v_sale_time - v_acquired_at)) / 86400)::integer
    end;
    v_marker := (v_canonical->'data') || jsonb_build_object('status','Sold','qty',1,'_dealerOutcomeId',v_outcome_id);
    execute format('update public.%I set data=$2 where id=$1 returning row_version',v_table) into v_canonical_version using v_inventory_id,v_marker;
    v_inventory_version := v_canonical_version;
    v_data := v_payload || jsonb_build_object('outcomeId',v_outcome_id,'saleId',v_sale_id,'copyId',v_copy_id,'candidateId',v_candidate_id,'paymentStatus','Unknown','agreedAmount',coalesce(to_jsonb(v_agreed),'null'::jsonb),'currency',v_original_currency,'dealerCostBasis',v_copy.data->'costComponent','dealerActual',null,'contribution','Unknown','soldAt',v_sale_time);
    insert into public.dealer_records(entity_type,id,owner_user_id,candidate_id,state,data) values ('outcome',v_outcome_id,v_owner,v_candidate_id,'sale_recorded',v_data) returning * into v_record;
    v_identity := coalesce(v_candidate.data->'identity',v_candidate.data);
    v_sale_data := (v_canonical->'data') || jsonb_build_object(
      'status','Sold','qty',1,'dateSold',v_sale_time,'soldAt',v_sale_time,
      'product',coalesce(v_canonical->'data'->>'name',v_identity->>'name'),'buyer',coalesce(v_payload->>'buyer',v_payload->'sale'->>'buyer'),
      'inventoryId',v_inventory_id,'inventoryTable',v_table,'copyId',v_copy_id,
      'candidateId',v_candidate_id,'totalCollected',coalesce(to_jsonb(v_agreed),'null'::jsonb),
      'agreedAmount',coalesce(to_jsonb(v_agreed),'null'::jsonb),'currency',v_original_currency,
      'paymentStatus','Unknown','dealerPaymentStatus','Unknown','cashSettledAt',null,
      'costPrice',v_cost,'shippingCost',null,'fees',null,'sellingFee',null,'outboundShipping',null,
      'channel',coalesce(v_payload->>'channel',v_payload->'sale'->>'channel','Manual'),'dateAcquired',coalesce(v_canonical->'data'->'dateAcquired',v_canonical->'data'->'datePurchased'),
      'daysHeld',v_days_held,'dealerCostBasis',v_copy.data->'costComponent',
      'profit',null,'margin',null,'_dealerOwnerId',v_owner_text,'_dealerCopyId',v_copy_id,
      '_dealerCandidateId',v_candidate_id,'_dealerOutcomeId',v_outcome_id,'dealerSaleId',v_sale_id
    );
    execute 'insert into public.sales(id,data,row_version,updated_at) values ($1,$2,1,$3) returning row_version' into v_canonical_version using v_sale_id,v_sale_data,v_now;
    update public.dealer_records set data=v_candidate.data || jsonb_build_object('status','Acquired','lastOutcomeId',v_outcome_id),state='Acquired' where owner_user_id=v_owner and entity_type='candidate' and id=v_candidate_id returning * into v_candidate;
    update public.dealer_canonical_links set sale_id=v_sale_id,sale_row_version=v_canonical_version,canonical_row_version=v_inventory_version where owner_user_id=v_owner and copy_id=v_copy_id returning * into v_link;
    v_result := jsonb_build_object('candidate',public.dealer_record_json(v_candidate),'outcome',public.dealer_record_json(v_record),'sale',jsonb_build_object('id',v_sale_id,'row_version',v_canonical_version,'paymentStatus','Unknown'),'canonicalRef',jsonb_build_object('table',v_table,'id',v_inventory_id,'row_version',v_inventory_version),'saleRowVersion',v_canonical_version);
    v_revisions := v_revisions || jsonb_build_array(jsonb_build_object('entity_type','candidate','id',v_candidate_id,'row_version',v_candidate.row_version),jsonb_build_object('entity_type','outcome','id',v_outcome_id,'row_version',v_record.row_version),jsonb_build_object('table',v_table,'id',v_inventory_id,'row_version',v_inventory_version),jsonb_build_object('table','sales','id',v_sale_id,'row_version',1));

  elsif v_command = 'settle_sale' then
    v_outcome_id := coalesce(v_payload->>'outcomeId',v_payload->>'outcome_id',v_payload->>'saleId',v_payload->>'sale_id');
    if v_outcome_id is null then return jsonb_build_object('ok', false, 'code', 'outcome_required'); end if;
    select * into v_outcome from public.dealer_records where owner_user_id=v_owner and entity_type='outcome' and id=v_outcome_id for update;
    if not found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
    if v_expected_outcome = 0 or v_expected_outcome <> v_outcome.row_version then return jsonb_build_object('ok', false, 'code', 'version_conflict', 'current', public.dealer_record_json(v_outcome)); end if;
    if v_outcome.data->>'paymentStatus' = 'Settled' then return jsonb_build_object('ok', false, 'code', 'state_conflict'); end if;
    v_sale_id := v_outcome.data->>'saleId';
    select * into v_link from public.dealer_canonical_links where owner_user_id=v_owner and sale_id=v_sale_id for update;
    if not found then return jsonb_build_object('ok', false, 'code', 'canonical_required'); end if;
    execute 'select jsonb_build_object(''id'',id,''data'',data,''row_version'',row_version) from public.sales where id=$1 for update' into v_canonical using v_sale_id;
    if v_canonical is null then return jsonb_build_object('ok', false, 'code', 'canonical_not_found'); end if;
    -- Settlement mutates the canonical sales row. Require its separate
    -- version so an inventory-row version cannot accidentally authorise a
    -- stale payment update.
    if v_expected_sale = 0 then return jsonb_build_object('ok', false, 'code', 'missing_expected_version'); end if;
    if v_expected_sale <> (v_canonical->>'row_version')::bigint then return jsonb_build_object('ok', false, 'code', 'version_conflict', 'current', v_canonical); end if;
    v_evidence := coalesce(v_payload->'settlementEvidence',v_payload->'settlement_evidence',v_payload->'settlement');
    if jsonb_typeof(v_evidence) <> 'object'
       or nullif(btrim(coalesce(v_evidence->>'proof',v_evidence->>'source',v_evidence->>'reference',v_evidence->>'url',v_evidence->>'note','')),'') is null then return jsonb_build_object('ok', false, 'code', 'settlement_proof_required'); end if;
    if nullif(btrim(coalesce(v_evidence->>'date',v_evidence->>'at',v_evidence->>'observedAt',v_evidence->>'observed_at','')),'') is null then
      return jsonb_build_object('ok', false, 'code', 'settlement_proof_required');
    end if;
    begin
      v_settled_at := coalesce(v_payload->>'cashSettledAt',v_payload->>'cash_settled_at',v_payload->>'settledAt',v_payload->>'settled_at')::timestamptz;
    exception when others then return jsonb_build_object('ok', false, 'code', 'settlement_date_required'); end;
    if v_settled_at is null then return jsonb_build_object('ok', false, 'code', 'settlement_date_required'); end if;
    if v_settled_at > v_now then return jsonb_build_object('ok', false, 'code', 'settlement_date_future'); end if;
    v_original_currency := upper(coalesce(v_outcome.data->>'currency','SGD'));
    v_settlement_currency := upper(coalesce(v_payload->>'settlementCurrency',v_payload->>'settlement_currency',v_payload->>'currency',v_original_currency));
    if v_settlement_currency !~ '^[A-Z]{3}$' then return jsonb_build_object('ok', false, 'code', 'currency_invalid'); end if;
    v_fx := coalesce(v_payload->'fx',v_payload->'fxMetadata',v_payload->'fx_metadata');
    if v_fx is null and (v_payload ? 'fxDirection' or v_payload ? 'fx_direction') then
      v_fx := jsonb_build_object(
        'base',split_part(upper(coalesce(v_payload->>'fxDirection',v_payload->>'fx_direction')),'_',1),
        'quote',split_part(upper(coalesce(v_payload->>'fxDirection',v_payload->>'fx_direction')),'_',2),
        'rate',coalesce(v_payload->'fxRate',v_payload->'fx_rate'),
        'source',coalesce(v_payload->>'fxSource',v_payload->>'fx_source'),
        'observedAt',coalesce(v_payload->>'fxAt',v_payload->>'fx_at',v_payload->>'sourceTime',v_payload->>'source_time')
      );
    end if;
    if v_settlement_currency <> 'SGD' then
      begin
        v_fx := public.dealer_normalise_fx(v_fx, v_settlement_currency);
      exception when others then return jsonb_build_object('ok', false, 'code', 'fx_metadata_required'); end;
    elsif v_fx is not null then
      begin
        v_fx := public.dealer_normalise_fx(v_fx, v_settlement_currency);
      exception when others then return jsonb_build_object('ok', false, 'code', 'fx_metadata_invalid'); end;
    end if;
    begin
      v_posted_proceeds := public.dealer_parse_money(coalesce(v_payload->'proceeds',v_payload->'actual'->'proceeds',v_payload->'posted'->'proceeds'));
      v_posted_selling_fee := public.dealer_parse_money(coalesce(v_payload->'sellingFee',v_payload->'selling_fee',v_payload->'fees',v_payload->'actual'->'sellingFee',v_payload->'actual'->'selling_fee',v_payload->'posted'->'sellingFee',v_payload->'posted'->'selling_fee'));
      v_posted_shipping := public.dealer_parse_money(coalesce(v_payload->'outboundShipping',v_payload->'outbound_shipping',v_payload->'shipping',v_payload->'actual'->'outboundShipping',v_payload->'actual'->'outbound_shipping',v_payload->'posted'->'outboundShipping',v_payload->'posted'->'outbound_shipping'));
      v_landed_cost := public.dealer_parse_money(coalesce(v_outcome.data->'dealerCostBasis'->'settledAmount',v_outcome.data->'dealerCostBasis'->'amount',v_outcome.data->'dealerCostBasis'->'itemCost',v_outcome.data->'dealerCostBasis'));
      if v_payload ? 'canonicalLandedCost' or v_payload ? 'canonical_landed_cost' then
        return jsonb_build_object('ok', false, 'code', 'cost_basis_override_forbidden');
      end if;
    exception when others then return jsonb_build_object('ok', false, 'code', 'invalid_money'); end;
    if v_posted_proceeds is null or v_posted_selling_fee is null or v_posted_shipping is null then return jsonb_build_object('ok', false, 'code', 'settlement_amount_required'); end if;
    if v_landed_cost is null then return jsonb_build_object('ok', false, 'code', 'cost_basis_required'); end if;
    if v_posted_proceeds < 0 or v_posted_selling_fee < 0 or v_posted_shipping < 0 or v_landed_cost < 0 then return jsonb_build_object('ok', false, 'code', 'invalid_money'); end if;
    begin
      v_proceeds := round(public.dealer_fx_to_sgd(v_posted_proceeds, v_settlement_currency, v_fx), 2);
      v_selling_fee := round(public.dealer_fx_to_sgd(v_posted_selling_fee, v_settlement_currency, v_fx), 2);
      v_shipping := round(public.dealer_fx_to_sgd(v_posted_shipping, v_settlement_currency, v_fx), 2);
    exception when others then return jsonb_build_object('ok', false, 'code', 'fx_conversion_invalid'); end;
    v_contribution := v_proceeds - v_selling_fee - v_shipping - v_landed_cost;
    v_data := v_outcome.data || jsonb_build_object(
      'paymentStatus','Settled',
      'cashSettledAt',v_settled_at,
      'settlementCurrency',v_settlement_currency,
      'settlementFx',v_fx,
      'settlementEvidence',v_evidence,
      'dealerActual',jsonb_build_object(
        'proceeds',v_proceeds,
        'sellingFee',v_selling_fee,
        'outboundShipping',v_shipping,
        'canonicalLandedCost',v_landed_cost,
        'contribution',v_contribution,
        'reportingCurrency','SGD',
        'postedCurrency',v_settlement_currency,
        'postedProceeds',v_posted_proceeds,
        'postedSellingFee',v_posted_selling_fee,
        'postedOutboundShipping',v_posted_shipping
      ),
      'contribution',v_contribution
    );
    if v_payload ? 'fxDirection' or v_payload ? 'fx_direction' then
      v_data := v_data || jsonb_build_object(
        'fxDirection',coalesce(v_payload->>'fxDirection',v_payload->>'fx_direction'),
        'fxRate',coalesce(v_payload->>'fxRate',v_payload->>'fx_rate'),
        'fxSource',coalesce(v_payload->>'fxSource',v_payload->>'fx_source'),
        'fxAt',coalesce(v_payload->>'fxAt',v_payload->>'fx_at',v_payload->>'sourceTime',v_payload->>'source_time')
      );
    end if;
    update public.dealer_records set data=v_data,state='settled' where owner_user_id=v_owner and entity_type='outcome' and id=v_outcome_id returning * into v_record;
    v_table := v_link.inventory_table;
    execute 'update public.sales set data=$2 where id=$1 returning row_version' into v_canonical_version using v_sale_id,(v_canonical->'data') || jsonb_build_object(
      'paymentStatus','Settled',
      'dealerPaymentStatus','Settled',
      'totalCollected',v_proceeds,
      'postedProceeds',v_proceeds,
      'postedSellingFee',v_selling_fee,
      'postedOutboundShipping',v_shipping,
      'totalCollectedOriginal',v_posted_proceeds,
      'fees',v_selling_fee,
      'shippingCost',v_shipping,
      'postedProceedsOriginal',v_posted_proceeds,
      'postedSellingFeeOriginal',v_posted_selling_fee,
      'postedOutboundShippingOriginal',v_posted_shipping,
      'postedCurrency',v_settlement_currency,
      'settlementFx',v_fx,
      'dealerActual',v_data->'dealerActual',
      'profit',v_contribution,
      'margin',case when v_proceeds=0 then null else v_contribution/v_proceeds end
    );
    update public.dealer_canonical_links set sale_row_version=v_canonical_version where owner_user_id=v_owner and copy_id=v_link.copy_id;
    v_result := jsonb_build_object('outcome',public.dealer_record_json(v_record),'sale',jsonb_build_object('id',v_sale_id,'row_version',v_canonical_version,'paymentStatus','Settled','contribution',v_contribution));
    v_revisions := v_revisions || jsonb_build_array(jsonb_build_object('entity_type','outcome','id',v_outcome_id,'row_version',v_record.row_version),jsonb_build_object('table','sales','id',v_sale_id,'row_version',v_canonical_version));

  elsif v_command = 'record_non_sale' then
    v_copy_id := coalesce(v_payload->>'copyId',v_payload->>'copy_id');
    if v_copy_id is null then return jsonb_build_object('ok', false, 'code', 'copy_required'); end if;
    select * into v_copy from public.dealer_records where owner_user_id=v_owner and entity_type='copy' and id=v_copy_id for update;
    if not found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
    v_candidate_id := v_copy.candidate_id;
    select * into v_candidate from public.dealer_records where owner_user_id=v_owner and entity_type='candidate' and id=v_candidate_id for update;
    if not found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
    if v_expected_candidate = 0 then return jsonb_build_object('ok', false, 'code', 'missing_expected_version'); end if;
    if v_expected_candidate <> v_candidate.row_version then return jsonb_build_object('ok', false, 'code', 'version_conflict', 'current', public.dealer_record_json(v_candidate)); end if;
    if coalesce(v_candidate.data->>'status',v_candidate.state) <> 'Acquired' then return jsonb_build_object('ok', false, 'code', 'acquired_copy_required'); end if;
    select * into v_link from public.dealer_canonical_links where owner_user_id=v_owner and copy_id=v_copy_id for update;
    if not found then return jsonb_build_object('ok', false, 'code', 'canonical_required'); end if;
    execute format('select jsonb_build_object(''id'',id,''data'',data,''row_version'',row_version) from public.%I where id=$1 for update',v_link.inventory_table) into v_canonical using v_link.inventory_id;
    if v_canonical is null then return jsonb_build_object('ok', false, 'code', 'canonical_not_found'); end if;
    if coalesce(lower(v_canonical->'data'->>'status'),'available') = 'sold' then return jsonb_build_object('ok', false, 'code', 'already_sold'); end if;
    if (v_canonical->'data' ? 'qty') and (v_canonical->'data'->>'qty') !~ '^1$' then return jsonb_build_object('ok', false, 'code', 'single_physical_copy_required'); end if;
    v_outcome_id := coalesce(v_payload->>'outcomeId',v_payload->>'outcome_id',v_command_id_text);
    if exists (select 1 from public.dealer_records where owner_user_id=v_owner and entity_type='outcome' and id=v_outcome_id) then return jsonb_build_object('ok', false, 'code', 'state_conflict'); end if;
    v_data := v_payload || jsonb_build_object('outcomeId',v_outcome_id,'copyId',v_copy_id,'candidateId',v_candidate_id,'paymentStatus','NotApplicable','actual','Unknown','contribution','Unknown','reason',coalesce(v_payload->'reason',v_payload->'nonSale'));
    insert into public.dealer_records(entity_type,id,owner_user_id,candidate_id,state,data) values ('outcome',v_outcome_id,v_owner,v_candidate_id,'non_sale',v_data) returning * into v_record;
    v_result := jsonb_build_object('outcome',public.dealer_record_json(v_record));
    v_revisions := v_revisions || jsonb_build_array(jsonb_build_object('entity_type','outcome','id',v_outcome_id,'row_version',v_record.row_version));

  elsif v_command = 'review_outcome' then
    v_outcome_id := coalesce(v_payload->>'outcomeId',v_payload->>'outcome_id');
    if v_outcome_id is null then return jsonb_build_object('ok', false, 'code', 'outcome_required'); end if;
    select * into v_outcome from public.dealer_records where owner_user_id=v_owner and entity_type='outcome' and id=v_outcome_id for update;
    if not found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
    if v_expected_outcome = 0 then return jsonb_build_object('ok', false, 'code', 'missing_expected_version'); end if;
    if v_expected_outcome <> v_outcome.row_version then return jsonb_build_object('ok', false, 'code', 'version_conflict', 'current', public.dealer_record_json(v_outcome)); end if;
    v_review_input := coalesce(v_payload->'review','{}'::jsonb);
    if nullif(btrim(coalesce(v_review_input->>'cause',v_review_input->>'reason',v_payload->>'cause',v_payload->>'reason','')),'') is null then
      return jsonb_build_object('ok', false, 'code', 'review_cause_required');
    end if;
    v_restock := coalesce(v_payload->'restockDecision',v_payload->'restock_decision',v_review_input->'restockDecision',v_review_input->'restock_decision');
    if jsonb_typeof(v_restock) <> 'object'
       or nullif(btrim(coalesce(v_restock->>'decision',v_restock->>'reason','')),'') is null
       or nullif(btrim(coalesce(v_restock->>'date',v_restock->>'at',v_restock->>'reviewedAt','')),'') is null then
      return jsonb_build_object('ok', false, 'code', 'restock_decision_required');
    end if;
    begin
      v_sale_time := coalesce(v_restock->>'date',v_restock->>'at',v_restock->>'reviewedAt')::timestamptz;
    exception when others then return jsonb_build_object('ok', false, 'code', 'restock_decision_invalid'); end;
    if v_sale_time is null or v_sale_time > v_now then return jsonb_build_object('ok', false, 'code', 'restock_decision_future'); end if;
    select * into v_candidate from public.dealer_records where owner_user_id=v_owner and entity_type='candidate' and id=v_outcome.candidate_id for update;
    if not found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
    if v_candidate.data->>'approvedPlanId' is not null then
      select * into v_plan from public.dealer_records where owner_user_id=v_owner and entity_type='plan' and id=v_candidate.data->>'approvedPlanId' for update;
    end if;
    if v_outcome.data->>'paymentStatus' = 'Settled' then
      v_sale_id := v_outcome.data->>'saleId';
      execute 'select data from public.sales where id=$1 for update' into v_sale_data using v_sale_id;
      if v_sale_data is null or v_sale_data->>'paymentStatus' <> 'Settled' or not (v_sale_data ? 'dealerActual') then return jsonb_build_object('ok', false, 'code', 'settlement_required'); end if;
      v_review_actual := v_sale_data->'dealerActual';
    else
      v_sale_data := null;
      v_review_actual := jsonb_build_object('status','Unknown');
    end if;
    if v_plan is null or coalesce(v_plan.data->'expected'->>'status','Unknown') <> 'Known' or v_plan.data->'plannedLandedCost'->>'amount' is null then
      v_plan_variance := jsonb_build_object('status','Unknown','reason','planned_contribution_unknown');
      v_target_variance := jsonb_build_object('status','Unknown','reason','target_unknown');
    elsif v_review_actual->>'contribution' is null or v_review_actual->>'status' = 'Unknown' then
      v_plan_variance := jsonb_build_object('status','Unknown','plannedContribution',((v_plan.data->'expected'->>'expectedNetProceeds')::numeric - (v_plan.data->'plannedLandedCost'->>'amount')::numeric),'reason','actual_contribution_unknown');
      v_target_variance := jsonb_build_object('status','Unknown','targetContribution',v_plan.data->'expected'->'targetContribution','reason','actual_contribution_unknown');
    else
      v_plan_variance := jsonb_build_object('status','Known','plannedContribution',((v_plan.data->'expected'->>'expectedNetProceeds')::numeric - (v_plan.data->'plannedLandedCost'->>'amount')::numeric),'actualContribution',(v_review_actual->>'contribution')::numeric,'delta',(v_review_actual->>'contribution')::numeric - ((v_plan.data->'expected'->>'expectedNetProceeds')::numeric - (v_plan.data->'plannedLandedCost'->>'amount')::numeric),'formula','actual contribution - planned contribution');
      if v_plan.data->'expected'->>'targetContribution' is null then
        v_target_variance := jsonb_build_object('status','Unknown','reason','target_unknown');
      else
        v_target_variance := jsonb_build_object('status','Known','targetContribution',(v_plan.data->'expected'->>'targetContribution')::numeric,'actualContribution',(v_review_actual->>'contribution')::numeric,'delta',(v_review_actual->>'contribution')::numeric - (v_plan.data->'expected'->>'targetContribution')::numeric,'formula','actual contribution - target contribution');
      end if;
    end if;
    v_id := coalesce(v_payload->>'reviewId',v_payload->>'review_id',v_command_id_text);
    v_data := v_review_input || jsonb_build_object('outcomeId',v_outcome_id,'actual',v_review_actual,'planVariance',v_plan_variance,'targetVariance',v_target_variance,'restockDecision',v_restock,'reviewedAt',v_now,'reviewedBy',v_owner_text);
    insert into public.dealer_records(entity_type,id,owner_user_id,candidate_id,state,data) values ('review',v_id,v_owner,v_outcome.candidate_id,'recorded',v_data) returning * into v_record;
    v_result := jsonb_build_object('review',public.dealer_record_json(v_record));
    v_revisions := v_revisions || jsonb_build_array(jsonb_build_object('entity_type','review','id',v_id,'row_version',v_record.row_version));
  end if;

  v_response := jsonb_build_object('ok',true,'client_protocol',2,'schema_version',1,'command_id',v_command_id_text,'result',v_result,'revisions',v_revisions);
  insert into public.dealer_command_receipts(command_id,owner_user_id,request_fingerprint,request_json,response) values (v_command_id,v_owner,v_fingerprint,p_request,v_response);
  return v_response;
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'code', 'state_conflict');
  when check_violation then
    return jsonb_build_object('ok', false, 'code', 'invalid_state');
  when others then
    return jsonb_build_object('ok', false, 'code', 'dealer_command_failed');
end;
$function$;

revoke all on function public.dealer_record_revision_guard() from public, anon, authenticated;
revoke all on function public.dealer_link_revision_guard() from public, anon, authenticated;
revoke all on function public.dealer_record_json(public.dealer_records) from public, anon, authenticated;
revoke all on function public.dealer_payload_keys_valid(text, jsonb) from public, anon, authenticated;
revoke all on function public.dealer_command_payload_keys_valid(text, jsonb) from public, anon, authenticated;
revoke all on function public.dealer_nested_keys_valid(text, jsonb) from public, anon, authenticated;
revoke all on function public.dealer_expected_version(jsonb, text) from public, anon, authenticated;
revoke all on function public.dealer_parse_money(jsonb) from public, anon, authenticated;
revoke all on function public.dealer_parse_plan_number(jsonb) from public, anon, authenticated;
revoke all on function public.dealer_nested_protected(jsonb) from public, anon, authenticated;
revoke all on function public.dealer_normalise_fx(jsonb, text) from public, anon, authenticated;
revoke all on function public.dealer_fx_to_sgd(numeric, text, jsonb) from public, anon, authenticated;
revoke all on function public.dealer_plan_component(jsonb, text[]) from public, anon, authenticated;
revoke all on function public.dealer_plan_economics(jsonb) from public, anon, authenticated;
revoke all on function public.dealer_candidate_readiness(uuid, text) from public, anon, authenticated;
revoke all on function public.dealer_canonical_marker(jsonb) from public, anon, authenticated;
revoke all on function public.collectibles_dealer_blocks_generic(text, text, jsonb) from public, anon, authenticated;
revoke all on function public.collectibles_dealer_pull_v1(jsonb) from public, anon, authenticated;
revoke all on function public.collectibles_dealer_command_v1(jsonb) from public, anon, authenticated;
grant execute on function public.collectibles_dealer_pull_v1(jsonb) to service_role;
grant execute on function public.collectibles_dealer_command_v1(jsonb) to service_role;

commit;
