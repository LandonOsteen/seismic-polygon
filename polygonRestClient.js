const axios = require('axios');
const config = require('./config');
const moment = require('moment-timezone');

class PolygonRestClient {
  constructor(apiKey = config.polygon.apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.polygon.io';
  }

  async getIntradayHighFromAgg(symbol) {
    // Get current Eastern time
    const now = moment().tz(config.timeZone);

    // Set start to midnight Eastern of the same day
    const startOfDayET = moment.tz(
      `${now.format('YYYY-MM-DD')}T00:00:00`,
      config.timeZone
    );

    const start = startOfDayET.valueOf();
    const end = now.valueOf();

    // Use 1-minute bars from midnight ET to now
    const url = `${this.baseUrl}/v2/aggs/ticker/${symbol}/range/1/minute/${start}/${end}?adjusted=true&sort=asc&limit=50000&apiKey=${this.apiKey}`;

    try {
      const response = await axios.get(url);
      const data = response.data;

      if (data.results && data.results.length > 0) {
        let maxHigh = Number.NEGATIVE_INFINITY;
        for (const bar of data.results) {
          if (bar.h > maxHigh) {
            maxHigh = bar.h;
          }
        }
        return maxHigh === Number.NEGATIVE_INFINITY ? null : maxHigh;
      } else {
        return null; // No data available
      }
    } catch (err) {
      console.error(
        `Error fetching intraday high for ${symbol}: ${err.message}`
      );
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

  _getIntradayTimeRange() {
    const now = moment().tz(config.timeZone);
    const yyyy = now.format('YYYY');
    const mm = now.format('MM');
    const dd = now.format('DD');

    const startOfDayET = moment.tz(
      `${yyyy}-${mm}-${dd}T00:00:00`,
      config.timeZone
    );
    const start = startOfDayET.valueOf();
    const end = now.valueOf();
    return { start, end };
  }
}

module.exports = PolygonRestClient;
