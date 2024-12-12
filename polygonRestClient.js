const axios = require('axios');
const config = require('./config');
const moment = require('moment-timezone');

class PolygonRestClient {
  constructor(apiKey = config.polygon.apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.polygon.io';
  }

  async getIntradayHigh(symbol) {
    const { start, end } = this._getIntradayTimeRange();
    const url = `${this.baseUrl}/v2/aggs/ticker/${symbol}/range/10/second/${start}/${end}?adjusted=true&sort=asc&limit=50000&apiKey=${this.apiKey}`;

    try {
      const response = await axios.get(url);
      const data = response.data;

      if (!data.results || data.results.length === 0) {
        return null;
      }

      let maxHigh = Number.NEGATIVE_INFINITY;
      for (const bar of data.results) {
        if (bar.h > maxHigh) {
          maxHigh = bar.h;
        }
      }
      return maxHigh === Number.NEGATIVE_INFINITY ? null : maxHigh;
    } catch (err) {
      // If we get a 400 error, log and return null gracefully
      console.error(
        `Error fetching intraday high for ${symbol}: ${err.message}`
      );
      return null;
    }
  }

  async getGainersOrLosers(direction = 'gainers', includeOtc = false) {
    const url = `${this.baseUrl}/v2/snapshot/locale/us/markets/stocks/${direction}?apiKey=${this.apiKey}&include_otc=${includeOtc}`;
    try {
      const response = await axios.get(url);
      return response.data.tickers || [];
    } catch (err) {
      console.error(`Error fetching ${direction}: ${err.message}`);
      return [];
    }
  }

  _getIntradayTimeRange() {
    const now = moment().tz(config.timeZone);
    const startOfDayET = now.clone().startOf('day');
    // Convert to UTC with 'Z' to ensure proper ISO8601 format
    const start = startOfDayET.utc().format('YYYY-MM-DDTHH:mm:ss[Z]');
    const end = now.utc().format('YYYY-MM-DDTHH:mm:ss[Z]');
    return { start, end };
  }
}

module.exports = PolygonRestClient;
