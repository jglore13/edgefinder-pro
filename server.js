require('dotenv').config();
const express = require('express');
const axios = require('axios');
const xml2js = require('xml2js');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const ODDS_API_KEY = 'cd69f10ac2a8324c03c26303c5649271';
const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';

const ROTOWIRE_FEEDS = {
  nfl: 'https://www.rotowire.com/rss/news.php?type=NFL',
  nba: 'https://www.rotowire.com/rss/news.php?type=NBA',
  mlb: 'https://www.rotowire.com/rss/news.php?type=MLB',
  nhl: 'https://www.rotowire.com/rss/news.php?type=NHL',
};

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// GET /api/sports
app.get('/api/sports', async (req, res) => {
  try {
    const response = await axios.get(`${ODDS_API_BASE}/sports`, {
      params: { apiKey: ODDS_API_KEY, all: req.query.all || false },
    });
    res.json(response.data);
  } catch (err) {
    console.error('Sports error:', err.response?.data || err.message);
    res.status(err.response?.status || 500).json({ error: err.response?.data || err.message });
  }
});

// GET /api/odds
app.get('/api/odds', async (req, res) => {
  const { sport, eventId, markets, propMarkets, regions, bookmakers, oddsFormat, dateFormat } = req.query;
  if (!sport) return res.status(400).json({ error: 'sport query param is required' });

  try {
    let url;
    let params = { apiKey: ODDS_API_KEY };

    if (eventId) {
      url = `${ODDS_API_BASE}/sports/${sport}/events/${eventId}/odds`;
      params.markets = propMarkets || 'player_pass_tds,player_rush_yds,player_receptions';
      params.regions = regions || 'us';
      params.oddsFormat = oddsFormat || 'american';
      if (bookmakers) params.bookmakers = bookmakers;
    } else {
      url = `${ODDS_API_BASE}/sports/${sport}/odds`;
      params.markets = markets || 'h2h,spreads,totals';
      params.regions = regions || 'us';
      params.oddsFormat = oddsFormat || 'american';
      params.dateFormat = dateFormat || 'iso';
      if (bookmakers) params.bookmakers = bookmakers;
    }

    const response = await axios.get(url, { params });
    const quota = {
      remainingRequests: response.headers['x-requests-remaining'],
      usedRequests: response.headers['x-requests-used'],
      lastUpdate: response.headers['x-timestamp'],
    };
    res.json({ data: response.data, quota });
  } catch (err) {
    console.error('Odds error:', err.response?.data || err.message);
    res.status(err.response?.status || 500).json({ error: err.response?.data || err.message });
  }
});

// GET /api/injuries
app.get('/api/injuries', async (req, res) => {
  const sport = (req.query.sport || 'nfl').toLowerCase();
  const feedUrl = ROTOWIRE_FEEDS[sport];
  if (!feedUrl) return res.status(400).json({ error: `Unknown sport. Choose from: ${Object.keys(ROTOWIRE_FEEDS).join(', ')}` });

  try {
    const response = await axios.get(feedUrl, {
      headers: { 'User-Agent': 'EdgeFinderPro/2.0' },
      timeout: 10000,
    });
    const parsed = await xml2js.parseStringPromise(response.data, { explicitArray: false });
    const items = parsed?.rss?.channel?.item || [];
    const itemsArray = Array.isArray(items) ? items : [items];
    const news = itemsArray.map((item) => ({
      title: item.title || '',
      description: item.description || '',
      link: item.link || '',
      pubDate: item.pubDate || '',
      category: item.category || '',
    }));
    res.json({ sport, count: news.length, items: news });
  } catch (err) {
    console.error('Injuries error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/claude
app.post('/api/claude', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set on server' });

  const { model, messages, system, max_tokens } = req.body;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  try {
    const payload = {
      model: model || 'claude-sonnet-4-6',
      max_tokens: max_tokens || 4096,
      messages,
    };
    if (system) payload.system = system;

    const response = await axios.post('https://api.anthropic.com/v1/messages', payload, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      timeout: 120000,
    });
    res.json(response.data);
  } catch (err) {
    console.error('Claude error:', err.response?.data || err.message);
    res.status(err.response?.status || 500).json({ error: err.response?.data || err.message });
  }
});

// GET /api/scores
app.get('/api/scores', async (req, res) => {
  const { sport, daysFrom } = req.query;
  if (!sport) return res.status(400).json({ error: 'sport query param is required' });
  try {
    const response = await axios.get(`${ODDS_API_BASE}/sports/${sport}/scores`, {
      params: { apiKey: ODDS_API_KEY, daysFrom: daysFrom || 1 },
    });
    res.json({ data: response.data });
  } catch (err) {
    console.error('Scores error:', err.response?.data || err.message);
    res.status(err.response?.status || 500).json({ error: err.response?.data || err.message });
  }
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`EdgeFinder Pro v2 running at http://localhost:${PORT}`);
});
