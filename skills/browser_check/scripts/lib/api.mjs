/*
 * `browser-check api [name or part]` — what a script can call, without reading the plugin's source.
 * bc.* helpers are described here (keep in step with scripts/ego/prelude.mjs); ego's own functions come live from
 * ego's help() (so an ego update cannot leave this behind). Agents read the plugin's source 152 times in the
 * 2026-09/10 records looking for exactly this.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export const BC_API = [
  { name: 'bc.run', sig: "const r = await bc.run('<short-task-name>', async ({ task, page }) => { … }, { prep? })", what: 'Open (or resume) your own task space, prep the page, run fn, then close the space once 0 requests are in flight — also when fn throws. r = { result, closed }. If it never settles with only GETs open (a live page) it is blanked and closed (closed.settle.cut); with a write open it is left open and LEFT_OPEN is reported.' },
  { name: 'bc.shot', sig: "bc.out('SHOT', await bc.shot(page, '<name>', { fullPage?, timeoutMs? }))", what: 'A PNG capture that also works while ego is minimized (screencast) or closed with X (reopens it minimized). Returns { ok, via, ms, reopened? }; the image becomes a file in `images`. fullPage also works minimized (the page is resized to its own height for one frame; result in fullPage: { whole, height, pageHeight }).' },
  { name: 'bc.setWidth', sig: 'await bc.setWidth(page, width, height?, { mobile? })', what: "An exact CSS width: corrects for ego's page zoom, which made a plain Emulation.setDeviceMetricsOverride of 1280 come out as 1164. mobile defaults to width < 768. Returns { asked, width, height }. Undo with Emulation.clearDeviceMetricsOverride." },
  { name: 'bc.popups', sig: 'await bc.popups(task)', what: 'Windows of this task not seen yet get the same guard, in-flight counter and event record as the first page; returns the new ones [{ label, url, error? }]. Page actions in bc.run do this from their receipt; call it after anything else that may open a window. A request in the first moments of the window can still go out unblocked.' },
  { name: 'bc.beforeGuard', sig: 'await bc.beforeGuard(page)', what: 'URLs of fetch/XHR/beacon requests that started in this document before the guard reached it (a window that was already loading). They were not blocked and may have written — report them.' },
  { name: 'bc.otherPages', sig: 'await bc.otherPages(task, page)', what: "The task's pages other than this one, e.g. the windows a click opened." },
  { name: 'bc.watch', sig: 'await bc.watch(page, { console? })', what: "Start recording console, exceptions, log and network events. Call before the step you want to watch. It turns off ego's hiding of console messages (a page can then detect CDP) unless console: false or --no-console." },
  { name: 'bc.problems', sig: "bc.out('PROBLEMS', await bc.problems(page))", what: 'consoleState says whether console counts can be trusted (on · hidden · blind · not watched; unless on, a 0 is reported as null). Errors only: console errors, exceptions, log errors, failed requests, 4xx/5xx responses; browser-extension noise in .ext. Has .summary counts.' },
  { name: 'bc.sent', sig: 'await bc.sent(page, { since? })', what: 'Every request other than GET/HEAD/OPTIONS the page sent since bc.watch (or since a bc.mark index), with its response status — what a click saved or sent.' },
  { name: 'bc.mark', sig: 'const at = await bc.mark(page)', what: 'A position in the event record, for bc.sent(page, { since: at }).' },
  { name: 'bc.events', sig: 'await bc.events(page, { keep? })', what: "Pull ego's event buffer (use this, never page.events() — that empties the buffer bc.problems reads)." },
  { name: 'bc.settle', sig: 'await bc.settle(page, maxMs?)', what: 'Wait until no fetch/XHR is open and the resource count is stable (5 checks, 500 ms apart). { settled, ms }.' },
  { name: 'bc.finish', sig: 'await bc.finish(task, page)', what: 'Close the space after it settles (bc.run does this for you).' },
  { name: 'bc.prep', sig: 'await bc.prep(page, { light? })', what: 'In-flight counter, the light colour scheme and bc.fixViewport (bc.run does this for you).' },
  { name: 'bc.fixViewport', sig: 'await bc.fixViewport(page)', what: "A page with no size (0x0 — a tab opened in a minimized ego window that was never shown) gets its window's size through device metrics, so it paints and captures; a page with a size is left alone, the window is not touched. bc.run and bc.shot do this for you." },
  { name: 'bc.guardWrites', sig: "await bc.guardWrites(page, { allow: ['/api/token/refresh'] })", what: 'Refuse non-GET fetch/XHR/sendBeacon/form submits in the page unless the path is allowed (self-tests first). Prefer the --guard-writes option. On a logged-in site the token-refresh path must be allowed — ask the user for it.' },
  { name: 'bc.guardReport', sig: 'await bc.guardReport(page)', what: 'What the guard refused: { blocked: [{ kind, method, url }], allow }.' },
  { name: 'bc.kit', sig: "await bc.kit(page, '<kit>')", what: 'Run one of the in-page kits (list below) in the page; write the name literally so the runner sends that kit.' },
  { name: 'bc.kitSource', sig: "bc.kitSource(page, '<kit>')", what: "A kit's source text, e.g. for Page.addScriptToEvaluateOnNewDocument." },
  { name: 'bc.out', sig: "bc.out('<TAG>', value)", what: 'Return data: it appears in the result under outs.<TAG>.' },
  { name: 'bc.img', sig: "bc.img('<name>.png', buffer)", what: 'Return a file (any bytes): it is saved and listed in `images`.' },
  { name: 'bc.url', sig: 'bc.url', what: 'The --url this run was given.' },
  { name: 'bc.ensureWindow', sig: 'bc.ensureWindow()', what: 'Reopen ego minimized when every window was closed with X (bc.shot does this when it must). Never move or resize ego windows yourself.' },
];

/** ego's help() text → [{ name, desc, sig }]. Blocks are "name\n\ndescription\n\nsignature" separated by blank lines. */
export function parseHelp(text) {
  const parts = String(text).replace(/\r/g, '').split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < parts.length; i += 3) out.push({ name: parts[i], desc: parts[i + 1] || '', sig: parts[i + 2] || '' });
  return out;
}

export const HELP_SCRIPT = "bc.out('HELP', help());\n";

export function kits(kitDir) {
  try { return readdirSync(kitDir).filter((f) => f.endsWith('.js')).map((f) => f.replace(/\.js$/, '')).sort(); } catch { return []; }
}

/** The answer for `api [query]`. egoBlocks = parseHelp(help()) or null when ego could not be asked. */
export function answer(query, egoBlocks, kitNames) {
  const q = String(query || '').toLowerCase().trim();
  const ego = egoBlocks || [];
  if (!q) {
    return {
      how: 'browser-check api <name or part> — e.g. `api click`, `api bc.shot`, `api snapshot`, `api keyboard`',
      bc: BC_API.map((x) => x.sig),
      ego: ego.map((x) => x.name),
      kits: kitNames,
      egoAvailable: !!egoBlocks,
      selectors: "@12 / ref=12 from a snapshot of the same page · text=… (text=\"…\" is exact) · loc=role:button[name='Save'] · loc=css:… · loc=href:… · xpath=… · raw CSS · >> nth=0 picks one of several — exactly one match or it fails",
    };
  }
  const hit = (name) => name.toLowerCase().includes(q);
  const bcHits = BC_API.filter((x) => hit(x.name));
  const egoHits = ego.filter((x) => hit(x.name));
  const many = bcHits.length + egoHits.length > 12;
  return {
    query,
    bc: bcHits.map((x) => (many ? x.name : x)),
    ego: egoHits.map((x) => (many ? x.name : x)),
    note: many ? 'many matches — ask for one name for the details' : (bcHits.length + egoHits.length === 0 ? 'nothing matches — `browser-check api` lists every name' + (egoBlocks ? '' : ' (ego could not be asked this time)') : undefined),
  };
}

export const KIT_DIR_REL = join('scripts', 'kit');
