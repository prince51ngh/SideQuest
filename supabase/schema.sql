-- ============================================================================
-- SideQuest: database schema for Supabase (Postgres)
-- Run this whole file once in Supabase Dashboard > SQL Editor.
-- It is safe to run again after edits (types, tables, policies are re-created
-- only if missing / dropped first).
--
-- Money rule: every amount is stored in sen (RM 1.00 = 100) as an integer.
-- Clients can READ most tables (filtered by row level security) but can only
-- CHANGE data through the functions below, so the rules cannot be bypassed
-- from the browser.
-- ============================================================================

-- ---------- Types -----------------------------------------------------------
do $$ begin
  create type task_status as enum (
    'awaiting_poster_deposit', 'open', 'reserved', 'in_progress',
    'awaiting_confirmation', 'completed', 'disputed', 'resolved', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type deposit_status as enum (
    'awaiting_payment', 'held', 'refund_pending', 'refunded', 'forfeited', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type dispute_kind as enum (
    'back_out', 'no_show', 'not_completed', 'poor_quality', 'other');
exception when duplicate_object then null; end $$;

do $$ begin
  create type dispute_resolution as enum ('refund_both', 'forfeit_taker', 'forfeit_poster');
exception when duplicate_object then null; end $$;

-- ---------- Tables ----------------------------------------------------------
create table if not exists profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default 'New neighbour'
    check (char_length(display_name) between 2 and 40),
  bio text check (char_length(bio) <= 300),
  area text check (char_length(area) <= 60),
  role text not null default 'user' check (role in ('user', 'admin')),
  verification_status text not null default 'none'
    check (verification_status in ('none', 'pending', 'verified', 'rejected')),
  verification_doc_path text,
  verification_selfie_path text,
  created_at timestamptz not null default now()
);

create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  poster_id uuid not null references profiles (id) on delete restrict,
  taker_id uuid references profiles (id) on delete restrict,
  title text not null check (char_length(title) between 4 and 80),
  description text not null check (char_length(description) between 10 and 1000),
  category text not null check (category in
    ('home', 'garden', 'pets', 'errands', 'creative', 'tutoring', 'moving', 'tech', 'other')),
  area text not null check (char_length(area) between 2 and 60),
  reward_sen integer not null check (reward_sen between 500 and 500000),
  deposit_sen integer not null check (deposit_sen between 500 and 50000),
  due_at timestamptz not null,
  status task_status not null default 'awaiting_poster_deposit',
  reserved_until timestamptz,
  done_note text,
  marked_done_at timestamptz,
  auto_confirm_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  check (taker_id is null or taker_id <> poster_id)
);
create index if not exists tasks_board_idx on tasks (status, created_at desc);
create index if not exists tasks_poster_idx on tasks (poster_id);
create index if not exists tasks_taker_idx on tasks (taker_id);

-- Exact address / access notes. Only the poster, and the taker once the task
-- has started, can read this. The public board only ever shows tasks.area.
create table if not exists task_private (
  task_id uuid primary key references tasks (id) on delete cascade,
  address text not null check (char_length(address) <= 300)
);

create table if not exists deposits (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks (id) on delete restrict,
  user_id uuid not null references profiles (id) on delete restrict,
  party text not null check (party in ('poster', 'taker')),
  amount_sen integer not null check (amount_sen > 0),
  status deposit_status not null default 'awaiting_payment',
  stripe_session_id text,
  stripe_payment_intent_id text,
  stripe_refund_id text,
  last_error text,
  paid_at timestamptz,
  refunded_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists deposits_one_live_per_party
  on deposits (task_id, party) where status <> 'cancelled';
create index if not exists deposits_task_idx on deposits (task_id);
create index if not exists deposits_refund_idx on deposits (status) where status = 'refund_pending';

-- A forfeited deposit that an admin has awarded to the person who was let down.
-- Money is paid out by the admin outside the app (e.g. DuitNow) and marked paid.
create table if not exists payouts (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks (id),
  deposit_id uuid not null unique references deposits (id),
  to_user_id uuid not null references profiles (id),
  amount_sen integer not null check (amount_sen > 0),
  status text not null default 'due' check (status in ('due', 'paid')),
  reference text,
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists disputes (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks (id) on delete restrict,
  raised_by uuid not null references profiles (id),
  against_user uuid not null references profiles (id),
  kind dispute_kind not null,
  description text not null check (char_length(description) between 10 and 1000),
  status text not null default 'open' check (status in ('open', 'resolved')),
  evidence_deadline timestamptz not null default (now() + interval '72 hours'),
  resolution dispute_resolution,
  admin_note text,
  resolved_by uuid references profiles (id),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists disputes_one_open_per_task on disputes (task_id) where status = 'open';

create table if not exists dispute_evidence (
  id uuid primary key default gen_random_uuid(),
  dispute_id uuid not null references disputes (id) on delete cascade,
  user_id uuid not null references profiles (id),
  note text not null check (char_length(note) between 3 and 1000),
  file_path text,
  created_at timestamptz not null default now()
);
create index if not exists dispute_evidence_idx on dispute_evidence (dispute_id);

create table if not exists task_proofs (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks (id) on delete cascade,
  user_id uuid not null references profiles (id),
  kind text not null check (kind in ('progress', 'completion')),
  file_path text not null,
  caption text check (char_length(caption) <= 200),
  created_at timestamptz not null default now()
);
create index if not exists task_proofs_idx on task_proofs (task_id);

create table if not exists messages (
  id bigint generated always as identity primary key,
  task_id uuid not null references tasks (id) on delete cascade,
  sender_id uuid not null references profiles (id),
  body text not null default '' check (char_length(body) <= 1000),
  file_path text,
  created_at timestamptz not null default now(),
  check (body <> '' or file_path is not null)
);
create index if not exists messages_task_idx on messages (task_id, created_at);

create table if not exists reviews (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks (id) on delete cascade,
  reviewer_id uuid not null references profiles (id),
  reviewee_id uuid not null references profiles (id),
  rating smallint not null check (rating between 1 and 5),
  comment text check (char_length(comment) <= 500),
  created_at timestamptz not null default now(),
  unique (task_id, reviewer_id)
);
create index if not exists reviews_reviewee_idx on reviews (reviewee_id);

-- ---------- Helper functions ------------------------------------------------
create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'admin' from profiles where id = auth.uid()), false)
$$;

create or replace function is_task_party(p_task uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from tasks
    where id = p_task and (poster_id = auth.uid() or taker_id = auth.uid()))
$$;

create or replace function is_dispute_party(p_dispute uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from disputes d join tasks t on t.id = d.task_id
    where d.id = p_dispute and (t.poster_id = auth.uid() or t.taker_id = auth.uid()))
$$;

-- For storage paths shaped "<task uuid>/<user uuid>/<file>"
create or replace function storage_task_party(p_name text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare v uuid;
begin
  begin
    v := (string_to_array(p_name, '/'))[1]::uuid;
  exception when others then
    return false;
  end;
  return is_task_party(v);
end $$;

-- ---------- New user -> profile --------------------------------------------
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  v_name := coalesce(nullif(trim(left(new.raw_user_meta_data ->> 'display_name', 40)), ''), 'New neighbour');
  if char_length(v_name) < 2 then v_name := 'New neighbour'; end if;
  insert into profiles (id, display_name) values (new.id, v_name);
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();

-- People can edit their own profile, but never their own role or verification result.
create or replace function protect_profile_columns() returns trigger
language plpgsql as $$
begin
  if auth.uid() is not null
     and coalesce(current_setting('app.trusted', true), '') <> '1'
     and not is_admin() then
    new.role := old.role;
    new.verification_status := old.verification_status;
    new.verification_doc_path := old.verification_doc_path;
    new.verification_selfie_path := old.verification_selfie_path;
  end if;
  return new;
end $$;

drop trigger if exists protect_profile_columns on profiles;
create trigger protect_profile_columns before update on profiles
  for each row execute function protect_profile_columns();

-- ---------- Public view of profiles (no private columns) -------------------
create or replace view public_profiles as
select
  p.id,
  p.display_name,
  p.bio,
  p.area,
  (p.verification_status = 'verified') as verified,
  p.created_at,
  coalesce((select round(avg(r.rating)::numeric, 2) from reviews r where r.reviewee_id = p.id), 0) as rating_avg,
  (select count(*) from reviews r where r.reviewee_id = p.id) as rating_count,
  (select count(*) from tasks t
     where t.status in ('completed', 'resolved') and (t.poster_id = p.id or t.taker_id = p.id)) as finished_count
from profiles p;

grant select on public_profiles to anon, authenticated;

-- ---------- Row level security ---------------------------------------------
alter table profiles enable row level security;
alter table tasks enable row level security;
alter table task_private enable row level security;
alter table deposits enable row level security;
alter table payouts enable row level security;
alter table disputes enable row level security;
alter table dispute_evidence enable row level security;
alter table task_proofs enable row level security;
alter table messages enable row level security;
alter table reviews enable row level security;

drop policy if exists profiles_read on profiles;
create policy profiles_read on profiles for select
  using (id = auth.uid() or is_admin());
drop policy if exists profiles_update_own on profiles;
create policy profiles_update_own on profiles for update
  using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists tasks_read on tasks;
create policy tasks_read on tasks for select
  using (status = 'open' or poster_id = auth.uid() or taker_id = auth.uid() or is_admin());

drop policy if exists task_private_read on task_private;
create policy task_private_read on task_private for select using (
  is_admin() or exists (
    select 1 from tasks t where t.id = task_id and (
      t.poster_id = auth.uid()
      or (t.taker_id = auth.uid()
          and t.status in ('in_progress', 'awaiting_confirmation', 'disputed', 'completed', 'resolved')))));

drop policy if exists deposits_read on deposits;
create policy deposits_read on deposits for select
  using (user_id = auth.uid() or is_task_party(task_id) or is_admin());

drop policy if exists payouts_read on payouts;
create policy payouts_read on payouts for select
  using (to_user_id = auth.uid() or is_admin());

drop policy if exists disputes_read on disputes;
create policy disputes_read on disputes for select
  using (is_task_party(task_id) or is_admin());

drop policy if exists evidence_read on dispute_evidence;
create policy evidence_read on dispute_evidence for select
  using (is_dispute_party(dispute_id) or is_admin());
drop policy if exists evidence_insert on dispute_evidence;
create policy evidence_insert on dispute_evidence for insert with check (
  user_id = auth.uid()
  and is_dispute_party(dispute_id)
  and exists (select 1 from disputes d where d.id = dispute_id and d.status = 'open'));

drop policy if exists proofs_read on task_proofs;
create policy proofs_read on task_proofs for select
  using (is_task_party(task_id) or is_admin());
drop policy if exists proofs_insert on task_proofs;
create policy proofs_insert on task_proofs for insert with check (
  user_id = auth.uid()
  and exists (select 1 from tasks t
    where t.id = task_id and t.taker_id = auth.uid()
      and t.status in ('in_progress', 'awaiting_confirmation')));

drop policy if exists messages_read on messages;
create policy messages_read on messages for select
  using (is_task_party(task_id) or is_admin());
drop policy if exists messages_insert on messages;
create policy messages_insert on messages for insert with check (
  sender_id = auth.uid()
  and exists (select 1 from tasks t
    where t.id = task_id and t.taker_id is not null
      and (t.poster_id = auth.uid() or t.taker_id = auth.uid())
      and t.status in ('reserved', 'in_progress', 'awaiting_confirmation', 'disputed')));

drop policy if exists reviews_read on reviews;
create policy reviews_read on reviews for select using (true);

-- ---------- Storage ---------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('task-files', 'task-files', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('verification', 'verification', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists task_files_read on storage.objects;
create policy task_files_read on storage.objects for select to authenticated
  using (bucket_id = 'task-files' and (is_admin() or storage_task_party(name)));

drop policy if exists task_files_insert on storage.objects;
create policy task_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'task-files'
    and storage_task_party(name)
    and (string_to_array(name, '/'))[2] = auth.uid()::text);

drop policy if exists verification_read on storage.objects;
create policy verification_read on storage.objects for select to authenticated
  using (bucket_id = 'verification'
    and ((string_to_array(name, '/'))[1] = auth.uid()::text or is_admin()));

drop policy if exists verification_insert on storage.objects;
create policy verification_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'verification' and (string_to_array(name, '/'))[1] = auth.uid()::text);

-- Admins delete the ID photos as soon as they have made their decision.
drop policy if exists verification_delete on storage.objects;
create policy verification_delete on storage.objects for delete to authenticated
  using (bucket_id = 'verification' and is_admin());

-- ---------- Realtime: new chat messages and task status changes -------------
do $$ begin
  alter publication supabase_realtime add table public.messages;
exception when others then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.tasks;
exception when others then null; end $$;

-- ============================================================================
-- Actions people can take (called from the browser with supabase.rpc)
-- ============================================================================

-- Post a task. The poster's deposit row is created here; it is only
-- published ('open') after the payment webhook confirms the money arrived.
create or replace function create_task(
  p_title text, p_description text, p_category text, p_area text,
  p_reward_sen int, p_deposit_sen int, p_due_at timestamptz, p_address text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_task uuid;
  v_min int;
begin
  if v_uid is null then raise exception 'Sign in first'; end if;
  if p_due_at <= now() + interval '1 hour' then
    raise exception 'Pick a due time at least an hour from now';
  end if;
  v_min := greatest(500, ceil(p_reward_sen * 0.10)::int);
  if p_deposit_sen < v_min then
    raise exception 'The deposit for this reward must be at least RM %', to_char(v_min / 100.0, 'FM999990.00');
  end if;

  insert into tasks (poster_id, title, description, category, area, reward_sen, deposit_sen, due_at)
  values (v_uid, trim(p_title), trim(p_description), p_category, trim(p_area), p_reward_sen, p_deposit_sen, p_due_at)
  returning id into v_task;

  if nullif(trim(coalesce(p_address, '')), '') is not null then
    insert into task_private (task_id, address) values (v_task, left(trim(p_address), 300));
  end if;

  insert into deposits (task_id, user_id, party, amount_sen)
  values (v_task, v_uid, 'poster', p_deposit_sen);
  return v_task;
end $$;

-- Someone says "I'll take it". They get 45 minutes to pay their deposit.
create or replace function reserve_task(p_task uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_t tasks;
  v_dep uuid;
begin
  if v_uid is null then raise exception 'Sign in first'; end if;
  update tasks
     set status = 'reserved', taker_id = v_uid, reserved_until = now() + interval '45 minutes'
   where id = p_task and status = 'open' and poster_id <> v_uid and due_at > now() + interval '30 minutes'
  returning * into v_t;
  if not found then raise exception 'This task is no longer available'; end if;
  insert into deposits (task_id, user_id, party, amount_sen)
  values (p_task, v_uid, 'taker', v_t.deposit_sen) returning id into v_dep;
  return v_dep;
end $$;

-- The taker changes their mind before paying: no penalty.
create or replace function release_reservation(p_task uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update tasks set status = 'open', taker_id = null, reserved_until = null
   where id = p_task and status = 'reserved' and taker_id = auth.uid();
  if not found then raise exception 'There is no reservation to release'; end if;
  update deposits set status = 'cancelled'
   where task_id = p_task and party = 'taker' and status = 'awaiting_payment';
end $$;

-- The poster withdraws a task nobody has started yet: full refund, no penalty.
create or replace function cancel_task(p_task uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_t tasks;
begin
  select * into v_t from tasks where id = p_task and poster_id = auth.uid() for update;
  if not found then raise exception 'Task not found'; end if;
  if v_t.status not in ('awaiting_poster_deposit', 'open') then
    raise exception 'This task can no longer be cancelled here. Use "Back out" or "Report a problem" instead.';
  end if;
  update tasks set status = 'cancelled' where id = p_task;
  update deposits
     set status = case when status = 'held' then 'refund_pending'::deposit_status else 'cancelled'::deposit_status end
   where task_id = p_task and status in ('awaiting_payment', 'held');
end $$;

-- Taker says the work is finished. At least one completion photo is required.
create or replace function mark_done(p_task uuid, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from tasks where id = p_task and taker_id = auth.uid() and status = 'in_progress') then
    raise exception 'You can only finish a task you have taken and started';
  end if;
  if not exists (select 1 from task_proofs where task_id = p_task and kind = 'completion') then
    raise exception 'Add at least one completion photo first';
  end if;
  update tasks
     set status = 'awaiting_confirmation', marked_done_at = now(),
         auto_confirm_at = now() + interval '48 hours',
         done_note = left(trim(coalesce(p_note, '')), 500)
   where id = p_task;
end $$;

-- Poster confirms: both deposits go back to their owners.
create or replace function confirm_task(p_task uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update tasks set status = 'completed', completed_at = now()
   where id = p_task and poster_id = auth.uid() and status = 'awaiting_confirmation';
  if not found then raise exception 'There is nothing to confirm on this task'; end if;
  update deposits set status = 'refund_pending' where task_id = p_task and status = 'held';
end $$;

-- Either person reports a problem or backs out. Both deposits stay frozen
-- until an admin has seen evidence from both sides.
create or replace function raise_dispute(p_task uuid, p_kind dispute_kind, p_description text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_t tasks;
  v_against uuid;
  v_id uuid;
begin
  select * into v_t from tasks where id = p_task for update;
  if not found then raise exception 'Task not found'; end if;
  if v_uid is distinct from v_t.poster_id and v_uid is distinct from v_t.taker_id then
    raise exception 'Only the two people on this task can do that';
  end if;
  if v_t.status not in ('in_progress', 'awaiting_confirmation') then
    raise exception 'A problem can only be reported while the task is under way';
  end if;
  v_against := case
    when p_kind = 'back_out' then v_uid
    when v_uid = v_t.poster_id then v_t.taker_id
    else v_t.poster_id end;
  insert into disputes (task_id, raised_by, against_user, kind, description)
  values (p_task, v_uid, v_against, p_kind, trim(p_description))
  returning id into v_id;
  update tasks set status = 'disputed' where id = p_task;
  return v_id;
end $$;

create or replace function submit_review(p_task uuid, p_rating int, p_comment text default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_t tasks;
  v_other uuid;
begin
  select * into v_t from tasks where id = p_task;
  if not found or v_t.status not in ('completed', 'resolved') then
    raise exception 'You can review a task once it is finished';
  end if;
  v_other := case
    when v_uid = v_t.poster_id then v_t.taker_id
    when v_uid = v_t.taker_id then v_t.poster_id
    else null end;
  if v_other is null then raise exception 'Only the two people on a task can review it'; end if;
  insert into reviews (task_id, reviewer_id, reviewee_id, rating, comment)
  values (p_task, v_uid, v_other, p_rating, nullif(trim(coalesce(p_comment, '')), ''));
exception when unique_violation then
  raise exception 'You already reviewed this task';
end $$;

create or replace function submit_verification(p_doc text, p_selfie text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if split_part(p_doc, '/', 1) <> auth.uid()::text or split_part(p_selfie, '/', 1) <> auth.uid()::text then
    raise exception 'Those files do not belong to you';
  end if;
  perform set_config('app.trusted', '1', true);
  update profiles
     set verification_status = 'pending', verification_doc_path = p_doc, verification_selfie_path = p_selfie
   where id = auth.uid() and verification_status in ('none', 'rejected');
  if not found then raise exception 'Verification is already pending or approved'; end if;
end $$;

-- ---------- Admin-only actions ---------------------------------------------
create or replace function admin_review_verification(p_user uuid, p_approve boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  update profiles
     set verification_status = case when p_approve then 'verified' else 'rejected' end
   where id = p_user and verification_status = 'pending';
  if not found then raise exception 'No pending request for that person'; end if;
end $$;

create or replace function admin_payouts()
returns table (payout_id uuid, task_id uuid, task_title text, to_user_id uuid, display_name text,
               email text, amount_sen int, status text, reference text, paid_at timestamptz, created_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  return query
    select po.id, po.task_id, t.title, po.to_user_id, pr.display_name, u.email::text,
           po.amount_sen, po.status, po.reference, po.paid_at, po.created_at
      from payouts po
      join tasks t on t.id = po.task_id
      join profiles pr on pr.id = po.to_user_id
      join auth.users u on u.id = po.to_user_id
     order by (po.status = 'due') desc, po.created_at desc;
end $$;

create or replace function admin_mark_payout_paid(p_payout uuid, p_reference text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  if char_length(trim(coalesce(p_reference, ''))) < 3 then
    raise exception 'Add a payment reference (for example the DuitNow transfer ID)';
  end if;
  update payouts set status = 'paid', reference = trim(p_reference), paid_at = now()
   where id = p_payout and status = 'due';
  if not found then raise exception 'That payout is not waiting to be paid'; end if;
end $$;

create or replace function admin_held_total() returns table (held_sen bigint, refund_pending_sen bigint, payouts_due_sen bigint)
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  return query select
    coalesce((select sum(amount_sen) from deposits where status = 'held'), 0)::bigint,
    coalesce((select sum(amount_sen) from deposits where status = 'refund_pending'), 0)::bigint,
    coalesce((select sum(amount_sen) from payouts where status = 'due'), 0)::bigint;
end $$;

-- ============================================================================
-- Server-only functions: called by Edge Functions with the service role key.
-- Browsers cannot call these (execute permission is revoked below).
-- ============================================================================

-- Payment confirmed by Stripe. Safe to call twice for the same deposit.
create or replace function mark_deposit_paid(p_deposit uuid, p_payment_intent text, p_session text) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_d deposits;
  v_t tasks;
begin
  select * into v_d from deposits where id = p_deposit for update;
  if not found then return 'unknown'; end if;
  if v_d.status in ('held', 'refund_pending', 'refunded', 'forfeited') then
    -- Same payment reported twice is fine; a DIFFERENT payment for a deposit that is
    -- already covered means the person paid twice, so the extra one must be refunded.
    if v_d.stripe_payment_intent_id is not null and p_payment_intent is not null
       and v_d.stripe_payment_intent_id <> p_payment_intent then
      return 'duplicate';
    end if;
    return 'ok';
  end if;

  select * into v_t from tasks where id = v_d.task_id for update;

  -- Paid too late (reservation expired, task cancelled...): queue an automatic refund.
  if v_d.status = 'cancelled'
     or (v_d.party = 'poster' and v_t.status <> 'awaiting_poster_deposit')
     or (v_d.party = 'taker' and not (v_t.status = 'reserved' and v_t.taker_id = v_d.user_id)) then
    update deposits
       set status = 'refund_pending', stripe_payment_intent_id = p_payment_intent,
           stripe_session_id = coalesce(p_session, stripe_session_id), paid_at = now(),
           last_error = 'Paid after the task stopped waiting for this deposit'
     where id = v_d.id;
    return 'needs_refund';
  end if;

  update deposits
     set status = 'held', stripe_payment_intent_id = p_payment_intent,
         stripe_session_id = coalesce(p_session, stripe_session_id), paid_at = now(), last_error = null
   where id = v_d.id;

  if v_d.party = 'poster' then
    update tasks set status = 'open' where id = v_t.id;
  else
    update tasks set status = 'in_progress', reserved_until = null where id = v_t.id;
  end if;
  return 'ok';
end $$;

-- Admin ruling on a dispute. Called by the admin-resolve-dispute Edge Function.
create or replace function resolve_dispute(
  p_dispute uuid, p_resolution dispute_resolution, p_note text, p_admin uuid
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_d disputes;
  v_t tasks;
  v_poster deposits;
  v_taker deposits;
begin
  select * into v_d from disputes where id = p_dispute for update;
  if not found or v_d.status <> 'open' then raise exception 'This dispute is not open'; end if;
  select * into v_t from tasks where id = v_d.task_id for update;

  if now() < v_d.evidence_deadline then
    if not exists (select 1 from dispute_evidence where dispute_id = p_dispute and user_id = v_t.poster_id)
       or not exists (select 1 from dispute_evidence where dispute_id = p_dispute and user_id = v_t.taker_id) then
      raise exception 'Both people must add evidence first, or wait until the evidence window closes at %',
        to_char(v_d.evidence_deadline at time zone 'Asia/Kuala_Lumpur', 'DD Mon YYYY HH24:MI');
    end if;
  end if;

  select * into v_poster from deposits where task_id = v_t.id and party = 'poster' and status = 'held';
  select * into v_taker from deposits where task_id = v_t.id and party = 'taker' and status = 'held';

  if p_resolution = 'refund_both' then
    update deposits set status = 'refund_pending' where task_id = v_t.id and status = 'held';
  elsif p_resolution = 'forfeit_taker' then
    if v_taker.id is null then raise exception 'There is no held taker deposit to forfeit'; end if;
    update deposits set status = 'forfeited' where id = v_taker.id;
    insert into payouts (task_id, deposit_id, to_user_id, amount_sen)
    values (v_t.id, v_taker.id, v_t.poster_id, v_taker.amount_sen);
    update deposits set status = 'refund_pending' where id = v_poster.id;
  else
    if v_poster.id is null then raise exception 'There is no held poster deposit to forfeit'; end if;
    update deposits set status = 'forfeited' where id = v_poster.id;
    insert into payouts (task_id, deposit_id, to_user_id, amount_sen)
    values (v_t.id, v_poster.id, v_t.taker_id, v_poster.amount_sen);
    update deposits set status = 'refund_pending' where id = v_taker.id;
  end if;

  update disputes
     set status = 'resolved', resolution = p_resolution, admin_note = left(trim(coalesce(p_note, '')), 1000),
         resolved_by = p_admin, resolved_at = now()
   where id = p_dispute;
  update tasks set status = 'resolved', completed_at = now() where id = v_t.id;
  return v_t.id;
end $$;

-- Housekeeping, run every few minutes by the sweep-expired Edge Function.
create or replace function sweep_expired() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_reservations int; v_unfunded int; v_overdue int; v_auto int;
begin
  -- 1. Taker did not pay in time: put the task back on the board.
  with r as (
    update tasks set status = 'open', taker_id = null, reserved_until = null
     where status = 'reserved' and reserved_until < now() returning id)
  update deposits set status = 'cancelled'
   where party = 'taker' and status = 'awaiting_payment' and task_id in (select id from r);
  get diagnostics v_reservations = row_count;

  -- 2. Poster never paid the deposit: drop the draft.
  with u as (
    update tasks set status = 'cancelled'
     where status = 'awaiting_poster_deposit' and created_at < now() - interval '2 hours' returning id)
  update deposits set status = 'cancelled'
   where party = 'poster' and status = 'awaiting_payment' and task_id in (select id from u);
  get diagnostics v_unfunded = row_count;

  -- 3. Nobody took the task before its due time: cancel and refund the poster.
  with o as (
    update tasks set status = 'cancelled' where status = 'open' and due_at < now() returning id)
  update deposits set status = 'refund_pending' where status = 'held' and task_id in (select id from o);
  get diagnostics v_overdue = row_count;

  -- 4. Poster did not respond within 48 hours of "done": confirm automatically.
  with a as (
    update tasks set status = 'completed', completed_at = now()
     where status = 'awaiting_confirmation' and auto_confirm_at < now() returning id)
  update deposits set status = 'refund_pending' where status = 'held' and task_id in (select id from a);
  get diagnostics v_auto = row_count;

  return jsonb_build_object(
    'reservations_released', v_reservations, 'unfunded_dropped', v_unfunded,
    'overdue_refunds_queued', v_overdue, 'auto_confirm_refunds_queued', v_auto);
end $$;

-- Lock server-only functions away from browsers.
revoke execute on function mark_deposit_paid(uuid, text, text) from public, anon, authenticated;
revoke execute on function resolve_dispute(uuid, dispute_resolution, text, uuid) from public, anon, authenticated;
revoke execute on function sweep_expired() from public, anon, authenticated;
grant execute on function mark_deposit_paid(uuid, text, text) to service_role;
grant execute on function resolve_dispute(uuid, dispute_resolution, text, uuid) to service_role;
grant execute on function sweep_expired() to service_role;

-- ============================================================================
-- After you sign up for the first time, make yourself the admin by running:
--   update profiles set role = 'admin'
--   where id = (select id from auth.users where email = 'you@example.com');
-- ============================================================================
