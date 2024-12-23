const axios = require('axios');
const config = require('./config');

class PolygonRestClient {
  constructor(apiKey = config.polygon.apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.polygon.io';
  }

  async getIntradayHigh(symbol) {
    // Get today's UTC date
    const today = new Date();
    const yyyy = today.getUTCFullYear();
    const mm = String(today.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(today.getUTCDate()).padStart(2, '0');
    const dateStr = `${yyyy}-${mm}-${dd}`;

    // start at midnight UTC, end now
    const start = new Date(`${dateStr}T00:00:00Z`).getTime();
    const end = Date.now();

    // Polygon aggregates endpoint
    const url = `${this.baseUrl}/v2/aggs/ticker/${symbol}/range/1/minute/${start}/${end}?adjusted=true&sort=asc&limit=50000&apiKey=${this.apiKey}`;

    const response = await axios.get(url);
    const data = response.data;

    if (data.results && data.results.length > 0) {
      let maxHigh = Number.NEGATIVE_INFINITY;
      data.results.forEach((bar) => {
        if (bar.h > maxHigh) {
          maxHigh = bar.h;
        }
      });
      return maxHigh;
    } else {
      return 0;
    }
  }
}

module.exports = PolygonRestClient;
