import * as Minio from 'minio';
import { randomUUID } from 'node:crypto';
import { config } from '../config/index.js';
import { logger } from './utils/logger.js';
import type { Readable } from 'node:stream';

const TAG = '[minio-client]';

export const minioClient = new Minio.Client({
  endPoint: config.minioEndpoint,
  port: config.minioPort,
  useSSL: config.minioUseSsl,
  accessKey: config.minioAccessKey,
  secretKey: config.minioSecretKey,
});

/**
 * Ensure the bucket exists and has a public read policy.
 * Called once during application startup.
 */
export async function ensureMinioBucket(): Promise<void> {
  try {
    const bucketName = config.minioBucket;
    const exists = await minioClient.bucketExists(bucketName);

    if (!exists) {
      await minioClient.makeBucket(bucketName, 'us-east-1');
      logger.info(`${TAG} Created bucket: ${bucketName}`);

      // Set public read policy so Zalo servers and users can download the files
      const policy = {
        Version: '2012-10-17',
        Statement: [
          {
            Action: ['s3:GetObject'],
            Effect: 'Allow',
            Principal: '*',
            Resource: [`arn:aws:s3:::${bucketName}/*`],
          },
        ],
      };
      await minioClient.setBucketPolicy(bucketName, JSON.stringify(policy));
      logger.info(`${TAG} Set public read policy for bucket: ${bucketName}`);
    } else {
      logger.info(`${TAG} Bucket ${bucketName} already exists`);
    }
  } catch (err: any) {
    logger.error(`${TAG} Failed to initialize bucket: ${err.message}`);
    // Non-fatal, might just be network delay. But logs will show it.
  }
}

/**
 * Upload a stream to MinIO.
 * 
 * @param stream The readable stream (e.g. from fastify multipart)
 * @param filename Original filename to preserve extension
 * @param mimetype Content-Type
 * @returns The public URL of the uploaded file
 */
export async function uploadStreamToMinio(
  stream: Readable,
  filename: string,
  mimetype: string,
): Promise<string> {
  const bucketName = config.minioBucket;
  const uniqueName = `${randomUUID()}-${filename.replace(/[^a-zA-Z0-9.-]/g, '_')}`;

  const metaData = {
    'Content-Type': mimetype,
  };

  try {
    // We pass the stream directly. MinIO handles the chunks.
    await minioClient.putObject(bucketName, uniqueName, stream, undefined, metaData);

    // Construct the public URL using the public endpoint from config
    // We trim trailing slashes just in case
    const baseUrl = config.minioPublicUrl.replace(/\/$/, '');
    
    // e.g. http://192.168.1.100:9000/zalocrm-media/uuid-file.pdf
    const publicUrl = `${baseUrl}/${bucketName}/${uniqueName}`;
    
    logger.debug(`${TAG} Uploaded ${uniqueName} to MinIO`);
    return publicUrl;
  } catch (err: any) {
    logger.error(`${TAG} Upload failed: ${err.message}`);
    throw new Error(`Failed to upload to object storage: ${err.message}`);
  }
}
