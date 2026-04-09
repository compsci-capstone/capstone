import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "~/env";

const credentials =
  env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
    ? {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      }
    : undefined;

const endpointConfig = env.AWS_ENDPOINT_URL
  ? { endpoint: env.AWS_ENDPOINT_URL, forcePathStyle: true }
  : {};

// Internal client — used for S3 operations (upload, get, etc.)
const s3Client = new S3Client({
  region: env.AWS_REGION,
  credentials,
  ...endpointConfig,
});

// Presigned URL client — uses the public/browser-accessible endpoint.
// When AWS_ENDPOINT_URL_PUBLIC is set (e.g., http://localhost:9000 for MinIO),
// presigned URLs use that so browsers can resolve them.
// Falls back to the internal endpoint, then to default AWS behavior.
const publicEndpoint = env.AWS_ENDPOINT_URL_PUBLIC ?? env.AWS_ENDPOINT_URL;
const publicEndpointConfig = publicEndpoint
  ? { endpoint: publicEndpoint, forcePathStyle: true }
  : {};

const presignClient = new S3Client({
  region: env.AWS_REGION,
  credentials,
  ...publicEndpointConfig,
});

export const generateSignedUrl = async (key: string, expiresIn = 3600) => {
  const command = new GetObjectCommand({
    Bucket: env.AWS_BUCKET_NAME,
    Key: key,
  });

  return await getSignedUrl(presignClient, command, { expiresIn });
};
