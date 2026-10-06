import { useMemo, useState } from "react";
import "./styles.css";
import OrderList from "./components/OrderList";
import OrderEditor from "./components/OrderEditor";
import ConflictPanel from "./components/ConflictPanel";
import { useLedgerStore } from "./ledger/store";
import { isSimulatingFail } from "./ledger/storage";
import { collectConflicts, formatTime, orderStats } from "./ledger/ui-helpers";

const STATUS_FILTERS = ["全部", "待维护", "维护中", "待交付", "已完工"];
const TYPE_FILTERS = ["全板型", "全地域", "公园板", "竞速板", "粉雪板"];

export default function App() {
  const store = useLedgerStore();
  const { doc, device, queue, toasts } = store;

  const [tab, setTab] = useState<"orders" | "conflicts" | "log">("orders");
  const [statusFilter, setStatusFilter] = useState("全部");
  const [typeFilter, setTypeFilter] = useState("全板型");
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [deviceNameDraft, setDeviceNameDraft] = useState(device.name);
  const [failOn, setFailOn] = useState(isSimulatingFail());

  const orders = useMemo(() => Object.values(doc.orders), [doc]);
  const stats = useMemo(() => orderStats(orders), [orders]);
  const conflictCount = collectConflicts(doc).length;

  const filtered = useMemo(() => {
    return orders
      .filter((o) => (statusFilter === "全部" ? true : o.fields.status.value === statusFilter))
      .filter((o) => (typeFilter === "全板型" ? true : o.fields.boardType.value === typeFilter))
      .filter((o) => {
        if (!query.trim()) return true;
        const q = query.trim().toLowerCase();
        const hay = [
          o.fields.orderNo.value,
          o.fields.brand.value,
          o.fields.customer.value,
          o.fields.preference.value,
          ...o.damages.map((d) => `${d.id} ${d.position.value}`),
        ]
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [orders, statusFilter, typeFilter, query]);

  const editingOrder = editingId ? doc.orders[editingId] ?? null : null;

  const openOrder = (id: string) => {
    setEditingId(id);
    setCreating(false);
  };
  const startCreate = () => {
    setCreating(true);
    setEditingId(null);
  };
  const closeEditor = (id?: string) => {
    setCreating(false);
    setEditingId(id && doc.orders[id] ? id : null);
  };

  return (
    <main className="app">
      <header className="topbar">
        <div>
          <h1>滑雪板调校店 · 本地协同台账</h1>
          <small>
            工单 / 底板损伤 / 修补记录 · 本地可续作 · 台账修订 <b>r{doc.rev}</b> ·{" "}
            {doc.devices.length} 台设备
          </small>
        </div>
        <div className="device-box">
          <span className="muted">本机身份（两台平板请各取一名）：</span>
          <input
            value={deviceNameDraft}
            onChange={(e) => setDeviceNameDraft(e.target.value)}
            onBlur={() => deviceNameDraft.trim() && store.renameDevice(deviceNameDraft)}
          />
          <button
            className="btn btn-mini"
            onClick={() => deviceNameDraft.trim() && store.renameDevice(deviceNameDraft)}
          >
            改名
          </button>
        </div>
      </header>

      {queue.length > 0 && (
        <div className="queue-banner">
          <b>⚠ 有 {queue.length} 个未提交批次（写盘失败后保留）：</b>
          <span>
            {queue
              .map((c) => `${c.ops.length} 项改动 @ ${formatTime(c.at)}`)
              .join("；")}
          </span>
          <button className="btn btn-primary btn-mini" onClick={store.retryQueue}>
            立即重试写盘
          </button>
        </div>
      )}

      <section className="metrics">
        <article><small>工单总数</small><strong>{stats.total}</strong></article>
        <article><small>待维护/进行中</small><strong>{stats.open}</strong></article>
        <article><small>已完工</small><strong>{stats.done}</strong></article>
        <article><small>底板损伤点</small><strong>{stats.damages}</strong></article>
        <article>
          <small>待确认冲突</small>
          <strong className={conflictCount > 0 ? "metric-warn" : ""}>{conflictCount}</strong>
        </article>
      </section>

      <nav className="tabs">
        <button className={tab === "orders" ? "active" : ""} onClick={() => setTab("orders")}>
          工单台账
        </button>
        <button className={tab === "conflicts" ? "active" : ""} onClick={() => setTab("conflicts")}>
          待确认冲突{conflictCount > 0 ? `（${conflictCount}）` : ""}
        </button>
        <button className={tab === "log" ? "active" : ""} onClick={() => setTab("log")}>
          批次记录
        </button>
      </nav>

      {tab === "orders" && !creating && !editingOrder && (
        <>
          <section className="filters">
            <div className="chip-row">
              {STATUS_FILTERS.map((s) => (
                <button key={s} className={`chip ${statusFilter === s ? "chip-on" : ""}`} onClick={() => setStatusFilter(s)}>
                  {s}
                </button>
              ))}
            </div>
            <div className="chip-row">
              {TYPE_FILTERS.map((s) => (
                <button key={s} className={`chip ${typeFilter === s ? "chip-on" : ""}`} onClick={() => setTypeFilter(s)}>
                  {s}
                </button>
              ))}
            </div>
            <input className="search" placeholder="搜索工单号 / 品牌 / 客户 / 损伤编号"
              value={query} onChange={(e) => setQuery(e.target.value)} />
            <button className="btn btn-primary" onClick={startCreate}>＋ 新建工单</button>
          </section>

          <OrderList orders={filtered} selectedId={editingId} waxFor={store.waxFor} onOpen={openOrder} />
        </>
      )}

      {(creating || editingOrder) && (
        <OrderEditor
          key={creating ? "__new__" : editingOrder!.id}
          order={editingOrder}
          saveDraft={store.saveDraft}
          onSaved={(id) => closeEditor(id)}
          onCancel={() => closeEditor()}
        />
      )}

      {tab === "conflicts" && (
        <section className="panel">
          <h2>字段冲突仲裁</h2>
          <p className="muted">
            两台平板同时改了同一字段且结果不同时，系统不会让任何人盖掉对方：双方版本都留在这里，由一位技师选定最终版本。
          </p>
          <ConflictPanel doc={doc} onResolve={store.resolveConflict} />
        </section>
      )}

      {tab === "log" && (
        <section className="panel">
          <h2>写盘批次记录（最近 200 条）</h2>
          <table className="log-table">
            <thead>
              <tr>
                <th>时间</th><th>设备</th><th>工单</th><th>批次内容</th><th>批次号</th>
              </tr>
            </thead>
            <tbody>
              {doc.log.map((l) => (
                <tr key={l.id}>
                  <td>{formatTime(l.at)}</td>
                  <td>{l.by}</td>
                  <td>{l.orderLabel || "—"}</td>
                  <td>{l.summary}</td>
                  <td className="mono">{l.changesetId.slice(-10)}</td>
                </tr>
              ))}
              {doc.log.length === 0 && (
                <tr><td colSpan={5} className="muted">还没有批次记录。</td></tr>
              )}
            </tbody>
          </table>

          <div className="dev-tools">
            <h3>故障演练 / 维护</h3>
            <p className="muted">
              开启“模拟写盘失败”后保存，改动会完整保留在“未提交批次队列”里；关闭后点“立即重试写盘”即可补齐，
              或等待自动重试（每 15 秒 / 重新联网）。
            </p>
            <label className="inline">
              <input
                type="checkbox"
                checked={failOn}
                onChange={(e) => {
                  setFailOn(e.target.checked);
                  store.toggleFail(e.target.checked);
                }}
              />
              模拟写盘失败
            </label>
            <button className="btn btn-mini" onClick={() => { if (confirm("确定清空全部本地台账并恢复示例数据？")) store.reset(); }}>
              清空并重置为示例数据
            </button>
            <button
              className="btn btn-mini"
              onClick={() => { if (confirm("将用 v1 旧格式示例台账覆盖当前数据并触发自动升级，确定？")) store.loadLegacy(); }}
            >
              载入 v1 旧台账演示升级
            </button>
          </div>
        </section>
      )}

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.level}`}>{t.text}</div>
        ))}
      </div>

      <footer className="footer-note">
        数据保存在本机 localStorage，两台平板（同浏览器两个标签页即可模拟）改动均按批次写盘、字段级合并；
        损伤点 D-xxx / 修补记录 R-xxx 为稳定编号，旧台账升级后原损伤与修复位置照旧可查。
      </footer>
    </main>
  );
}
