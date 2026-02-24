import { describe, it, expect } from "vitest";
import { buildPfPointerMemo, POINTER_FLAGS } from "../../chain/pointer.js";

describe("buildPfPointerMemo", () => {
  it("builds a memo with CID and thread_id", async () => {
    const memo = await buildPfPointerMemo({
      cid: "bafkreiabcdefghijklmnopqrstuvwxyz",
      kind: "CHAT",
      schema: 1,
      threadId: "thread-123",
      flags: POINTER_FLAGS.encrypted,
    });

    expect(memo).toBeDefined();
    expect(memo.memoTypeHex).toBeDefined();
    expect(memo.memoDataHex).toBeDefined();
    expect(memo.memoFormatHex).toBeDefined();
    expect(memo.memoTypeHex).toMatch(/^[0-9a-fA-F]+$/);
    expect(memo.memoDataHex).toMatch(/^[0-9a-fA-F]+$/);
  });

  it("builds a memo without thread_id", async () => {
    const memo = await buildPfPointerMemo({
      cid: "bafkreitest",
      kind: "CHAT",
      schema: 1,
      flags: 0,
    });

    expect(memo).toBeDefined();
    expect(memo.memoTypeHex).toBeDefined();
    expect(memo.memoDataHex).toBeDefined();
  });

  it("POINTER_FLAGS has encrypted = 0x01", () => {
    expect(POINTER_FLAGS.encrypted).toBe(0x01);
  });
});
