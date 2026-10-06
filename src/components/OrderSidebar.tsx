import { useMemo, useState } from "react";
import { ledgerStore, useLedger } from "../ledger/store";
import { ORDER_STATUS_LABEL, type OrderStatus } from "../ledger/types";
import { damageCount, waxEligibility } from "../ledger/validity";

const FILTERS: { key: OrderStatus | "all"; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "pending", label: "待维护" },
  { key: "in_progress", label: "进行中" },
  { key: "done", label: "已完工" },
];

interface Props {
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export default function OrderSidebar({ selectedId, onSelect }: Props) {
  const ledger = useLedger();
  const [filter, setFilter] = useState<OrderStatus | "all">("all");
  const [query, setQuery] = useState("");

  const orders = useMemo(() => {
    return Object.values(ledger.orders)
      .filter((o) => (filter === "all" ? true : o.status === filter))
      .filter((o) => {
        const q = query.trim();
        if (!q) return true;
        return (
          o.id.includes(q) ||
          o.boardBrand.includes(q) ||
          o.boardType.includes(q) ||
          o.customerPref.includes(q)
        );
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [ledger.orders, filter, query]);

  return (
    <aside className="panel sidebar">
      <div className="heading">
        <div>
          <p>工单列表</p>
          <h2>维护工单</h2>
        </div>
        <button
          className="primary"
          onClick={() => {
            const id = ledgerStore.addOrder();
            onSelect(id);
          }}
        >
          新增工单
        </button>
      </div>

      <input
        className="search"
        placeholder="搜工单编号 / 品牌 / 板型 / 客户偏好"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <div className="chips">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={filter === f.key ? "chip-active" : ""}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="order-list">
        {orders.length === 0 && <p className="empty">没有匹配的工单</p>}
        {orders.map((o) => {
          const wax = waxEligibility(ledger, o.id);
          const dmg = damageCount(ledger, o.id);
          return (
            <button
              key={o.id}
              className={`order-item ${selectedId === o.id ? "selected" : ""}`}
              onClick={() => onSelect(o.id)}
            >
              <div className="order-item-head">
                <strong>{o.id}</strong>
                <span className={`status-pill status-${o.status}`}>{ORDER_STATUS_LABEL[o.status]}</span>
              </div>
              <div className="order-item-body">
                <span>{o.boardBrand || "未填品牌"}</span>
                <span>{o.boardType || "未填板型"}</span>
              </div>
              <div className="order-item-meta">
                <span>损伤点 {dmg}</span>
                <span className={wax.eligible ? "text-ok" : "text-warn"}>
                  {wax.eligible ? "打蜡合格" : "打蜡待确认"}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
