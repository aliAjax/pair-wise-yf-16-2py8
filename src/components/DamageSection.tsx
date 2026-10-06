import { useState } from "react";
import { ledgerStore, useLedger } from "../ledger/store";
import type { DamagePoint } from "../ledger/types";
import { formatTime } from "../ledger/ids";

interface Props {
  orderId: string;
}

export default function DamageSection({ orderId }: Props) {
  const ledger = useLedger();
  const damages = Object.values(ledger.damages)
    .filter((d) => d.orderId === orderId)
    .sort((a, b) => a.createdAt - b.createdAt);

  return (
    <section className="panel sub-panel">
      <div className="heading">
        <div>
          <p>底板损伤标记</p>
          <h3>损伤点（稳定编号，改位置不改号）</h3>
        </div>
        <button onClick={() => ledgerStore.addDamage(orderId)}>新增损伤点</button>
      </div>

      {damages.length === 0 && <p className="empty">暂无损伤点，点「新增损伤点」标记第一处底板损伤。</p>}

      <div className="entity-list">
        {damages.map((d) => (
          <DamageRow key={d.id} damage={d} />
        ))}
      </div>
    </section>
  );
}

function DamageRow({ damage }: { damage: DamagePoint }) {
  const [draft, setDraft] = useState<DamagePoint>(damage);
  const [dirty, setDirty] = useState(false);
  const linkedRepairs = useLedgerValue(damage.id);

  const set = <K extends keyof DamagePoint>(key: K, value: DamagePoint[K]) => {
    setDraft((p) => ({ ...p, [key]: value }));
    setDirty(true);
  };

  return (
    <article className="entity-card">
      <div className="entity-id">
        <b>{damage.id}</b>
        <span>v{damage.version}</span>
      </div>
      <div className="entity-body">
        <div className="field-grid">
          <label>
            <span>损伤位置</span>
            <input
              value={draft.location}
              placeholder="如：板头左侧 12cm"
              onChange={(e) => set("location", e.target.value)}
            />
          </label>
          <label>
            <span>损伤类型</span>
            <input value={draft.kind} onChange={(e) => set("kind", e.target.value)} />
          </label>
          <label>
            <span>尺寸</span>
            <input value={draft.size} onChange={(e) => set("size", e.target.value)} />
          </label>
          <label>
            <span>备注</span>
            <input value={draft.note} onChange={(e) => set("note", e.target.value)} />
          </label>
        </div>
        <div className="entity-footer">
          <span className="entity-meta">
            更新于 {formatTime(damage.updatedAt)} · {damage.updatedBy}
            {linkedRepairs > 0 && ` · 关联修补 ${linkedRepairs} 处`}
          </span>
          <div className="entity-actions">
            <button
              className="primary"
              disabled={!dirty}
              onClick={() => {
                ledgerStore.upsertDamage(draft);
                setDirty(false);
              }}
            >
              保存损伤点
            </button>
            <button
              className="danger"
              onClick={() => {
                if (confirm(`删除损伤点 ${damage.id}？关联修补将保留并标记。`)) {
                  ledgerStore.commitDeleteDamage(damage.id);
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

function useLedgerValue(damageId: string): number {
  const ledger = useLedger();
  return Object.values(ledger.repairs).filter((r) => r.damageId === damageId).length;
}
