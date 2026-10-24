-- TestMu AI Hack Day claim and team sync (branch testmu-hack-day-api). Additive and idempotent.
-- What the claim answered: the participant's TestMu AI organization and the outcome code.
alter table testmu_links add column if not exists organization_id bigint;
alter table testmu_links add column if not exists claim_code text;
-- The captain's sync into one TestMu AI team: the last team/invite answer per teammate. Never a password.
create table if not exists testmu_team_sync (
  team_id         bigint not null references teams(id) on delete cascade,
  member_id       bigint not null references members(id) on delete cascade,
  code            text not null,
  message         text,
  organization_id bigint,
  attempted_at    timestamptz not null default now(),
  primary key (team_id, member_id)
);
create index if not exists idx_testmu_team_sync_member on testmu_team_sync(member_id);
