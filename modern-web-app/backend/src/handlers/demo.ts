import { ScanCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminAddUserToGroupCommand,
  AdminDeleteUserCommand,
  ListUsersCommand,
  UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';
import { ddb, TABLE } from '../lib/db.js';
import { buildSeed } from '../lib/seed.js';

// Demo-reset Lambda: wipes and reseeds the table, re-asserts the two demo
// accounts, and removes every other Cognito user. Runs nightly via
// EventBridge Scheduler and on demand via `make seed`.

const cognito = new CognitoIdentityProviderClient({});
const POOL = process.env.USER_POOL_ID ?? '';

interface DemoUser {
  email: string;
  password: string;
  name: string;
  group: 'admin' | 'citizen';
}

const DEMO_USERS: DemoUser[] = [
  {
    email: process.env.DEMO_ADMIN_EMAIL ?? '',
    password: process.env.DEMO_ADMIN_PASSWORD ?? '',
    name: 'Demo Admin',
    group: 'admin',
  },
  {
    email: process.env.DEMO_CITIZEN_EMAIL ?? '',
    password: process.env.DEMO_CITIZEN_PASSWORD ?? '',
    name: 'Demo Citizen',
    group: 'citizen',
  },
];

async function ensureDemoUser(u: DemoUser): Promise<string> {
  let sub: string | undefined;
  try {
    const existing = await cognito.send(new AdminGetUserCommand({ UserPoolId: POOL, Username: u.email }));
    sub = existing.UserAttributes?.find((a) => a.Name === 'sub')?.Value;
  } catch (err) {
    if (!(err instanceof UserNotFoundException)) throw err;
    const created = await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: POOL,
        Username: u.email,
        MessageAction: 'SUPPRESS',
        UserAttributes: [
          { Name: 'email', Value: u.email },
          { Name: 'email_verified', Value: 'true' },
          { Name: 'name', Value: u.name },
        ],
      })
    );
    sub = created.User?.Attributes?.find((a) => a.Name === 'sub')?.Value;
  }

  await cognito.send(
    new AdminSetUserPasswordCommand({ UserPoolId: POOL, Username: u.email, Password: u.password, Permanent: true })
  );
  await cognito.send(
    new AdminAddUserToGroupCommand({ UserPoolId: POOL, Username: u.email, GroupName: u.group })
  );

  if (!sub) throw new Error(`could not resolve sub for ${u.email}`);
  return sub;
}

/** Self-signups are welcome all day — and evicted every night. */
async function purgeStrangerUsers(): Promise<number> {
  const keep = new Set(DEMO_USERS.map((u) => u.email.toLowerCase()));
  let purged = 0;
  let pagination: string | undefined;

  do {
    const page = await cognito.send(
      new ListUsersCommand({ UserPoolId: POOL, PaginationToken: pagination, Limit: 60 })
    );
    for (const user of page.Users ?? []) {
      const email = user.Attributes?.find((a) => a.Name === 'email')?.Value?.toLowerCase();
      if (email && keep.has(email)) continue;
      if (!user.Username) continue;
      await cognito.send(new AdminDeleteUserCommand({ UserPoolId: POOL, Username: user.Username }));
      purged += 1;
    }
    pagination = page.PaginationToken;
  } while (pagination);

  return purged;
}

async function wipeTable(): Promise<number> {
  let deleted = 0;
  let startKey: Record<string, unknown> | undefined;

  do {
    const page = await ddb.send(
      new ScanCommand({
        TableName: TABLE,
        ProjectionExpression: 'PK, SK',
        ExclusiveStartKey: startKey,
      })
    );
    const keys = page.Items ?? [];
    for (let i = 0; i < keys.length; i += 25) {
      let requests = keys.slice(i, i + 25).map((k) => ({ DeleteRequest: { Key: { PK: k.PK, SK: k.SK } } }));
      while (requests.length > 0) {
        const res = await ddb.send(new BatchWriteCommand({ RequestItems: { [TABLE]: requests } }));
        deleted += requests.length;
        const unprocessed = res.UnprocessedItems?.[TABLE] ?? [];
        deleted -= unprocessed.length;
        requests = unprocessed as typeof requests;
        if (requests.length > 0) await new Promise((r) => setTimeout(r, 250));
      }
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);

  return deleted;
}

async function writeItems(items: Record<string, unknown>[]): Promise<void> {
  for (let i = 0; i < items.length; i += 25) {
    let requests = items.slice(i, i + 25).map((item) => ({ PutRequest: { Item: item } }));
    while (requests.length > 0) {
      const res = await ddb.send(new BatchWriteCommand({ RequestItems: { [TABLE]: requests } }));
      const unprocessed = res.UnprocessedItems?.[TABLE] ?? [];
      requests = unprocessed as typeof requests;
      if (requests.length > 0) await new Promise((r) => setTimeout(r, 250));
    }
  }
}

export const handler = async (event: { mode?: string } = {}) => {
  console.log('demo-reset start', { mode: event.mode ?? 'reset' });

  const [adminSub, citizenSub] = await Promise.all(DEMO_USERS.map(ensureDemoUser));
  const purged = await purgeStrangerUsers();

  const deleted = await wipeTable();
  const seed = buildSeed(new Date(), {
    sub: citizenSub!,
    email: DEMO_USERS[1]!.email,
    name: DEMO_USERS[1]!.name,
  });
  await writeItems(seed.items);

  const result = { ...seed.summary, deleted, purgedUsers: purged, adminSub, citizenSub };
  console.log('demo-reset done', result);
  return result;
};
