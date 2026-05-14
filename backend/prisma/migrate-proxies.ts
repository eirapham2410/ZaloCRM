import 'dotenv/config';
import { prisma } from '../src/shared/database/prisma-client.js';

async function main() {
  console.log('Bắt đầu quá trình migrate dữ liệu Proxy Pool...');

  // 1. Tìm tất cả ZaloAccount có proxy cũ (string) không rỗng
  const accountsWithProxy = await prisma.zaloAccount.findMany({
    where: {
      proxy: { not: null, notIn: [''] },
    },
  });

  if (accountsWithProxy.length === 0) {
    console.log('Không có tài khoản nào cần migrate proxy.');
    return;
  }

  console.log(`Tìm thấy ${accountsWithProxy.length} tài khoản có proxy cũ.`);

  // 2. Gom nhóm proxy theo URL và OrgId
  const proxyMap = new Map<string, { orgId: string; accountIds: string[] }>();

  for (const acc of accountsWithProxy) {
    const key = `${acc.orgId}::${acc.proxy}`;
    if (!proxyMap.has(key)) {
      proxyMap.set(key, { orgId: acc.orgId, accountIds: [] });
    }
    proxyMap.get(key)!.accountIds.push(acc.id);
  }

  console.log(`Cần tạo ${proxyMap.size} bản ghi Proxy mới trong Pool.`);

  // 3. Tạo Proxy và cập nhật ZaloAccount (trong transaction nếu có thể)
  let successCount = 0;
  for (const [key, data] of proxyMap.entries()) {
    const proxyUrl = key.split('::')[1];

    try {
      await prisma.$transaction(async (tx) => {
        // Kiểm tra xem proxy này đã tồn tại trong Pool chưa
        let proxyRecord = await tx.proxy.findUnique({
          where: {
            orgId_url: { orgId: data.orgId, url: proxyUrl },
          },
        });

        // Nếu chưa có, tạo mới
        if (!proxyRecord) {
          proxyRecord = await tx.proxy.create({
            data: {
              orgId: data.orgId,
              url: proxyUrl,
              status: 'active',
              maxAccounts: 5,
            },
          });
        }

        // Cập nhật proxyId cho các ZaloAccount
        await tx.zaloAccount.updateMany({
          where: { id: { in: data.accountIds } },
          data: { proxyId: proxyRecord.id },
        });
      });

      successCount += data.accountIds.length;
      console.log(`✓ Đã migrate proxy [${proxyUrl}] cho ${data.accountIds.length} tài khoản.`);
    } catch (err) {
      console.error(`✗ Lỗi khi migrate proxy [${proxyUrl}]:`, err);
    }
  }

  console.log(`Hoàn tất! Đã migrate thành công ${successCount} / ${accountsWithProxy.length} tài khoản.`);
}

main()
  .catch((e) => {
    console.error('Migration thất bại:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
