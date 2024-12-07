const axios = require('axios');
const config = require('./config');

class PolygonRestClient {
  constructor(apiKey = config.polygon.apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.polygon.io';
  }

  async getIntradayHigh(symbol) {
    // Include pre-market by starting at midnight UTC
    const today = new Date();
    const yyyy = today.getUTCFullYear();
    const mm = String(today.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(today.getUTCDate()).padStart(2, '0');
    const dateStr = `${yyyy}-${mm}-${dd}`;
    const start = new Date(`${dateStr}T00:00:00Z`).getTime();
    const end = Date.now();

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
      return null;
    }
  }

  async getGainersOrLosers(direction = 'gainers', includeOtc = false) {
    const validDirections = ['gainers', 'losers'];
    if (!validDirections.includes(direction)) {
      throw new Error(
        `Invalid direction "${direction}". Must be 'gainers' or 'losers'.`
      );
    }

    const url = `${this.baseUrl}/v2/snapshot/locale/us/markets/stocks/${direction}?apiKey=${this.apiKey}&include_otc=${includeOtc}`;
    const response = await axios.get(url);
    return response.data.tickers || [];
  }

  async getTickerDetails(symbol) {
    const url = `${this.baseUrl}/v3/reference/tickers/${symbol}?apiKey=${this.apiKey}`;
    try {
      const response = await axios.get(url);
      return response.data.results || null;
    } catch (err) {
      console.error(
        `Error fetching ticker details for ${symbol}: ${err.message}`
      );
      return null;
    }
  }
}

module.exports = PolygonRestClient;
