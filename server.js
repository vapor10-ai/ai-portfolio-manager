import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// yahoo-finance2 exports a class constructor
const yfModule = await import('yahoo-finance2');
const YahooFinance = yfModule.default || yfModule;
const yahooFinance = new YahooFinance();

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

// ─── Cache layer ───
const cache = new Map();
function cached(key, ttlMs, fetcher) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < ttlMs) return Promise.resolve(entry.data);
  return fetcher().then(data => {
    cache.set(key, { data, ts: Date.now() });
    return data;
  });
}

// ─── Helper: safe Yahoo quote ───
async function safeQuote(symbol) {
  try {
    const q = await yahooFinance.quote(symbol);
    return q;
  } catch (e) {
    console.error(`Quote error for ${symbol}:`, e.message);
    return null;
  }
}

// ─── Helper: direct Yahoo Finance API call (for methods not in this version) ───
async function yahooFetch(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  if (!res.ok) throw new Error(`Yahoo API error ${res.status}`);
  return res.json();
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
      marketState: data.marketState,
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

// ─── GET /api/search?q=apple ─ Search tickers using autoc ───
app.get('/api/search', async (req, res) => {
  try {
    const query = req.query.q || '';
    if (query.length < 1) return res.json([]);

    // Try autoc method (available in this version)
    if (typeof yahooFinance.autoc === 'function') {
      const results = await cached(`search_${query}`, 300000, () =>
        yahooFinance.autoc(query)
      );
      const items = results?.Result || results?.quotes || results || [];
      return res.json(items.filter(q =>
        !q.typeDisp || q.typeDisp === 'Equity' || q.typeDisp === 'ETF'
      ).slice(0, 12).map(q => ({
        symbol: q.symbol,
        name: q.name || q.shortname || q.longname || q.symbol,
        exchange: q.exchDisp || q.exchange || '',
        type: q.typeDisp || q.quoteType || 'Equity',
      })));
    }

    // Fallback: direct Yahoo search API
    const data = await cached(`search_${query}`, 300000, async () => {
      const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=12&newsCount=0`;
      return yahooFetch(url);
    });
    res.json((data.quotes || []).filter(q =>
      q.quoteType === 'EQUITY' || q.quoteType === 'ETF'
    ).map(q => ({
      symbol: q.symbol,
      name: q.shortname || q.longname || q.symbol,
      exchange: q.exchDisp || q.exchange || '',
      type: q.quoteType || 'Equity',
    })));
  } catch (e) {
    console.error('Search error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/financials/:symbol ─ Detailed financials via direct API ───
app.get('/api/financials/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const data = await cached(`fin_${symbol}`, 300000, async () => {
      const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=summaryDetail,defaultKeyStatistics,financialData`;
      return yahooFetch(url);
    });

    const result = data?.quoteSummary?.result?.[0] || {};
    const sd = result.summaryDetail || {};
    const ks = result.defaultKeyStatistics || {};
    const fd = result.financialData || {};

    // Helper to extract raw value from Yahoo's nested format
    const raw = (obj) => obj?.raw ?? obj?.fmt ?? obj ?? null;

    res.json({
      symbol,
      pe: raw(sd.trailingPE),
      fwdPe: raw(sd.forwardPE),
      peg: raw(ks.pegRatio),
      priceToBook: raw(sd.priceToBook),
      divYield: sd.dividendYield?.raw ? sd.dividendYield.raw * 100 : 0,
      beta: raw(sd.beta),
      profitMargin: raw(fd.profitMargins),
      operatingMargin: raw(fd.operatingMargins),
      returnOnEquity: raw(fd.returnOnEquity),
      returnOnAssets: raw(fd.returnOnAssets),
      revenueGrowth: fd.revenueGrowth?.raw ? fd.revenueGrowth.raw * 100 : null,
      earningsGrowth: fd.earningsGrowth?.raw ? fd.earningsGrowth.raw * 100 : null,
      debtToEquity: raw(fd.debtToEquity),
      currentRatio: raw(fd.currentRatio),
      totalRevenue: raw(fd.totalRevenue),
      targetMeanPrice: raw(fd.targetMeanPrice),
      recommendationKey: fd.recommendationKey,
      numberOfAnalysts: raw(fd.numberOfAnalystOpinions),
      totalCash: raw(fd.totalCash),
      totalDebt: raw(fd.totalDebt),
      freeCashflow: raw(fd.freeCashflow),
    });
  } catch (e) {
    console.error('Financials error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/history/:symbol?range=1mo ─ Price history via direct API ───
app.get('/api/history/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const range = req.query.range || '1mo';
    const intervalMap = { '1d': '5m', '5d': '15m', '1mo': '1d', '3mo': '1d', '6mo': '1d', '1y': '1wk', '5y': '1mo' };
    const interval = intervalMap[range] || '1d';

    const data = await cached(`hist_${symbol}_${range}`, 60000, async () => {
      const url = `https://query2.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=${interval}`;
      return yahooFetch(url);
    });

    const result = data?.chart?.result?.[0];
    if (!result) return res.json([]);

    const timestamps = result.timestamp || [];
    const closes = result.indicators?.quote?.[0]?.close || [];
    const opens = result.indicators?.quote?.[0]?.open || [];
    const highs = result.indicators?.quote?.[0]?.high || [];
    const lows = result.indicators?.quote?.[0]?.low || [];
    const volumes = result.indicators?.quote?.[0]?.volume || [];

    res.json(timestamps.map((t, i) => ({
      date: new Date(t * 1000).toISOString(),
      open: opens[i],
      high: highs[i],
      low: lows[i],
      close: closes[i],
      volume: volumes[i],
    })).filter(q => q.close != null));
  } catch (e) {
    console.error('History error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/trending ─ Trending stocks via direct API ───
app.get('/api/trending', async (req, res) => {
  try {
    // Use a curated list and fetch live quotes instead of unreliable trending API
    const popular = ['AAPL','MSFT','GOOGL','AMZN','NVDA','TSLA','META','JPM','NFLX','AMD',
      'PLTR','COIN','SOFI','V','DIS'];
    const quotes = await Promise.all(popular.map(s =>
      cached(`quote_${s}`, 60000, () => safeQuote(s)).catch(() => null)
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

// ─── GET /api/screener/:type ─ Stock screener ───
app.get('/api/screener/:type', async (req, res) => {
  try {
    const type = req.params.type;
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
