// Platform status endpoint — the one keyless Lambda route. Reports each
// microservice's catalog size straight from DynamoDB metadata (no table-read
// permissions: DescribeTable only, and ItemCount is ~6h-lagged, hence
// "approximate").
import { DynamoDBClient, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { json, route } from '../lib/http.js';

const client = new DynamoDBClient({});
// { "<serviceName>": "<tableName>", ... }
const SERVICES: Record<string, string> = JSON.parse(process.env.SERVICE_TABLES_JSON!);

export const handler = route({
  'GET /v2/status': async () => {
    const services = await Promise.all(
      Object.entries(SERVICES).map(async ([name, table]) => {
        try {
          const res = await client.send(new DescribeTableCommand({ TableName: table }));
          return {
            name,
            status: res.Table?.TableStatus === 'ACTIVE' ? 'operational' : 'degraded',
            approximateRecords: res.Table?.ItemCount ?? 0,
          };
        } catch {
          return { name, status: 'unreachable', approximateRecords: null };
        }
      })
    );
    const allUp = services.every((s) => s.status === 'operational');
    return json(200, {
      status: allUp ? 'operational' : 'degraded',
      apiVersions: { v1: 'deprecated (sunset 2027-06-30)', v2: 'current' },
      services,
      generatedAt: new Date().toISOString(),
    });
  },
});
