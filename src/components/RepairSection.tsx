import { useState } from "react";
import { ledgerStore, useLedger } from "../ledger/store";
import type { RepairRecord } from "../ledger/types";
import { formatTime } from "../ledger/ids";

interface Props {
  orderId: string;
}

export default function RepairSection({ orderId }: Props) {
  const ledger = useLedger();
  const repairs = Object.values(ledger.repairs)
    .filter((r) => r.orderId === orderId)
    .sort((a, b) => a.createdAt - b.createdAt);
  const damages = Object.values(ledger.damages)
    .filter((d) => d.orderId === orderId)
    .sort((a, b) => a.createdAt - b.createdAt);

  return (
    <section className="panel sub-panel">
      <div className="heading">
        <div>
          <p>修补记录</p>
          <h3>关联真实损伤点，材料改动即作废</h3>
        </div>
        <button
          disabled={damages.length === 0}
          title={damages.length === 0 ? "请先新增损伤点" : "新增修补记录"}
          onClick={() => ledgerStore.addRepair(orderId, damages[0]?.id ?? "")}
        >
          新增修补
        </button>
      </div>

      {damages.length === 0 && (
        <p className="empty">还没有损伤点，修补记录必须关联真实损伤点，请先到上方新增。</p>
      )}
      {repairs.length === 0 && damages.length > 0 && <p className="empty">暂无修补记录。</p>}

      <div className="entity-list">
        {repairs.map((r) => (
          <RepairRow key={r.id} repair={r} damageOptions={damages.map((d) => ({ id: d.id, location: d.location }))} />
        ))}
      </div>
    </section>
  );
}

function RepairRow({
  repair,
  damageOptions,
}: {
  repair: RepairRecord;
  damageOptions: { id: string; location: string }[];
}) {
  const [draft, setDraft] = useState<RepairRecord>(repair);
  const [dirty, setDirty] = useState(false);

  const set = <K extends keyof RepairRecord>(key: K, value: RepairRecord[K]) => {
    setDraft((p) => ({ ...p, [key]: value }));
    setDirty(true);
  };

  return (
    <article className={`entity-card ${repair.invalid ? "entity-invalid" : ""}`}>
      <div className="entity-id">
        <b>{repair.id}</b>
        <span>v{repair.version}</span>
      </div>
      <div className="entity-body">
        <div className="field-grid">
          <label>
            <span>关联损伤点</span>
            <select
              value={draft.damageId}
              onChange={(e) => set("damageId", e.target.value)}
            >
              {damageOptions.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.id} · {d.location || "（未填位置）"}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>修补材料</span>
            <input value={draft.material} onChange={(e) => set("material", e.target.value)} />
          </label>
          <label>
            <span>修补方式</span>
            <input value={draft.method} onChange={(e) => set("method", e.target.value)} />
          </label>
          <label>
            <span>修补结果</span>
            <input value={draft.result} onChange={(e) => set("result", e.target.value)} />
          </label>
        </div>

        <div className="repair-flags">
          <label className="check">
            <input
              type="checkbox"
              checked={draft.confirmed}
              onChange={(e) => {
                set("confirmed", e.target.checked);
              }}
            />
            <span>已确认修补</span>
          </label>
          {repair.invalid && (
            <span className="invalid-badge" title={repair.invalidReason}>
              已作废：{repair.invalidReason}
            </span>
          )}
          {repair.confirmed && !repair.invalid && <span className="ok-badge">有效</span>}
        </div>

        <div className="entity-footer">
          <span className="entity-meta">
            更新于 {formatTime(repair.updatedAt)} · {repair.updatedBy}
            {repair.confirmedAt ? ` · 确认于 ${formatTime(repair.confirmedAt)}` : ""}
            {repair.damageLocation ? ` · 损伤点位置留档：${repair.damageLocation}` : ""}
          </span>
          <div className="entity-actions">
            <button
              className="primary"
              disabled={!dirty}
              onClick={() => {
                ledgerStore.upsertRepair(draft);
                setDirty(false);
              }}
            >
              保存修补
            </button>
            <button
              className="danger"
              onClick={() => {
                if (confirm(`删除修补记录 ${repair.id}？`)) {
                  ledgerStore.commitDeleteRepair(repair.id);
                }
              }}
            >
              删除
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}
