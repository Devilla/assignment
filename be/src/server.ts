import { createServer, createShop } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const server = createServer(createShop({ config }));
server.listen(config.port, () => {
  console.log(`Checkout service on :${config.port} (every ${config.milestoneN} orders -> ${config.couponPercent}% coupon)`);
});
