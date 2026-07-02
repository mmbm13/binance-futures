import { WebsocketClient, WS_KEY_MAP } from 'binance';

const USE_TESTNET = false;

const wsClient = new WebsocketClient({ beautify: false, demoTrading: USE_TESTNET});
// receive raw events
wsClient.on('message', (data) => {
  console.log('raw message received ', JSON.stringify(data, null, 2));
});

// notification when a connection is opened
wsClient.on('open', (data) => {
  console.log('connection opened open:', data.wsKey, data.wsUrl);
});

// receive formatted events with beautified keys. Any "known" floats stored in strings as parsed as floats.
wsClient.on('formattedMessage', (data) => {
  console.log('formattedMessage: ', data);
});

// read response to command sent via WS stream (e.g LIST_SUBSCRIPTIONS)
wsClient.on('response', (data) => {
  console.log('log response: ', JSON.stringify(data, null, 2));
});

// receive notification when a ws connection is reconnecting automatically
wsClient.on('reconnecting', (data) => {
  console.log('ws automatically reconnecting.... ', data?.wsKey);
});

// receive notification that a reconnection completed successfully (e.g use REST to check for missing data)
wsClient.on('reconnected', (data) => {
  console.log('ws has reconnected ', data?.wsKey);
});

// Recommended: receive error events (e.g. first reconnection failed)
wsClient.on('exception', (data) => {
  console.log('ws saw error ', data?.wsKey);
});

gracefulShutdown(wsClient);

function gracefulShutdown(ws: WebsocketClient) {
  process.on('SIGINT', () => {
    ws.closeAll();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    ws.closeAll();
    process.exit(0);
  });
}

const test = async () => {
  const wsKeyUsdmPublic = WS_KEY_MAP.usdm;
  // await wsClient.subscribe('btcusdt@markPrice@1s', wsKeyUsdmPublic);
  await wsClient.subscribeMarkPrice('BTCUSDT', 'usdm', 1000);
}

test();