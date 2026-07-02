#!/bin/bash
set -e

PI_USER="your-user"
PI_HOST="your-ip-address"

echo "Installing crontab on Raspberry Pi ($PI_HOST)..."

ssh $PI_USER@$PI_HOST << 'EOF'
# Create a temporary file for the new cron jobs
CRON_FILE=$(mktemp)

# Dump existing crontab (ignore error if no crontab exists)
crontab -l > $CRON_FILE 2>/dev/null || true

# Remove old career-dashboard cron entries
sed -i '/career-dashboard\/scripts\/cron/d' $CRON_FILE
sed -i '/CAREER DASHBOARD PIPELINE/d' $CRON_FILE
sed -i '/^# -/d' $CRON_FILE

# Append the new pipeline
cat << 'CRON_JOBS' >> $CRON_FILE
# --- CAREER DASHBOARD PIPELINE ---
0 0 * * * cd /opt/career-dashboard && /usr/bin/npx tsx scripts/cron/00_00_context.ts >> /var/log/career-dashboard-cron.log 2>&1
30 0 * * * cd /opt/career-dashboard && /usr/bin/npx tsx scripts/cron/00_30_discovery.ts >> /var/log/career-dashboard-cron.log 2>&1
0 1 * * * cd /opt/career-dashboard && /usr/bin/npx tsx scripts/cron/01_00_ingest.ts >> /var/log/career-dashboard-cron.log 2>&1
30 1 * * * cd /opt/career-dashboard && /usr/bin/npx tsx scripts/cron/01_30_needs_jd.ts >> /var/log/career-dashboard-cron.log 2>&1
30 2 * * * cd /opt/career-dashboard && /usr/bin/npx tsx scripts/cron/02_30_score.ts >> /var/log/career-dashboard-cron.log 2>&1
30 3 * * * cd /opt/career-dashboard && /usr/bin/npx tsx scripts/cron/03_30_af.ts >> /var/log/career-dashboard-cron.log 2>&1
30 4 * * * cd /opt/career-dashboard && /usr/bin/npx tsx scripts/cron/04_30_linkedin.ts >> /var/log/career-dashboard-cron.log 2>&1
30 5 * * * cd /opt/career-dashboard && /usr/bin/npx tsx scripts/cron/05_30_ef.ts >> /var/log/career-dashboard-cron.log 2>&1
15 6 * * * cd /opt/career-dashboard && /usr/bin/npx tsx scripts/cron/reconcile_jobs.ts >> /var/log/career-dashboard-cron.log 2>&1
0 7 * * * curl -s http://localhost:3000/api/jobs/batch-af-status >> /var/log/career-dashboard-cron.log 2>&1
0 12 * * * curl -s http://localhost:3000/api/jobs/batch-context-status >> /var/log/career-dashboard-cron.log 2>&1
# ---------------------------------
CRON_JOBS

# Install the new crontab
crontab $CRON_FILE
rm $CRON_FILE

echo "Please manually run these commands on the server to create the log file:"
echo "sudo touch /var/log/career-dashboard-cron.log"
echo "sudo chown $USER:$USER /var/log/career-dashboard-cron.log"

echo "Crontab installed successfully!"
echo "Current crontab:"
crontab -l
EOF
