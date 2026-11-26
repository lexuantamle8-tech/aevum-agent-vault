import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";

const RPC_URL = process.env.AEVUM_RPC_URL || "https://rpc-test.qday.info";
const CHAIN_ID = Number(process.env.AEVUM_CHAIN_ID || 44005);
const TUSD8_ADDRESS =
  process.env.TUSD8_ADDRESS || "0x456569838f1d43009A91ebA4263147Afd7233483";
const EXPLORER_URL = "https://explorer-test.qday.info";

function loadDeployerKey() {
  if (process.env.AEVUM_DEPLOYER_KEY) {
    return process.env.AEVUM_DEPLOYER_KEY.trim();
  }
  const keyFile = path.resolve(process.cwd(), "../../.aevum_deployer.json");
  if (!fs.existsSync(keyFile)) {
    throw new Error(
      `Deployer keypair not found at ${keyFile} and AEVUM_DEPLOYER_KEY not set.`
    );
  }
  const parsed = JSON.parse(fs.readFileSync(keyFile, "utf8"));
  return parsed.privateKey;
}

async function main() {
  const artifactPath = path.resolve(
    process.cwd(),
    "artifacts/AevumAgentVault.json"
  );
  if (!fs.existsSync(artifactPath)) {
    throw new Error("Missing artifacts/AevumAgentVault.json. Run `npm run compile` first.");
  }
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));

  const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
  const wallet = new ethers.Wallet(loadDeployerKey(), provider);
  const balance = await provider.getBalance(wallet.address);

  console.log(`Network:  QDay Aevum Testnet (Chain ID ${CHAIN_ID})`);
  console.log(`RPC:      ${RPC_URL}`);
  console.log(`Deployer: ${wallet.address}`);
  console.log(`Balance:  ${ethers.formatEther(balance)} tQDAY`);
  console.log(`tUSD8:    ${TUSD8_ADDRESS}`);

  if (balance === 0n) {
    console.error(
      `\nDeployer has 0 tQDAY. Drip testnet funds at https://faucet.qday.info/en for ${wallet.address} and re-run.`
    );
    process.exit(1);
  }

  console.log("\nDeploying AevumAgentVault...");
  const factory = new ethers.ContractFactory(
    artifact.abi,
    artifact.bytecode,
    wallet
  );
  const contract = await factory.deploy(TUSD8_ADDRESS);
  const tx = contract.deploymentTransaction();
  console.log(`Deploy TX: ${tx.hash}`);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  const receipt = await provider.getTransactionReceipt(tx.hash);

  const deploymentsDir = path.resolve(process.cwd(), "deployments");
  fs.mkdirSync(deploymentsDir, { recursive: true });
  const record = {
    network: "qday-aevum-testnet",
    chainId: CHAIN_ID,
    rpcUrl: RPC_URL,
    explorerUrl: EXPLORER_URL,
    tUSD8: TUSD8_ADDRESS,
    vaultAddress: address,
    deployer: wallet.address,
    txHash: tx.hash,
    blockNumber: receipt?.blockNumber ?? null,
    deployedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(deploymentsDir, "qday-testnet.json"),
    JSON.stringify(record, null, 2)
  );

  console.log(`\nDeployed AevumAgentVault at: ${address}`);
  console.log(`Explorer: ${EXPLORER_URL}/address/${address}`);
  console.log(`Saved deployment record to deployments/qday-testnet.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
