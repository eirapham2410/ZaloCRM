import { PrismaClient } from '@prisma/client';
import { ZaloPool } from './dist/modules/zalo/zalo-pool.js';
import { zaloOps } from './dist/shared/zalo-operations.js';

const prisma = new PrismaClient();

async function run() {
  const accountId = '4cfcaf16-3c7f-430d-af1e-5d38150c4bdb';
  const groupId = '1033998813844181793'; // One of the groups that returned 0 members
  
  console.log(`Starting test for account ${accountId}, group ${groupId}`);
  
  // 1. Initialize DB and Zalo Pool
  console.log('Initializing Zalo Pool...');
  await ZaloPool.init();
  
  // Wait a moment for connection to establish
  await new Promise(r => setTimeout(r, 5000));
  
  console.log('Connected! Fetching group info...');
  
  try {
    const rawRes = await zaloOps.exec({ accountId, category: 'group_read', operation: 'getGroupInfo' }, async (api) => {
       return await api.getGroupInfo(groupId);
    });
    
    const groupInfo = rawRes?.gridInfoMap?.[groupId] || rawRes?.data?.gridInfoMap?.[groupId] || rawRes?.[groupId];
    if (!groupInfo) {
      console.log('Group info not found in standard paths. Raw response:');
      console.log(JSON.stringify(rawRes, null, 2));
      process.exit(1);
    }
    
    console.log('--- GROUP INFO KEYS ---');
    console.log(Object.keys(groupInfo));
    
    console.log('--- POTENTIAL MEMBER ARRAYS ---');
    const memberIdsKeys = Object.keys(groupInfo).filter(k => k.toLowerCase().includes('member') || k.toLowerCase().includes('uid'));
    for (const k of memberIdsKeys) {
       console.log(`${k}:`, typeof groupInfo[k], Array.isArray(groupInfo[k]) ? `Array(${groupInfo[k].length})` : groupInfo[k]);
    }

    console.log('--- TOTAL MEMBER ---');
    console.log(groupInfo.totalMember || 'N/A');

  } catch (err) {
    console.error('Error fetching group info:', err);
  }
  
  process.exit(0);
}

run().catch(console.error);
