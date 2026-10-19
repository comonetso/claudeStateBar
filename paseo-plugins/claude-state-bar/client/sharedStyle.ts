type Entry = { version: number; css: string | null };
type StyleHub = { users: Map<object, Entry>; shown: { id: string; css: string } | null };

/** DOM은 호출자가 맡는다. 연결마다 한 표, 마지막 연결이 내려갈 때만 시트를 걷는다. */
export function retainSharedStyle(id: string, version: number, write: (id: string, css: string | null) => void) {
  const g = globalThis as Record<string, unknown>;
  const hubs = (g.__claudeStateBar_sharedStyles_v1 ??= new Map<string, StyleHub>()) as Map<string, StyleHub>;
  let hub = hubs.get(id);
  if (!hub) { hub = { users: new Map(), shown: null }; hubs.set(id, hub); }
  const state = hub;
  const token = {};
  const entry: Entry = { version, css: null };
  state.users.set(token, entry);
  const apply = () => {
    let winner: Entry | null = null;
    for (const candidate of state.users.values()) {
      if (candidate.css !== null && (!winner || candidate.version >= winner.version)) winner = candidate;
    }
    // 아직 그려지지 않은 연결만 남아도 페이지 테마의 마지막 칠은 유지한다.
    const next = winner ? { id: `${id}-v${winner.version}`, css: winner.css! } : state.users.size ? state.shown : null;
    if (state.shown && state.shown.id !== next?.id) write(state.shown.id, null);
    if (next) write(next.id, next.css); // 실제 시트가 없어졌다면 다시 넣는다.
    state.shown = next;
  };
  let disposed = false;
  return {
    set(css: string): void { if (!disposed) { entry.css = css; apply(); } },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      state.users.delete(token);
      apply();
      if (!state.users.size) hubs.delete(id);
    },
  };
}
