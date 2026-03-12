
import { client, checkConnection } from './bot/client';
import { db } from './db';

const test = async () => {
  console.log('Testing Connections...');

  // 1. Database
  console.log('--- Database ---');
  try {
    const res = await db.query('SELECT NOW()');
    console.log('DB Connected:', res.rows[0]);
  } catch (err) {
    console.error('DB Connection Failed:', err);
  }

  // 2. Binance Futures
  console.log('--- Binance Futures ---');
  const isConnected = await checkConnection();
  if (isConnected) {
    try {
      const account = await client.getAccountInformationV3();
      console.log('Account Info fetched. Can trade:', account.canTrade);
      const usdt = account.assets.find((a: any) => a.asset === 'USDT');
      console.log('USDT Balance:', usdt);
    } catch (e) {
      console.error('Failed to fetch account info:', e);
    }
  }

  // cleanup
  await db.end();
};

test();
