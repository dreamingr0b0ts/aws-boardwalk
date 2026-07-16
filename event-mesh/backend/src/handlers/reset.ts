// Nightly broom (09:00 UTC, the boardwalk's shared reset hour): purge the
// dead-letter queues and sweep all request traces. Lifetime STATS counters
// survive; USAGE counters expire via TTL on their own.

import { PurgeQueueCommand, SQSClient } from '@aws-sdk/client-sqs';
import { BatchWriteCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../lib/trace.js';

const TABLE = process.env.TABLE_NAME!;
const QUEUES: Record<string, { dlqUrl: string }> = JSON.parse(process.env.QUEUES_JSON!);

const sqs = new SQSClient({});

export async function handler(): Promise<{ deletedItems: number; purgedQueues: number }> {
  let deletedItems = 0;
  let startKey: Record<string, unknown> | undefined;

  do {
    const page = await ddb.send(
      new ScanCommand({
        TableName: TABLE,
        FilterExpression: 'begins_with(PK, :req)',
        ExpressionAttributeValues: { ':req': 'REQ#' },
        ProjectionExpression: 'PK, SK',
        ExclusiveStartKey: startKey,
      })
    );

    const keys = page.Items ?? [];
    for (let i = 0; i < keys.length; i += 25) {
      const batch = keys.slice(i, i + 25);
      await ddb.send(
        new BatchWriteCommand({
          RequestItems: {
            [TABLE]: batch.map((k) => ({ DeleteRequest: { Key: { PK: k.PK, SK: k.SK } } })),
          },
        })
      );
      deletedItems += batch.length;
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);

  let purgedQueues = 0;
  for (const q of Object.values(QUEUES)) {
    try {
      await sqs.send(new PurgeQueueCommand({ QueueUrl: q.dlqUrl }));
      purgedQueues += 1;
    } catch (err: unknown) {
      // PurgeQueue allows one purge per 60s; a manual reset racing the
      // nightly one shouldn't fail the whole sweep.
      if ((err as { name?: string }).name !== 'PurgeQueueInProgress') throw err;
    }
  }

  console.log(`reset: deleted ${deletedItems} trace items, purged ${purgedQueues} DLQs`);
  return { deletedItems, purgedQueues };
}
