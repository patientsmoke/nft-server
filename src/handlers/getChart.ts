import { HistoricalStatistics } from "../models";
import {
  successResponse,
  errorResponse,
  IResponse,
} from "../utils/lambda-response";

const handler = async (event: any): Promise<IResponse> => {
  try {
    const { chain, marketplace } = event?.pathParameters || {};
    const chart = await HistoricalStatistics.getChart({ chain, marketplace });
    return successResponse(chart);
  } catch (e) {
    console.log(e);
    return errorResponse({ message: "Error" });
  }
};

export default handler;
