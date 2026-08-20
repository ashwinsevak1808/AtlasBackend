-- 013_flow_schedules_unique.sql
--
-- Adds the "one schedule per flow" constraint to a flow_schedules table that
-- was created before it existed.
--
-- 012 originally shipped without it, and gained it later in the same file.
-- `create table if not exists` means re-running 012 does nothing to a table
-- that is already there, so anyone who ran the earlier version has a table
-- with no unique constraint on flow_id — and `on conflict (flow_id)` fails
-- against it with "there is no unique or exclusion constraint matching the ON
-- CONFLICT specification", surfacing as a 500 the moment a schedule is saved.
--
-- Safe to run whether or not you hit that: it removes any duplicate rows first
-- and is idempotent. A fresh database that ran the current 012 already has the
-- constraint, and this simply replaces it with an identically-shaped one.

-- Keep the newest schedule per flow if duplicates were ever written.
delete from flow_schedules a
 using flow_schedules b
 where a.flow_id = b.flow_id
   and a.created_at < b.created_at;

alter table flow_schedules drop constraint if exists flow_schedules_flow_id_key;
alter table flow_schedules add  constraint flow_schedules_flow_id_key unique (flow_id);
