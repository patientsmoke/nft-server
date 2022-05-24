import { OwnableStandard } from "./constants";
import { Blockchain, Marketplace, HumanABI } from "./types";

export type MarketChainConfig = {
  contractAddress: string;
  abi: HumanABI;
  saleEventName: string;
  deploymentEventName: string;
  deployBlock?: number;
};

export type MarketChainsConfig = Partial<Record<Blockchain, MarketChainConfig>>;

export type MarketConfig = {
  chains: MarketChainsConfig;
};

const markets: Partial<Record<Marketplace, MarketConfig>> = {
  [Marketplace.Opensea]: {
    chains: {
      [Blockchain.Ethereum]: {
        deployBlock: 14120913,
        contractAddress: "0x7f268357a8c2552623316e2562d90e642bb538e5",
        saleEventName: "OrdersMatched",
        deploymentEventName: "OwnershipTransferred",
        abi: [
          ...OwnableStandard,
          "event OrdersMatched (bytes32 buyHash, bytes32 sellHash, address indexed maker, address indexed taker, uint price, bytes32 indexed metadata)",
        ],
      },
    },
  },
};

export const OpenSea = markets[Marketplace.Opensea];

export default markets;