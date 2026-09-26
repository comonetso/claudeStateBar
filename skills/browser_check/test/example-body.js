// Example one-shot body for `browser-check.mjs run` — opens a harmless public page in OUR OWN tab, scans, captures, closes.
const tab = await openTab('https://example.com/');
const ownId = tab.targetId; // the same id appears in listBrowserTabs(); counting by URL would also count the user's own tabs
const env = await K.G('prep', () => K.prep(tab, { darkReader: 'must-be-off-warn' }), 8000);
K.out('ENV', env && env.after ? { darkReader: env.after.darkReader, injected: env.after.injected, iw: env.after.iw, dpr: env.after.dpr, warnings: env.warnings } : env);
K.out('FPS', await K.G('wake', () => K.wake(tab), 15000)); // wake = up to 3 captures + 1 s fps samples — give it 15 s
K.out('X', { hasX: K.hasX(tab) });
if (K.hasX(tab)) K.out('AX', await K.G('ax', async () => { await K.X(tab, 'Accessibility.enable'); const t = await K.X(tab, 'Accessibility.getFullAXTree'); return { nodes: (t.nodes || []).length }; }, 8000));
await K.img(tab, 'example', { type: 'jpeg', quality: 40 });
await closeTab(tab);
K.out('DONE', { leftTabs: (await listBrowserTabs()).filter((t) => t.targetId === ownId).length });
