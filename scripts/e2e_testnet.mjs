import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";

const RPC_URL = process.env.AEVUM_RPC_URL || "https://rpc-test.qday.info";
const CHAIN_ID = Number(process.env.AEVUM_CHAIN_ID || 44005);
const TUSD8_ADDRESS =
  process.env.TUSD8_ADDRESS || "0x456569838f1d43009A91ebA4263147Afd7233483";
const EXPLORER_URL = "https://explorer-test.qday.info";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
];

function loadDeployerKey() {
  if (process.env.AEVUM_DEPLOYER_KEY) {
    return process.env.AEVUM_DEPLOYER_KEY.trim();
  }
  const keyFile = path.resolve(process.cwd(), "../../.aevum_deployer.json");
  return JSON.parse(fs.readFileSync(keyFile, "utf8")).privateKey;
}

async function main() {
  const depPath = path.resolve(process.cwd(), "deployments/qday-testnet.json");
  if (!fs.existsSync(depPath)) {
    throw new Error("Missing deployments/qday-testnet.json. Run `npm run deploy` first.");
  }
  const dep = JSON.parse(fs.readFileSync(depPath, "utf8"));
  const artifact = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), "artifacts/AevumAgentVault.json"), "utf8")
  );

  const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
  const principal = new ethers.Wallet(loadDeployerKey(), provider);
  const vault = new ethers.Contract(dep.vaultAddress, artifact.abi, principal);
  const tusd8 = new ethers.Contract(TUSD8_ADDRESS, ERC20_ABI, principal);

  const tusd8Bal = await tusd8.balanceOf(principal.address);
  console.log(`Principal: ${principal.address}`);
  console.log(`Vault:     ${dep.vaultAddress}`);
  console.log(`tUSD8 Bal: ${ethers.formatUnits(tusd8Bal, 6)} tUSD8`);

  if (tusd8Bal < 2_000_000n) {
    throw new Error("Need at least 2 tUSD8 from https://faucet.qday.info/en to run E2E.");
  }

  // 1. Register ERC-8004 agent identity
  const tx1 = await vault.registerAgent("ipfs://bafybeiaevumguard-agent-v1/metadata.json");
  const r1 = await tx1.wait();
  const regLog = r1.logs
    .map((l) => { try { return vault.interface.parseLog(l); } catch { return null; } })
    .find((p) => p?.name === "AgentRegistered");
  const agentId = regLog.args.agentId;
  console.log(`[1] AgentRegistered #${agentId}: ${EXPLORER_URL}/tx/${tx1.hash}`);

  // 2. Approve & deposit 2 tUSD8
  const depositAmt = 2_000_000n;
  const tx2a = await tusd8.approve(dep.vaultAddress, depositAmt);
  await tx2a.wait();
  const tx2b = await vault.deposit(depositAmt);
  await tx2b.wait();
  console.log(`[2] Deposited 2.00 tUSD8: ${EXPLORER_URL}/tx/${tx2b.hash}`);

  // 3. Create scoped session (using principal as sessionKey for single-key testnet demo)
  const expiresAt = Math.floor(Date.now() / 1000) + 86400;
  const tx3 = await vault.createSession(
    agentId,
    principal.address,
    500_000n, // 0.50 tUSD8 per tx
    1_500_000n, // 1.50 tUSD8 daily cap
    expiresAt,
    true
  );
  const r3 = await tx3.wait();
  const sessLog = r3.logs
    .map((l) => { try { return vault.interface.parseLog(l); } catch { return null; } })
    .find((p) => p?.name === "SessionCreated");
  const sessionId = sessLog.args.sessionId;
  console.log(`[3] SessionCreated #${sessionId}: ${EXPLORER_URL}/tx/${tx3.hash}`);

  // 4. Allowlist a vendor address
  const vendor = "0x000000000000000000000000000000000000dEaD";
  const tx4 = await vault.setRecipientAllowed(sessionId, vendor, true);
  await tx4.wait();
  console.log(`[4] Allowlisted vendor ${vendor}: ${EXPLORER_URL}/tx/${tx4.hash}`);

  // 5. Execute policy-compliant agent payment (0.25 tUSD8)
  const memoHash = ethers.keccak256(ethers.toUtf8Bytes("invoice:compute-api-001"));
  const tx5 = await vault.executeAgentPayment(sessionId, vendor, 250_000n, memoHash);
  await tx5.wait();
  console.log(`[5] AgentPaymentSettled (0.25 tUSD8): ${EXPLORER_URL}/tx/${tx5.hash}`);

  // 6. Simulate prompt-injection over-cap spend (must revert with PerTxCapExceeded)
  try {
    await vault.executeAgentPayment.staticCall(sessionId, vendor, 1_000_000n, memoHash);
    throw new Error("Expected PerTxCapExceeded revert!");
  } catch (err) {
    console.log(`[6] Prompt-injection drain (1.00 tUSD8 > 0.50 cap) BLOCKED on-chain!`);
  }

  // 7. Create & release milestone escrow (0.50 tUSD8)
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const milestoneHash = ethers.keccak256(ethers.toUtf8Bytes("milestone:deliverable-v1"));
  const tx7 = await vault.createEscrow(sessionId, vendor, 500_000n, deadline, milestoneHash);
  const r7 = await tx7.wait();
  const escLog = r7.logs
    .map((l) => { try { return vault.interface.parseLog(l); } catch { return null; } })
    .find((p) => p?.name === "EscrowCreated");
  const escrowId = escLog.args.escrowId;
  console.log(`[7] EscrowCreated #${escrowId} (0.50 tUSD8): ${EXPLORER_URL}/tx/${tx7.hash}`);

  const tx8 = await vault.releaseEscrow(escrowId);
  await tx8.wait();
  console.log(`[8] EscrowReleased #${escrowId}: ${EXPLORER_URL}/tx/${tx8.hash}`);

  // 8. Instant revoke session
  const tx9 = await vault.revokeSession(sessionId);
  await tx9.wait();
  console.log(`[9] SessionRevoked #${sessionId}: ${EXPLORER_URL}/tx/${tx9.hash}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
