import { useState } from "react";
import { ledgerStore, useLedger } from "../ledger/store";
import { ORDER_STATUS_LABEL, type OrderStatus, type WorkOrder } from "../ledger/types";
import { formatTime } from "../ledger/ids";
import { waxEligibility } from "../ledger/validity";
import DamageSection from "./DamageSection";
import RepairSection from "./RepairSection";

interface Props {
  orderId: string;
}

export default function OrderEditor({ orderId }: Props) {
  const ledger = useLedger();
  const order = ledger.orders[orderId];
  const [draft, setDraft] = useState<WorkOrder | null>(null);
  const [dirty, setDirty] = useState(false);

  if (!order) {
    return (
      <section className="panel editor">
        <p className="empty">工单不存在或已删除。</p>
      </section>
    );
  }

  const current = draft && draft.id === order.id ? draft : order;
  const wax = waxEligibility(ledger, order.id);

  const set = <K extends keyof WorkOrder>(key: K, value: WorkOrder[K]) => {
    setDraft((p) => ({ ...(p ?? order), [key]: value }));
    setDirty(true);
  };

  const save = () => {
    ledgerStore.upsertOrder(current);
    setDirty(false);
  };

  return (
    <section className="panel editor">
      <div className="heading">
        <div>
          <p>工单编辑</p>
          <h2>
            {order.id}
            <span className={`status-pill status-${order.status}`} style={{ marginLeft: 10 }}>
              {ORDER_STATUS_LABEL[order.status]}
            </span>
          </h2>
        </div>
        <div className="entity-actions">
          <button className="primary" disabled={!dirty} onClick={save}>
            保存工单
          </button>
          <button
            className="danger"
            onClick={() => {
              if (confirm(`删除工单 ${order.id}？其下损伤点与修补记录将一并删除。`)) {
                ledgerStore.commitDeleteOrder(order.id);
              }
            }}
          >
            删除工单
          </button>
        </div>
      </div>

      <div className={`wax-banner ${wax.eligible ? "wax-ok" : "wax-bad"}`}>
        <strong>打蜡资格：{wax.eligible ? "合格" : "作废"}</strong>
        <span>{wax.reason}</span>
      </div>

      <div className="field-grid">
        <label>
          <span>雪板品牌</span>
          <input value={current.boardBrand} onChange={(e) => set("boardBrand", e.target.value)} />
        </label>
        <label>
          <span>长度</span>
          <input value={current.boardLength} onChange={(e) => set("boardLength", e.target.value)} />
        </label>
        <label>
          <span>板型</span>
          <input value={current.boardType} onChange={(e) => set("boardType", e.target.value)} />
        </label>
        <label>
          <span>刃角</span>
          <input value={current.edgeAngle} onChange={(e) => set("edgeAngle", e.target.value)} />
        </label>
        <label>
          <span>打蜡类型</span>
          <input value={current.waxType} onChange={(e) => set("waxType", e.target.value)} />
        </label>
        <label>
          <span>客户偏好</span>
          <input value={current.customerPref} onChange={(e) => set("customerPref", e.target.value)} />
        </label>
        <label>
          <span>完工状态</span>
          <select
            value={current.status}
            onChange={(e) => set("status", e.target.value as OrderStatus)}
          >
            <option value="pending">待维护</option>
            <option value="in_progress">进行中</option>
            <option value="done">已完工</option>
          </select>
        </label>
      </div>

      <p className="entity-meta">
        最后更新于 {formatTime(order.updatedAt)} · {order.updatedBy} · 版本 v{order.version}
      </p>

      <DamageSection orderId={order.id} />
      <RepairSection orderId={order.id} />
    </section>
  );
}
