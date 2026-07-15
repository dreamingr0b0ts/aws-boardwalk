import { DeleteCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { ddb, TABLE, type DocRecord } from '../lib/store.js';

const BUCKET = process.env.DOCS_BUCKET!;

const s3 = new S3Client({});

/**
 * Nightly broom (EventBridge 09:00 UTC, same hour as plank 1): purge every
 * user-uploaded document — DynamoDB record, original file, and extraction —
 * so the browsable index resets to the seeded corpus. Item TTL is the backstop
 * if this ever fails; seeds are never touched.
 */
export async function handler(): Promise<{ purged: number }> {
  const uploads: DocRecord[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new ScanCommand({
        TableName: TABLE,
        FilterExpression: 'SK = :meta AND #src = :upload',
        ExpressionAttributeNames: { '#src': 'source' },
        ExpressionAttributeValues: { ':meta': 'META', ':upload': 'upload' },
        ExclusiveStartKey: startKey,
      })
    );
    uploads.push(...((page.Items ?? []) as DocRecord[]));
    startKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);

  for (const doc of uploads) {
    const listed = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `incoming/${doc.docId}/` })
    );
    const keys = (listed.Contents ?? []).map((o) => ({ Key: o.Key! }));
    keys.push({ Key: `extracted/${doc.docId}.json` });
    await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: keys, Quiet: true } }));
    await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `DOC#${doc.docId}`, SK: 'META' } }));
  }

  console.log(`purged ${uploads.length} uploaded document(s); seeds untouched`);
  return { purged: uploads.length };
}
