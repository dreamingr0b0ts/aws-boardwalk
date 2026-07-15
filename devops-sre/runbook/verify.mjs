// Backup/restore drill — verify + report step.
// Compares the restored scratch table against the live source, measures
// RTO/RPO, and publishes the report to the ops status page.

import { DynamoDBClient, ScanCommand, DescribeContinuousBackupsCommand } from "@aws-sdk/client-dynamodb";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { CloudFrontClient, CreateInvalidationCommand } from "@aws-sdk/client-cloudfront";

const ddb = new DynamoDBClient({});
const s3 = new S3Client({});
const cf = new CloudFrontClient({});

async function countItems(table) {
  let count = 0;
  let key;
  do {
    const page = await ddb.send(
      new ScanCommand({ TableName: table, Select: "COUNT", ExclusiveStartKey: key })
    );
    count += page.Count ?? 0;
    key = page.LastEvaluatedKey;
  } while (key);
  return count;
}

export const handler = async (event) => {
  const { sourceTable, drillTable, backupArn, backupCreatedAt, executionStart, executionName } = event;
  const now = new Date();

  const [sourceCount, drillCount] = await Promise.all([
    countItems(sourceTable),
    countItems(drillTable),
  ]);

  // PITR posture on the live table. With PITR on, worst-case data loss (RPO)
  // is the gap to LatestRestorableDateTime — normally well under 5 minutes.
  let pitr = { enabled: false };
  const cb = await ddb.send(new DescribeContinuousBackupsCommand({ TableName: sourceTable }));
  const desc = cb.ContinuousBackupsDescription?.PointInTimeRecoveryDescription;
  if (desc?.PointInTimeRecoveryStatus === "ENABLED") {
    const latest = desc.LatestRestorableDateTime;
    pitr = {
      enabled: true,
      latestRestorableTime: latest?.toISOString(),
      rpoSeconds: latest ? Math.max(0, Math.round((now - latest) / 1000)) : null,
    };
  }

  const started = new Date(executionStart);
  const backupAt = new Date(backupCreatedAt);
  const verified = sourceCount === drillCount && drillCount >= 0;

  const report = {
    runbook: "backup-restore-drill",
    execution: executionName,
    startedAt: started.toISOString(),
    completedAt: now.toISOString(),
    sourceTable,
    drillTable,
    backupArn,
    result: verified ? "PASS" : "FAIL",
    itemCounts: { source: sourceCount, restored: drillCount },
    // RTO measured end-to-end: snapshot + restore + integrity check.
    rtoSeconds: Math.round((now - started) / 1000),
    // RPO for the on-demand snapshot path: age of the backup we restored from.
    snapshotRpoSeconds: Math.round((now - backupAt) / 1000),
    pointInTimeRecovery: pitr,
  };

  const bucket = process.env.SITE_BUCKET;
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: "runbook/latest.json",
    Body: JSON.stringify(report, null, 2),
    ContentType: "application/json",
    CacheControl: "no-cache",
  }));
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: `runbook/history/${now.toISOString()}-${executionName}.json`,
    Body: JSON.stringify(report, null, 2),
    ContentType: "application/json",
  }));

  await cf.send(new CreateInvalidationCommand({
    DistributionId: process.env.DISTRIBUTION,
    InvalidationBatch: {
      CallerReference: `${executionName}-${Date.now()}`,
      Paths: { Quantity: 1, Items: ["/runbook/latest.json"] },
    },
  }));

  if (!verified) {
    throw new Error(
      `Restore verification failed: source=${sourceCount} restored=${drillCount}`
    );
  }
  return report;
};
