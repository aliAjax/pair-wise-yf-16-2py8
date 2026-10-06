import { useState } from "react";
import { useLedger } from "./ledger/store";
import StatusBar from "./components/StatusBar";
import OrderSidebar from "./components/OrderSidebar";
import OrderEditor from "./components/OrderEditor";
import ConflictPanel from "./components/ConflictPanel";
import OutboxPanel from "./components/OutboxPanel";
import PeerPanel from "./components/PeerPanel";
import HistoryPanel from "./components/HistoryPanel";

export default function App() {
  const ledger = useLedger();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const currentId = selectedId && ledger.orders[selectedId] ? selectedId : Object.values(ledger.orders)[0]?.id ?? null;

  return (
    <main className="app">
      <section className="hero">
        <p>滑雪板调校维护 · 本地可续作台账</p>
        <h1>调校台账</h1>
        <span>
          工单、底板损伤点、修补记录全部落本地：损伤点带稳定编号，修补关联真实损伤点。
          两台平板同时修改按字段合并，都改过的字段各留一版待确认；损伤点或修补材料改动后，
          已确认修补与打蜡资格立即作废重算；写盘失败留住批次重试，旧数据自动补齐编号与版本。
        </span>
      </section>

      <StatusBar />

      <section className="workspace">
        <OrderSidebar selectedId={currentId} onSelect={setSelectedId} />
        {currentId ? (
          <OrderEditor orderId={currentId} />
        ) : (
          <section className="panel editor">
            <p className="empty">暂无工单，点「新增工单」开始。</p>
          </section>
        )}
      </section>

      <section className="two-col">
        <ConflictPanel />
        <OutboxPanel />
      </section>

      <PeerPanel />
      <HistoryPanel />
    </main>
  );
}
