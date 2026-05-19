import { prisma } from '../shared/database/prisma-client.js';
import { logger } from '../shared/utils/logger.js';

export async function migrateZaloAccess() {
  logger.info('Starting ZaloAccountAccess migration...');
  try {
    const accounts = await prisma.zaloAccount.findMany({
      include: {
        access: true
      }
    });

    let migratedCount = 0;

    for (const account of accounts) {
      const hasOwnerAccess = account.access.some(a => a.userId === account.ownerUserId);
      if (!hasOwnerAccess) {
        await prisma.$transaction(async (tx) => {
          await tx.zaloAccountAccess.create({
            data: {
              zaloAccountId: account.id,
              userId: account.ownerUserId,
              permission: 'admin'
            }
          });
        });
        migratedCount++;
      }
    }

    logger.info(`Migration completed. Added admin access for ${migratedCount} accounts.`);
  } catch (error) {
    logger.error('Error during ZaloAccountAccess migration:', error);
  } finally {
    await prisma.$disconnect();
  }
}

// Allow running directly if executed via tsx
if (import.meta.url === `file://${process.argv[1]}`) {
  migrateZaloAccess().then(() => process.exit(0)).catch(() => process.exit(1));
}
