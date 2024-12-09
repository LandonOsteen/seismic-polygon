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
    // Using 5-second bars instead of 10-second bars
    const url = `${this.baseUrl}/v2/aggs/ticker/${symbol}/range/5/second/${start}/${end}?adjusted=true&sort=asc&limit=50000&apiKey=${this.apiKey}`;
    const response = await axios.get(url);
    const data = response.data;

    if (data.results && data.results.length > 0) {
      let maxHigh = Number.NEGATIVE_INFINITY;
      for (const bar of data.results) {
        if (bar.h > maxHigh) {
          maxHigh = bar.h;
        }
      }
      return maxHigh;
    } else {
      return null;
    }
  }

  async getIntradayVolume(symbol) {
    const { start, end } = this._getIntradayTimeRange();
    // 1-minute bars remain for volume aggregation
    const url = `${this.baseUrl}/v2/aggs/ticker/${symbol}/range/1/minute/${start}/${end}?adjusted=true&sort=asc&limit=50000&apiKey=${this.apiKey}`;
    const response = await axios.get(url);
    const data = response.data;

    let totalVolume = 0;
    if (data.results && data.results.length > 0) {
      for (const bar of data.results) {
        totalVolume += bar.v;
      }
    }
    return totalVolume;
  }

  _getIntradayTimeRange() {
    // Ensure times are in Eastern Time
    const now = moment().tz(config.timeZone);
    const yyyy = now.format('YYYY');
    const mm = now.format('MM');
    const dd = now.format('DD');

    // Start from midnight Eastern
    const startOfDayET = moment.tz(
      `${yyyy}-${mm}-${dd}T00:00:00`,
      config.timeZone
    );
    const start = startOfDayET.valueOf();
    const end = now.valueOf();
    return { start, end };
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
