import axios from "axios";
import { Sale } from "../models/sale";
import { DataAdapter } from ".";
import { Coingecko } from "../api/coingecko";
import { getPriceAtDate, sleep, formatUSD } from "../utils";
import {
  ETHEREUM_DEFAULT_TOKEN_ADDRESS,
  SOLANA_DEFAULT_TOKEN_ADDRESS,
} from "../constants";

const BASE_TOKENS = [
  {
    address: ETHEREUM_DEFAULT_TOKEN_ADDRESS,
    fetch: Coingecko.getHistoricalEthPrices,
  },
  {
    address: SOLANA_DEFAULT_TOKEN_ADDRESS,
    fetch: Coingecko.getHistoricalSolPrices,
  },
];
const BASE_TOKENS_ADDRESSES = BASE_TOKENS.map((token) => token.address);

async function runSaleCurrencyConversions(): Promise<void> {
  const sales = await Sale.getUnconvertedSales();
  const tokenAddressPrices = await fetchTokenAddressPrices();

  console.log("Updating currency conversions for", sales.length, "sales");

  await updateSaleCurrencyConversions(sales, tokenAddressPrices);
}

async function fetchTokenAddressPrices(): Promise<Record<string, number[][]>> {
  const tokenAddressPrices: Record<string, number[][]> = {};

  const tokenAddressesRaw = await Sale.getUnconvertedSalesTokenAddresses();
  const tokenAddresses = tokenAddressesRaw
    .map((data) => data.tokenAddress)
    .filter((data) => !BASE_TOKENS_ADDRESSES.includes(data));

  for (const baseToken of BASE_TOKENS) {
    tokenAddressPrices[baseToken.address] = await baseToken.fetch();
  }

  for (const tokenAddress of tokenAddresses) {
    try {
      //TODO generalize for tokens on other chains
      const prices = await Coingecko.getHistoricalPricesByAddress(
        "ethereum",
        tokenAddress,
        "eth"
      );
      tokenAddressPrices[tokenAddress] = prices;
    } catch (e) {
      if (axios.isAxiosError(e)) {
        if (e.response.status === 404) {
          console.error("Historical prices not found:", e.message);
        }
        if (e.response.status === 429) {
          // Backoff for 1 minute if rate limited
          await sleep(60);
        }
      }
      console.error("Error retrieving historical prices:", e.message);
    }
    await sleep(1);
  }

  return tokenAddressPrices;
}

//TODO optimize and refactor
async function updateSaleCurrencyConversions(
  sales: Sale[],
  tokenAddressPrices: Record<string, number[][]>
): Promise<void> {
  for (const sale of sales) {
    const saleTokenAddress = sale.paymentTokenAddress;
    const saleTimestamp = sale.timestamp.toString();
    const salePrice = sale.price;

    if (
      saleTokenAddress in tokenAddressPrices &&
      !BASE_TOKENS_ADDRESSES.includes(saleTokenAddress)
    ) {
      const baseAtDate = getPriceAtDate(
        saleTimestamp,
        tokenAddressPrices[saleTokenAddress]
      );
      const priceBase = baseAtDate ? salePrice * baseAtDate : null;

      //TODO generalize for tokens on other chains
      const priceUSD = priceBase
        ? formatUSD(
            priceBase *
              getPriceAtDate(
                saleTimestamp,
                tokenAddressPrices[ETHEREUM_DEFAULT_TOKEN_ADDRESS]
              )
          )
        : null;

      sale.priceBase = priceBase ?? -1;
      sale.priceUSD = priceUSD ?? BigInt(-1);
    } else if (BASE_TOKENS_ADDRESSES.includes(saleTokenAddress)) {
      sale.priceBase = salePrice;
      sale.priceUSD = formatUSD(
        salePrice *
          getPriceAtDate(saleTimestamp, tokenAddressPrices[saleTokenAddress])
      );
    } else {
      sale.priceBase = -1;
      sale.priceUSD = BigInt(-1);
    }
  }

  // Break in chunks of 65535 so Postgres doesn't break, and
  // save in chunks of 1000 so Typeorm doesn't freeze
  while (sales.length) {
    console.log("Sales left to update:", sales.length);
    await Sale.save(sales.splice(0, 65535), { chunk: 1000 });
  }
}

async function run(): Promise<void> {
  try {
    while (true) {
      console.log("Running currency converter");
      await runSaleCurrencyConversions();
      await sleep(60 * 60);
    }
  } catch (e) {
    console.error("Currency converter adapter error:", e.message);
  }
}

const CurrencyConverterAdapter: DataAdapter = { run };
export default CurrencyConverterAdapter;
