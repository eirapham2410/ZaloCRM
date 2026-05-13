
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function run() {
  const msgs = await prisma.message.findMany({
    where: { quote: { not: null }, senderType: 'contact' },
    orderBy: { sentAt: 'desc' },
    take: 3
  });
  msgs.forEach(m => {
    console.log('\n--- Message ID:', m.id, 'Sender:', m.senderType, '---');
    console.log('zaloMsgId:', m.zaloMsgId);
    console.log('cliMsgId:', m.cliMsgId);
    console.log('Quote:', JSON.stringify(m.quote, null, 2));
  });
}
run().then(() => process.exit(0)).catch(console.error);

