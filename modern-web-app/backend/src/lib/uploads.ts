import { S3Client, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// Attachment uploads: browser → S3 via presigned POST (the policy enforces
// key, content-type, and the 4 MB ceiling server-side); downloads are
// short-lived presigned GETs. File bytes never pass through Lambda.

export const s3 = new S3Client({});
export const UPLOADS_BUCKET = process.env.UPLOADS_BUCKET ?? '';

export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_APP = 3;
export const GLOBAL_ATTACHMENTS_PER_DAY = 200;

export const ALLOWED_CONTENT_TYPES: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
};

export function attachmentKey(appId: string, attId: string): string {
  return `uploads/${appId}/${attId}`;
}

export async function presignUpload(key: string, contentType: string) {
  return createPresignedPost(s3, {
    Bucket: UPLOADS_BUCKET,
    Key: key,
    Conditions: [
      ['content-length-range', 1, MAX_ATTACHMENT_BYTES],
      ['eq', '$Content-Type', contentType],
    ],
    Fields: { 'Content-Type': contentType },
    Expires: 300,
  });
}

/** Returns the object's size, or null if it was never uploaded. */
export async function uploadedSize(key: string): Promise<number | null> {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: UPLOADS_BUCKET, Key: key }));
    return head.ContentLength ?? 0;
  } catch {
    return null;
  }
}

export async function presignDownload(key: string, filename: string): Promise<string> {
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: UPLOADS_BUCKET,
      Key: key,
      ResponseContentDisposition: `inline; filename="${filename.replace(/[^\w. -]/g, '_')}"`,
    }),
    { expiresIn: 300 }
  );
}
