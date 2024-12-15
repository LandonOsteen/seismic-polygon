// polygonRestClient.js
const axios = require('axios');
const config = require('./config');
const moment = require('moment-timezone');

class PolygonRestClient {
  constructor(apiKey = config.polygon.apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.polygon.io';
  }

  /**
   * Fetches the intraday high for a given symbol using specified aggregation.
   * @param {string} symbol - The stock symbol.
   * @param {string} unit - The aggregation unit (e.g., 'second').
   * @param {number} amount - The number of units per aggregation bar.
   * @returns {number|null} - The highest price of the day or null if unavailable.
   */
  async getIntradayHighFromAgg(symbol, unit, amount) {
    const { start, end } = this._getIntradayTimeRange();
    const url = `${this.baseUrl}/v2/aggs/ticker/${symbol}/range/${amount}/${unit}/${start}/${end}?adjusted=true&sort=asc&limit=50000&apiKey=${this.apiKey}`;
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
        return null;
      }
    } catch (err) {
      console.error(
        `Error fetching intraday high for ${symbol}: ${err.message}`
      );
      return null;
    }
  }

  /**
   * Fetches the intraday low for a given symbol using specified aggregation.
   * @param {string} symbol - The stock symbol.
   * @param {string} unit - The aggregation unit (e.g., 'second').
   * @param {number} amount - The number of units per aggregation bar.
   * @returns {number|null} - The lowest price of the day or null if unavailable.
   */
  async getIntradayLowFromAgg(symbol, unit, amount) {
    const { start, end } = this._getIntradayTimeRange();
    const url = `${this.baseUrl}/v2/aggs/ticker/${symbol}/range/${amount}/${unit}/${start}/${end}?adjusted=true&sort=asc&limit=50000&apiKey=${this.apiKey}`;
    try {
      const response = await axios.get(url);
      const data = response.data;

      if (data.results && data.results.length > 0) {
        let minLow = Infinity;
        for (const bar of data.results) {
          if (bar.l < minLow) {
            minLow = bar.l;
          }
        }
        return minLow === Infinity ? null : minLow;
      } else {
        return null;
      }
    } catch (err) {
      console.error(
        `Error fetching intraday low for ${symbol}: ${err.message}`
      );
      return null;
    }
  }

  /**
   * Helper method to determine the intraday time range based on configured timezone.
   * @returns {Object} - Contains start and end timestamps in milliseconds.
   */
  _getIntradayTimeRange() {
    const now = moment().tz(config.timeZone);
    const yyyy = now.format('YYYY');
    const mm = now.format('MM');
    const dd = now.format('DD');

    // Start from midnight in the configured timezone
    const startOfDay = moment.tz(
      `${yyyy}-${mm}-${dd}T00:00:00`,
      config.timeZone
    );
    const start = startOfDay.valueOf();
    const end = now.valueOf();
    return { start, end };
  }

  /**
   * Fetches gainers or losers from Polygon API.
   * Note: Since automated watchlist creation is removed, this method may not be used.
   * Included here for completeness.
   * @param {string} direction - 'gainers' or 'losers'.
   * @param {boolean} includeOtc - Whether to include OTC stocks.
   * @returns {Array} - Array of ticker objects.
   */
  async getGainersOrLosers(direction = 'gainers', includeOtc = false) {
    const validDirections = ['gainers', 'losers'];
    if (!validDirections.includes(direction)) {
      throw new Error(
        `Invalid direction "${direction}". Must be 'gainers' or 'losers'.`
      );
    }

    const url = `${this.baseUrl}/v2/snapshot/locale/us/markets/stocks/${direction}?apiKey=${this.apiKey}&include_otc=${includeOtc}`;
    try {
      const response = await axios.get(url);
      return response.data.tickers || [];
    } catch (err) {
      console.error(`Error fetching ${direction}: ${err.message}`);
      return [];
    }
  }

  /**
   * Fetches ticker details from Polygon API.
   * Note: This method may be used for additional symbol validations or data.
   * @param {string} symbol - The stock symbol.
   * @returns {Object|null} - Ticker details or null if not found.
   */
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
