import { useMemo, useState } from "react";
import { useLedger } from "../ledger/store";
import { formatTime } from "../ledger/ids";

export default function HistoryPanel() {
  const ledger = useLedger();
  const [query, setQuery] = useState("");

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const damages = Object.values(ledger.damages).sort((a, b) => b.updatedAt - a.updatedAt);
    const repairs = Object.values(ledger.repairs).sort((a, b) => b.updatedAt - a.updatedAt);
    if (!q) return { damages, repairs };
    const match = (s: string) => s.toLowerCase().includes(q);
    return {
      damages: damages.filter(
        (d) => match(d.id) || match(d.orderId) || match(d.location) || match(d.kind) || match(d.note),
      ),
      repairs: repairs.filter(
        (r) =>
          match(r.id) ||
          match(r.orderId) ||
          match(r.damageId) ||
          match(r.damageLocation) ||
          match(r.material) ||
          match(r.method) ||
          match(r.result),
      ),
    };
  }, [ledger, query]);

  return (
    <section className="panel">
      <div className="heading">
        <div>
          <p>历史留档</p>
          <h2>损伤 / 修补位置查询（作废也留档）</h2>
        </div>
      </div>
      <input
        className="search"
        placeholder="搜编号 / 位置 / 材料 / 工单号，如 DMG-0001、板头、P-Tex"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <div className="history-columns">
        <div>
          <h3>底板损伤点（{results.damages.length}）</h3>
          {results.damages.length === 0 && <p className="empty">无匹配</p>}
          <div className="records">
            {results.damages.map((d) => (
              <article key={d.id}>
                <b>{d.id}</b>
                <div>
                  <h3>
                    {d.orderId} · {d.location || "（未填位置）"}
                  </h3>
                  <p>
                    {d.kind} · {d.size || "—"} · {d.note || "无备注"}
                  </p>
                  <p className="entity-meta">
                    更新于 {formatTime(d.updatedAt)} · {d.updatedBy} · v{d.version}
                  </p>
                </div>
              </article>
            ))}
          </div>
        </div>

        <div>
          <h3>修补记录（{results.repairs.length}）</h3>
          {results.repairs.length === 0 && <p className="empty">无匹配</p>}
          <div className="records">
            {results.repairs.map((r) => (
              <article key={r.id} className={r.invalid ? "record-invalid" : ""}>
                <b>{r.id}</b>
                <div>
                  <h3>
                    {r.orderId} · 关联 {r.damageId}
                    {r.invalid && <span className="invalid-badge">已作废</span>}
                    {r.confirmed && !r.invalid && <span className="ok-badge">已确认</span>}
                  </h3>
                  <p>
                    {r.material} · {r.method || "—"} · {r.result || "无结果"}
                  </p>
                  <p className="entity-meta">
                    位置留档：{r.damageLocation || "—"} · 更新于 {formatTime(r.updatedAt)}
                  </p>
                  {r.invalid && <p className="invalid-reason">作废原因：{r.invalidReason}</p>}
                </div>
              </article>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
