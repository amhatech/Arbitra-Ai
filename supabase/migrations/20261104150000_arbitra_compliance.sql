create extension if not exists pgcrypto;

create table public.contracts (
  id uuid primary key default gen_random_uuid(),
  source_fingerprint text not null unique
    check (source_fingerprint ~ '^[a-f0-9]{64}$'),
  freelancer_email text not null
    check (freelancer_email = lower(btrim(freelancer_email))
      and freelancer_email ~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$'),
  freelancer_email_verified boolean not null default false,
  client_email text not null
    check (client_email = lower(btrim(client_email))
      and client_email ~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$'),
  client_email_verified boolean not null default false,
  total_budget numeric(10, 2) not null check (total_budget > 0),
  currency varchar(3) not null check (currency ~ '^[A-Z]{3}$'),
  current_status text not null default 'NEGOTIATING'
    check (current_status in ('NEGOTIATING', 'ACTIVE', 'DISPUTED', 'COMPLETED')),
  paypal_order_id text unique,
  paypal_approval_url text,
  paypal_authorization_id text unique,
  paypal_capture_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint contracts_distinct_parties check (freelancer_email <> client_email)
);

create table public.milestones (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references public.contracts(id) on delete cascade,
  title text not null check (length(btrim(title)) between 1 and 160),
  amount numeric(10, 2) not null check (amount > 0),
  verification_type text not null
    check (verification_type in ('github_commit', 'figma_link')),
  description text not null check (length(btrim(description)) between 12 and 6000),
  status text not null default 'AWAITING_FUNDS'
    check (status in ('AWAITING_FUNDS', 'ESCROWED', 'PENDING_RELEASE', 'PAID', 'MUTED_DISPUTE')),
  ai_score integer check (ai_score between 0 and 100),
  ai_summary text,
  ai_evidence jsonb not null default '[]'::jsonb
    check (jsonb_typeof(ai_evidence) = 'array'),
  verification_commit_sha text,
  verification_timestamp timestamptz,
  release_countdown_eta timestamptz,
  released_amount numeric(10, 2) not null default 0
    check (released_amount >= 0 and released_amount <= amount),
  paypal_payout_batch_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint milestone_release_eta_only_for_pending
    check ((status = 'PENDING_RELEASE') = (release_countdown_eta is not null)),
  constraint milestone_paid_amount_matches_status
    check (status <> 'PAID' or released_amount = amount)
);

create table public.milestone_payouts (
  id uuid primary key default gen_random_uuid(),
  milestone_id uuid not null references public.milestones(id) on delete restrict,
  amount numeric(10, 2) not null check (amount > 0),
  currency varchar(3) not null check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'PROCESSING'
    check (status in ('PROCESSING', 'SUCCEEDED', 'FAILED')),
  idempotency_key text not null unique,
  paypal_batch_id text unique,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index milestones_contract_id_idx on public.milestones(contract_id);
create index milestones_status_release_eta_idx
  on public.milestones(status, release_countdown_eta);
create index milestone_payouts_milestone_status_idx
  on public.milestone_payouts(milestone_id, status);

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger contracts_set_updated_at
before update on public.contracts
for each row execute function public.set_updated_at();

create trigger milestones_set_updated_at
before update on public.milestones
for each row execute function public.set_updated_at();

create trigger milestone_payouts_set_updated_at
before update on public.milestone_payouts
for each row execute function public.set_updated_at();

create function public.upsert_contract_from_negotiation(
  p_fingerprint text,
  p_payload jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_contract_id uuid;
  v_status text;
  v_milestone_total numeric(10, 2);
begin
  if jsonb_typeof(p_payload->'milestones') <> 'array'
    or jsonb_array_length(p_payload->'milestones') = 0 then
    raise exception using errcode = '22023', message = 'At least one milestone is required';
  end if;

  select coalesce(sum((item->>'amount')::numeric), 0)
    into v_milestone_total
    from jsonb_array_elements(p_payload->'milestones') as item;

  if v_milestone_total <> (p_payload->>'total_budget')::numeric then
    raise exception using errcode = '22023', message = 'Milestone amounts must equal the contract budget';
  end if;

  insert into public.contracts (
    source_fingerprint,
    freelancer_email,
    freelancer_email_verified,
    client_email,
    client_email_verified,
    total_budget,
    currency
  )
  values (
    p_fingerprint,
    lower(btrim(p_payload->>'freelancer_email')),
    coalesce((p_payload->>'freelancer_email_verified')::boolean, false),
    lower(btrim(p_payload->>'client_email')),
    coalesce((p_payload->>'client_email_verified')::boolean, false),
    (p_payload->>'total_budget')::numeric,
    upper(p_payload->>'currency')
  )
  on conflict (source_fingerprint) do nothing;

  select id, current_status
    into v_contract_id, v_status
    from public.contracts
    where source_fingerprint = p_fingerprint
    for update;

  if v_status <> 'NEGOTIATING' then
    raise exception using errcode = '23514',
      message = 'A funded or completed contract cannot be changed by parsing';
  end if;

  update public.contracts
    set freelancer_email = lower(btrim(p_payload->>'freelancer_email')),
        freelancer_email_verified = case
          when contracts.freelancer_email = lower(btrim(p_payload->>'freelancer_email'))
            then contracts.freelancer_email_verified
              or coalesce((p_payload->>'freelancer_email_verified')::boolean, false)
          else coalesce((p_payload->>'freelancer_email_verified')::boolean, false)
        end,
        client_email = lower(btrim(p_payload->>'client_email')),
        client_email_verified = case
          when contracts.client_email = lower(btrim(p_payload->>'client_email'))
            then contracts.client_email_verified
              or coalesce((p_payload->>'client_email_verified')::boolean, false)
          else coalesce((p_payload->>'client_email_verified')::boolean, false)
        end,
        total_budget = (p_payload->>'total_budget')::numeric,
        currency = upper(p_payload->>'currency')
    where id = v_contract_id;

  delete from public.milestones where contract_id = v_contract_id;

  insert into public.milestones (
    contract_id,
    title,
    amount,
    verification_type,
    description
  )
  select
    v_contract_id,
    item->>'title',
    (item->>'amount')::numeric,
    item->>'verification_type',
    item->>'description'
  from jsonb_array_elements(p_payload->'milestones') as item;

  return v_contract_id;
end;
$$;

create function public.verify_contract_party(p_email text)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_updated integer;
  v_client_updated integer;
begin
  if p_email is null
    or lower(btrim(p_email)) !~ '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$' then
    raise exception using errcode = '22023', message = 'Verified email is invalid';
  end if;

  update public.contracts
    set freelancer_email_verified = true
    where freelancer_email = lower(btrim(p_email))
      and not freelancer_email_verified;

  get diagnostics v_updated = row_count;

  update public.contracts
    set client_email_verified = true
    where client_email = lower(btrim(p_email))
      and not client_email_verified;

  get diagnostics v_client_updated = row_count;
  v_updated := v_updated + v_client_updated;
  return v_updated;
end;
$$;

create function public.activate_contract_after_authorization(
  p_contract_id uuid,
  p_order_id text,
  p_authorization_id text,
  p_capture_id text,
  p_authorized_amount numeric,
  p_currency text,
  p_client_email text
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_contract public.contracts%rowtype;
begin
  select * into v_contract
    from public.contracts
    where id = p_contract_id
    for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Contract not found';
  end if;
  if v_contract.current_status <> 'NEGOTIATING'
    or v_contract.paypal_order_id <> p_order_id
    or (v_contract.paypal_capture_id is not null
      and v_contract.paypal_capture_id <> p_capture_id) then
    raise exception using errcode = '23514', message = 'PayPal order does not match an active negotiation';
  end if;
  if v_contract.client_email <> lower(btrim(p_client_email))
    or not v_contract.client_email_verified
    or not v_contract.freelancer_email_verified then
    raise exception using errcode = '42501', message = 'Verified contract parties are required';
  end if;
  if v_contract.total_budget <> p_authorized_amount
    or v_contract.currency <> upper(p_currency) then
    raise exception using errcode = '23514', message = 'PayPal authorization amount does not match the contract';
  end if;

  update public.contracts
    set current_status = 'ACTIVE',
        paypal_authorization_id = p_authorization_id,
        paypal_capture_id = p_capture_id
    where id = p_contract_id;

  update public.milestones
    set status = 'ESCROWED'
    where contract_id = p_contract_id and status = 'AWAITING_FUNDS';

  return p_contract_id;
end;
$$;

create function public.record_work_verification(
  p_milestone_id uuid,
  p_ai_score integer,
  p_commit_sha text,
  p_summary text,
  p_evidence jsonb
)
returns public.milestones
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_milestone public.milestones%rowtype;
  v_contract_status text;
begin
  if p_ai_score < 0 or p_ai_score > 100 then
    raise exception using errcode = '22023', message = 'AI score must be between 0 and 100';
  end if;

  select m.* into v_milestone
    from public.milestones m
    where m.id = p_milestone_id
    for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Milestone not found';
  end if;

  if v_milestone.status <> 'ESCROWED' then
    raise exception using errcode = '23514', message = 'Milestone is not available for verification';
  end if;

  select c.current_status into v_contract_status
    from public.contracts c
    where c.id = v_milestone.contract_id;

  if v_contract_status <> 'ACTIVE' then
    raise exception using errcode = '23514', message = 'Contract is not active';
  end if;

  update public.milestones
    set ai_score = p_ai_score,
        ai_summary = p_summary,
        ai_evidence = p_evidence,
        verification_commit_sha = p_commit_sha,
        verification_timestamp = now(),
        status = case when p_ai_score >= 85 then 'PENDING_RELEASE' else 'ESCROWED' end,
        release_countdown_eta = case
          when p_ai_score >= 85 then now() + interval '24 hours'
          else null
        end
    where id = p_milestone_id
    returning * into v_milestone;

  return v_milestone;
end;
$$;

create function public.record_pending_escrow_capture(
  p_contract_id uuid,
  p_order_id text,
  p_authorization_id text,
  p_capture_id text,
  p_client_email text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_contract public.contracts%rowtype;
begin
  select * into v_contract
    from public.contracts
    where id = p_contract_id
    for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Contract not found';
  end if;
  if v_contract.current_status <> 'NEGOTIATING'
    or v_contract.paypal_order_id <> p_order_id
    or v_contract.client_email <> lower(btrim(p_client_email))
    or not v_contract.client_email_verified
    or not v_contract.freelancer_email_verified then
    raise exception using errcode = '42501', message = 'Verified client and active order required';
  end if;
  if v_contract.paypal_capture_id is not null
    and v_contract.paypal_capture_id <> p_capture_id then
    raise exception using errcode = '23514', message = 'A different escrow capture is already recorded';
  end if;

  update public.contracts
    set paypal_authorization_id = p_authorization_id,
        paypal_capture_id = p_capture_id
    where id = p_contract_id;
end;
$$;

create function public.fail_pending_escrow_capture(
  p_capture_id text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.contracts
    set paypal_order_id = null,
        paypal_approval_url = null,
        paypal_authorization_id = null,
        paypal_capture_id = null
    where paypal_capture_id = p_capture_id
      and current_status = 'NEGOTIATING';

  if not found then
    raise exception using errcode = 'P0002', message = 'Pending escrow capture not found';
  end if;
end;
$$;

create function public.raise_milestone_dispute(
  p_milestone_id uuid,
  p_user_email text
)
returns public.milestones
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_milestone public.milestones%rowtype;
  v_contract public.contracts%rowtype;
begin
  select m.* into v_milestone
    from public.milestones m
    where m.id = p_milestone_id
    for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Milestone not found';
  end if;

  select c.* into v_contract
    from public.contracts c
    where c.id = v_milestone.contract_id
    for update;

  if lower(btrim(p_user_email)) not in (v_contract.freelancer_email, v_contract.client_email)
    or (lower(btrim(p_user_email)) = v_contract.freelancer_email
      and not v_contract.freelancer_email_verified)
    or (lower(btrim(p_user_email)) = v_contract.client_email
      and not v_contract.client_email_verified) then
    raise exception using errcode = '42501', message = 'Verified contract party required';
  end if;
  if v_milestone.status <> 'PENDING_RELEASE'
    or v_milestone.release_countdown_eta <= now() then
    raise exception using errcode = '23514', message = 'Milestone is not within its dispute window';
  end if;

  update public.milestones
    set status = 'MUTED_DISPUTE',
        release_countdown_eta = null
    where id = p_milestone_id
    returning * into v_milestone;

  update public.contracts
    set current_status = 'DISPUTED'
    where id = v_contract.id and current_status = 'ACTIVE';

  return v_milestone;
end;
$$;

create function public.reserve_milestone_payout(
  p_freelancer_email text,
  p_amount numeric,
  p_idempotency_key text,
  p_milestone_id uuid default null
)
returns table (
  payout_id uuid,
  milestone_id uuid,
  currency varchar(3),
  idempotency_key text,
  is_retry boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_candidate record;
  v_candidate_count integer := 0;
  v_existing public.milestone_payouts%rowtype;
  v_reserved numeric(10, 2);
begin
  if p_amount <= 0 or round(p_amount, 2) <> p_amount then
    raise exception using errcode = '22023', message = 'Payout amount must be positive with at most two decimals';
  end if;

  select p.* into v_existing
    from public.milestone_payouts p
    join public.milestones m on m.id = p.milestone_id
    join public.contracts c on c.id = m.contract_id
    where p.status = 'PROCESSING'
      and p.amount = p_amount
      and c.freelancer_email = lower(btrim(p_freelancer_email))
      and (p_milestone_id is null or p.milestone_id = p_milestone_id)
    order by p.created_at
    limit 1
    for update of p;

  if found then
    return query select v_existing.id, v_existing.milestone_id,
      v_existing.currency, v_existing.idempotency_key, true;
    return;
  end if;

  for v_candidate in
    select m.id, m.amount, m.released_amount, c.currency
      from public.milestones m
      join public.contracts c on c.id = m.contract_id
      where c.freelancer_email = lower(btrim(p_freelancer_email))
        and (p_milestone_id is null or m.id = p_milestone_id)
        and c.freelancer_email_verified
        and c.current_status = 'ACTIVE'
        and m.status = 'PENDING_RELEASE'
        and m.release_countdown_eta <= now()
        and m.amount - m.released_amount >= p_amount
      order by m.release_countdown_eta, m.created_at
      limit 2
      for update of m
  loop
    v_candidate_count := v_candidate_count + 1;
    if v_candidate_count = 1 then
      v_reserved := coalesce((
        select sum(p.amount)
          from public.milestone_payouts p
          where p.milestone_id = v_candidate.id
            and p.status = 'PROCESSING'
      ), 0);

      if v_candidate.amount - v_candidate.released_amount - v_reserved < p_amount then
        raise exception using errcode = '23514', message = 'Payout exceeds the remaining milestone balance';
      end if;
    end if;
  end loop;

  if v_candidate_count = 0 then
    raise exception using errcode = '23514', message = 'No eligible, released milestone has sufficient balance';
  elsif v_candidate_count > 1 then
    raise exception using errcode = '23514', message = 'Payout is ambiguous; settle one milestone at a time';
  end if;

  insert into public.milestone_payouts (
    milestone_id,
    amount,
    currency,
    status,
    idempotency_key
  )
  values (
    v_candidate.id,
    p_amount,
    v_candidate.currency,
    'PROCESSING',
    p_idempotency_key
  )
  returning id, milestone_payouts.milestone_id, milestone_payouts.currency,
    milestone_payouts.idempotency_key, false
  into payout_id, milestone_id, currency, idempotency_key, is_retry;

  return next;
end;
$$;

create function public.complete_milestone_payout(
  p_payout_id uuid,
  p_paypal_batch_id text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_payout public.milestone_payouts%rowtype;
begin
  select * into v_payout
    from public.milestone_payouts
    where id = p_payout_id
    for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Payout reservation not found';
  end if;

  if v_payout.status = 'SUCCEEDED' then
    return;
  end if;

  if v_payout.status <> 'PROCESSING' then
    raise exception using errcode = '23514', message = 'Payout reservation is not processing';
  end if;

  update public.milestone_payouts
    set status = 'SUCCEEDED',
        paypal_batch_id = p_paypal_batch_id,
        error_message = null
    where id = p_payout_id;

  update public.milestones
    set released_amount = released_amount + v_payout.amount,
        paypal_payout_batch_id = p_paypal_batch_id,
        status = case
          when released_amount + v_payout.amount = amount then 'PAID'
          else status
        end,
        release_countdown_eta = case
          when released_amount + v_payout.amount = amount then null
          else release_countdown_eta
        end
    where id = v_payout.milestone_id;
end;
$$;

create function public.fail_milestone_payout(
  p_payout_id uuid,
  p_error_message text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_payout public.milestone_payouts%rowtype;
begin
  select * into v_payout
    from public.milestone_payouts
    where id = p_payout_id
    for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Payout reservation not found';
  end if;
  if v_payout.status = 'FAILED' then
    return;
  end if;
  if v_payout.status <> 'PROCESSING' then
    raise exception using errcode = '23514', message = 'Payout reservation cannot be marked failed';
  end if;

  update public.milestone_payouts
    set status = 'FAILED',
        error_message = left(p_error_message, 1000)
    where id = p_payout_id;
end;
$$;

alter table public.contracts enable row level security;
alter table public.milestones enable row level security;
alter table public.milestone_payouts enable row level security;

revoke all on public.contracts, public.milestones, public.milestone_payouts from anon, authenticated;
grant all on public.contracts, public.milestones, public.milestone_payouts to service_role;

revoke all on function public.upsert_contract_from_negotiation(text, jsonb) from public, anon, authenticated;
revoke all on function public.verify_contract_party(text) from public, anon, authenticated;
revoke all on function public.activate_contract_after_authorization(uuid, text, text, text, numeric, text, text) from public, anon, authenticated;
revoke all on function public.record_pending_escrow_capture(uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.fail_pending_escrow_capture(text) from public, anon, authenticated;
revoke all on function public.raise_milestone_dispute(uuid, text) from public, anon, authenticated;
revoke all on function public.record_work_verification(uuid, integer, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.reserve_milestone_payout(text, numeric, text, uuid) from public, anon, authenticated;
revoke all on function public.complete_milestone_payout(uuid, text) from public, anon, authenticated;
revoke all on function public.fail_milestone_payout(uuid, text) from public, anon, authenticated;

grant execute on function public.upsert_contract_from_negotiation(text, jsonb) to service_role;
grant execute on function public.verify_contract_party(text) to service_role;
grant execute on function public.activate_contract_after_authorization(uuid, text, text, text, numeric, text, text) to service_role;
grant execute on function public.record_pending_escrow_capture(uuid, text, text, text, text) to service_role;
grant execute on function public.fail_pending_escrow_capture(text) to service_role;
grant execute on function public.raise_milestone_dispute(uuid, text) to service_role;
grant execute on function public.record_work_verification(uuid, integer, text, text, jsonb) to service_role;
grant execute on function public.reserve_milestone_payout(text, numeric, text, uuid) to service_role;
grant execute on function public.complete_milestone_payout(uuid, text) to service_role;
grant execute on function public.fail_milestone_payout(uuid, text) to service_role;
