import { ledgerStore, useLedger } from "../ledger/store";
import { formatTime } from "../ledger/ids";

export default function ConflictPanel() {
  const ledger = useLedger();
  const conflicts = ledger.conflicts;

  return (
    <section className="panel">
      <div className="heading">
        <div>
          <p>字段级合并</p>
          <h2>两处改动待确认（{conflicts.length}）</h2>
        </div>
      </div>
      {conflicts.length === 0 && <p className="empty">没有待确认冲突。两台平板改到同一字段且不一致时，各留一版到这里。</p>}
      <div className="conflict-list">
        {conflicts.map((c) => (
          <article key={c.id} className="conflict-card">
            <div className="conflict-head">
              <strong>
                {c.kind === "order" ? "工单" : c.kind === "damage" ? "损伤点" : "修补"} {c.entityId}
              </strong>
              <span className="conflict-field">{c.label}</span>
            </div>
            {c.field !== "existence" && (
              <div className="conflict-base">基线：{c.base || "（空）"}</div>
            )}
            <div className="conflict-versions">
              <div className="conflict-version">
                <header>本机版 {c.localAt ? `· ${formatTime(c.localAt)}` : ""}</header>
                <p>{c.local || "（空）"}</p>
                <button onClick={() => ledgerStore.resolveConflict(c.id, "local")}>采用本机版</button>
              </div>
              <div className="conflict-version">
                <header>对端版 {c.remoteAt ? `· ${formatTime(c.remoteAt)}` : ""}</header>
                <p>{c.remote || "（空）"}</p>
                <button onClick={() => ledgerStore.resolveConflict(c.id, "remote")}>采用对端版</button>
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
