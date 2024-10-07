# Trading Exit System

A Node.js application for managing trading positions with dynamic stop loss adjustments, profit target executions, and real-time monitoring via a terminal dashboard. This system integrates with Alpaca for trading operations and Polygon for real-time market data.

## Features

- **Dynamic Stop Losses**: Automatically adjust stop loss levels based on profit targets hit.
- **Profit Target Execution**: Close portions of positions when predefined profit targets are reached.
- **Pyramiding**: Optionally add to positions when certain profit levels are achieved.
- **Real-Time Dashboard**: Monitor positions, orders, profits, and system logs in real-time using a terminal-based dashboard.
- **Paper and Live Trading Modes**: Easily switch between paper trading and live trading environments.

## Prerequisites

- **Node.js** v12 or higher
- **npm** (Node Package Manager)
- An **Alpaca** account (for trading operations)
- A **Polygon.io** account (for real-time market data)
