const axios = require('axios');
const config = require('./config');
const moment = require('moment-timezone');

class PolygonRestClient {
  constructor(apiKey = config.polygon.apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.polygon.io';
  }

  async getIntradayHighFromAgg(symbol) {
    const now = moment().tz(config.timeZone);
    const startOfDayET = moment.tz(
      `${now.format('YYYY-MM-DD')}T00:00:00`,
      config.timeZone
    );
    const start = startOfDayET.valueOf();
    const end = now.valueOf();

    const url = `${this.baseUrl}/v2/aggs/ticker/${symbol}/range/2/second/${start}/${end}?adjusted=true&sort=asc&limit=50000&apiKey=${this.apiKey}`;

    const response = await axios.get(url);
    const data = response.data;

    if (data.results && data.results.length > 0) {
      let maxHigh = Number.NEGATIVE_INFINITY;
      for (const bar of data.results) {
        if (bar.h > maxHigh) maxHigh = bar.h;
      }
      return maxHigh === Number.NEGATIVE_INFINITY ? null : maxHigh;
    } else {
      return null; // No data available
    }
  }

  /**
   * Fetch top gainers or losers from Polygon snapshot endpoint.
   * direction: 'gainers' or 'losers'
   * includeOtc: boolean to include OTC securities or not
   */
  async getGainersOrLosers(direction = 'gainers', includeOtc = false) {
    const validDirections = ['gainers', 'losers'];
    if (!validDirections.includes(direction)) {
      throw new Error(
        `Invalid direction "${direction}". Must be 'gainers' or 'losers'.`
      );
    }

    const url = `${this.baseUrl}/v2/snapshot/locale/us/markets/stocks/${direction}?apiKey=${this.apiKey}&include_otc=${includeOtc}`;
    const response = await axios.get(url);
    // response.data.tickers is the array of tickers
    return response.data.tickers || [];
  }
}

module.exports = PolygonRestClient;
