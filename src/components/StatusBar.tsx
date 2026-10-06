import { ledgerStore, useLedger } from "../ledger/store";

export default function StatusBar() {
  const ledger = useLedger();
  const fault = ledgerStore.isFaultInjection();

  return (
    <section className="panel status-bar">
      <div className="status-item">
        <small>台账版本</small>
        <strong>v{ledger.schemaVersion}</strong>
      </div>
      <div className="status-item">
        <small>本机设备</small>
        <strong>{ledger.deviceId}</strong>
      </div>
      <div className="status-item">
        <small>待确认冲突</small>
        <strong className={ledger.conflicts.length ? "badge-warn" : ""}>{ledger.conflicts.length}</strong>
      </div>
      <div className="status-item">
        <small>写盘队列</small>
        <strong className={ledger.outbox.length ? "badge-warn" : ""}>{ledger.outbox.length} 批</strong>
      </div>
      <div className="status-item">
        <small>写盘状态</small>
        <strong className={ledger.outbox.length ? "badge-warn" : "badge-ok"}>
          {ledger.outbox.length ? "有未写入批次" : "已落盘"}
        </strong>
      </div>
      <label className="fault-toggle">
        <input
          type="checkbox"
          checked={fault}
          onChange={(e) => ledgerStore.setFaultInjection(e.target.checked)}
        />
        <span>模拟写盘失败（测试重试）</span>
      </label>
    </section>
  );
}
