-- ============================================================
-- Kasir Chat - Supabase schema
-- Jalankan di Supabase Dashboard > SQL Editor > New query > Run
-- ============================================================

-- 1. households (buku bersama)
create table if not exists public.households (
  id          uuid primary key default gen_random_uuid(),
  name        text not null default 'Rumah Tangga',
  join_code   text not null unique,
  currency    text not null default 'IDR',
  created_at  timestamptz not null default now()
);

-- 2. profiles (satu per user auth, Extend jadi MVP)
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text,
  display_name  text,
  avatar_url    text,
  created_at    timestamptz not null default now()
);

-- 3. household_members (banyak user -> 1 household, role owner/member)
create table if not exists public.household_members (
  household_id  uuid not null references public.households(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  role          text not null default 'member' check (role in ('owner','member')),
  created_at    timestamptz not null default now(),
  primary key (household_id, user_id)
);

-- 4. transactions
-- user_id sengaja referensi public.profiles (bukan auth.users) supaya
-- PostgREST bisa embed "profiles:user_id(display_name)".
create table if not exists public.transactions (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households(id) on delete cascade,
  user_id       uuid references public.profiles(id) on delete set null,
  type          text not null check (type in ('income','expense')),
  amount        bigint not null check (amount > 0),
  category      text not null,
  note          text not null default '',
  raw           text,
  date          date not null default current_date,
  created_at    timestamptz not null default now()
);

create index if not exists idx_tx_household_date on public.transactions (household_id, date desc, created_at desc);
create index if not exists idx_tx_household_type  on public.transactions (household_id, type);
create index if not exists idx_tx_user            on public.transactions (user_id);

-- 5. messages (riwayat chat)
create table if not exists public.messages (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households(id) on delete cascade,
  user_id       uuid references public.profiles(id) on delete set null,
  role          text not null check (role in ('user','bot')),
  text          text not null,
  payload       jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists idx_msg_household on public.messages (household_id, created_at desc);

-- ============================================================
-- Row Level Security
-- Semua query wajib lewat helper ini, tidak boleh pakai service_role
-- dari browser.
-- ============================================================

alter table public.households        enable row level security;
alter table public.profiles          enable row level security;
alter table public.household_members enable row level security;
alter table public.transactions      enable row level security;
alter table public.messages          enable row level security;

create or replace function public.my_household_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select household_id from public.household_members where user_id = auth.uid()
$$;

create or replace function public.is_member_of(target uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.household_members
    where household_id = target and user_id = auth.uid()
  )
$$;

-- households: hanya boleh melihat household yang dia anggota
create policy "households_select" on public.households
  for select using (public.is_member_of(id));

create policy "households_update" on public.households
  for update using (public.is_member_of(id))
  with check (public.is_member_of(id));

-- profiles: semua anggota household yang sama boleh baca
create policy "profiles_select" on public.profiles
  for select using (
    id = auth.uid()
    or exists (
      select 1 from public.household_members a
      join public.household_members b on a.household_id = b.household_id
      where a.user_id = auth.uid() and b.user_id = profiles.id
    )
  );

create policy "profiles_update_self" on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

create policy "profiles_insert_self" on public.profiles
  for insert with check (id = auth.uid());

-- household_members: lihat anggota sendiri, owner bisa tambah
create policy "members_select" on public.household_members
  for select using (user_id = auth.uid() or public.is_member_of(household_id));

create policy "members_insert" on public.household_members
  for insert with check (
    user_id = auth.uid()
    or exists (
      select 1 from public.household_members
      where household_id = household_members.household_id
        and user_id = auth.uid() and role = 'owner'
    )
  );

create policy "members_delete" on public.household_members
  for delete using (
    exists (
      select 1 from public.household_members
      where household_id = household_members.household_id
        and user_id = auth.uid() and role = 'owner'
    )
  );

-- transactions & messages: hanya anggota household itu
create policy "tx_select" on public.transactions
  for select using (public.is_member_of(household_id));

create policy "tx_insert" on public.transactions
  for insert with check (public.is_member_of(household_id) and user_id = auth.uid());

create policy "tx_update" on public.transactions
  for update using (public.is_member_of(household_id))
  with check (public.is_member_of(household_id));

create policy "tx_delete" on public.transactions
  for delete using (public.is_member_of(household_id));

create policy "msg_select" on public.messages
  for select using (public.is_member_of(household_id));

create policy "msg_insert" on public.messages
  for insert with check (public.is_member_of(household_id) and user_id = auth.uid());

-- ============================================================
-- trigger: auto-buat profile saat user signup
-- Jalankan DULUAN sebelum signup pertama.
-- ============================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
-- helper: buat household pertama + daftarkan owner
-- security definer karena RLS tidak mengizinkan user baru
-- membaca/menulis household sebelum dia jadi anggota.
-- ============================================================
create or replace function public.setup_my_household(household_name text)
returns public.households
language plpgsql
security definer
set search_path = public
as $$
declare
  h public.households;
  c text;
  i integer;
begin
  -- sudah punya household? kembalikan yang pertama
  select hm.household_id into h
  from public.household_members hm
  where hm.user_id = auth.uid()
  order by hm.created_at
  limit 1;

  if h.id is not null then
    select * into h from public.households where id = h.id;
    return h;
  end if;

  -- acak kode undangan, ulangi kalau bentrok
  for i in 1..8 loop
    c := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
    begin
      insert into public.households (name, join_code)
      values (coalesce(nullif(trim(household_name), ''), 'Rumah Tangga'), c)
      returning * into h;
      exit;
    exception when unique_violation then
      continue;
    end;
  end loop;

  if h.id is null then
    raise exception 'Gagal membuat household, coba lagi';
  end if;

  insert into public.household_members (household_id, user_id, role)
  values (h.id, auth.uid(), 'owner');

  return h;
end;
$$;

-- fungsi: gabung household pakai join code
create or replace function public.join_household(code text)
returns public.households
language plpgsql
security definer
set search_path = public
as $$
declare
  h public.households;
begin
  select * into h
  from public.households
  where join_code = upper(trim(coalesce(code, '')))
  limit 1;

  if h.id is null then
    raise exception 'Kode undangan tidak ditemukan';
  end if;

  insert into public.household_members (household_id, user_id, role)
  values (h.id, auth.uid(), 'member')
  on conflict do nothing;

  return h;
end;
$$;

grant execute on function public.setup_my_household(text) to authenticated;
grant execute on function public.join_household(text) to authenticated;
revoke execute on function public.setup_my_household(text) from anon;
revoke execute on function public.join_household(text) from anon;
