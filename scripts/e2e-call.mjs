// End-to-end check against the real GPT-Live API: headless Chromium plays a
// synthesized spoken request as its microphone, places a call through the
// dashboard, and waits for a delegation, a subagent result, and a spoken
// reply. Costs one short GPT-Live session plus the backend calls.
//
//   node scripts/e2e-call.mjs [http://127.0.0.1:4520] ["spoken request"]
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const base = process.argv[2] ?? 'http://127.0.0.1:4520';
const request = process.argv[3] ?? 'Hi Kit. Can you look up the current weather in Boston for me?';
const out = resolve('e2e-output');
mkdirSync(out, { recursive: true });
const wav = join(out, 'request.wav');
// The fake microphone loops its file, so the request is followed by a long silence.
if (!existsSync(wav) || process.argv[3]) {
  execFileSync('say', ['-v', 'Samantha', '-o', join(out, 'request.aiff'), `[[slnc 4000]] ${request} [[slnc 45000]]`]);
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@48000', '-c', '1', join(out, 'request.aiff'), wav]);
}

const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, permissions: ['microphone'] });
const page = await context.newPage();
page.on('console', message => { if (message.type() === 'error') console.log('[browser]', message.text()); });
const step = async (name, fn) => { const t = Date.now(); await fn(); console.log(`ok  ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)`); };
let failed = false;
try {
  await page.goto(base);
  await step('dashboard loaded', () => page.waitForSelector('#btn-connect'));
  await page.click('#btn-connect');
  await step('call live (session.started on the data channel)', () => page.waitForSelector('#status[data-state="live"]', { timeout: 30000 }));
  await step('user speech transcribed', () => page.waitForSelector('.turn.user', { timeout: 30000 }));
  await step('GPT-Live delegated', () => page.waitForFunction(() => [...document.querySelectorAll('.step .route')].some(n => n.textContent === 'GPT-Live to Orchestrator'), null, { timeout: 40000 }));
  await step('subagent started', () => page.waitForSelector('.agent', { timeout: 40000 }));
  await step('subagent finished', () => page.waitForSelector('.agent[data-status="done"], .agent[data-status="failed"]', { timeout: 90000 }));
  await step('result sent to GPT-Live and acknowledged', () => page.waitForFunction(() => [...document.querySelectorAll('.step.from-subagent .meta')].some(n => n.textContent.includes('accepted')), null, { timeout: 30000 }));
  // Give the voice time to speak the result, then try two composer presets.
  await page.waitForTimeout(8000);
  for (const preset of ['Quiet progress', 'Stop talking']) {
    await page.click(`#presets button:text-is("${preset}")`);
    await step(`preset "${preset}" accepted`, () => page.waitForFunction(() => [...document.querySelectorAll('.step.manual .meta')].filter(n => n.textContent.includes('accepted')).length >= 1 + [...document.querySelectorAll('.step.manual')].indexOf([...document.querySelectorAll('.step.manual')].at(-1)), null, { timeout: 15000 }));
  }
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(out, 'dashboard.png') });
  await page.click('#btn-hangup');
  await step('call closed (session.closed)', () => page.waitForFunction(() => document.querySelector('#status').textContent === 'Call ended', null, { timeout: 20000 }));
} catch (error) {
  failed = true;
  console.log('FAIL', error.message.split('\n')[0]);
  await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
} finally {
  const summary = await page.evaluate(() => ({
    thread: [...document.querySelectorAll('#thread > .turn, #thread > .step, #thread > .agent, #thread > .divider')].map(n => n.innerText.replace(/\s+/g, ' ').slice(0, 220)),
    timeline: [...document.querySelectorAll('#timeline .ev:not([data-quiet])')].map(n => n.innerText.replace(/\s+/g, ' ').slice(0, 160))
  })).catch(() => null);
  if (summary) {
    console.log('\n--- thread ---'); for (const line of summary.thread) console.log(line);
    console.log('\n--- timeline ---'); for (const line of summary.timeline) console.log(line);
  }
  await browser.close();
  process.exit(failed ? 1 : 0);
}
