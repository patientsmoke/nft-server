import { Marketplace } from "../types";
import dynamodb from "../utils/dynamodb";

export class Sale {
  txnHash: string;
  sellerAddress: string;
  buyerAddress: string;
  marketplace: Marketplace;
  price: number;
  priceBase: number;
  priceUSD: number;
  paymentTokenAddress: string;
  excluded: boolean;

  static async insert({
    slug,
    marketplace,
    sales,
  }: {
    slug: string;
    marketplace: Marketplace;
    sales: any[];
  }) {
    const batchWriteStep = 25;
    for (let i = 0; i < sales.length; i += batchWriteStep) {
      const items = sales.slice(i, i + batchWriteStep).map((sale: any) => {
        const { timestamp, txnHash, ...data } = sale;
        return {
          PK: `sales#${slug}#marketplace#${marketplace}`,
          SK: `${timestamp}#txnHash#${txnHash}`,
          ...data,
        };
      });
      await dynamodb.batchWrite(items);
    }
  }

  static async getLastSaleTime({
    slug,
    marketplace,
  }: {
    slug: string;
    marketplace: Marketplace;
  }) {
    return dynamodb
      .query({
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: {
          ":pk": `sales#${slug}#marketplace#${marketplace}`,
        },
        Limit: 1,
        ScanIndexForward: false,
      })
      .then((result) => {
        const results = result.Items;
        if (results.length) {
          return results[0]?.SK?.split("#")[0];
        }
        return "0";
      });
  }
}
