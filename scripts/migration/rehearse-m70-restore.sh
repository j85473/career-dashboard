#!/usr/bin/env bash
# Restore the verified September 1 archive into a NEW, isolated rehearsal database.
# No source database connection, live application, scheduler, or provider calls.
set -euo pipefail
[[ ${EUID} -eq 0 && $(hostname) == m70 ]] || exit 1
[[ $(cat /sys/class/net/eno1/address) == 2c:f0:5d:47:f1:22 ]] || exit 1
[[ $(findmnt -nro UUID /) == be454a64-715e-42ec-a83b-6eac18550d5d ]] || exit 1
[[ ! -e /etc/career-dashboard/production-enabled ]] || exit 1

archive=/var/lib/postgresql/m70-rehearsal/source-20260901T223925Z.dump
expected_sha=084f885ba22d4793a5a27d0abbe51e796f8f8a55a8c0aca377d7416589d49889
[[ $(stat -c %s "$archive") == 2312598898 ]] || exit 1
printf '%s  %s\n' "$expected_sha" "$archive" | sha256sum --check -
[[ $(runuser -u postgres -- psql -X -At -d postgres -c "SELECT count(*) FROM pg_database WHERE datname='career_rehearsal_20260902';") == 0 ]] || {
  echo 'Rehearsal database already exists; inspect it. No automatic deletion.' >&2; exit 1;
}
[[ $(runuser -u postgres -- psql -X -At -d postgres -c "SELECT count(*) FROM pg_roles WHERE rolname='career_rehearsal_owner';") == 0 ]] || {
  echo 'Rehearsal owner already exists; inspect it before retrying.' >&2; exit 1;
}
umask 027
touch /var/log/m70-restore-rehearsal.log
chown root:adm /var/log/m70-restore-rehearsal.log
chmod 0640 /var/log/m70-restore-rehearsal.log
exec > >(tee -a /var/log/m70-restore-rehearsal.log) 2>&1
trap 'echo "Rehearsal failed at line $LINENO. Retain partial database for diagnosis; do not activate services."' ERR
date -u '+Rehearsal started %Y-%m-%dT%H:%M:%SZ'
runuser -u postgres -- pg_restore --list "$archive" > /var/lib/postgresql/m70-rehearsal/archive-contents.txt
runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -d postgres -c \
  'CREATE ROLE career_rehearsal_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;'
runuser -u postgres -- createdb --template=template0 --encoding=UTF8 \
  --lc-collate=en_GB.UTF-8 --lc-ctype=en_GB.UTF-8 --owner=career_rehearsal_owner career_rehearsal_20260902
restore_started=$(date +%s)
runuser -u postgres -- pg_restore --exit-on-error --no-owner --no-privileges \
  --jobs=2 --role=career_rehearsal_owner --dbname=career_rehearsal_20260902 "$archive"
echo "Restore elapsed seconds: $(( $(date +%s) - restore_started ))"
runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -d career_rehearsal_20260902 <<'SQL'
ANALYZE;
BEGIN READ ONLY;
SELECT current_database(), pg_size_pretty(pg_database_size(current_database())) AS restored_size;
SELECT datcollate, datctype, datcollversion, pg_database_collation_actual_version(oid) AS actual_version
  FROM pg_database WHERE datname=current_database();
SELECT extname, extversion FROM pg_extension ORDER BY extname;
SELECT count(*) AS jobs, count("aimFitScore") AS aim_scores,
  count("reqFitScore") AS experience_scores, count("fitScore") AS legacy_scores FROM public."Job";
SELECT status, count(*) FROM public."Job" GROUP BY status ORDER BY status;
SELECT count(*) AS public_indexes FROM pg_indexes WHERE schemaname='public';
SELECT count(*) AS user_triggers FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
  JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal;
SELECT count(*) AS invalid_indexes FROM pg_index WHERE NOT indisvalid OR NOT indisready;
SELECT count(*) AS exclusion_constraints FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
  WHERE n.nspname='public' AND c.contype='x';
SELECT format('SELECT %L AS table_name, count(*) AS rows FROM %I.%I;', n.nspname||'.'||c.relname, n.nspname, c.relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_'
  ORDER BY n.nspname,c.relname
\gexec
COMMIT;
SQL
date -u '+Rehearsal restore and inventory completed %Y-%m-%dT%H:%M:%SZ'
echo 'This is the September 1 snapshot. Field-level comparison and application tests remain outstanding.'
echo 'No live Dashboard services, acquisition, or schedules were started.'
