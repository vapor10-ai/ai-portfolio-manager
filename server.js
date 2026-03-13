import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ═══════════════════════════════════════
// DATABASE
// ═══════════════════════════════════════
const dbPath = path.join(__dirname, 'data', 'portfolio.db');
import { mkdirSync } from 'fs';
mkdirSync(path.join(__dirname, 'data'), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    shares REAL NOT NULL DEFAULT 0,
    buy_price REAL NOT NULL DEFAULT 0,
    added_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS watchlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL DEFAULT 'Main',
    sort_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS watchlist_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    watchlist_id INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    added_at INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (watchlist_id) REFERENCES watchlists(id) ON DELETE CASCADE,
    UNIQUE(watchlist_id, symbol)
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  );
`);

// Ensure at least one watchlist exists
const wlCount = db.prepare('SELECT COUNT(*) as c FROM watchlists').get();
if (wlCount.c === 0) {
  db.prepare('INSERT INTO watchlists (name, sort_order) VALUES (?, 0)').run('Main');
}

// ─── DB Helpers ───
const DB = {
  // Positions
  getPositions: () => db.prepare('SELECT ticker, name, shares, buy_price as buyPrice, added_at as addedAt FROM positions ORDER BY added_at').all(),
  upsertPosition: (p) => db.prepare(`
    INSERT INTO positions (ticker, name, shares, buy_price, added_at) VALUES (@ticker, @name, @shares, @buyPrice, @addedAt)
    ON CONFLICT(ticker) DO UPDATE SET name=@name, shares=@shares, buy_price=@buyPrice
  `).run(p),
  deletePosition: (ticker) => db.prepare('DELETE FROM positions WHERE ticker = ?').run(ticker),
  replaceAllPositions: db.transaction((positions) => {
    db.prepare('DELETE FROM positions').run();
    const ins = db.prepare('INSERT INTO positions (ticker, name, shares, buy_price, added_at) VALUES (@ticker, @name, @shares, @buyPrice, @addedAt)');
    for (const p of positions) ins.run(p);
  }),

  // Watchlists
  getWatchlists: () => {
    const lists = db.prepare('SELECT id, name, sort_order as sortOrder FROM watchlists ORDER BY sort_order').all();
    return lists.map(l => ({
      ...l,
      items: db.prepare('SELECT symbol, name, added_at as addedAt FROM watchlist_items WHERE watchlist_id = ? ORDER BY added_at').all(l.id),
    }));
  },
  replaceAllWatchlists: db.transaction((watchlists) => {
    db.prepare('DELETE FROM watchlist_items').run();
    db.prepare('DELETE FROM watchlists').run();
    const insWl = db.prepare('INSERT INTO watchlists (name, sort_order) VALUES (?, ?)');
    const insItem = db.prepare('INSERT INTO watchlist_items (watchlist_id, symbol, name, added_at) VALUES (?, ?, ?, ?)');
    watchlists.forEach((wl, i) => {
      const { lastInsertRowid } = insWl.run(wl.name, i);
      (wl.items || []).forEach(item => insItem.run(lastInsertRowid, item.symbol, item.name || '', item.addedAt || Date.now()));
    });
  }),

  // Settings (budget, theme, data source, etc.)
  getSetting: (key, fallback = null) => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (!row) return fallback;
    try { return JSON.parse(row.value); } catch { return row.value; }
  },
  setSetting: (key, value) => {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=?')
      .run(key, JSON.stringify(value), JSON.stringify(value));
  },
};

// ─── Direct Yahoo Finance client with cookie/crumb auth ───
class YahooClient {
  constructor() {
    this.crumb = null;
    this.cookie = null;
    this.lastAuth = 0;
  }

  async auth() {
    // Re-auth every 30 minutes
    if (this.crumb && this.cookie && Date.now() - this.lastAuth < 1800000) return;
    try {
      // Step 1: Get cookie from Yahoo
      const r1 = await fetch('https://fc.yahoo.com', { redirect: 'manual' });
      this.cookie = r1.headers.get('set-cookie')?.split(';')[0] || '';

      // Step 2: Get crumb using cookie
      const r2 = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
        headers: { 'Cookie': this.cookie, 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }
      });
      this.crumb = await r2.text();
      this.lastAuth = Date.now();
      console.log('Yahoo auth success, crumb:', this.crumb?.substring(0, 8) + '...');
    } catch (e) {
      console.error('Yahoo auth error:', e.message);
    }
  }

  async fetch(url) {
    await this.auth();
    const separator = url.includes('?') ? '&' : '?';
    const fullUrl = this.crumb ? `${url}${separator}crumb=${encodeURIComponent(this.crumb)}` : url;
    const res = await fetch(fullUrl, {
      headers: {
        'Cookie': this.cookie || '',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      }
    });
    if (!res.ok) throw new Error(`Yahoo API ${res.status}: ${res.statusText}`);
    return res.json();
  }

  async quote(symbol) {
    const data = await this.fetch(`https://query2.finance.yahoo.com/v7/finance/quote?symbols=${symbol}`);
    return data?.quoteResponse?.result?.[0] || null;
  }

  async quotes(symbols) {
    const data = await this.fetch(`https://query2.finance.yahoo.com/v7/finance/quote?symbols=${symbols.join(',')}`);
    return data?.quoteResponse?.result || [];
  }

  async search(query) {
    const data = await this.fetch(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=12&newsCount=0`);
    return data?.quotes || [];
  }

  async news(query, count = 15) {
    const data = await this.fetch(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=0&newsCount=${count}`);
    return (data?.news || []).map(n => ({
      title: n.title,
      link: n.link,
      publisher: n.publisher,
      publishedAt: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString() : null,
      thumbnail: n.thumbnail?.resolutions?.[0]?.url || null,
      relatedTickers: n.relatedTickers || [],
    }));
  }

  async chart(symbol, range = '1mo', interval = '1d') {
    const data = await this.fetch(`https://query2.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=${interval}`);
    const result = data?.chart?.result?.[0];
    if (!result) return [];
    const ts = result.timestamp || [];
    const q = result.indicators?.quote?.[0] || {};
    return ts.map((t, i) => ({
      date: new Date(t * 1000).toISOString(),
      open: q.open?.[i], high: q.high?.[i], low: q.low?.[i], close: q.close?.[i], volume: q.volume?.[i],
    })).filter(x => x.close != null);
  }

  async financials(symbol) {
    const data = await this.fetch(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=summaryDetail,defaultKeyStatistics,financialData`);
    return data?.quoteSummary?.result?.[0] || {};
  }
}

const yahoo = new YahooClient();

// ─── Alpha Vantage Client (Backup) ───
class AlphaVantageClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
  }

  async fetch(params) {
    const qs = new URLSearchParams({ ...params, apikey: this.apiKey }).toString();
    const res = await fetch(`https://www.alphavantage.co/query?${qs}`);
    if (!res.ok) throw new Error(`Alpha Vantage ${res.status}`);
    const data = await res.json();
    if (data['Error Message']) throw new Error(data['Error Message']);
    if (data['Note']) throw new Error('Alpha Vantage rate limit hit');
    return data;
  }

  async quote(symbol) {
    const data = await this.fetch({ function: 'GLOBAL_QUOTE', symbol });
    const q = data['Global Quote'];
    if (!q || !q['05. price']) return null;
    return {
      symbol: q['01. symbol'],
      name: symbol,
      price: parseFloat(q['05. price']),
      change: parseFloat(q['09. change']),
      changePct: parseFloat(q['10. change percent']?.replace('%', '')),
      open: parseFloat(q['02. open']),
      high: parseFloat(q['03. high']),
      low: parseFloat(q['04. low']),
      prevClose: parseFloat(q['08. previous close']),
      volume: parseInt(q['06. volume']),
    };
  }

  async search(query) {
    const data = await this.fetch({ function: 'SYMBOL_SEARCH', keywords: query });
    return (data.bestMatches || []).filter(m =>
      m['3. type'] === 'Equity' || m['3. type'] === 'ETF'
    ).slice(0, 12).map(m => ({
      symbol: m['1. symbol'],
      name: m['2. name'],
      exchange: m['4. region'] || '',
      type: m['3. type'] || 'Equity',
    }));
  }

  async chart(symbol, range = '1mo') {
    // Map range to AV function
    const isIntraday = range === '1d' || range === '5d';
    let data;
    if (isIntraday) {
      data = await this.fetch({ function: 'TIME_SERIES_INTRADAY', symbol, interval: '15min', outputsize: range === '1d' ? 'compact' : 'full' });
      const ts = data['Time Series (15min)'] || {};
      return Object.entries(ts).slice(0, range === '1d' ? 30 : 150).reverse().map(([date, v]) => ({
        date, open: parseFloat(v['1. open']), high: parseFloat(v['2. high']),
        low: parseFloat(v['3. low']), close: parseFloat(v['4. close']), volume: parseInt(v['5. volume']),
      }));
    } else {
      data = await this.fetch({ function: 'TIME_SERIES_DAILY', symbol, outputsize: 'compact' });
      const ts = data['Time Series (Daily)'] || {};
      const limitMap = { '1mo': 22, '3mo': 66, '6mo': 132, '1y': 252, '5y': 1260 };
      return Object.entries(ts).slice(0, limitMap[range] || 22).reverse().map(([date, v]) => ({
        date, open: parseFloat(v['1. open']), high: parseFloat(v['2. high']),
        low: parseFloat(v['3. low']), close: parseFloat(v['4. close']), volume: parseInt(v['5. volume']),
      }));
    }
  }

  async financials(symbol) {
    const data = await this.fetch({ function: 'OVERVIEW', symbol });
    if (!data.Symbol) return {};
    return {
      symbol: data.Symbol,
      pe: parseFloat(data.TrailingPE) || null,
      fwdPe: parseFloat(data.ForwardPE) || null,
      peg: parseFloat(data.PEGRatio) || null,
      priceToBook: parseFloat(data.PriceToBookRatio) || null,
      divYield: parseFloat(data.DividendYield) ? parseFloat(data.DividendYield) * 100 : 0,
      beta: parseFloat(data.Beta) || null,
      profitMargin: parseFloat(data.ProfitMargin) || null,
      operatingMargin: parseFloat(data.OperatingMarginTTM) || null,
      returnOnEquity: parseFloat(data.ReturnOnEquityTTM) || null,
      returnOnAssets: parseFloat(data.ReturnOnAssetsTTM) || null,
      revenueGrowth: parseFloat(data.QuarterlyRevenueGrowthYOY) ? parseFloat(data.QuarterlyRevenueGrowthYOY) * 100 : null,
      earningsGrowth: parseFloat(data.QuarterlyEarningsGrowthYOY) ? parseFloat(data.QuarterlyEarningsGrowthYOY) * 100 : null,
      targetMeanPrice: parseFloat(data.AnalystTargetPrice) || null,
      totalRevenue: parseFloat(data.RevenueTTM) || null,
      marketCap: parseFloat(data.MarketCapitalization) || null,
    };
  }
}

// Helper: get the right data client based on request header or env
function getClient(req) {
  const source = req.headers['x-data-source'] || 'yahoo';
  const avKey = req.headers['x-av-key'] || process.env.ALPHA_VANTAGE_KEY || '';
  if (source === 'alphavantage' && avKey) {
    return { client: new AlphaVantageClient(avKey), source: 'alphavantage' };
  }
  return { client: yahoo, source: 'yahoo' };
}

// Helper: try primary, fallback to other
async function withFallback(req, yahooFn, avFn) {
  const { client, source } = getClient(req);
  try {
    if (source === 'alphavantage') return await avFn(client);
    return await yahooFn(yahoo);
  } catch (primaryErr) {
    console.warn(`${source} failed:`, primaryErr.message, '- trying fallback');
    try {
      const avKey = req.headers['x-av-key'] || process.env.ALPHA_VANTAGE_KEY || '';
      if (source === 'yahoo' && avKey) {
        return await avFn(new AlphaVantageClient(avKey));
      } else if (source === 'alphavantage') {
        return await yahooFn(yahoo);
      }
    } catch (fallbackErr) {
      console.error('Fallback also failed:', fallbackErr.message);
    }
    throw primaryErr;
  }
}

// ─── Claude API ───
async function callClaude(apiKey, messages, maxTokens = 1024) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
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

// ─── Cache ───
const cache = new Map();
function cached(key, ttlMs, fn) {
  const e = cache.get(key);
  if (e && Date.now() - e.ts < ttlMs) return Promise.resolve(e.data);
  return fn().then(d => { cache.set(key, { data: d, ts: Date.now() }); return d; });
}

// ═══════════════════════════════════════
// DATA API ROUTES (Portfolio, Watchlists, Settings)
// ═══════════════════════════════════════

// ─── Portfolio CRUD ───
app.get('/api/db/positions', (req, res) => {
  try { res.json(DB.getPositions()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/db/positions', (req, res) => {
  try {
    const { ticker, name, shares, buyPrice, addedAt } = req.body;
    DB.upsertPosition({ ticker, name: name || ticker, shares: parseFloat(shares), buyPrice: parseFloat(buyPrice), addedAt: addedAt || Date.now() });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/db/positions/sync', (req, res) => {
  try {
    const positions = (req.body.positions || []).map(p => ({
      ticker: p.ticker, name: p.name || p.ticker, shares: parseFloat(p.shares),
      buyPrice: parseFloat(p.buyPrice), addedAt: p.addedAt || Date.now(),
    }));
    DB.replaceAllPositions(positions);
    res.json({ ok: true, count: positions.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/db/positions/:ticker', (req, res) => {
  try { DB.deletePosition(req.params.ticker.toUpperCase()); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Watchlist CRUD ───
app.get('/api/db/watchlists', (req, res) => {
  try {
    const wl = DB.getWatchlists();
    // Transform to match frontend format: [{name, items:[{symbol,name,addedAt}]}]
    res.json(wl.map(l => ({ name: l.name, items: l.items })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/db/watchlists/sync', (req, res) => {
  try {
    const watchlists = req.body.watchlists || [];
    DB.replaceAllWatchlists(watchlists);
    res.json({ ok: true, count: watchlists.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Settings CRUD ───
app.get('/api/db/settings', (req, res) => {
  try {
    res.json({
      budget: DB.getSetting('budget', { total: 0, maxPerStock: 20, maxPerSector: 40 }),
      theme: DB.getSetting('theme', 'dark'),
      dataSource: DB.getSetting('dataSource', 'yahoo'),
      avKey: DB.getSetting('avKey', ''),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/db/settings', (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: 'key required' });
    DB.setSetting(key, value);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Full state sync (load everything at once) ───
app.get('/api/db/state', (req, res) => {
  try {
    res.json({
      positions: DB.getPositions(),
      watchlists: DB.getWatchlists().map(l => ({ name: l.name, items: l.items })),
      budget: DB.getSetting('budget', { total: 0, maxPerStock: 20, maxPerSector: 40 }),
      theme: DB.getSetting('theme', 'dark'),
      dataSource: DB.getSetting('dataSource', 'yahoo'),
      avKey: DB.getSetting('avKey', ''),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════
// MARKET API ROUTES
// ═══════════════════════════════════════

// ─── Quote ───
app.get('/api/quote/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const { source } = getClient(req);
    const cacheKey = `q_${symbol}_${source}`;
    const result = await cached(cacheKey, 30000, () => withFallback(req,
      async (yc) => {
        const q = await yc.quote(symbol);
        if (!q) throw new Error('Symbol not found');
        return {
          symbol: q.symbol, name: q.shortName || q.longName || symbol,
          price: q.regularMarketPrice, change: q.regularMarketChange,
          changePct: q.regularMarketChangePercent,
          open: q.regularMarketOpen, high: q.regularMarketDayHigh,
          low: q.regularMarketDayLow, prevClose: q.regularMarketPreviousClose,
          volume: q.regularMarketVolume, mktCap: q.marketCap,
          pe: q.trailingPE, fwdPe: q.forwardPE, eps: q.epsTrailingTwelveMonths,
          divYield: q.trailingAnnualDividendYield ? q.trailingAnnualDividendYield * 100 : 0,
          beta: q.beta, high52: q.fiftyTwoWeekHigh, low52: q.fiftyTwoWeekLow,
          avg50: q.fiftyDayAverage, avg200: q.twoHundredDayAverage,
          exchange: q.exchange, currency: q.currency, marketState: q.marketState,
        };
      },
      async (av) => {
        const q = await av.quote(symbol);
        if (!q) throw new Error('Symbol not found');
        return { ...q, name: q.name || symbol, exchange: q.exchange || '', currency: q.currency || 'USD', marketState: q.marketState || 'CLOSED' };
      }
    ));
    res.json(result);
  } catch (e) {
    console.error('Quote error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Batch Quotes ───
app.get('/api/quotes', async (req, res) => {
  try {
    const symbols = (req.query.symbols || '').split(',').filter(Boolean).map(s => s.trim().toUpperCase());
    if (!symbols.length) return res.json([]);
    const quotes = await cached(`qs_${symbols.join(',')}`, 30000, () => yahoo.quotes(symbols));
    res.json(quotes.map(q => ({
      symbol: q.symbol, name: q.shortName || q.longName || q.symbol,
      price: q.regularMarketPrice, change: q.regularMarketChange,
      changePct: q.regularMarketChangePercent, volume: q.regularMarketVolume,
      mktCap: q.marketCap, pe: q.trailingPE, fwdPe: q.forwardPE,
      divYield: q.trailingAnnualDividendYield ? q.trailingAnnualDividendYield * 100 : 0,
      beta: q.beta, high52: q.fiftyTwoWeekHigh, low52: q.fiftyTwoWeekLow,
      marketState: q.marketState,
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Search ───
app.get('/api/search', async (req, res) => {
  try {
    const query = req.query.q || '';
    if (query.length < 1) return res.json([]);
    const { source } = getClient(req);
    const results = await cached(`s_${query}_${source}`, 300000, () => withFallback(req,
      async (yc) => {
        const r = await yc.search(query);
        return r.filter(q => q.quoteType === 'EQUITY' || q.quoteType === 'ETF')
          .slice(0, 12).map(q => ({
            symbol: q.symbol, name: q.shortname || q.longname || q.symbol,
            exchange: q.exchDisp || q.exchange || '', type: q.quoteType || 'Equity',
          }));
      },
      async (av) => av.search(query)
    ));
    res.json(results);
  } catch (e) {
    console.error('Search error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Financials ───
app.get('/api/financials/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const { source } = getClient(req);
    const result = await cached(`f_${symbol}_${source}`, 300000, () => withFallback(req,
      async (yc) => {
        const data = await yc.financials(symbol);
        const sd = data.summaryDetail || {};
        const ks = data.defaultKeyStatistics || {};
        const fd = data.financialData || {};
        const raw = (o) => { if(o==null)return null; if(typeof o==='number')return o; if(typeof o==='string')return o; if(typeof o==='object'&&'raw' in o)return o.raw??null; return null; };
        return {
          symbol, pe: raw(sd.trailingPE), fwdPe: raw(sd.forwardPE), peg: raw(ks.pegRatio),
          priceToBook: raw(sd.priceToBook),
          divYield: sd.dividendYield?.raw ? sd.dividendYield.raw * 100 : 0,
          beta: raw(sd.beta), profitMargin: raw(fd.profitMargins),
          operatingMargin: raw(fd.operatingMargins), returnOnEquity: raw(fd.returnOnEquity),
          returnOnAssets: raw(fd.returnOnAssets),
          revenueGrowth: fd.revenueGrowth?.raw ? fd.revenueGrowth.raw * 100 : null,
          earningsGrowth: fd.earningsGrowth?.raw ? fd.earningsGrowth.raw * 100 : null,
          debtToEquity: raw(fd.debtToEquity), currentRatio: raw(fd.currentRatio),
          totalRevenue: raw(fd.totalRevenue), targetMeanPrice: raw(fd.targetMeanPrice),
          recommendationKey: fd.recommendationKey,
          numberOfAnalysts: raw(fd.numberOfAnalystOpinions),
          freeCashflow: raw(fd.freeCashflow),
        };
      },
      async (av) => av.financials(symbol)
    ));
    res.json(result);
  } catch (e) {
    console.error('Financials error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── History ───
app.get('/api/history/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const range = req.query.range || '1mo';
    const { source } = getClient(req);
    const imap = { '1d':'5m','5d':'15m','1mo':'1d','3mo':'1d','6mo':'1d','1y':'1wk','5y':'1mo' };
    const data = await cached(`h_${symbol}_${range}_${source}`, 60000, () => withFallback(req,
      async (yc) => yc.chart(symbol, range, imap[range] || '1d'),
      async (av) => av.chart(symbol, range)
    ));
    res.json(data);
  } catch (e) {
    console.error('History error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── News ───
app.get('/api/news/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const news = await cached(`news_${symbol}`, 300000, () => yahoo.news(symbol, 10));
    res.json(news);
  } catch (e) {
    console.error('News error:', e.message);
    res.json([]);
  }
});

app.get('/api/news', async (req, res) => {
  try {
    const news = await cached('market_news', 300000, () => yahoo.news('stock market today', 20));
    res.json(news);
  } catch (e) {
    console.error('Market news error:', e.message);
    res.json([]);
  }
});

// ─── Trending (popular stocks with live data) ───
app.get('/api/trending', async (req, res) => {
  try {
    const popular = ['AAPL','MSFT','GOOGL','AMZN','NVDA','TSLA','META','JPM','NFLX','AMD','PLTR','COIN','SOFI','V','DIS'];
    const quotes = await cached('trending', 60000, () => yahoo.quotes(popular));
    res.json(quotes.map(q => ({
      symbol: q.symbol, name: q.shortName || q.longName || q.symbol,
      price: q.regularMarketPrice, change: q.regularMarketChange,
      changePct: q.regularMarketChangePercent, volume: q.regularMarketVolume, mktCap: q.marketCap,
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Screener ───
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
    const quotes = await cached('screener', 60000, () => yahoo.quotes(tickers));
    let results = quotes.map(q => ({
      symbol: q.symbol, name: q.shortName || q.longName || q.symbol,
      price: q.regularMarketPrice, change: q.regularMarketChange,
      changePct: q.regularMarketChangePercent, volume: q.regularMarketVolume,
      mktCap: q.marketCap, pe: q.trailingPE,
    }));
    if (type === 'gainers') results.sort((a,b) => (b.changePct||0) - (a.changePct||0));
    else if (type === 'losers') results.sort((a,b) => (a.changePct||0) - (b.changePct||0));
    else results.sort((a,b) => (b.volume||0) - (a.volume||0));
    res.json(results.slice(0, 20));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Claude AI Analysis ───
app.post('/api/analyze', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'Claude API key not configured. Set ANTHROPIC_API_KEY in .env' });
  try {
    const { symbol, financials, context } = req.body;
    const prompt = `You are a senior financial analyst. Analyze ${symbol} stock with these real-time metrics:\n\n${JSON.stringify(financials, null, 2)}\n\nAdditional context: ${context || 'None'}\n\nProvide a structured analysis in this EXACT JSON format (no markdown, just JSON):\n{"view":"Bullish" or "Neutral" or "Bearish","confidence":1-10,"valuation":"Undervalued" or "Fairly Valued" or "Overvalued","risk":"Low" or "Medium" or "High","horizon":"Short Term" or "Medium Term" or "Long Term","targetPrice":number or null,"summary":"2-3 sentence overall assessment","catalysts":["list of positive catalysts"],"risks":["list of key risks"],"keyMetrics":"1-2 sentence on most important metrics","sectorView":"1 sentence on sector outlook","actionable":"1 sentence recommendation"}\n\nBe specific, data-driven, and direct. This is not investment advice - it is analytical commentary.`;
    const text = await callClaude(apiKey, [{ role: 'user', content: prompt }]);
    try { res.json(JSON.parse(text)); } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) res.json(JSON.parse(match[0]));
      else res.json({ summary: text, view: 'Neutral', risk: 'Medium', valuation: 'Fairly Valued' });
    }
  } catch (e) {
    console.error('Claude API error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── AI Market Scanner ───
app.post('/api/scan', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'Claude API key not configured' });
  try {
    const { portfolio, criteria } = req.body;
    const scanList = ['AAPL','MSFT','GOOGL','AMZN','NVDA','META','TSLA','JPM','V','JNJ','WMT','PG','UNH','MA','HD','NFLX','AMD','CRM','COST','KO','PEP','ABBV','MRK','XOM','CVX','LLY','AVGO','ADBE','ORCL','CSCO','ACN','TXN','QCOM','INTU','AMAT','MU','SOFI','PLTR','SQ','SHOP'];
    const quotes = await cached('scan_quotes', 60000, () => yahoo.quotes(scanList));
    const stockData = quotes.map(q => ({
      symbol: q.symbol, name: q.shortName, price: q.regularMarketPrice,
      changePct: q.regularMarketChangePercent?.toFixed(2), pe: q.trailingPE?.toFixed(1),
      fwdPe: q.forwardPE?.toFixed(1), mktCap: q.marketCap,
      divYield: q.trailingAnnualDividendYield ? (q.trailingAnnualDividendYield * 100).toFixed(2) : '0',
      beta: q.beta?.toFixed(2),
    }));
    const prompt = `You are an AI market scanner for a portfolio manager. Analyze these stocks and provide investment recommendations.\n\nCURRENT PORTFOLIO: ${JSON.stringify(portfolio || [])}\nUSER CRITERIA: ${criteria || 'Find best opportunities across all criteria - value, growth, and income'}\n\nMARKET DATA:\n${JSON.stringify(stockData, null, 2)}\n\nProvide recommendations in this EXACT JSON format:\n{"marketSentiment":"Bullish" or "Neutral" or "Bearish","marketSummary":"2-3 sentence market overview","recommendations":[{"symbol":"TICKER","name":"Company Name","action":"Strong Buy" or "Buy" or "Watch" or "Avoid","reason":"1-2 sentence explanation","category":"Value" or "Growth" or "Income" or "Momentum"}],"diversificationTip":"1 sentence about portfolio diversification","sectorOpportunity":"1 sentence about which sectors look attractive"}\n\nProvide 8-12 recommendations sorted by conviction. Be data-driven and specific. This is analytical commentary, not investment advice.`;
    const text = await callClaude(apiKey, [{ role: 'user', content: prompt }], 2048);
    try { res.json(JSON.parse(text)); } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) res.json(JSON.parse(match[0]));
      else res.json({ marketSummary: text, recommendations: [] });
    }
  } catch (e) {
    console.error('Scan error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Data Source Status ───
app.get('/api/datasource', (req, res) => {
  const avKey = process.env.ALPHA_VANTAGE_KEY || '';
  res.json({
    yahoo: true,
    alphavantage: !!avKey,
    avKeySet: avKey ? 'server' : 'none',
  });
});

// ─── Fallback ───
app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

// ─── Start ───
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`AI Portfolio Manager v2.0 running on http://localhost:${PORT}`);
  console.log(`Claude API: ${process.env.ANTHROPIC_API_KEY ? 'Configured' : 'Not set'}`);
  // Pre-auth with Yahoo on startup
  await yahoo.auth();
});
