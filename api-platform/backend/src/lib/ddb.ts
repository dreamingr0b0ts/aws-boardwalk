import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { BadRequest, decodeToken } from './http.js';

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export interface ListPage {
  items: Record<string, unknown>[];
  lastEvaluatedKey?: Record<string, unknown>;
}

// Filtered, cursor-paginated Scan. These catalogs are a few hundred items per
// service, so a filtered Scan with a real LastEvaluatedKey cursor is the
// honest simplest thing — the pagination contract to clients stays identical
// if the storage ever moves to a GSI Query.
export async function listScan(opts: {
  table: string;
  keyAttrs: string[]; // the table's key schema, for building resume cursors
  limit: number;
  nextToken?: string;
  equals: Record<string, string | undefined>; // attribute -> required value (undefined = no filter)
}): Promise<ListPage> {
  let startKey: Record<string, unknown> | undefined;
  if (opts.nextToken) {
    const decoded = decodeToken(opts.nextToken);
    if (!decoded) throw new BadRequest('nextToken is not a valid cursor from a previous response.');
    startKey = decoded;
  }

  const clauses: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  for (const [attr, value] of Object.entries(opts.equals)) {
    if (value === undefined) continue;
    clauses.push(`#${attr} = :${attr}`);
    names[`#${attr}`] = attr;
    values[`:${attr}`] = value;
  }

  // A filtered Scan can return an empty page while more matches remain; keep
  // scanning until the page fills or the table ends so clients never see a
  // confusing empty-but-has-nextToken page.
  const items: Record<string, unknown>[] = [];
  let scanKey: Record<string, unknown> | undefined = startKey;
  do {
    const res: {
      Items?: Record<string, unknown>[];
      LastEvaluatedKey?: Record<string, unknown>;
    } = await ddb.send(
      new ScanCommand({
        TableName: opts.table,
        Limit: 100,
        ExclusiveStartKey: scanKey,
        FilterExpression: clauses.length ? clauses.join(' AND ') : undefined,
        ExpressionAttributeNames: clauses.length ? names : undefined,
        ExpressionAttributeValues: clauses.length ? values : undefined,
      })
    );
    for (const item of res.Items ?? []) {
      items.push(item);
      if (items.length === opts.limit) {
        // Resume exactly after the last returned item (its own key is a valid
        // ExclusiveStartKey), unless it was also the final item of the table.
        const isTableEnd = !res.LastEvaluatedKey && item === (res.Items ?? []).at(-1);
        return {
          items,
          lastEvaluatedKey: isTableEnd
            ? undefined
            : Object.fromEntries(opts.keyAttrs.map((attr) => [attr, item[attr]])),
        };
      }
    }
    scanKey = res.LastEvaluatedKey;
  } while (scanKey);

  return { items };
}
