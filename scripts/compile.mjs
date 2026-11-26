import fs from "node:fs";
import path from "node:path";
import solc from "solc";

const rootDir = process.cwd();
const contractsDir = path.join(rootDir, "contracts");
const artifactsDir = path.join(rootDir, "artifacts");

fs.mkdirSync(artifactsDir, { recursive: true });

const sources = {};
for (const file of fs.readdirSync(contractsDir)) {
  if (file.endsWith(".sol")) {
    sources[file] = {
      content: fs.readFileSync(path.join(contractsDir, file), "utf8"),
    };
  }
}

const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "paris",
    outputSelection: {
      "*": {
        "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"],
      },
    },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));

if (output.errors) {
  const fatal = output.errors.filter((e) => e.severity === "error");
  for (const err of output.errors) {
    console.error(err.formattedMessage);
  }
  if (fatal.length > 0) {
    process.exit(1);
  }
}

for (const [fileName, contracts] of Object.entries(output.contracts)) {
  for (const [contractName, artifact] of Object.entries(contracts)) {
    const bytecode = artifact.evm.bytecode.object;
    const deployedBytecode = artifact.evm.deployedBytecode.object;
    const runtimeBytes = deployedBytecode.length / 2;
    const outObj = {
      contractName,
      sourceName: fileName,
      compiler: solc.version(),
      evmVersion: "paris",
      abi: artifact.abi,
      bytecode: "0x" + bytecode,
      deployedBytecode: "0x" + deployedBytecode,
      runtimeBytecodeSize: runtimeBytes,
    };
    fs.writeFileSync(
      path.join(artifactsDir, `${contractName}.json`),
      JSON.stringify(outObj, null, 2)
    );
    fs.writeFileSync(
      path.join(artifactsDir, `${contractName}.abi.json`),
      JSON.stringify(artifact.abi, null, 2)
    );
    console.log(
      `Compiled ${contractName} (${fileName}) -> artifacts/${contractName}.json | runtime size: ${runtimeBytes} bytes`
    );
  }
}
