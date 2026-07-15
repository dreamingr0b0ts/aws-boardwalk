import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export const TABLE = process.env.TABLE_NAME ?? '';

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export type AppStatus = 'submitted' | 'under_review' | 'approved' | 'denied';

export const STATUSES: AppStatus[] = ['submitted', 'under_review', 'approved', 'denied'];

export interface PermitType {
  slug: string;
  name: string;
  description: string;
  category: string;
  fee: number;
  processingDays: number;
  active: boolean;
}

export interface Application {
  id: string;
  typeSlug: string;
  typeName: string;
  category: string;
  applicantSub: string;
  applicantName: string;
  applicantEmail: string;
  address: string;
  description: string;
  status: AppStatus;
  submittedAt: string;
  decidedAt?: string;
  decisionNote?: string;
}

/** Strip single-table plumbing before an item leaves the API. */
export function publicView<T extends Record<string, unknown>>(item: T): Omit<T, 'PK' | 'SK' | 'GSI1PK' | 'GSI1SK' | 'GSI2PK' | 'GSI2SK' | 'entity'> {
  const { PK, SK, GSI1PK, GSI1SK, GSI2PK, GSI2SK, entity, ...rest } = item;
  return rest as Omit<T, 'PK' | 'SK' | 'GSI1PK' | 'GSI1SK' | 'GSI2PK' | 'GSI2SK' | 'entity'>;
}
