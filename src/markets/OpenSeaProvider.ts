import { ethers, BigNumber, Event } from "ethers";
import { Interface } from "@ethersproject/abi/lib/interface";
import { getLogger } from "../utils/logger";
import { IMarketOnChainProvider } from "../interfaces";
import {
  BaseMarketOnChainProviderFactory,
  ContractInstances,
  AbiInterfaces,
  MarketProviders,
  ChainTopics,
  SaleEvents,
  ChainEvents,
  EventMetadata,
  TxReceiptsWithMetadata,
  EventLogType,
  LogType,
} from "./BaseMarketOnChainProvider";
import { MarketConfig } from "../markets";
import { ChainProviders } from "../providers/OnChainProviderFactory";
import { Blockchain, Marketplace } from "../types";
import { AdapterState } from "../models";
import { TransactionReceipt, Log } from "@ethersproject/providers";
import {
  IERC1155Standard,
  IERC20Standard,
  IERC721Standard,
} from "../constants";
import { ParseErrors, UnparsableLogError } from "../utils/UnparsableLogError";
import {
  MetricsReporter as DefaultMetricsReporter,
  MetricData,
  customMetricsReporter,
} from "../utils/metrics";
import {
  ClusterManager,
  ClusterWorker,
  IClusterProvider,
} from "../utils/cluster";

const LOGGER = getLogger("OPENSEA_PROVIDER", {
  datadog: !!process.env.DATADOG_API_KEY,
});

const MATURE_BLOCK_AGE = 250;
const BLOCK_RANGE = 250;
const EVENT_RECEIPT_PARALLELISM: number =
  parseInt(process.env.EVENT_RECEIPT_PARALLELISM) || 2;

let MetricsReporter = DefaultMetricsReporter;

/**
 * OS Market Chain Provider
 *
 * Not completely fleshed out just yet, and there is a lot of
 * work to be done to have this be more genric. Many of the EVM
 * based chain details have creeped in (i.e. parsing logs).
 *
 * General idea with a market provider is an extension of chain
 * providers (i.e. RpcJsonProvider), and are meant to be interfaces
 * for interpreting on-chain events for a specific market that is then
 * generalized for the adapter. Other market providers should also
 * implement IMarketOnChainProvider, but that is subject to change as
 * it may be possible to create a generic market provider that will work
 * for the majority of marketplaces, so long as they follow the same
 * general outline of OS for example.
 */

export class OpenSeaProvider
  implements IMarketOnChainProvider, IClusterProvider
{
  public static ERC721ContractInterface = new ethers.utils.Interface(
    IERC721Standard
  );

  public static ERC1155ContractInterface = new ethers.utils.Interface(
    IERC1155Standard
  );

  public static ERC20ContractInterface = new ethers.utils.Interface(
    IERC20Standard
  );

  public chains: ChainProviders;
  public contracts: ContractInstances;
  public interfaces: AbiInterfaces;
  public topics: ChainTopics;
  public events: SaleEvents;
  public config: MarketConfig;

  private metrics: Map<number, Record<string, MetricData>>;
  private __metricsInterval: NodeJS.Timer;
  private cluster: ClusterManager;
  private worker: ClusterWorker;

  constructor(config: MarketConfig) {
    const { chains, contracts, interfaces, topics }: MarketProviders =
      BaseMarketOnChainProviderFactory.createMarketProviders(config);
    this.config = config;
    this.chains = chains;
    this.contracts = contracts;
    this.interfaces = interfaces;
    this.topics = topics;

    this.initMetrics();
  }

  public withCluster(kluster: ClusterManager): void {
    this.cluster = kluster;
    this.cluster.start().sendPing();
  }

  public withWorker(worker: ClusterWorker): void {
    this.worker = worker;
    MetricsReporter = customMetricsReporter("", "", [`worker:${worker.uuid}`]);
  }

  public async dispatchWorkMethod(
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    switch (method) {
      case "getEventReceipts": {
        // eslint-disable-next-line prefer-spread
        return this.getEventReceipts.apply(this, args);
      }
    }
  }

  private initMetrics(force = false): void {
    if (this.__metricsInterval) {
      if (!force) return;
      clearInterval(this.__metricsInterval);
    }
    this.metrics = new Map();
    this.__metricsInterval = setInterval(() => this.reportMetrics(), 1e4);
  }

  private reportMetrics() {
    for (const time of this.metrics.keys()) {
      const metrics: Record<string, MetricData> = this.metrics.get(time);
      for (const metric of Object.keys(metrics)) {
        const value = metrics[metric];
        MetricsReporter.submit(
          value.metric,
          value.value,
          value.type || "gauge",
          time || null
        );
        this.setMetric(metric);
      }
      this.metrics.delete(time);
    }
  }

  public setMetric(metric: string, value = 0) {
    const time = Math.floor(Date.now() / 1000);
    const timeHash = this.metrics.has(time) ? this.metrics.get(time) : {};
    this.metrics.set(time, {
      ...timeHash,
      [metric]: { metric, value } as MetricData,
    } as Record<string, MetricData>);
  }

  public ensureMetric(time: number, metric: string, initialValue = 0) {
    let timeHash = this.metrics.get(time);
    if (!timeHash) {
      timeHash = {};
    }
    if (!(metric in timeHash)) {
      timeHash[metric] = { metric, value: initialValue };
    }
    this.metrics.set(time, timeHash);
  }

  public incrMetric(metric: string, incr = 1) {
    const time = Math.floor(Date.now() / 1000);
    this.ensureMetric(time, metric);
    const value = this.metrics.has(time)
      ? this.metrics.get(time)[metric].value
      : 0;
    this.setMetric(metric, value + incr);
  }

  public decrMetric(metric: string, decr = 1) {
    const time = Math.floor(Date.now() / 1000);
    this.ensureMetric(time, metric);
    const value = this.metrics.has(time)
      ? this.metrics.get(time)[metric].value
      : 0;
    this.setMetric(metric, value - decr);
  }

  public async *fetchSales(): AsyncGenerator<ChainEvents> {
    // eslint-disable-next-line no-unreachable-loop
    for (const chain of Object.keys(this.chains) as Blockchain[]) {
      const { deployBlock, contractAddress } = this.config.chains[chain];
      const currentBlock: number = await this.chains[
        chain
      ].getCurrentBlockNumber();
      const lastMatureBlock = currentBlock - MATURE_BLOCK_AGE;
      let { lastSyncedBlockNumber } = await AdapterState.getSalesAdapterState(
        Marketplace.Opensea,
        chain,
        true,
        deployBlock
      );
      if (deployBlock && Number.isInteger(deployBlock)) {
        if (lastSyncedBlockNumber < deployBlock) {
          AdapterState.updateSalesLastSyncedBlockNumber(
            Marketplace.Opensea,
            deployBlock
          );
        }
        lastSyncedBlockNumber = Math.max(deployBlock, lastSyncedBlockNumber);
      }
      const contract = this.contracts[chain];
      const filterTopics = this.contracts[chain].interface.encodeFilterTopics(
        this.contracts[chain].interface.getEvent(
          this.config.chains[chain].saleEventName
        ),
        []
      );

      if (lastMatureBlock - lastSyncedBlockNumber <= MATURE_BLOCK_AGE) {
        LOGGER.error(`Not enough mature blocks to scan.`, {
          currentBlock,
          lastMatureBlock,
          lastSyncedBlockNumber,
        });
        return;
      }

      let retryCount = 0;
      let retryQuery = false;

      for (
        let i = 0;
        i < lastMatureBlock - lastSyncedBlockNumber;
        i += BLOCK_RANGE + 1
      ) {
        const fromBlock = lastSyncedBlockNumber + i;
        const toBlock =
          fromBlock + BLOCK_RANGE > currentBlock
            ? currentBlock
            : fromBlock + BLOCK_RANGE;

        LOGGER.info("Searching blocks: ", {
          fromBlock,
          toBlock,
          range: toBlock - fromBlock,
        });

        if (retryQuery) {
          LOGGER.warning(`Retrying query`, {
            fromBlock,
            toBlock,
            range: toBlock - fromBlock,
            retryCount,
          });
        }

        try {
          const queryFilterStart = performance.now();
          const events: Array<Event> = (
            await contract.queryFilter(
              {
                address: contractAddress,
                topics: filterTopics,
              },
              fromBlock,
              toBlock
            )
          ).filter((e) => !e.removed);
          const queryFilterEnd = performance.now();
          MetricsReporter.submit(
            `opensea.${chain}.contract_queryFilter.blockRange`,
            toBlock - fromBlock
          );
          MetricsReporter.submit(
            `opensea.${chain}.contract_queryFilter.latency`,
            queryFilterEnd - queryFilterStart
          );

          LOGGER.info(
            `Found ${events.length} events between ${fromBlock} to ${toBlock}`
          );

          if (events.length) {
            const result: Array<TxReceiptsWithMetadata> =
              await this.cluster.parallelizeMethod<
                Event,
                TxReceiptsWithMetadata
              >("getEventReceipts", events, chain);
            LOGGER.warning(`EventReceiptResult`, { result });
            const receipts =
              result &&
              result.reduce((m, r) => {
                for (const txHash of Object.keys(r)) {
                  if (txHash in m) {
                    m[txHash].meta = [...m[txHash].meta, ...r[txHash].meta];
                  } else {
                    m[txHash] = r[txHash];
                  }
                }
                return m;
              }, {} as TxReceiptsWithMetadata);

            yield {
              chain,
              events,
              blockRange: {
                startBlock: fromBlock,
                endBlock: toBlock,
              },
              receipts,
            };
          } else {
            yield {
              chain,
              events,
              blockRange: {
                startBlock: fromBlock,
                endBlock: toBlock,
              },
            };
          }

          retryCount = 0;
          retryQuery = false;
        } catch (e) {
          LOGGER.error(`Query error`, {
            error: /quorum/.test(e.message) ? `Quorum error` : e.message,
            reason: e.reason,
            fromBlock,
            toBlock,
            stack: e.stack.substr(0, 500),
          });
          if (retryCount < 3) {
            // try again
            retryCount++;
            i -= i - (BLOCK_RANGE + 1) < 0 ? i : BLOCK_RANGE + 1;
            retryQuery = true;
          } else if (retryCount > 3) {
            LOGGER.error(`Not able to recover from query errors`);
            throw new Error(`Not able to recover from query errors`);
          }
        }
      }
    }
  }

  public async getEventReceipts(
    events: Array<Event>,
    chain: Blockchain
  ): Promise<TxReceiptsWithMetadata> {
    const receipts: TxReceiptsWithMetadata = {};
    const queryReceiptStart = performance.now();
    for (let i = 0; i < events.length; i += EVENT_RECEIPT_PARALLELISM) {
      const eventsSlice = events.slice(i, i + EVENT_RECEIPT_PARALLELISM);
      const promises: Array<Promise<TransactionReceipt>> = [];
      const expectedReceiptCount: Record<string, number> = {};
      const promiseMap: Record<string, number> = {};

      this.incrMetric(
        `opensea.${chain}.event_txReceiptProcess.numReceiptsPerSecond`,
        eventsSlice.length
      );

      for (const event of eventsSlice) {
        if (!(event.transactionHash in expectedReceiptCount)) {
          expectedReceiptCount[event.transactionHash] = 0;
        }
        expectedReceiptCount[event.transactionHash]++;
        if (!(event.transactionHash in promiseMap)) {
          promiseMap[event.transactionHash] =
            promises.push(this.getEventReceipt(event, chain)) - 1;
        }
      }

      const txReceipts = await Promise.all(promises);

      const queryReceiptEnd = performance.now();
      const queryTime = queryReceiptEnd - queryReceiptStart;
      MetricsReporter.submit(
        `opensea.${chain}.event_queryTxReceipt.latency`,
        queryTime / eventsSlice.length
      );

      if (txReceipts.length !== eventsSlice.length) {
        LOGGER.warning(
          `Receipt to event ratio unbalanced, possible multi-sale`,
          {
            eventsSlice,
            txReceipts,
          }
        );
      }

      for (let j = 0; j < eventsSlice.length; j++) {
        const event = eventsSlice[j];
        const receipt = txReceipts[promiseMap[event.transactionHash]];
        if (!(receipt.transactionHash in receipts)) {
          receipts[receipt.transactionHash] = {
            receipt,
            meta: [this.getEventMetadata(event, receipt, chain)],
          };
        } else {
          LOGGER.debug(`Multi-sale TX`, {
            event,
            receipt,
          });
          receipts[event.transactionHash].meta.push(
            this.getEventMetadata(event, receipt, chain)
          );
        }
        this.incrMetric(
          `opensea.${chain}.event_txReceiptProcess.numEventsPerSecond`
        );
      }
    }
    return receipts;
  }

  private async getEventReceipt(
    event: Event,
    chain: Blockchain,
    retryCount = 0
  ): Promise<TransactionReceipt> {
    if (
      !("getTransactionReceipt" in event) ||
      !(typeof event.getTransactionReceipt === "function")
    ) {
      this.restoreEventWrap(event, chain);
    }

    try {
      return await event.getTransactionReceipt();
    } catch (e) {
      if (retryCount > 3) {
        LOGGER.error(`Failed to get event receipt`, {
          error: e,
          event,
        });
        e.message = `Unabled to get event receipt`;
        throw e;
      }
      retryCount++;
      return await this.getEventReceipt(event, chain, retryCount);
    }
  }

  private restoreEventWrap(event: Event, chain: Blockchain) {
    event.getTransactionReceipt = async (): Promise<TransactionReceipt> => {
      return await this.chains[chain].provider.getTransactionReceipt(
        event.transactionHash
      );
    };
  }

  public getEventMetadata(
    event: Event,
    receipt: TransactionReceipt,
    chain = Blockchain.Ethereum
  ): EventMetadata {
    const { logs } = receipt;
    const { price: originalPrice } = event.args;
    let eventMetadata: EventMetadata = {
      contractAddress: null,
      eventSignatures: [],
      buyer: null,
      seller: null,
      tokenID: null,
      price: originalPrice,
      data: null,
    };

    if (!originalPrice) {
      eventMetadata.price = event.args[4];
    }

    let eventSigs,
      isERC721,
      isERC1155,
      hasERC20,
      ERC20Logs,
      ERC721Logs,
      ERC1155Logs;

    let relevantLogs;

    try {
      const parsedLogs: EventLogType[] = logs.map((l) =>
        this.parseLog(l, chain)
      );
      const eventIndex = this.getEventIndex(event, parsedLogs);
      const eventLog = parsedLogs[eventIndex];
      relevantLogs = this.findEventRelevantLogs(event, parsedLogs, eventIndex);
      ({
        eventSigs,
        isERC721,
        isERC1155,
        hasERC20,
        ERC20Logs,
        ERC721Logs,
        ERC1155Logs,
      } = this.reduceParsedLogs(relevantLogs));
      const price = hasERC20
        ? this.getERC20Price(ERC20Logs)
        : eventMetadata.price;
      eventMetadata.eventSignatures = eventSigs;

      LOGGER.debug(`Found event index from ${parsedLogs.length} receipt logs`, {
        idx: eventIndex,
        tx: receipt.transactionHash,
        event: event.event,
        type: eventLog.type.toString(),
        nRelevantLogs: relevantLogs.length,
        isERC721,
        isERC1155,
        hasERC20,
      });

      if (isERC721) {
        const ERC721Transfer = (ERC721Logs as EventLogType[]).find(
          (l) => l.log.name === "Transfer"
        );

        if (ERC721Transfer) {
          const [, seller, buyer, tokenID] = ERC721Transfer.topics;
          eventMetadata = {
            ...eventMetadata,
            seller: ethers.utils.hexStripZeros(seller),
            buyer: ethers.utils.hexStripZeros(buyer),
            tokenID,
            contractAddress: ERC721Transfer.contract,
            data: ERC721Transfer.decodedData,
          };
          LOGGER.debug(`ERC721Transfer`, {
            ...eventMetadata,
            tx: receipt.transactionHash,
          });
          return eventMetadata;
        }
      } else if (isERC1155) {
        const ERC1155TransferSingle = (ERC1155Logs as EventLogType[]).find(
          (l) => l.log.name === "TransferSingle"
        );
        const ERC1155TransferBatch = (ERC1155Logs as EventLogType[]).find(
          (l) => l.log.name === "TransferBatch"
        );
        if (ERC1155TransferSingle) {
          const [, seller, buyer] = ERC1155TransferSingle.decodedData;
          eventMetadata = {
            ...eventMetadata,
            seller: ethers.utils.hexStripZeros(seller),
            buyer: ethers.utils.hexStripZeros(buyer),
            tokenID: null,
            data: ERC1155TransferSingle.decodedData,
          };
          LOGGER.debug(`ERC1155TransferSingle`, {
            ...eventMetadata,
            tx: receipt.transactionHash,
          });
          return eventMetadata;
        } else if (ERC1155TransferBatch) {
          // TODO
          LOGGER.alert(`TODO: ERC1155TransferBatch`, {
            ...eventMetadata,
            tx: receipt.transactionHash,
          });
          return eventMetadata;
        }
      }

      this.warnNonStandardEventLogs(eventIndex, event, receipt);
      return eventMetadata;
    } catch (e) {
      LOGGER.error(`Retrieving event metadata failed`, {
        eventMetadata,
        event,
        receipt,
        ERCRelevantLogs: isERC721 ? ERC721Logs : ERC1155Logs,
        ERC20: hasERC20 ? ERC20Logs : [null],
        relevantLogs,
      });
    } finally {
      // eslint-disable-next-line no-unsafe-finally
      return eventMetadata;
    }
  }

  public warnNonStandardEventLogs(
    eventIndex: number,
    event: Event,
    receipt: TransactionReceipt
  ) {
    LOGGER.warning(`Event is NON_STANDARD`, { eventIndex, event, receipt });
  }

  public getERC20Price(logs: EventLogType[]): BigNumber {
    return null;
  }

  public reduceParsedLogs(parsedRelevantLogs: EventLogType[]) {
    return parsedRelevantLogs.reduce(
      (c, l) => {
        c.eventNames.push(l.log.name);
        c.eventSigs.push(l.log.signature);

        if (l.type === LogType.ERC721) {
          c.isERC721 = true;
          c.ERC721Logs.push(l);
        } else if (l.type === LogType.ERC1155) {
          c.isERC1155 = true;
          c.ERC1155Logs.push(l);
        }

        if (l.type === LogType.ERC20) {
          c.hasERC20 = true;
          c.ERC20Logs.push(l);
        }

        return c;
      },
      {
        eventNames: [],
        eventSigs: [],
        ERC20Logs: [],
        ERC721Logs: [],
        ERC1155Logs: [],
        isERC721: false,
        isERC1155: false,
        hasERC20: false,
      }
    );
  }

  public parseLog(log: Log, chain: Blockchain): EventLogType {
    const errors: ParseErrors = {};
    const parsers: Partial<Record<LogType | Marketplace, Interface>> = {
      [LogType.ERC721]: OpenSeaProvider.ERC721ContractInterface,
      [LogType.ERC1155]: OpenSeaProvider.ERC1155ContractInterface,
      [LogType.ERC20]: OpenSeaProvider.ERC20ContractInterface,
      [Marketplace.Opensea]: this.contracts[chain].interface,
    };

    const parsed: EventLogType = {
      log: null,
      type: null,
      contract: log.address,
      topics: log.topics,
      errors: [],
    };
    const parseLogStart = performance.now();
    for (const lType of Object.keys(parsers) as LogType[] | Marketplace[]) {
      try {
        parsed.log = parsers[lType].parseLog(log);
        parsed.type = lType;
        try {
          parsed.decodedData = parsers[lType].decodeEventLog(
            parsed.log.name,
            log.data,
            log.topics
          );
        } catch (evtLogErr) {
          LOGGER.error(`Failed to decode event log data`, {
            lType,
            evtLogErr,
            name: parsed.log.name,
            data: log.data,
            topics: log.topics,
          });
        }
        break;
      } catch (e) {
        errors[lType] = e;
      }
    }

    if (Object.keys(errors).length === Object.keys(parsers).length) {
      parsed.log = null;
      parsed.type = LogType.UNKNOWN;
      parsed.errors.push(new UnparsableLogError(log, errors));
    }
    const parseLogEnd = performance.now();
    MetricsReporter.submit(
      `opensea.${chain}.receipt_parseLog.latency`,
      parseLogEnd - parseLogStart
    );

    return parsed;
  }

  public getEventIndex(event: Event, parsedLogs: EventLogType[]): number {
    for (let i = parsedLogs.length - 1; i >= 0; i--) {
      const evtParsedLog = parsedLogs[i];
      if (event.topics[0] === evtParsedLog.log.topic) {
        return i;
      }
    }
    return null;
  }

  public findEventRelevantLogs(
    event: Event,
    parsedLogs: EventLogType[],
    eventIndex: number
  ) {
    const relevantLogs: EventLogType[] = [];

    if (parsedLogs.length === 1) {
      return relevantLogs;
    }

    for (let i = eventIndex - 1; i >= 0; i--) {
      const parsedEvtLog = parsedLogs[i];

      switch (parsedEvtLog.type) {
        case LogType.ERC1155:
        case LogType.ERC721:
        case LogType.ERC20:
          relevantLogs.unshift(parsedEvtLog);
          break;
        case Marketplace.Opensea:
        default:
          return relevantLogs;
      }
    }

    return relevantLogs;
  }
}