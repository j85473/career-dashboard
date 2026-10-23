import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const activation = readFileSync('scripts/deployment/activate-m70.sh', 'utf8');
const service = readFileSync('scripts/deployment/m70/career-dashboard-web-discovery.service', 'utf8');
const timer = readFileSync('scripts/deployment/m70/career-dashboard-web-discovery.timer', 'utf8');
const web = readFileSync('scripts/deployment/m70/career-dashboard.service', 'utf8');

test('faster passes share passive responsiveness telemetry with the web service', () => {
  const telemetry = 'Environment=DASHBOARD_RESPONSIVENESS_FILE=/var/lib/career-dashboard/data/runtime/dashboard-responsiveness.json';
  assert.ok(service.includes(telemetry));
  assert.ok(web.includes(telemetry));
  assert.match(timer, /OnUnitInactiveSec=15s/);
  assert.match(timer, /AccuracySec=1s/);
  assert.match(timer, /RandomizedDelaySec=5s/);
});

test('web discovery remains opt-in, bounded, and outside browser/scoring resources', () => {
  assert.match(service, /ConditionPathExists=\/etc\/career-dashboard\/web-discovery-enabled/);
  assert.match(service, /ConditionPathExists=\/etc\/career-dashboard\/web-discovery-seeds\.txt/);
  assert.match(service, /CPUQuota=50%/);
  assert.match(service, /MemoryMax=512M/);
  assert.match(service, /Nice=19/);
  assert.match(service, /--max-old-space-size=256/);
  assert.match(service, /state\.sqlite/);
  assert.doesNotMatch(service, /cloakbrowser|xvfb|scoring/i);
  assert.doesNotMatch(activation, /enable --now career-dashboard-web-discovery/);
});

test('release and rollback preserve a web discovery timer only when it was running', () => {
  assert.match(activation, /systemctl is-active --quiet career-dashboard-web-discovery\.timer && WEB_DISCOVERY=1/);
  assert.match(activation, /\[\[ \$MODE != maintenance \]\] \|\| WEB_DISCOVERY=0/);
  assert.match(activation, /\(\( WEB_DISCOVERY == 0 \)\) \|\| systemctl start career-dashboard-web-discovery\.timer/);
  const recovery = activation.slice(activation.indexOf('recover() {'), activation.indexOf('trap recover ERR'));
  assert.match(recovery, /systemctl stop career-dashboard-web-discovery\.timer career-dashboard-web-discovery\.service/);
  assert.match(recovery, /if \[\[ ! -f \$OLD\/scripts\/deployment\/m70\/career-dashboard-web-discovery\.timer \]\]; then\n\s+WEB_DISCOVERY=0/);
  assert.match(recovery, /systemctl disable career-dashboard-web-discovery\.timer/);
  assert.match(recovery, /rm -f \/etc\/systemd\/system\/career-dashboard-web-discovery\.timer \/etc\/systemd\/system\/career-dashboard-web-discovery\.service/);
  const stopping = activation.slice(activation.indexOf('trap recover ERR'));
  assert.ok(stopping.indexOf('systemctl stop career-dashboard-web-discovery.timer career-dashboard-web-discovery.service') < stopping.indexOf('/api/pipeline/stop?mode=quiesce'));
});
