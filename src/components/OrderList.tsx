import { OrderRecord } from "../ledger/types";
import { WaxEligibility } from "../ledger/merge";

interface Props {
  orders: OrderRecord[];
  selectedId: string | null;
  waxFor: (order: OrderRecord) => WaxEligibility;
  onOpen: (id: string) => void;
}

export default function OrderList({ orders, selectedId, waxFor, onOpen }: Props) {
  if (orders.length === 0) {
    return <p className="muted">没有符合筛选条件的工单。</p>;
  }
  return (
    <div className="order-list">
      {orders.map((o) => {
        const wax = waxFor(o);
        const openDamage = o.damages.filter((d) => d.status.value !== "已修补").length;
        const unconfirmed = o.repairs.filter((r) => r.confirmed.value !== "是").length;
        const dangling = o.repairs.filter(
          (r) => r.damageId && !o.damages.some((d) => d.id === r.damageId),
        ).length;
        const conflictCount =
          Object.values(o.fields).filter((t) => t.conflict && t.conflict.resolvedValue === undefined).length +
          o.damages.reduce(
            (n, d) =>
              n +
              (["kind", "position", "sizeCm", "note", "status"] as const).filter(
                (f) => d[f].conflict && d[f].conflict!.resolvedValue === undefined,
              ).length,
            0,
          ) +
          o.repairs.reduce(
            (n, r) =>
              n +
              (["material", "method", "technician", "confirmed", "confirmNote"] as const).filter(
                (f) => r[f].conflict && r[f].conflict!.resolvedValue === undefined,
              ).length,
            0,
          );
        return (
          <article
            key={o.id}
            className={`order-card status-${o.fields.status.value || "none"} ${selectedId === o.id ? "selected" : ""}`}
            onClick={() => onOpen(o.id)}
          >
            <header className="order-card-head">
              <b>{o.fields.orderNo.value || o.id}</b>
              <span className="status-tag">{o.fields.status.value || "未设定状态"}</span>
            </header>
            <p className="order-line">
              {[o.fields.brand.value, o.fields.lengthCm.value && `${o.fields.lengthCm.value}cm`, o.fields.boardType.value]
                .filter(Boolean)
                .join(" · ") || "（未填板具信息）"}
            </p>
            <p className="order-line">
              刃角 侧{o.fields.edgeSideDeg.value || "—"}° / 底{o.fields.edgeBaseDeg.value || "—"}° ·{" "}
              蜡：{o.fields.waxType.value || "未选"}
            </p>
            <div className="order-tags">
              <span className="tag">损伤点 {o.damages.length}{openDamage > 0 ? `（待修${openDamage}）` : ""}</span>
              <span className="tag">修补 {o.repairs.length}{unconfirmed > 0 ? `（待确认${unconfirmed}）` : ""}</span>
              <span className={`tag ${wax.eligible ? "tag-ok" : "tag-block"}`}>
                {wax.eligible ? "✓ 具备打蜡资格" : "✗ 暂不可打蜡"}
              </span>
              {dangling > 0 && <span className="tag tag-warn">旧修补待关联×{dangling}</span>}
              {conflictCount > 0 && <span className="tag tag-warn">⚠ 冲突×{conflictCount}</span>}
            </div>
            {!wax.eligible && (
              <ul className="wax-reasons">
                {wax.reasons.slice(0, 3).map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
                {wax.reasons.length > 3 && <li>另有 {wax.reasons.length - 3} 项…</li>}
              </ul>
            )}
            <p className="order-line muted">客户：{o.fields.customer.value || "—"} · {o.fields.preference.value || "无偏好"}</p>
          </article>
        );
      })}
    </div>
  );
}
