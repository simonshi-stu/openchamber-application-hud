import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PRIVATE_ROOT, PROJECT_ROOT } from '../core/store.js';
import {
  HUD_06_LOCAL_LEDGER_SCHEMA_VERSION,
  createHud06LocalLedgerServer,
} from '../integrations/openchamber/service/hud-06-local-ledger.js';

const SCRIPT_PATH = fileURLToPath(import.meta.url);

function optionValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function parseCookies(response) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie') || ''];
  return values.map((value) => value.split(';', 1)[0]).filter(Boolean).join('; ');
}

function csrfFromHtml(html) {
  const match = /<meta name="hud06-csrf" content="([^"]+)"/.exec(html);
  if (!match) throw new Error('HUD-06 HTML did not expose the local CSRF token.');
  return match[1];
}

async function startChild({ sandboxPath, reportPath }) {
  const child = spawn(process.execPath, [SCRIPT_PATH, '--serve', `--sandbox=${sandboxPath}`, `--report=${reportPath}`], {
    cwd: PROJECT_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const info = await new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk;
      const lineEnd = buffer.indexOf('\n');
      if (lineEnd < 0) return;
      const line = buffer.slice(0, lineEnd).trim();
      child.stdout.off('data', onData);
      try {
        resolve({ ...JSON.parse(line), child });
      } catch (error) {
        reject(new Error(`HUD-06 child did not emit startup JSON: ${line}\n${stderr}\n${error.message}`));
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', onData);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      reject(new Error(`HUD-06 child exited before startup: code=${code} signal=${signal}\n${stderr}`));
    });
  });
  return info;
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
}

async function clientFor(info) {
  const page = await fetch(info.url);
  const html = await page.text();
  return {
    info,
    cookies: parseCookies(page),
    csrf: csrfFromHtml(html),
  };
}

async function getState(client) {
  const response = await fetch(`${client.info.origin}/api/state`, {
    headers: { Cookie: client.cookies },
  });
  return { status: response.status, body: await response.json() };
}

async function action(client, name, payload = {}) {
  const response = await fetch(`${client.info.origin}/api/action`, {
    method: 'POST',
    headers: {
      Cookie: client.cookies,
      Origin: client.info.origin,
      'X-HUD06-CSRF': client.csrf,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action: name, payload }),
  });
  return { status: response.status, body: await response.json() };
}

function assertOk(result, label) {
  if (result.status < 200 || result.status >= 300 || result.body?.ok !== true) {
    throw new Error(`${label} failed: ${JSON.stringify(result.body)}`);
  }
  return result.body.state;
}

async function completePreparation(client) {
  let state = (await getState(client)).body.state;
  if (state.stage === 'recovery_required') {
    state = assertOk(await action(client, 'recover'), 'recover');
  }
  if (state.stage === 'confirm_material') {
    state = assertOk(await action(client, 'confirm_material', {
      binding: state.material.binding,
      values: {
        content: state.material.candidate.content,
        responsibilities: state.material.candidate.responsibilities,
      },
    }), 'confirm_material');
  }
  if (state.stage === 'select_position') {
    state = assertOk(await action(client, 'select_position', { binding: state.position.binding }), 'select_position');
  }
  if (state.stage === 'prepare_plan') {
    state = assertOk(await action(client, 'prepare_plan', {
      positionBinding: state.position.binding,
      materialBinding: state.material.binding,
    }), 'prepare_plan');
  }
  if (state.stage === 'confirm_plan') {
    state = assertOk(await action(client, 'confirm_plan', { binding: state.plan.binding }), 'confirm_plan');
  }
  if (state.stage === 'run_fill') {
    state = assertOk(await action(client, 'run_fill', { binding: state.plan.binding }), 'run_fill');
  }
  if (state.stage !== 'prepared') throw new Error(`preparation did not finish: ${state.stage}`);
  return state;
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return filePath;
}

async function runCheck() {
  const artifactRoot = path.join(PRIVATE_ROOT, 'application-copilot', `hud-06-ledger-check-${randomUUID()}`);
  const sandboxPath = path.join(artifactRoot, 'sandbox');
  const reportPath = path.join(artifactRoot, 'hud-06-report.md');
  await fs.mkdir(artifactRoot, { recursive: true });
  let first = null;
  let second = null;
  try {
    const firstInfo = await startChild({ sandboxPath, reportPath });
    first = firstInfo.child;
    const firstClient = await clientFor(firstInfo);
    const prepared = await completePreparation(firstClient);
    await writeJson(path.join(artifactRoot, 'ledger-before-report.json'), prepared.ledger);

    const eventId = 'hud06-synthetic-user-report-1';
    const reportPayload = {
      binding: prepared.application.currentBinding,
      expectedLedgerRevision: prepared.ledger.revision,
      eventId,
      reportedAt: '2026-11-03T00:10:00.000Z',
      reference: 'SYNTHETIC-USER-REPORT-ONLY',
      blockReason: '虚构本人报告；没有可信官网回执或 ack。',
      confirmedByUser: true,
    };
    const reported = await action(firstClient, 'record_submission_report', reportPayload);
    const reportedState = assertOk(reported, 'record_submission_report');
    const repeated = await action(firstClient, 'record_submission_report', reportPayload);
    if (repeated.status !== 200 || repeated.body?.ok !== true || repeated.body?.result?.duplicate !== true) {
      throw new Error(`duplicate report was not idempotent: ${JSON.stringify(repeated.body)}`);
    }
    await writeJson(path.join(artifactRoot, 'ledger-after-report.json'), reportedState.ledger);
    const blockedReplay = await action(firstClient, 'run_fill', {});
    if (blockedReplay.status !== 409 || blockedReplay.body?.error?.code !== 'APPLICATION_RESULT_LOCKED') {
      throw new Error(`reported application did not block replay: ${JSON.stringify(blockedReplay.body)}`);
    }
    await stopChild(first);
    first = null;

    const secondInfo = await startChild({ sandboxPath, reportPath });
    second = secondInfo.child;
    const secondClient = await clientFor(secondInfo);
    const restarted = (await getState(secondClient)).body.state;
    if (restarted.ledger.application?.status !== 'submitted_reported'
      || restarted.ledger.revision !== reportedState.ledger.revision) {
      throw new Error(`ledger did not survive process restart: ${JSON.stringify(restarted.ledger)}`);
    }
    await writeJson(path.join(artifactRoot, 'ledger-after-restart.json'), restarted.ledger);
    const repeatedAfterRestart = await action(secondClient, 'record_submission_report', reportPayload);
    if (repeatedAfterRestart.status !== 200 || repeatedAfterRestart.body?.result?.duplicate !== true) {
      throw new Error(`restart duplicate report was not idempotent: ${JSON.stringify(repeatedAfterRestart.body)}`);
    }
    const blockedAfterRestart = await action(secondClient, 'run_fill', {});
    if (blockedAfterRestart.status !== 409 || blockedAfterRestart.body?.error?.code !== 'APPLICATION_RESULT_LOCKED') {
      throw new Error(`restart did not preserve replay block: ${JSON.stringify(blockedAfterRestart.body)}`);
    }
    await stopChild(second);
    second = null;

    const summary = {
      schemaVersion: HUD_06_LOCAL_LEDGER_SCHEMA_VERSION,
      synthetic: true,
      externalNetworkCalls: 0,
      processRestart: true,
      firstPid: firstInfo.child.pid,
      secondPid: secondInfo.child.pid,
      statusBeforeReport: prepared.application.status,
      statusAfterReport: reportedState.application.status,
      statusAfterRestart: restarted.ledger.application.status,
      duplicateReport: true,
      replayBlockedBeforeRestart: true,
      replayBlockedAfterRestart: true,
      artifactRoot,
      reportPath,
    };
    await writeJson(path.join(artifactRoot, 'check-summary.json'), summary);
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await stopChild(second).catch(() => {});
    await stopChild(first).catch(() => {});
  }
}

const scenario = optionValue('scenario', 'happy');
const reportPath = optionValue('report', null);
const sandboxPath = optionValue('sandbox', null);

if (process.argv.includes('--check')) {
  try {
    await runCheck();
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  }
} else {
  let app = null;
  let stopping = null;
  const stop = async () => {
    if (stopping) return stopping;
    stopping = (async () => { if (app) await app.stop(); })();
    return stopping;
  };
  process.once('SIGINT', () => { void stop().finally(() => process.exit(0)); });
  process.once('SIGTERM', () => { void stop().finally(() => process.exit(0)); });
  try {
    app = await createHud06LocalLedgerServer({ scenario, sandboxPath, reportPath: reportPath || undefined });
    console.log(JSON.stringify({
      schemaVersion: app.schemaVersion,
      url: app.url,
      origin: app.origin,
      port: app.port,
      sandboxPath: app.sandboxPath,
      scenario: app.scenario,
      synthetic: true,
      externalNetwork: false,
      realSubmission: false,
      note: '打开 URL 进入离线台账试用；按 Ctrl+C 关闭。',
    }));
    await new Promise(() => {});
  } catch (error) {
    await stop().catch(() => {});
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  }
}
