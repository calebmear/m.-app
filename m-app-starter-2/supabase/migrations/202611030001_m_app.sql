begin;

-- Apply only to the new Supabase project for m. app.
-- This migration never refers to QPI or to unprefixed application tables.
create table public.m_app_months (
  user_id uuid not null references auth.users(id) on delete cascade,
  month date not null check (extract(day from month) = 1),
  document jsonb not null check (jsonb_typeof(document) = 'object'),
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, month),
  check (document->>'month' = to_char(month, 'YYYY-MM')),
  check ((document->>'schemaVersion')::integer = 1)
);
create table public.m_app_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  document jsonb not null check (jsonb_typeof(document) = 'object'),
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now()
);
create table public.m_app_month_history (
  user_id uuid not null references auth.users(id) on delete cascade,
  month date not null,
  revision bigint not null,
  document jsonb not null,
  saved_at timestamptz not null default now(),
  primary key (user_id, month, revision)
);

alter table public.m_app_months enable row level security;
alter table public.m_app_preferences enable row level security;
alter table public.m_app_month_history enable row level security;
create policy "Read own m. app months" on public.m_app_months for select to authenticated using ((select auth.uid()) = user_id);
create policy "Read own m. app defaults" on public.m_app_preferences for select to authenticated using ((select auth.uid()) = user_id);
create policy "Read own m. app history" on public.m_app_month_history for select to authenticated using ((select auth.uid()) = user_id);
revoke all on public.m_app_months, public.m_app_preferences, public.m_app_month_history from public, anon, authenticated;
grant select on public.m_app_months, public.m_app_preferences, public.m_app_month_history to authenticated;

create function public.m_app_save_month(p_month date, p_document jsonb, p_expected_revision bigint)
returns setof public.m_app_months
language plpgsql security definer set search_path = '' as $$
declare
  owner_id uuid := auth.uid();
  previous public.m_app_months;
  saved public.m_app_months;
begin
  if owner_id is null then raise exception 'Sign in to save your budget.' using errcode = '42501'; end if;
  if p_month is null or extract(day from p_month) <> 1 or p_document is null
     or jsonb_typeof(p_document) <> 'object' or p_document->>'month' is distinct from to_char(p_month, 'YYYY-MM')
     or p_document->>'schemaVersion' is distinct from '1'
     or jsonb_typeof(p_document->'paychecks') is distinct from 'array'
     or jsonb_typeof(p_document->'bills') is distinct from 'array'
     or jsonb_typeof(p_document->'charges') is distinct from 'array'
     or jsonb_typeof(p_document->'statement') is distinct from 'object'
     or jsonb_typeof(p_document->'openingCents') is distinct from 'number'
     or jsonb_typeof(p_document->'closed') is distinct from 'boolean'
     or p_expected_revision is null or p_expected_revision < 0
  then raise exception 'Invalid monthly budget.' using errcode = '22023'; end if;

  if p_expected_revision = 0 then
    insert into public.m_app_months(user_id, month, document)
      values (owner_id, p_month, p_document)
      on conflict (user_id, month) do nothing returning * into saved;
    if not found then raise exception 'Budget changed on another device.' using errcode = '40001'; end if;
  else
    select * into previous from public.m_app_months
      where user_id = owner_id and month = p_month for update;
    if not found or previous.revision <> p_expected_revision then
      raise exception 'Budget changed on another device.' using errcode = '40001';
    end if;
    if previous.document->>'closed' = 'true' and
       (p_document->>'closed' <> 'false' or (p_document - 'closed') <> (previous.document - 'closed')) then
      raise exception 'Reopen this month before editing it.' using errcode = '22023';
    end if;
    update public.m_app_months set document = p_document, revision = previous.revision + 1, updated_at = now()
      where user_id = owner_id and month = p_month returning * into saved;
  end if;
  insert into public.m_app_month_history(user_id, month, revision, document)
    values (saved.user_id, saved.month, saved.revision, saved.document);
  return next saved;
end;
$$;

create function public.m_app_save_preferences(p_document jsonb, p_expected_revision bigint)
returns setof public.m_app_preferences
language plpgsql security definer set search_path = '' as $$
declare
  owner_id uuid := auth.uid();
  saved public.m_app_preferences;
begin
  if owner_id is null then raise exception 'Sign in to save defaults.' using errcode = '42501'; end if;
  if p_document is null or jsonb_typeof(p_document) <> 'object'
     or jsonb_typeof(p_document->'paychecks') is distinct from 'array'
     or jsonb_typeof(p_document->'bills') is distinct from 'array'
     or p_expected_revision is null or p_expected_revision < 0
  then raise exception 'Invalid recurring defaults.' using errcode = '22023'; end if;
  if p_expected_revision = 0 then
    insert into public.m_app_preferences(user_id, document) values (owner_id, p_document)
      on conflict (user_id) do nothing returning * into saved;
  else
    update public.m_app_preferences set document = p_document, revision = revision + 1, updated_at = now()
      where user_id = owner_id and revision = p_expected_revision returning * into saved;
  end if;
  if not found then raise exception 'Defaults changed on another device.' using errcode = '40001'; end if;
  return next saved;
end;
$$;

revoke all on function public.m_app_save_month(date, jsonb, bigint) from public, anon;
revoke all on function public.m_app_save_preferences(jsonb, bigint) from public, anon;
grant execute on function public.m_app_save_month(date, jsonb, bigint) to authenticated;
grant execute on function public.m_app_save_preferences(jsonb, bigint) to authenticated;
commit;
