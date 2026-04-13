const NodeCache = require('node-cache');

const cache = new NodeCache({
  stdTTL: parseInt(process.env.CACHE_TTL_SECONDS || '3600'),
  checkperiod: 600,
  maxKeys: 500,
});

module.exports = cache;
