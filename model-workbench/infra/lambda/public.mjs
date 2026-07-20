// Anonymous landing data: the model roster, the scenario catalog, and the
// aggregate daily counters. This function's role has NO bedrock permissions —
// nothing on this route can spend a token.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { catalog } from "./scenarios.mjs";

const TABLE = process.env.TABLE_NAME;
const MODELS = JSON.parse(process.env.MODELS);
const USER_DAILY_LIMIT = Number(process.env.USER_DAILY_LIMIT ?? 30);
const GLOBAL_DAILY_LIMIT = Number(process.env.GLOBAL_DAILY_LIMIT ?? 120);
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS ?? 500);

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const handler = async () => {
  let globalUsed = 0;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `USAGE#${today}`, SK: "GLOBAL" } }));
    globalUsed = Number(res.Item?.count ?? 0);
  } catch {
    /* landing stats are cosmetic */
  }

  return {
    statusCode: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify({
      models: MODELS,
      scenarios: catalog(),
      limits: { userDailyRuns: USER_DAILY_LIMIT, globalDailyRuns: GLOBAL_DAILY_LIMIT, maxOutputTokens: MAX_OUTPUT_TOKENS },
      stats: { globalUsed },
    }),
  };
};
