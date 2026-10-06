import { useState } from "react";
import { ledgerStore, useLedger } from "../ledger/store";
import {
  peerAddDamage,
  peerAddRepair,
  peerConfirmRepair,
  peerEditDamage,
  peerEditOrder,
  peerEditRepairMaterial,
  parsePeerJson,
} from "../ledger/peer";

export default function PeerPanel() {
  const ledger = useLedger();
  const [json, setJson] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const run = (fn: (l: typeof ledger) => typeof ledger, label: string) => {
    const remote = fn(ledger);
    const { conflicts, changedCount } = ledgerStore.mergeRemote(remote, label);
    setMsg(`已合并「${label}」：改动 ${changedCount} 处，新冲突 ${conflicts.length} 条`);
  };

  const applyJson = () => {
    try {
      const remote = parsePeerJson(json);
      const { conflicts, changedCount } = ledgerStore.mergeRemote(remote, "JSON 对端台账");
      setMsg(`已合并 JSON 台账：改动 ${changedCount} 处，新冲突 ${conflicts.length} 条`);
      setJson("");
    } catch (e) {
      setMsg(`JSON 解析失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <section className="panel">
      <div className="heading">
        <div>
          <p>第二台平板</p>
          <h2>对端改动模拟（tablet-B）</h2>
        </div>
      </div>
      <p className="peer-hint">
        两台平板同时改同一张工单时，按字段合并；两边都改过的字段进「待确认」。对端改损伤点位置或修补材料后，已确认修补立即作废重算。
      </p>
      <div className="chips">
        <button onClick={() => run(peerEditOrder, "对端修改工单品牌")}>对端改品牌</button>
        <button onClick={() => run(peerAddDamage, "对端新增损伤点")}>对端新增损伤点</button>
        <button onClick={() => run(peerEditDamage, "对端修改损伤点位置")}>对端改损伤位置</button>
        <button onClick={() => run(peerAddRepair, "对端新增修补")}>对端新增修补</button>
        <button onClick={() => run(peerEditRepairMaterial, "对端修改修补材料")}>对端改修补材料</button>
        <button onClick={() => run(peerConfirmRepair, "对端确认修补")}>对端确认修补</button>
      </div>

      <div className="json-box">
        <textarea
          placeholder="也可以粘贴对端平板导出的台账 JSON…"
          value={json}
          onChange={(e) => setJson(e.target.value)}
          rows={4}
        />
        <button className="primary" onClick={applyJson} disabled={!json.trim()}>
          应用对端 JSON
        </button>
      </div>

      {msg && <p className="peer-msg">{msg}</p>}
    </section>
  );
}
