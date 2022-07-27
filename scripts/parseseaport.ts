import { Blockchain } from "../src/types";
import { OpenSea } from "../src/markets";
import { OpenSeaProvider } from "../src/markets/OpenSeaProvider";
import { Provider } from "@ethersproject/abstract-provider";
import { providers } from "../src/providers/OnChainProviderFactory";

const txHash = process.argv[2];
const logIndex = parseInt(process.argv[3]);
const parseLogOnly = !!parseInt(process.argv[4]);

const ethProvider = <Provider>providers[Blockchain.Ethereum];

main();

async function main() {
  const seaport = OpenSeaProvider.build(OpenSea).find(
    (p) => p.CONTRACT_NAME === "seaport"
  );

  const receipt = await ethProvider.getTransactionReceipt(txHash);
  const log = receipt.logs.find((l) => l.logIndex === logIndex);

  if (parseLogOnly) {
    const parsed = seaport.parseLog(log, Blockchain.Ethereum);
    console.log(parsed.log.args.offer.map((o: any) => o.amount.toString()));
  } else {
    const parsed = seaport.parseEvents([log], Blockchain.Ethereum)[0];
    console.log(parsed, parsed.data.raw);
  }

  process.exit(0);
}