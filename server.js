import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import yahooFinance from 'yahoo-finance2';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Claude API via direct HTTP (no SDK needed)
async function callClaude(apiKey, messages, maxTokens = 1024) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: maxTokens, messages }),
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error?.message || `API error ${res.status}`); }
  const data = await res.json();
  return data.content[0].text;
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Yahoo Finance suppression for common warnings ───

// ─── Cache layer (in-memory, 30s TTL for quotes, 5min for others) ───
const cache = new Map();
function cached(key, ttlMs, fetcher) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < ttlMs) return Promise.resolve(entry.data);
  return fetcher().then(data => {
    cache.set(key, { data, ts: Date.now() });
    return data;
  });
}

// ─── Helper: safe Yahoo call ───
async function safeQuote(symbol) {
  try {
    const q = await yahooFinance.quote(symbol);
    return q;
  } catch (e) {
    console.error(`Quote error for ${symbol}:`, e.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════

// ─── GET /api/quote/:symbol ─ Real-time quote ───
app.get('/api/quote/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const data = await cached(`quote_${symbol}`, 30000, () => safeQuote(symbol));
    if (!data) return res.status(404).json({ error: 'Symbol not found' });
    res.json({
      symbol: data.symbol,
      name: data.shortName || data.longName || symbol,
      price: data.regularMarketPrice,
      change: data.regularMarketChange,
      changePct: data.regularMarketChangePercent,
      open: data.regularMarketOpen,
      high: data.regularMarketDayHigh,
      low: data.regularMarketDayLow,
      prevClose: data.regularMarketPreviousClose,
      volume: data.regularMarketVolume,
      avgVolume: data.averageDailyVolume3Month,
      mktCap: data.marketCap,
      pe: data.trailingPE,
      fwdPe: data.forwardPE,
      eps: data.epsTrailingTwelveMonths,
      divYield: data.dividendYield ? data.dividendYield * 100 : 0,
      beta: data.beta,
      high52: data.fiftyTwoWeekHigh,
      low52: data.fiftyTwoWeekLow,
      avg50: data.fiftyDayAverage,
      avg200: data.twoHundredDayAverage,
      exchange: data.exchange,
      currency: data.currency,
      marketState: data.marketState, // PRE, REGULAR, POST, CLOSED
    });
  } catch (e) {
    console.error('Quote error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/quotes?symbols=AAPL,MSFT ─ Batch quotes ───
app.get('/api/quotes', async (req, res) => {
  try {
    const symbols = (req.query.symbols || '').split(',').filter(Boolean).map(s => s.trim().toUpperCase());
    if (!symbols.length) return res.json([]);
    const quotes = await Promise.all(symbols.map(s =>
      cached(`quote_${s}`, 30000, () => safeQuote(s)).catch(() => null)
    ));
    res.json(quotes.filter(Boolean).map(q => ({
      symbol: q.symbol,
      name: q.shortName || q.longName || q.symbol,
      price: q.regularMarketPrice,
      change: q.regularMarketChange,
      changePct: q.regularMarketChangePercent,
      volume: q.regularMarketVolume,
      mktCap: q.marketCap,
      pe: q.trailingPE,
      fwdPe: q.forwardPE,
      divYield: q.dividendYield ? q.dividendYield * 100 : 0,
      beta: q.beta,
      high52: q.fiftyTwoWeekHigh,
      low52: q.fiftyTwoWeekLow,
      marketState: q.marketState,
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/search?q=apple ─ Search tickers ───
app.get('/api/search', async (req, res) => {
  try {
    const query = req.query.q || '';
    if (query.length < 1) return res.json([]);
    const results = await cached(`search_${query}`, 300000, () =>
      yahooFinance.search(query, { quotesCount: 12, newsCount: 0 })
    );
    res.json((results.quotes || []).filter(q =>
      q.quoteType === 'EQUITY' || q.quoteType === 'ETF'
    ).map(q => ({
      symbol: q.symbol,
      name: q.shortname || q.longname || q.symbol,
      exchange: q.exchange,
      type: q.quoteType,
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/financials/:symbol ─ Detailed financials ───
app.get('/api/financials/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const data = await cached(`fin_${symbol}`, 300000, () =>
      yahooFinance.quoteSummary(symbol, {
        modules: ['summaryDetail', 'defaultKeyStatistics', 'financialData', 'earningsTrend', 'industryTrend']
      })
    );
    const sd = data.summaryDetail || {};
    const ks = data.defaultKeyStatistics || {};
    const fd = data.financialData || {};

    res.json({
      symbol,
      pe: sd.trailingPE,
      fwdPe: sd.forwardPE,
      peg: ks.pegRatio,
      priceToBook: sd.priceToBook,
      priceToSales: ks.priceToSalesTrailing12Months,
      divYield: sd.dividendYield ? sd.dividendYield * 100 : 0,
      payoutRatio: sd.payoutRatio,
      beta: sd.beta,
      profitMargin: fd.profitMargins,
      operatingMargin: fd.operatingMargins,
      returnOnEquity: fd.returnOnEquity,
      returnOnAssets: fd.returnOnAssets,
      revenueGrowth: fd.revenueGrowth ? fd.revenueGrowth * 100 : null,
      earningsGrowth: fd.earningsGrowth ? fd.earningsGrowth * 100 : null,
      debtToEquity: fd.debtToEquity,
      currentRatio: fd.currentRatio,
      totalRevenue: fd.totalRevenue,
      targetMeanPrice: fd.targetMeanPrice,
      recommendationKey: fd.recommendationKey,
      numberOfAnalysts: fd.numberOfAnalystOpinions,
      totalCash: fd.totalCash,
      totalDebt: fd.totalDebt,
      freeCashflow: fd.freeCashflow,
      earningsQuarterlyGrowth: ks.earningsQuarterlyGrowth ? ks.earningsQuarterlyGrowth * 100 : null,
      revenueQuarterlyGrowth: ks.revenueQuarterlyGrowth ? ks.revenueQuarterlyGrowth * 100 : null,
      shortPercentOfFloat: ks.shortPercentOfFloat ? ks.shortPercentOfFloat * 100 : null,
      enterpriseToRevenue: ks.enterpriseToRevenue,
      enterpriseToEbitda: ks.enterpriseToEbitda,
    });
  } catch (e) {
    console.error('Financials error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/history/:symbol?range=1mo ─ Price history ───
app.get('/api/history/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const range = req.query.range || '1mo';
    const intervalMap = { '1d': '5m', '5d': '15m', '1mo': '1d', '3mo': '1d', '6mo': '1d', '1y': '1wk', '5y': '1mo' };
    const interval = intervalMap[range] || '1d';
    const periodMap = { '1d': 1, '5d': 5, '1mo': 30, '3mo': 90, '6mo': 180, '1y': 365, '5y': 1825 };
    const days = periodMap[range] || 30;
    const period1 = new Date(Date.now() - days * 86400000);

    const data = await cached(`hist_${symbol}_${range}`, 60000, () =>
      yahooFinance.chart(symbol, { period1, interval })
    );

    const quotes = data.quotes || [];
    res.json(quotes.map(q => ({
      date: q.date,
      open: q.open,
      high: q.high,
      low: q.low,
      close: q.close,
      volume: q.volume,
    })).filter(q => q.close != null));
  } catch (e) {
    console.error('History error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/trending ─ Trending / top movers ───
app.get('/api/trending', async (req, res) => {
  try {
    const data = await cached('trending', 300000, () =>
      yahooFinance.trendingSymbols('US', { count: 20 })
    );
    const symbols = (data.quotes || []).map(q => q.symbol).slice(0, 15);
    const quotes = await Promise.all(symbols.map(s =>
      cached(`quote_${s}`, 30000, () => safeQuote(s)).catch(() => null)
    ));
    res.json(quotes.filter(Boolean).map(q => ({
      symbol: q.symbol,
      name: q.shortName || q.longName || q.symbol,
      price: q.regularMarketPrice,
      change: q.regularMarketChange,
      changePct: q.regularMarketChangePercent,
      volume: q.regularMarketVolume,
      mktCap: q.marketCap,
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/screener ─ Stock screener (gainers/losers/active) ───
app.get('/api/screener/:type', async (req, res) => {
  try {
    const type = req.params.type; // gainers, losers, active
    // Use predefined popular tickers and sort by criteria
    const tickers = [
      'AAPL','MSFT','GOOGL','AMZN','NVDA','TSLA','META','JPM','JNJ','V',
      'WMT','PG','UNH','MA','HD','DIS','NFLX','PYPL','AMD','INTC',
      'BA','CRM','COST','KO','PEP','ABBV','MRK','XOM','CVX','LLY',
      'AVGO','ADBE','ORCL','CSCO','ACN','TXN','QCOM','INTU','AMAT','MU',
      'SOFI','PLTR','RIVN','SNAP','COIN','SQ','SHOP','ROKU','DKNG','MARA'
    ];
    const quotes = await Promise.all(tickers.map(s =>
      cached(`quote_${s}`, 60000, () => safeQuote(s)).catch(() => null)
    ));
    let results = quotes.filter(Boolean).map(q => ({
      symbol: q.symbol,
      name: q.shortName || q.longName || q.symbol,
      price: q.regularMarketPrice,
      change: q.regularMarketChange,
      changePct: q.regularMarketChangePercent,
      volume: q.regularMarketVolume,
      mktCap: q.marketCap,
      pe: q.trailingPE,
    }));

    if (type === 'gainers') results.sort((a,b) => (b.changePct||0) - (a.changePct||0));
    else if (type === 'losers') results.sort((a,b) => (a.changePct||0) - (b.changePct||0));
    else results.sort((a,b) => (b.volume||0) - (a.volume||0));

    res.json(results.slice(0, 20));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/analyze ─ Claude AI stock analysis ───
app.post('/api/analyze', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'Claude API key not configured. Set ANTHROPIC_API_KEY in .env' });

  try {
    const { symbol, financials, context } = req.body;
    const prompt = `You are a senior financial analyst. Analyze ${symbol} stock with these real-time metrics:

${JSON.stringify(financials, null, 2)}

Additional context: ${context || 'None'}

Provide a structured analysis in this EXACT JSON format (no markdown, just JSON):
{
  "view": "Bullish" or "Neutral" or "Bearish",
  "confidence": 1-10,
  "valuation": "Undervalued" or "Fairly Valued" or "Overvalued",
  "risk": "Low" or "Medium" or "High",
  "horizon": "Short Term" or "Medium Term" or "Long Term",
  "targetPrice": number or null,
  "summary": "2-3 sentence overall assessment",
  "catalysts": ["list of positive catalysts"],
  "risks": ["list of key risks"],
  "keyMetrics": "1-2 sentence on most important metrics",
  "sectorView": "1 sentence on sector outlook",
  "actionable": "1 sentence recommendation"
}

Be specific, data-driven, and direct. This is not investment advice - it is analytical commentary.`;

    const text = await callClaude(apiKey, [{ role: 'user', content: prompt }]);
    try {
      const parsed = JSON.parse(text);
      res.json(parsed);
    } catch {
      // Try to extract JSON from the response
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        res.json(JSON.parse(match[0]));
      } else {
        res.json({ summary: text, view: 'Neutral', risk: 'Medium', valuation: 'Fairly Valued' });
      }
    }
  } catch (e) {
    console.error('Claude API error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/scan ─ AI Market Scanner ───
app.post('/api/scan', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'Claude API key not configured' });

  try {
    const { portfolio, criteria } = req.body;

    // Get a broad set of stock data
    const scanList = [
      'AAPL','MSFT','GOOGL','AMZN','NVDA','META','TSLA','JPM','V','JNJ',
      'WMT','PG','UNH','MA','HD','NFLX','AMD','CRM','COST','KO',
      'PEP','ABBV','MRK','XOM','CVX','LLY','AVGO','ADBE','ORCL','CSCO',
      'ACN','TXN','QCOM','INTU','AMAT','MU','SOFI','PLTR','SQ','SHOP'
    ];

    const quotes = await Promise.all(scanList.map(s =>
      cached(`quote_${s}`, 60000, () => safeQuote(s)).catch(() => null)
    ));

    const stockData = quotes.filter(Boolean).map(q => ({
      symbol: q.symbol,
      name: q.shortName,
      price: q.regularMarketPrice,
      changePct: q.regularMarketChangePercent?.toFixed(2),
      pe: q.trailingPE?.toFixed(1),
      fwdPe: q.forwardPE?.toFixed(1),
      mktCap: q.marketCap,
      divYield: q.dividendYield ? (q.dividendYield * 100).toFixed(2) : '0',
      beta: q.beta?.toFixed(2),
    }));

    const prompt = `You are an AI market scanner for a portfolio manager. Analyze these stocks and provide investment recommendations.

CURRENT PORTFOLIO: ${JSON.stringify(portfolio || [])}
USER CRITERIA: ${criteria || 'Find best opportunities across all criteria - value, growth, and income'}

MARKET DATA:
${JSON.stringify(stockData, null, 2)}

Provide recommendations in this EXACT JSON format:
{
  "marketSentiment": "Bullish" or "Neutral" or "Bearish",
  "marketSummary": "2-3 sentence market overview",
  "recommendations": [
    {
      "symbol": "TICKER",
      "name": "Company Name",
      "action": "Strong Buy" or "Buy" or "Watch" or "Avoid",
      "reason": "1-2 sentence explanation",
      "category": "Value" or "Growth" or "Income" or "Momentum"
    }
  ],
  "diversificationTip": "1 sentence about portfolio diversification",
  "sectorOpportunity": "1 sentence about which sectors look attractive"
}

Provide 8-12 recommendations sorted by conviction. Be data-driven and specific. This is analytical commentary, not investment advice.`;

    const text = await callClaude(apiKey, [{ role: 'user', content: prompt }], 2048);
    try {
      const parsed = JSON.parse(text);
      res.json(parsed);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) res.json(JSON.parse(match[0]));
      else res.json({ marketSummary: text, recommendations: [] });
    }
  } catch (e) {
    console.error('Scan error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Fallback to index.html ───
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start server ───
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════╗
  ║   AI Portfolio Manager v2.0              ║
  ║   Running on http://localhost:${PORT}       ║
  ║                                          ║
  ║   Claude API: ${process.env.ANTHROPIC_API_KEY ? '✓ Configured' : '✗ Not set'}            ║
  ╚══════════════════════════════════════════╝
  `);
});
