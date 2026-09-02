#!/bin/bash
# Fixed, root-owned source controls for the explicitly authorized M70 migration.
set -euo pipefail
[[ $(id -u) == 0 && $(hostname) == Homebridge ]] || exit 1
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
case "${1:-}" in
inspect)
  systemctl show career-dashboard -p ActiveState -p User -p MainPID
  runuser -u postgres -- psql -X -d career_db -v ON_ERROR_STOP=1 <<'SQL'
SELECT datname,pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname='career_db';
SELECT rolname,rolsuper,rolcanlogin FROM pg_roles WHERE rolname LIKE 'career%';
SELECT usename,application_name,client_addr,state,xact_start FROM pg_stat_activity WHERE datname='career_db' AND pid<>pg_backend_pid();
SELECT n.nspname,p.proname,p.prosecdef,pg_get_userbyid(p.proowner) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','walking_map');
SQL
  ;;
stop)
  install -d -m 700 /var/lib/career-migration
  systemctl stop career-dashboard
  ;;
fence)
  ! systemctl is-active --quiet career-dashboard
  if crontab -u j85473 -l | /usr/bin/grep -Eq '^[^#].*cron:pipeline'; then
    echo 'Refusing fence while old scheduler is configured' >&2; exit 1
  fi
  runuser -u postgres -- psql -X -d career_db -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SET LOCAL lock_timeout='15s';
DO $$ BEGIN
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='career_archive_owner') THEN CREATE ROLE career_archive_owner NOLOGIN; END IF;
 IF EXISTS (SELECT FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND xact_start IS NOT NULL) THEN RAISE EXCEPTION 'Source still has open transactions'; END IF;
END $$;
DO $$ DECLARE o record; BEGIN
 FOR o IN SELECT c.relname,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') LOOP
 EXECUTE format('ALTER TABLE public.%I OWNER TO career_archive_owner',o.relname);
 END LOOP;
 FOR o IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='S' LOOP
 EXECUTE format('ALTER SEQUENCE public.%I OWNER TO career_archive_owner',o.relname);
 END LOOP;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM career_admin, PUBLIC;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO career_admin;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM career_admin, PUBLIC;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO career_admin;
COMMIT;
SELECT count(*) AS writable_public_tables FROM pg_tables WHERE schemaname='public' AND (has_table_privilege('career_admin',format('%I.%I',schemaname,tablename),'INSERT') OR has_table_privilege('career_admin',format('%I.%I',schemaname,tablename),'UPDATE') OR has_table_privilege('career_admin',format('%I.%I',schemaname,tablename),'DELETE') OR has_table_privilege('career_admin',format('%I.%I',schemaname,tablename),'TRUNCATE'));
SQL
  install -d -m 755 /etc/systemd/system/career-dashboard.service.d
  printf '[Unit]\nConditionPathExists=/etc/career-dashboard/pi-production-enabled\n' > /etc/systemd/system/career-dashboard.service.d/migrated.conf
  systemctl daemon-reload
  systemctl disable career-dashboard
  date -u +%FT%TZ > /var/lib/career-migration/fenced-at
  ;;
dump)
  [[ -f /var/lib/career-migration/fenced-at ]]
  ! systemctl is-active --quiet career-dashboard
  install -d -o postgres -g postgres -m 700 /mnt/pgdata/career-migration
  [[ ! -e /mnt/pgdata/career-migration/final.dump ]]
  runuser -u postgres -- pg_dump -Fc -Z1 --no-owner --no-acl -f /mnt/pgdata/career-migration/final.dump.partial career_db
  mv /mnt/pgdata/career-migration/final.dump.partial /mnt/pgdata/career-migration/final.dump
  chmod 600 /mnt/pgdata/career-migration/final.dump
  sha256sum /mnt/pgdata/career-migration/final.dump
  ;;
stream-dump)
  [[ -f /var/lib/career-migration/fenced-at ]]
  cat /mnt/pgdata/career-migration/final.dump
  ;;
*) echo 'Allowed: inspect, stop, fence, dump, stream-dump' >&2; exit 2 ;;
esac
