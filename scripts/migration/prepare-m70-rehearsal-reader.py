#!/usr/bin/env python3
"""Create credentials limited to reads of the isolated rehearsal; never print them."""
import os
from pathlib import Path
import pwd
import secrets
import socket
import subprocess

database = 'career_rehearsal_20260902'
role = 'career_rehearsal_reader'
envfile = Path('/etc/career-dashboard/rehearsal.env')
if os.getuid() != 0 or socket.gethostname() != 'm70' or envfile.exists():
    raise SystemExit('Wrong host/user or existing rehearsal environment; inspect first')
if Path('/etc/career-dashboard/production-enabled').exists():
    raise SystemExit('Production gate exists; preparation refused')
password = secrets.token_hex(32)
sql = f'''
CREATE ROLE {role} LOGIN PASSWORD '{password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE {role} IN DATABASE {database} SET default_transaction_read_only = on;
GRANT CONNECT ON DATABASE {database} TO {role};
GRANT USAGE ON SCHEMA public TO {role};
GRANT SELECT ON ALL TABLES IN SCHEMA public TO {role};
'''
result = subprocess.run(['runuser', '-u', 'postgres', '--', 'psql', '-X', '-v',
                         'ON_ERROR_STOP=1', '-1', '-d', database], input=sql,
                        text=True, capture_output=True)
if result.returncode:
    raise SystemExit('Reader creation failed; output withheld to protect generated credential')
fd = os.open(envfile, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o640)
os.fchown(fd, 0, pwd.getpwnam('career-dashboard').pw_gid)
with os.fdopen(fd, 'w') as out:
    out.write(f'DATABASE_URL=postgresql://{role}:{password}@127.0.0.1:5432/{database}?schema=public\n')
    out.write('DATABASE_RUNTIME_HOST=127.0.0.1\nNODE_ENV=production\nNEXT_TELEMETRY_DISABLED=1\n')
print('Restricted rehearsal reader created; generated credential remains on the M70 only.')
