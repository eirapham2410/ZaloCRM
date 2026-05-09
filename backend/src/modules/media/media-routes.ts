import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authMiddleware } from '../auth/auth-middleware.js';
import { uploadStreamToMinio } from '../../shared/minio-client.js';
import { logger } from '../../shared/utils/logger.js';

export async function mediaRoutes(app: FastifyInstance): Promise<void> {
  // Protect media upload route
  app.addHook('preHandler', authMiddleware);

  /**
   * POST /api/v1/media/upload
   * Receives a multipart/form-data upload and streams it directly to MinIO.
   */
  app.post('/api/v1/media/upload', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const data = await request.file();
      
      if (!data) {
        return reply.code(400).send({ success: false, message: 'No file uploaded' });
      }

      // data.file is a Readable stream provided by @fastify/multipart
      const publicUrl = await uploadStreamToMinio(data.file, data.filename, data.mimetype);

      return reply.send({
        success: true,
        url: publicUrl,
        fileName: data.filename,
      });
    } catch (err: any) {
      logger.error('Media upload failed:', err.message);
      return reply.code(500).send({
        success: false,
        message: 'Failed to upload media',
        error: err.message,
      });
    }
  });
}
