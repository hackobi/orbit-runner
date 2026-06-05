// Probe every server-side demosdk call against node2.demos.sh.
// Usage: node scripts/probe-demosdk.js          (read-only + confirm)
//        PROBE_BROADCAST=1 node scripts/probe-demosdk.js  (also broadcast the store tx — REAL chain write)
// NEVER prints mnemonics; only public addresses/hashes/response shapes.
require("../server/demosdk-esm-compat.js");
const { Demos } = require("@kynesyslabs/demosdk/websdk");
try { require("dotenv").config(); } catch (_) {}

const NODE_URL = "https://node2.demos.sh";
const PUBLIC_ADDR = "0xc7cc633eb31b8a055f8bf9160ade04184df47f5a1c690294dd50e74999dbd5a4";

const shape = (v, depth = 0) => {
  if (v === null || v === undefined) return String(v);
  if (typeof v === "bigint") return `bigint(${v})`;
  if (typeof v !== "object") return typeof v;
  if (Array.isArray(v)) return `array[${v.length}]` + (v.length && depth < 2 ? `<${shape(v[0], depth + 1)}>` : "");
  if (depth >= 2) return "object";
  return "{" + Object.keys(v).map((k) => `${k}:${shape(v[k], depth + 1)}`).join(", ") + "}";
};

async function step(name, fn) {
  try {
    const out = await fn();
    console.log(`PASS  ${name}  ->`, typeof out === "string" ? out : shape(out));
    return out;
  } catch (e) {
    console.log(`FAIL  ${name}  ->`, e?.message || String(e));
    return undefined;
  }
}

(async () => {
  const demos = new Demos();
  console.log(`SDK version: ${require(require("path").join(__dirname, "../node_modules/@kynesyslabs/demosdk/package.json")).version}`);

  await step("connect", () => demos.connect(NODE_URL));
  const info = await step("getAddressInfo(public)", () => demos.getAddressInfo(PUBLIC_ADDR));
  if (info) console.log("      balance:", String(info?.balance ?? info?.data?.balance ?? "?"), "nonce:", String(info?.nonce ?? "?"));
  const txs = await step("getTransactions('latest', 5)", () => demos.getTransactions("latest", 5));
  // Inspect the wire format of native-send amounts (DEM number vs OS string)
  if (Array.isArray(txs)) {
    for (const t of txs) {
      try {
        const c = typeof t.content === "string" ? JSON.parse(t.content) : t.content;
        const data = Array.isArray(c?.data) ? c.data : null;
        if (data && data[0] === "native" && data[1]?.nativeOperation === "send") {
          const [toAddr, amt] = data[1].args || [];
          console.log(`      native send wire amount: ${JSON.stringify(amt)} (${typeof amt}), tx.amount field: ${JSON.stringify(t.amount)} (${typeof t.amount})`);
          break;
        }
      } catch (_) {}
    }
  }
  await step("getMempool", () => demos.getMempool());
  const firstHash = Array.isArray(txs) && txs[0]?.hash ? txs[0].hash : null;
  if (firstHash) await step(`getTxByHash(${String(firstHash).slice(0, 14)}…)`, () => demos.getTxByHash(firstHash));
  else console.log("SKIP  getTxByHash (no hash from getTransactions)");
  await step("rpcCall(gcr_routine getWeb2Identities)", () =>
    demos.rpcCall({ method: "gcr_routine", params: [{ method: "getWeb2Identities", params: [PUBLIC_ADDR] }] }, true)
  );

  const mnemonic = (process.env.DEMOS_SERVER_MNEMONIC || "").trim();
  if (!mnemonic) {
    console.log("SKIP  wallet steps (DEMOS_SERVER_MNEMONIC not set)");
    return;
  }
  await step("connectWallet({isSeed:true})", () => demos.connectWallet(mnemonic, { isSeed: true }));
  await step("getAddress", () => demos.getAddress());
  await step("rpcCall(gcr_routine, wallet connected)", () =>
    demos.rpcCall({ method: "gcr_routine", params: [{ method: "getWeb2Identities", params: [PUBLIC_ADDR] }] }, true)
  );
  const tx = await step("store(Uint8Array[5])", () => demos.store(new Uint8Array([1, 2, 3, 4, 5])));
  if (tx) {
    const validity = await step("confirm(tx) [node validity check]", () => demos.confirm(tx));
    if (validity) console.log("      validity:", JSON.stringify(validity?.response?.data ?? validity?.response ?? validity)?.slice(0, 300));
    if (validity && process.env.PROBE_BROADCAST === "1") {
      const sendRes = await step("broadcast(validity) [REAL chain write]", () => demos.broadcast(validity));
      if (sendRes) console.log("      broadcast:", JSON.stringify(sendRes?.response ?? sendRes)?.slice(0, 300));
    }
  }
})().catch((e) => {
  console.error("UNCAUGHT:", e?.message || e);
  process.exit(1);
});
