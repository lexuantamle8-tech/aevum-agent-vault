import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ganache from "ganache";
import { ethers } from "ethers";

const USD = (n) => ethers.parseUnits(String(n), 6);

function loadArtifact(name) {
  return JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), `artifacts/${name}.json`), "utf8")
  );
}

async function expectCustomError(promise, iface, expectedErrorName) {
  let failed = false;
  try {
    const tx = await promise;
    if (tx && typeof tx.wait === "function") {
      await tx.wait();
    }
  } catch (err) {
    failed = true;
    const rawData =
      err?.data ||
      err?.info?.error?.data ||
      err?.error?.data ||
      err?.receipt?.revertReason;
    if (rawData && typeof rawData === "string" && rawData.startsWith("0x")) {
      const parsed = iface.parseError(rawData);
      assert.equal(
        parsed?.name,
        expectedErrorName,
        `Expected custom error ${expectedErrorName}, got ${parsed?.name}`
      );
      return;
    }
    // Fallback if ganache wraps revert message
    const msg = String(err?.message || err);
    if (!msg.includes("revert") && !msg.includes(expectedErrorName)) {
      throw err;
    }
  }
  assert.equal(failed, true, `Expected transaction to revert with ${expectedErrorName}`);
}

describe("AevumAgentVault — Policy-Bounded Agentic tUSD8 Vault & ERC-8004 Escrow", () => {
  let ganacheProvider;
  let provider;
  let owner, principal, agentKey, vendor, attacker;
  let tusd8, vault, vaultIface;

  before(async () => {
    ganacheProvider = ganache.provider({
      logging: { quiet: true },
      wallet: { totalAccounts: 6, defaultBalance: 1000 },
      chain: { chainId: 44005 },
    });
    provider = new ethers.BrowserProvider(ganacheProvider);

    owner = await provider.getSigner(0);
    principal = await provider.getSigner(1);
    agentKey = await provider.getSigner(2);
    vendor = await provider.getSigner(3);
    attacker = await provider.getSigner(4);

    const mockArt = loadArtifact("MockTUSD8");
    const vaultArt = loadArtifact("AevumAgentVault");
    vaultIface = new ethers.Interface(vaultArt.abi);

    const mockFactory = new ethers.ContractFactory(mockArt.abi, mockArt.bytecode, owner);
    tusd8 = await mockFactory.deploy();
    await tusd8.waitForDeployment();

    const vaultFactory = new ethers.ContractFactory(vaultArt.abi, vaultArt.bytecode, owner);
    vault = await vaultFactory.deploy(await tusd8.getAddress());
    await vault.waitForDeployment();

    // Mint 10,000 tUSD8 to principal and deposit 5,000 tUSD8 into vault
    await (await tusd8.mint(await principal.getAddress(), USD(10000))).wait();
    await (
      await tusd8.connect(principal).approve(await vault.getAddress(), USD(5000))
    ).wait();
    await (await vault.connect(principal).deposit(USD(5000))).wait();
  });

  after(async () => {
    if (ganacheProvider) {
      await ganacheProvider.disconnect();
    }
  });

  async function currentTimestamp() {
    const block = await provider.getBlock("latest");
    return Number(block.timestamp);
  }

  async function advanceTime(seconds) {
    await ganacheProvider.request({ method: "evm_increaseTime", params: [seconds] });
    await ganacheProvider.request({ method: "evm_mine", params: [] });
  }

  it("1. Registers an ERC-8004-aligned Agent Identity and emits AgentRegistered", async () => {
    const uri = "ipfs://bafybeiaevum-agent-identity/agent-01.json";
    const tx = await vault.connect(principal).registerAgent(uri);
    const receipt = await tx.wait();
    const parsed = receipt.logs
      .map((l) => { try { return vaultIface.parseLog(l); } catch { return null; } })
      .find((e) => e?.name === "AgentRegistered");

    assert.ok(parsed, "AgentRegistered event should be emitted");
    assert.equal(parsed.args.agentId, 1n);
    assert.equal(parsed.args.owner, await principal.getAddress());
    assert.equal(parsed.args.metadataUri, uri);

    const ag = await vault.agents(1n);
    assert.equal(ag.active, true);
    assert.equal(ag.metadataUri, uri);
  });

  it("2. Tracks principal vault deposits and allows principal withdrawal", async () => {
    const beforeBal = await vault.balances(await principal.getAddress());
    assert.equal(beforeBal, USD(5000));

    await (await vault.connect(principal).withdraw(USD(500))).wait();
    assert.equal(await vault.balances(await principal.getAddress()), USD(4500));

    // Re-deposit 500 to restore 5,000 balance
    await (
      await tusd8.connect(principal).approve(await vault.getAddress(), USD(500))
    ).wait();
    await (await vault.connect(principal).deposit(USD(500))).wait();
    assert.equal(await vault.balances(await principal.getAddress()), USD(5000));
  });

  it("3. Creates a scoped session key with per-tx cap, 24h cap, expiry, and allowlist", async () => {
    const now = await currentTimestamp();
    const tx = await vault.connect(principal).createSession(
      1n,
      await agentKey.getAddress(),
      USD(100),   // perTxCap: 100 tUSD8
      USD(250),   // dailyCap: 250 tUSD8
      now + 3600, // expires in 1 hour
      true        // allowlistEnabled
    );
    const receipt = await tx.wait();
    const ev = receipt.logs
      .map((l) => { try { return vaultIface.parseLog(l); } catch { return null; } })
      .find((e) => e?.name === "SessionCreated");

    assert.ok(ev, "SessionCreated should be emitted");
    assert.equal(ev.args.sessionId, 1n);
    assert.equal(ev.args.perTxCap, USD(100));
    assert.equal(ev.args.dailyCap, USD(250));
    assert.equal(ev.args.allowlistEnabled, true);

    await (
      await vault.connect(principal).setRecipientAllowed(1n, await vendor.getAddress(), true)
    ).wait();
    assert.equal(
      await vault.sessionRecipientAllowed(1n, await vendor.getAddress()),
      true
    );
  });

  it("4. Executes a policy-compliant agent tUSD8 payment and emits AgentPaymentSettled", async () => {
    const vendorAddr = await vendor.getAddress();
    const beforeVendor = await tusd8.balanceOf(vendorAddr);
    const memo = ethers.keccak256(ethers.toUtf8Bytes("api-usage-batch-1"));

    const tx = await vault
      .connect(agentKey)
      .executeAgentPayment(1n, vendorAddr, USD(80), memo);
    const receipt = await tx.wait();
    const ev = receipt.logs
      .map((l) => { try { return vaultIface.parseLog(l); } catch { return null; } })
      .find((e) => e?.name === "AgentPaymentSettled");

    assert.ok(ev, "AgentPaymentSettled event must be emitted");
    assert.equal(ev.args.amount, USD(80));
    assert.equal(ev.args.recipient, vendorAddr);
    assert.equal(await tusd8.balanceOf(vendorAddr), beforeVendor + USD(80));
    assert.equal(await vault.getRemainingDailyAllowance(1n), USD(170));
  });

  it("5. Blocks prompt-injected over-cap drain with PerTxCapExceeded", async () => {
    const memo = ethers.keccak256(ethers.toUtf8Bytes("malicious-drain-5000"));
    await expectCustomError(
      vault
        .connect(agentKey)
        .executeAgentPayment(1n, await vendor.getAddress(), USD(500), memo),
      vaultIface,
      "PerTxCapExceeded"
    );
  });

  it("6. Blocks unauthorized recipient (prompt-injected attacker address) with RecipientNotAllowed", async () => {
    const memo = ethers.keccak256(ethers.toUtf8Bytes("exfiltrate-to-attacker"));
    await expectCustomError(
      vault
        .connect(agentKey)
        .executeAgentPayment(1n, await attacker.getAddress(), USD(50), memo),
      vaultIface,
      "RecipientNotAllowed"
    );
  });

  it("7. Blocks unauthorized caller impersonating sessionKey with NotSessionKey", async () => {
    const memo = ethers.keccak256(ethers.toUtf8Bytes("impersonation"));
    await expectCustomError(
      vault
        .connect(attacker)
        .executeAgentPayment(1n, await vendor.getAddress(), USD(10), memo),
      vaultIface,
      "NotSessionKey"
    );
  });

  it("8. Enforces rolling 24h DailyCapExceeded and resets after 24 hours", async () => {
    // Session 1 already spent 80/250. Let's create Session 2 with 48h expiry to test 24h rollover cleanly.
    const now = await currentTimestamp();
    await (
      await vault.connect(principal).createSession(
        1n,
        await agentKey.getAddress(),
        USD(100),
        USD(180),
        now + 200000,
        false
      )
    ).wait(); // sessionId = 2

    const memo = ethers.keccak256(ethers.toUtf8Bytes("daily-cap-test"));
    await (
      await vault.connect(agentKey).executeAgentPayment(2n, await vendor.getAddress(), USD(100), memo)
    ).wait();
    // Remaining in 24h window is 80 tUSD8 -> attempting 90 must revert with DailyCapExceeded
    await expectCustomError(
      vault.connect(agentKey).executeAgentPayment(2n, await vendor.getAddress(), USD(90), memo),
      vaultIface,
      "DailyCapExceeded"
    );

    // Advance 24h + 10s -> rolling window resets to full 180 tUSD8
    await advanceTime(86410);
    assert.equal(await vault.getRemainingDailyAllowance(2n), USD(180));
    await (
      await vault
        .connect(agentKey)
        .executeAgentPayment(2n, await vendor.getAddress(), USD(90), memo, { gasLimit: 300000 })
    ).wait();
    assert.equal(await vault.getRemainingDailyAllowance(2n), USD(90));
  });

  it("9. Enforces session expiry with SessionExpired", async () => {
    // Session 1 had 1h expiry, and we advanced 24h in test 8 -> must now be expired
    const memo = ethers.keccak256(ethers.toUtf8Bytes("expired-session"));
    await expectCustomError(
      vault.connect(agentKey).executeAgentPayment(1n, await vendor.getAddress(), USD(10), memo),
      vaultIface,
      "SessionExpired"
    );
  });

  it("10. Enforces instant session revocation with SessionRevoked", async () => {
    const tx = await vault.connect(principal).revokeSession(2n);
    const receipt = await tx.wait();
    const ev = receipt.logs
      .map((l) => { try { return vaultIface.parseLog(l); } catch { return null; } })
      .find((e) => e?.name === "SessionRevokedEvent");
    assert.ok(ev, "SessionRevokedEvent should be emitted");

    const memo = ethers.keccak256(ethers.toUtf8Bytes("post-revoke"));
    await expectCustomError(
      vault.connect(agentKey).executeAgentPayment(2n, await vendor.getAddress(), USD(10), memo),
      vaultIface,
      "SessionRevoked"
    );
  });

  it("11. Executes full milestone escrow lifecycle: createEscrow -> releaseEscrow", async () => {
    const now = await currentTimestamp();
    await (
      await vault.connect(principal).createSession(
        1n,
        await agentKey.getAddress(),
        USD(200),
        USD(500),
        now + 7200,
        true
      )
    ).wait(); // sessionId = 3
    await (
      await vault.connect(principal).setRecipientAllowed(3n, await vendor.getAddress(), true)
    ).wait();

    const milestoneHash = ethers.keccak256(ethers.toUtf8Bytes("deliverable:dataset-v2"));
    const txCreate = await vault
      .connect(agentKey)
      .createEscrow(3n, await vendor.getAddress(), USD(150), now + 3600, milestoneHash);
    const rCreate = await txCreate.wait();
    const evCreate = rCreate.logs
      .map((l) => { try { return vaultIface.parseLog(l); } catch { return null; } })
      .find((e) => e?.name === "EscrowCreated");
    assert.ok(evCreate, "EscrowCreated should be emitted");
    const escrowId = evCreate.args.escrowId;

    const beforeVendor = await tusd8.balanceOf(await vendor.getAddress());
    const txRel = await vault.connect(agentKey).releaseEscrow(escrowId);
    const rRel = await txRel.wait();
    const evRel = rRel.logs
      .map((l) => { try { return vaultIface.parseLog(l); } catch { return null; } })
      .find((e) => e?.name === "EscrowReleased");
    assert.ok(evRel, "EscrowReleased should be emitted");
    assert.equal(await tusd8.balanceOf(await vendor.getAddress()), beforeVendor + USD(150));
  });

  it("12. Supports escrow refund back to principal vault balance on dispute/timeout", async () => {
    const now = await currentTimestamp();
    const milestoneHash = ethers.keccak256(ethers.toUtf8Bytes("deliverable:cancelled-job"));
    const beforeVaultBal = await vault.balances(await principal.getAddress());

    const txCreate = await vault
      .connect(agentKey)
      .createEscrow(3n, await vendor.getAddress(), USD(100), now + 3600, milestoneHash);
    const rCreate = await txCreate.wait();
    const escrowId = rCreate.logs
      .map((l) => { try { return vaultIface.parseLog(l); } catch { return null; } })
      .find((e) => e?.name === "EscrowCreated").args.escrowId;

    assert.equal(await vault.balances(await principal.getAddress()), beforeVaultBal - USD(100));

    // Agent cannot refund before deadline
    await expectCustomError(
      vault.connect(agentKey).refundEscrow(escrowId),
      vaultIface,
      "EscrowDeadlineNotReached"
    );

    // Principal can refund immediately on dispute
    await (await vault.connect(principal).refundEscrow(escrowId)).wait();
    assert.equal(await vault.balances(await principal.getAddress()), beforeVaultBal);
  });

  it("13. Enforces global emergency pause (VaultPaused) while keeping principal withdrawals open", async () => {
    await (await vault.connect(owner).setPaused(true)).wait();
    assert.equal(await vault.paused(), true);

    const memo = ethers.keccak256(ethers.toUtf8Bytes("during-pause"));
    await expectCustomError(
      vault.connect(agentKey).executeAgentPayment(3n, await vendor.getAddress(), USD(10), memo),
      vaultIface,
      "VaultPaused"
    );

    // Principal can still withdraw funds during emergency pause
    const beforeBal = await vault.balances(await principal.getAddress());
    await (await vault.connect(principal).withdraw(USD(10))).wait();
    assert.equal(await vault.balances(await principal.getAddress()), beforeBal - USD(10));

    await (await vault.connect(owner).setPaused(false)).wait();
    assert.equal(await vault.paused(), false);
  });
});
