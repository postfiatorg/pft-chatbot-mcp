import { afterEach, describe, expect, it, vi } from "vitest";
import { submitAndPoll } from "../../chain/submitter.js";

type Handler = (method: string, params: any) => any;

/** Raw HTTP reply, for responses a JSON-RPC result cannot express. */
class HttpReply {
  constructor(
    readonly status: number,
    readonly body: () => Promise<any>
  ) {}
}

/** Mock global fetch with a JSON-RPC dispatcher; records methods and params. */
function mockRpc(handler: Handler): { calls: string[]; params: Array<{ method: string; params: any }> } {
  const calls: string[] = [];
  const params: Array<{ method: string; params: any }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      calls.push(body.method);
      params.push({ method: body.method, params: body.params?.[0] ?? {} });
      const result = handler(body.method, body.params?.[0] ?? {});
      if (result instanceof HttpReply) {
        return {
          ok: result.status >= 200 && result.status < 300,
          status: result.status,
          statusText: result.status >= 500 ? "Service Unavailable" : "OK",
          json: result.body,
        };
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ result }),
      };
    })
  );
  return { calls, params };
}

const RPC = "http://rpc.test/";
const HASH = "AB".repeat(32);
const NOT_FOUND = { error: "txnNotFound", error_message: "Transaction not found." };
/** rippled's authoritative not-found for a ledger-ranged tx lookup. */
const NOT_FOUND_SEARCHED_ALL = { ...NOT_FOUND, searched_all: true };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("submitAndPoll", () => {
  it("reports a validated transaction with the ledger result", async () => {
    let txLookups = 0;
    mockRpc((method) => {
      if (method === "submit") return { engine_result: "tesSUCCESS" };
      if (method === "tx") {
        txLookups += 1;
        return txLookups < 2
          ? NOT_FOUND
          : { validated: true, ledger_index: 1005, meta: { TransactionResult: "tesSUCCESS" } };
      }
      if (method === "server_info") return { info: { validated_ledger: { seq: 1004 } } };
      throw new Error(`unexpected ${method}`);
    });
    const outcome = await submitAndPoll(RPC, "blob", HASH, 1120, { intervalMs: 0, maxAttempts: 5 });
    expect(outcome).toMatchObject({
      txHash: HASH,
      status: "validated",
      result: "tesSUCCESS",
      lastLedgerSequence: 1120,
      lastValidatedLedger: 1005,
    });
  });

  it("surfaces a tec result from the validated ledger as validated, not success", async () => {
    mockRpc((method) => {
      if (method === "submit") return { engine_result: "tesSUCCESS" };
      if (method === "tx") return { validated: true, meta: { TransactionResult: "tecUNFUNDED_PAYMENT" } };
      if (method === "server_info") return { info: { validated_ledger: { seq: 1 } } };
      throw new Error(`unexpected ${method}`);
    });
    const outcome = await submitAndPoll(RPC, "blob", HASH, 100, { intervalMs: 0, maxAttempts: 2 });
    expect(outcome.status).toBe("validated");
    expect(outcome.result).toBe("tecUNFUNDED_PAYMENT");
  });

  it("reports expiry only after an authoritative ranged txnNotFound once LastLedgerSequence passes", async () => {
    let validatedSeq = 1117;
    const { calls, params } = mockRpc((method, p) => {
      if (method === "submit") return { engine_result: "tesSUCCESS" };
      if (method === "tx") return p.min_ledger != null ? NOT_FOUND_SEARCHED_ALL : NOT_FOUND;
      if (method === "server_info") {
        validatedSeq += 1;
        return { info: { validated_ledger: { seq: validatedSeq } } };
      }
      throw new Error(`unexpected ${method}`);
    });
    const outcome = await submitAndPoll(RPC, "blob", HASH, 1120, { intervalMs: 0, maxAttempts: 30 });
    expect(outcome.status).toBe("expired");
    expect(outcome.result).toContain("LastLedgerSequence 1120");
    expect(outcome.result).toContain("searched_all over ledgers 1118-1120");
    expect(outcome.lastValidatedLedger).toBe(1121);
    // 1118 before submit; polls see 1119, 1120 (not expired) and 1121 (expired): then stop.
    expect(calls.filter((m) => m === "server_info")).toHaveLength(4);
    expect(calls.filter((m) => m === "tx")).toHaveLength(4); // 3 polls + 1 final look
    // The final look is bounded to the ledgers the transaction could have landed in.
    const finalLook = params.filter((c) => c.method === "tx").at(-1)!.params;
    expect(finalLook).toMatchObject({ transaction: HASH, min_ledger: 1118, max_ledger: 1120 });
  });

  it("does not report expiry for a transaction that validated in the final ledgers", async () => {
    let txLookups = 0;
    mockRpc((method) => {
      if (method === "submit") return { engine_result: "terQUEUED" };
      if (method === "tx") {
        txLookups += 1;
        // Not found on the regular poll, found on the final look after expiry.
        return txLookups === 2
          ? { validated: true, ledger_index: 1120, meta: { TransactionResult: "tesSUCCESS" } }
          : NOT_FOUND;
      }
      if (method === "server_info") return { info: { validated_ledger: { seq: 1121 } } };
      throw new Error(`unexpected ${method}`);
    });
    const outcome = await submitAndPoll(RPC, "blob", HASH, 1120, { intervalMs: 0, maxAttempts: 30 });
    expect(outcome.status).toBe("validated");
    expect(outcome.result).toBe("tesSUCCESS");
  });

  it("reports pending, not failure, when the polling budget runs out before expiry", async () => {
    const { calls } = mockRpc((method) => {
      if (method === "submit") return { engine_result: "tesSUCCESS" };
      if (method === "tx") return NOT_FOUND;
      if (method === "server_info") return { info: { validated_ledger: { seq: 1010 } } };
      throw new Error(`unexpected ${method}`);
    });
    const outcome = await submitAndPoll(RPC, "blob", HASH, 1120, { intervalMs: 0, maxAttempts: 3 });
    expect(outcome.status).toBe("pending");
    expect(outcome.result).toMatch(/^pending: submitted \(tesSUCCESS\)/);
    expect(outcome.lastLedgerSequence).toBe(1120);
    expect(outcome.lastValidatedLedger).toBe(1010);
    expect(calls.filter((m) => m === "tx")).toHaveLength(3);
  });

  it("reports a non-success submit result as rejected without polling", async () => {
    const { calls } = mockRpc((method) => {
      if (method === "submit") return { engine_result: "tefPAST_SEQ" };
      throw new Error(`unexpected ${method}`);
    });
    const outcome = await submitAndPoll(RPC, "blob", HASH, 1120, { intervalMs: 0, maxAttempts: 3 });
    expect(outcome).toMatchObject({ status: "rejected", result: "tefPAST_SEQ", txHash: HASH });
    // Only the pre-submit ledger observation (which may fail) and the submit.
    expect(calls).toEqual(["server_info", "submit"]);
  });

  it("keeps polling to the budget when LastLedgerSequence is unknown", async () => {
    const { calls } = mockRpc((method) => {
      if (method === "submit") return { engine_result: "tesSUCCESS" };
      if (method === "tx") return NOT_FOUND;
      throw new Error(`unexpected ${method}`);
    });
    const outcome = await submitAndPoll(RPC, "blob", HASH, undefined, { intervalMs: 0, maxAttempts: 2 });
    expect(outcome.status).toBe("pending");
    expect(calls.filter((m) => m === "server_info")).toHaveLength(0);
  });
});

describe("submitAndPoll final lookup after LastLedgerSequence passes", () => {
  const PASSED = { info: { validated_ledger: { seq: 1121 } } };

  /** submit succeeds, server_info reports `seq` (1121 by default), `tx` uses `onTx`. */
  function scenario(onTx: (p: any, n: number) => any, seq: () => any = () => PASSED) {
    let txLookups = 0;
    return mockRpc((method, p) => {
      if (method === "submit") return { engine_result: "tesSUCCESS" };
      if (method === "server_info") return seq();
      if (method === "tx") {
        txLookups += 1;
        return onTx(p, txLookups);
      }
      throw new Error(`unexpected ${method}`);
    });
  }

  function expectPendingNotExpired(outcome: Awaited<ReturnType<typeof submitAndPoll>>, reason: RegExp) {
    expect(outcome.status).not.toBe("expired");
    expect(outcome.status).toBe("pending");
    expect(outcome.result).toMatch(/^pending: LastLedgerSequence 1120 passed \(validated ledger 1121\)/);
    expect(outcome.result).toMatch(reason);
    expect(outcome.result).toContain("do not resend until tx_hash is confirmed absent");
    expect(outcome.lastLedgerSequence).toBe(1120);
    expect(outcome.lastValidatedLedger).toBe(1121);
  }

  it("does not declare expiry when both tx lookups throw (RPC unavailable)", async () => {
    scenario(() => {
      throw new Error("RPC unavailable");
    });
    const outcome = await submitAndPoll(RPC, "blob", HASH, 1120, { intervalMs: 0, maxAttempts: 1 });
    expectPendingNotExpired(outcome, /tx lookup failed: RPC unavailable/);
  });

  it("does not declare expiry when the final tx lookup returns HTTP 5xx", async () => {
    scenario((p) =>
      p.min_ledger != null ? new HttpReply(503, async () => ({})) : NOT_FOUND
    );
    const outcome = await submitAndPoll(RPC, "blob", HASH, 1120, { intervalMs: 0, maxAttempts: 2 });
    expectPendingNotExpired(outcome, /tx lookup failed: RPC tx HTTP 503/);
  });

  it("does not declare expiry when the final tx lookup returns invalid JSON", async () => {
    scenario((p) =>
      p.min_ledger != null
        ? new HttpReply(200, async () => {
            throw new SyntaxError("Unexpected token < in JSON at position 0");
          })
        : NOT_FOUND
    );
    const outcome = await submitAndPoll(RPC, "blob", HASH, 1120, { intervalMs: 0, maxAttempts: 2 });
    expectPendingNotExpired(outcome, /tx lookup failed: Unexpected token </);
  });

  it("does not declare expiry on an RPC error other than txnNotFound", async () => {
    scenario((p) =>
      p.min_ledger != null ? { error: "tooBusy", error_message: "The server is too busy." } : NOT_FOUND
    );
    const outcome = await submitAndPoll(RPC, "blob", HASH, 1120, { intervalMs: 0, maxAttempts: 2 });
    expectPendingNotExpired(outcome, /tx lookup error: tooBusy/);
  });

  it("does not declare expiry on txnNotFound with searched_all false (incomplete history)", async () => {
    scenario((p) => (p.min_ledger != null ? { ...NOT_FOUND, searched_all: false } : NOT_FOUND));
    const outcome = await submitAndPoll(RPC, "blob", HASH, 1120, { intervalMs: 0, maxAttempts: 2 });
    expectPendingNotExpired(outcome, /txnNotFound but searched_all=false/);
  });

  it("does not declare expiry when the submission ledger is unknown (unranged lookup)", async () => {
    let serverInfoCalls = 0;
    scenario(
      () => NOT_FOUND_SEARCHED_ALL,
      () => {
        serverInfoCalls += 1;
        if (serverInfoCalls === 1) throw new Error("server_info unavailable before submit");
        return PASSED;
      }
    );
    const outcome = await submitAndPoll(RPC, "blob", HASH, 1120, { intervalMs: 0, maxAttempts: 2 });
    expectPendingNotExpired(outcome, /without a ledger range/);
  });

  it("does not declare expiry on txnNotFound while the validated ledger has not passed LastLedgerSequence", async () => {
    const { calls } = scenario(
      () => NOT_FOUND_SEARCHED_ALL,
      () => ({ info: { validated_ledger: { seq: 1120 } } })
    );
    const outcome = await submitAndPoll(RPC, "blob", HASH, 1120, { intervalMs: 0, maxAttempts: 3 });
    expect(outcome.status).toBe("pending");
    expect(outcome.result).toMatch(/^pending: submitted \(tesSUCCESS\) but not yet validated/);
    expect(outcome.lastValidatedLedger).toBe(1120);
    expect(calls.filter((m) => m === "tx")).toHaveLength(3); // no final look was taken
  });

  it("recovers to expired once a later final lookup is authoritative", async () => {
    scenario((p, n) => {
      if (p.min_ledger == null) return NOT_FOUND;
      if (n <= 2) throw new Error("RPC unavailable"); // first final look fails
      return NOT_FOUND_SEARCHED_ALL;
    });
    const outcome = await submitAndPoll(RPC, "blob", HASH, 1120, { intervalMs: 0, maxAttempts: 5 });
    expect(outcome.status).toBe("expired");
    expect(outcome.lastValidatedLedger).toBe(1121);
  });

  it("reports validated when the final lookup finds the transaction in a validated ledger", async () => {
    scenario((p) =>
      p.min_ledger != null
        ? { validated: true, ledger_index: 1119, meta: { TransactionResult: "tesSUCCESS" } }
        : NOT_FOUND
    );
    const outcome = await submitAndPoll(RPC, "blob", HASH, 1120, { intervalMs: 0, maxAttempts: 2 });
    expect(outcome).toMatchObject({ status: "validated", result: "tesSUCCESS", lastValidatedLedger: 1119 });
  });
});
