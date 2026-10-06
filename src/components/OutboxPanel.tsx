import { ledgerStore, useLedger } from "../ledger/store";
import { formatTime } from "../ledger/ids";

export default function OutboxPanel() {
  const ledger = useLedger();
  const outbox = ledger.outbox;

  return (
    <section className="panel">
      <div className="heading">
        <div>
          <p>写盘队列</p>
          <h2>未提交批次（{outbox.length}）</h2>
        </div>
        {outbox.length > 0 && (
          <button className="primary" onClick={() => ledgerStore.retryAll()}>
            全部重试
          </button>
        )}
      </div>
      {outbox.length === 0 && <p className="empty">所有改动均已落盘。写盘失败时批次会留在这里，刷新页面也不丢。</p>}
      <div className="outbox-list">
        {outbox.map((b) => (
          <article key={b.id} className="outbox-card">
            <div className="outbox-head">
              <strong>{b.label}</strong>
              <span className="outbox-id">{b.id}</span>
            </div>
            <p className="outbox-meta">
              {formatTime(b.createdAt)} · 重试 {b.attempts} 次 · {b.ops.length} 个操作
            </p>
            {b.error && <p className="outbox-error">错误：{b.error}</p>}
            <button onClick={() => ledgerStore.retryBatch(b.id)}>重试该批次</button>
          </article>
        ))}
      </div>
    </section>
  );
}
