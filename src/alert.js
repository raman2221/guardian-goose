// =============================================================================
//  alert.js — operator dead-man alerts by email, sent directly to the
//  recipient's mail server (no relay account or credentials required).
// -----------------------------------------------------------------------------
//  Definitions:
//    RETRIES      backoff schedule (ms) used to ride out greylisting
//    MX           recipient domain's mail exchanger, resolved via dig
//    senderDomain the VPS reverse-DNS name, used as the From: domain
// =============================================================================

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const run = promisify(execFile);
const RETRIES = [0, 5 * 60_000, 15 * 60_000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ALERT_COOLDOWN_MS = 60 * 60_000;
const lastAlert = new Map();

async function resolveMx(domain) {
  const { stdout } = await run('dig', ['+short', 'MX', domain]);
  const rows = stdout.trim().split('\n').filter(Boolean)
    .map((l) => { const [prio, host] = l.split(/\s+/); return { prio: +prio, host: host?.replace(/\.$/, '') }; })
    .filter((r) => r.host).sort((a, b) => a.prio - b.prio);
  if (!rows.length) throw new Error(`no MX for ${domain}`);
  return rows[0].host;
}

async function senderDomain() {
  try {
    const { stdout: ip } = await run('curl', ['-s', '--max-time', '10', 'https://api.ipify.org']);
    const { stdout } = await run('dig', ['+short', '-x', ip.trim()]);
    const r = stdout.trim().split('\n')[0]?.replace(/\.$/, '');
    if (r) return r;
  } catch {}
  return os.hostname();
}

function foldBase64(s) {
  return s.match(/.{1,76}/g).join('\r\n');
}

function composeMessage(from, to, subject, payload) {
  const headers = [
    'From: WhatsApp Antispam Bot <' + from + '>',
    'To: <' + to + '>',
    'Subject: ' + subject,
    'Date: ' + new Date().toUTCString(),
    'Message-ID: <' + Date.now() + '.' + Math.floor(Math.random() * 1e9) + '@' + from.split('@')[1] + '>',
  ];
  if (typeof payload === 'string') {
    return headers.join('\r\n') + '\r\n\r\n' + payload + '\r\n';
  }
  const text = payload && payload.text ? payload.text : '';
  const attachments = Array.isArray(payload && payload.attachments) ? payload.attachments : [];
  if (!attachments.length) {
    return headers.join('\r\n') + '\r\nContent-Type: text/plain; charset="utf-8"\r\n\r\n' + text + '\r\n';
  }
  const boundary = '----=_GuardianGoose_' + Date.now() + '_' + Math.random().toString(16).slice(2);
  const parts = [];
  parts.push('Content-Type: multipart/mixed; boundary="' + boundary + '"');
  parts.push('');
  parts.push('--' + boundary);
  parts.push('Content-Type: text/plain; charset="utf-8"');
  parts.push('');
  parts.push(text);
  parts.push('');
  for (const a of attachments) {
    parts.push('--' + boundary);
    parts.push('Content-Type: ' + a.contentType);
    parts.push('Content-Disposition: attachment; filename="' + a.filename + '"');
    parts.push('Content-Transfer-Encoding: base64');
    parts.push('');
    parts.push(foldBase64(a.base64));
    parts.push('');
  }
  parts.push('--' + boundary + '--');
  parts.push('');
  return headers.join('\r\n') + '\r\n' + parts.join('\r\n');
}

async function attempt(mx, from, to, subject, payload) {
  const file = path.join(os.tmpdir(), 'alert-' + process.pid + '-' + Date.now() + '.eml');
  const msg = composeMessage(from, to, subject, payload);
  await writeFile(file, msg);
  try {
    await run('curl', ['-s', '--max-time', '60', '--url', 'smtp://' + mx + ':25', '--mail-from', from, '--mail-rcpt', to, '-T', file]);
    return 'ok';
  } catch (e) {
    const out = '' + (e.stdout || '') + (e.stderr || '') + (e.message || '');
    return /45\d/.test(out) || e.code === 8 ? 'temp' : 'fail';
  } finally {
    await unlink(file).catch(() => {});
  }
}

async function deliverEmail(cfg, subject, payload) {
  if (!cfg.alertEmail) return false;
  try {
    const to = cfg.alertEmail;
    const mx = await resolveMx(to.split('@')[1]);
    const from = 'antispam@' + await senderDomain();
    for (const delay of RETRIES) {
      if (delay) await sleep(delay);
      const r = await attempt(mx, from, to, subject, payload);
      if (r === 'ok') { console.log('alert email accepted by ' + mx); return true; }
      if (r === 'fail') console.error('alert email hard-failed, will still retry');
      else console.log('alert email greylisted (451), retrying later');
    }
    console.error('alert email: all retries exhausted');
    return false;
  } catch (e) {
    console.error('alert email error:', e.message);
    return false;
  }
}

export async function sendAlert(cfg, subject, body) {
  const prev = lastAlert.get(subject) || 0;
  if (Date.now() - prev < ALERT_COOLDOWN_MS) { console.log('alert suppressed (cooldown):', subject); return false; }
  lastAlert.set(subject, Date.now());
  return deliverEmail(cfg, subject, body);
}

export async function sendEmail(cfg, subject, payload) {
  return deliverEmail(cfg, subject, payload);
}
