-- Echo dev : schéma Supabase
-- À coller dans Dashboard Supabase > SQL Editor > Run

-- ============ PROFILES ============
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  avatar_url text,
  is_dev boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles lisibles par les connectés"
  on public.profiles for select to authenticated
  using (true);

create policy "chacun modifie son profil"
  on public.profiles for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- Les utilisateurs ne peuvent modifier que ces colonnes (surtout pas is_dev)
revoke update on public.profiles from authenticated;
grant update (username, avatar_url) on public.profiles to authenticated;

-- Création auto du profil à l'inscription
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, username)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data->>'username',
      'user_' || substr(new.id::text, 1, 8)
    )
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============ CHANNELS ============
create table public.channels (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  dev_only boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.channel_members (
  channel_id uuid not null references public.channels(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (channel_id, user_id)
);

-- Accès : membre du salon, ou dev si le salon est dev_only
create function public.can_access_channel(cid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    exists (
      select 1 from public.channel_members m
      where m.channel_id = cid and m.user_id = auth.uid()
    )
    or exists (
      select 1
      from public.channels c
      join public.profiles p on p.id = auth.uid()
      where c.id = cid and c.dev_only and p.is_dev
    );
$$;

alter table public.channels enable row level security;
alter table public.channel_members enable row level security;

create policy "salons visibles si accès"
  on public.channels for select to authenticated
  using (public.can_access_channel(id));

create policy "voir ses propres appartenances"
  on public.channel_members for select to authenticated
  using (user_id = auth.uid());

-- ============ MESSAGES ============
create table public.messages (
  id bigint generated always as identity primary key,
  channel_id uuid not null references public.channels(id) on delete cascade,
  author_id uuid references public.profiles(id) on delete set null, -- null pour l'IA
  reply_to bigint references public.messages(id) on delete set null, -- message cité
  role text not null default 'user' check (role in ('user', 'ai')),
  content text not null check (char_length(content) between 1 and 4000),
  created_at timestamptz not null default now(),
  edited_at timestamptz
);

create index messages_channel_created_idx
  on public.messages (channel_id, created_at desc);

alter table public.messages enable row level security;

create policy "lire les messages des salons accessibles"
  on public.messages for select to authenticated
  using (public.can_access_channel(channel_id));

-- Les utilisateurs écrivent uniquement en leur nom, avec role = 'user'.
-- Les réponses de l'IA sont insérées par l'Edge Function (service role, qui contourne la RLS).
create policy "écrire dans les salons accessibles"
  on public.messages for insert to authenticated
  with check (
    author_id = auth.uid()
    and role = 'user'
    and public.can_access_channel(channel_id)
  );

-- Modification : uniquement ses propres messages, et seule la colonne content est modifiable
revoke update on public.messages from authenticated;
grant update (content) on public.messages to authenticated;

create policy "modifier ses propres messages"
  on public.messages for update to authenticated
  using (
    author_id = auth.uid()
    and role = 'user'
    and public.can_access_channel(channel_id)
  )
  with check (
    author_id = auth.uid()
    and role = 'user'
    and public.can_access_channel(channel_id)
  );

-- Suppression : ses propres messages, et les réponses de l'IA pour les devs du salon
create policy "supprimer ses messages et ceux de l'IA"
  on public.messages for delete to authenticated
  using (
    public.can_access_channel(channel_id)
    and (
      (role = 'user' and author_id = auth.uid())
      or role = 'ai'
    )
  );

-- edited_at est rempli côté serveur (le client ne peut pas le falsifier)
create function public.set_edited_at()
returns trigger
language plpgsql
as $$
begin
  if new.content is distinct from old.content then
    new.edited_at = now();
  end if;
  return new;
end;
$$;

create trigger messages_set_edited_at
  before update on public.messages
  for each row execute function public.set_edited_at();

-- ============ REALTIME ============
alter publication supabase_realtime add table public.messages;

-- ============ LIVE SHARE (canaux Realtime privés "ws-...") ============
create function public.is_dev()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select is_dev from public.profiles where id = auth.uid()), false);
$$;

create policy "devs : écouter l'espace de travail"
  on realtime.messages for select to authenticated
  using (public.is_dev() and realtime.topic() like 'ws-%');

create policy "devs : écrire dans l'espace de travail"
  on realtime.messages for insert to authenticated
  with check (public.is_dev() and realtime.topic() like 'ws-%');

-- ============ DONNÉES DE DÉPART ============
insert into public.channels (name, dev_only) values ('dev-chat', true);

-- Une fois inscrits, vous deux passez is_dev à true :
-- update public.profiles set is_dev = true where username in ('ton_pseudo', 'pseudo_amie');
