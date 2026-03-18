require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const ODDS_KEYS = [
  process.env.ODDS_API_KEY  || 'cd69f10ac2a8324c03c26303c5649271',
  process.env.ODDS_API_KEY_2 || 'ae6507289d4e6e32abe66359770771a2',
];
let currentKeyIndex = 0;

function getOddsKey() { return ODDS_KEYS[currentKeyIndex]; }

async function axiosOdds(url, params) {
  const isExhausted = (err) => {
    const code = err.response?.data?.error_code;
    return (err.response?.status === 401 || err.response?.status === 422) && code === 'OUT_OF_USAGE_CREDITS';
  };
  const attempt = () => axios.get(url, { params: { ...params, apiKey: getOddsKey() } });
  try {
    return await attempt();
  } catch (err) {
    if (!isExhausted(err)) throw err;
    console.log(`Odds key ${currentKeyIndex + 1} exhausted, switching to key ${currentKeyIndex === 0 ? 2 : 1}`);
    currentKeyIndex = currentKeyIndex === 0 ? 1 : 0;
    try {
      return await attempt();
    } catch (err2) {
      if (!isExhausted(err2)) throw err2;
      const e = new Error('Odds API credits exhausted - please add credits at the-odds-api.com');
      e.statusCode = 402;
      throw e;
    }
  }
}

const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';

// ─── INJURY & NEWS FEED INFRASTRUCTURE ────────────────────────────────────────

const INJURY_SOURCES = {
  NBA:   ['https://www.rotowire.com/basketball/rss-injuries.php', 'https://www.cbssports.com/rss/headlines/nba/injuries'],
  MLB:   ['https://www.rotowire.com/baseball/rss-injuries.php',  'https://www.cbssports.com/rss/headlines/mlb/injuries'],
  NHL:   ['https://www.rotowire.com/hockey/rss-injuries.php',    'https://www.cbssports.com/rss/headlines/nhl/injuries'],
  NFL:   ['https://www.rotowire.com/football/rss-injuries.php',  'https://www.cbssports.com/rss/headlines/nfl/injuries'],
  NCAAB: ['https://www.cbssports.com/rss/headlines/college-basketball/injuries'],
  NCAAF: ['https://www.cbssports.com/rss/headlines/college-football/injuries'],
};

const NEWS_SOURCES = {
  NBA:   ['https://www.espn.com/espn/rss/nba/news', 'https://www.cbssports.com/rss/headlines/nba'],
  MLB:   ['https://www.espn.com/espn/rss/mlb/news', 'https://www.cbssports.com/rss/headlines/mlb'],
  NHL:   ['https://www.espn.com/espn/rss/nhl/news', 'https://www.cbssports.com/rss/headlines/nhl'],
  NFL:   ['https://www.espn.com/espn/rss/nfl/news', 'https://www.cbssports.com/rss/headlines/nfl'],
  NCAAB: ['https://www.espn.com/espn/rss/ncb/news', 'https://www.cbssports.com/rss/headlines/college-basketball'],
  NCAAF: ['https://www.espn.com/espn/rss/ncf/news', 'https://www.cbssports.com/rss/headlines/college-football'],
  MMA:   ['https://www.espn.com/espn/rss/mma/news'],
};

const injuryCache = {};
const newsCache   = {};

function parseXmlItems(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const c = m[1];
    const title = (c.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || c.match(/<title>(.*?)<\/title>/))?.[1]
      ?.replace(/<[^>]+>/g, '').trim() || '';
    const desc = (c.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/) || c.match(/<description>([\s\S]*?)<\/description>/))?.[1]
      ?.replace(/<[^>]+>/g, '').trim().slice(0, 250) || '';
    const link    = c.match(/<link>(.*?)<\/link>/)?.[1]?.trim() || '';
    const pubDate = c.match(/<pubDate>(.*?)<\/pubDate>/)?.[1]?.trim() || '';
    if (title) items.push({ title, desc, link, pubDate });
  }
  return items;
}

function parseInjuryStatus(title, desc) {
  const t = (title + ' ' + desc).toLowerCase();
  if (/ruled out|will not play|\bout\b|dnp/.test(t))          return 'OUT';
  if (/doubtful/.test(t))                                       return 'DOUBTFUL';
  if (/questionable/.test(t))                                   return 'QUESTIONABLE';
  if (/probable|likely to play/.test(t))                        return 'PROBABLE';
  if (/day-to-day|day to day/.test(t))                          return 'DAY-TO-DAY';
  if (/return(?:ing)?|activated|cleared|upgraded/.test(t))      return 'RETURNING';
  return 'NEWS';
}

async function fetchFeed(url) {
  const r = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EdgeFinderPro/1.0)' },
    timeout: 8000,
    responseType: 'text',
  });
  return typeof r.data === 'string' ? r.data : String(r.data);
}

async function fetchInjuriesForSport(sport) {
  const sources = INJURY_SOURCES[sport] || [];
  for (const url of sources) {
    try {
      const xml   = await fetchFeed(url);
      const raw   = parseXmlItems(xml);
      if (raw.length === 0) continue;
      const items = raw.slice(0, 30).map(i => ({ ...i, status: parseInjuryStatus(i.title, i.desc), sport }));
      injuryCache[sport] = { items, lastUpdated: new Date().toISOString(), source: url };
      console.log(`[Injuries] ${sport}: ${items.length} items from ${url}`);
      return items;
    } catch (e) {
      console.log(`[Injuries] ${sport} failed: ${url} — ${e.message}`);
    }
  }
  injuryCache[sport] = { items: [], lastUpdated: new Date().toISOString(), source: 'none' };
  return [];
}

async function fetchNewsForSport(sport) {
  const sources = NEWS_SOURCES[sport] || [];
  for (const url of sources) {
    try {
      const xml   = await fetchFeed(url);
      const items = parseXmlItems(xml).slice(0, 20).map(i => ({ ...i, sport }));
      if (items.length === 0) continue;
      newsCache[sport] = { items, lastUpdated: new Date().toISOString() };
      console.log(`[News] ${sport}: ${items.length} items from ${url}`);
      return items;
    } catch (e) {
      console.log(`[News] ${sport} failed: ${url} — ${e.message}`);
    }
  }
  newsCache[sport] = { items: [], lastUpdated: new Date().toISOString() };
  return [];
}

const ALL_INJURY_SPORTS = ['NBA', 'MLB', 'NHL', 'NFL', 'NCAAB', 'NCAAF'];
const ALL_NEWS_SPORTS   = ['NBA', 'MLB', 'NHL', 'NFL', 'NCAAB', 'NCAAF', 'MMA'];

// Init on startup
Promise.all(ALL_INJURY_SPORTS.map(s => fetchInjuriesForSport(s)))
  .then(() => console.log('[Injuries] All feeds initialized'));
Promise.all(ALL_NEWS_SPORTS.map(s => fetchNewsForSport(s)))
  .then(() => console.log('[News] All feeds initialized'));

// Refresh injuries every 20 min
setInterval(() => ALL_INJURY_SPORTS.forEach(s => fetchInjuriesForSport(s)), 20 * 60 * 1000);

// Refresh news every 30 min
setInterval(() => ALL_NEWS_SPORTS.forEach(s => fetchNewsForSport(s)), 30 * 60 * 1000);

// Questionable players: re-check every 5 min
setInterval(async () => {
  for (const sport of ALL_INJURY_SPORTS) {
    const c = injuryCache[sport];
    if (!c) continue;
    if (c.items.some(i => i.status === 'QUESTIONABLE' || i.status === 'DAY-TO-DAY' || i.status === 'DOUBTFUL')) {
      console.log(`[Injuries] ${sport} has uncertain players — refreshing`);
      await fetchInjuriesForSport(sport);
    }
  }
}, 5 * 60 * 1000);

// ─── MIDDLEWARE ────────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── API ROUTES ────────────────────────────────────────────────────────────────

// GET /api/sports
app.get('/api/sports', async (req, res) => {
  try {
    const response = await axiosOdds(`${ODDS_API_BASE}/sports`, { all: req.query.all || false });
    res.json(response.data);
  } catch (err) {
    console.error('Sports error:', err.message);
    res.status(err.statusCode || err.response?.status || 500).json({ error: err.message });
  }
});

// GET /api/odds
app.get('/api/odds', async (req, res) => {
  const { sport, eventId, markets, propMarkets, regions, bookmakers, oddsFormat, dateFormat } = req.query;
  if (!sport) return res.status(400).json({ error: 'sport query param is required' });
  try {
    let url, params = {};
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
    const response = await axiosOdds(url, params);
    const quota = {
      remainingRequests: response.headers['x-requests-remaining'],
      usedRequests: response.headers['x-requests-used'],
      lastUpdate: response.headers['x-timestamp'],
    };
    res.json({ data: response.data, quota });
  } catch (err) {
    console.error('Odds error:', err.message);
    res.status(err.statusCode || err.response?.status || 500).json({ error: err.message });
  }
});

// GET /api/injuries?sport=NBA
app.get('/api/injuries', async (req, res) => {
  const sport = (req.query.sport || 'NBA').toUpperCase();
  if (!INJURY_SOURCES[sport]) {
    return res.json({ sport, injuries: [], lastUpdated: null, source: 'none', hasQuestionable: false });
  }
  if (!injuryCache[sport]?.lastUpdated) {
    await fetchInjuriesForSport(sport);
  }
  const c = injuryCache[sport] || {};
  res.json({
    sport,
    injuries: c.items || [],
    lastUpdated: c.lastUpdated || null,
    source: c.source || 'none',
    hasQuestionable: (c.items || []).some(i => i.status === 'QUESTIONABLE' || i.status === 'DAY-TO-DAY'),
  });
});

// GET /api/news?sport=NBA
app.get('/api/news', async (req, res) => {
  const sport = (req.query.sport || 'NBA').toUpperCase();
  if (!newsCache[sport]?.lastUpdated) {
    await fetchNewsForSport(sport);
  }
  const c = newsCache[sport] || {};
  res.json({ sport, news: c.items || [], lastUpdated: c.lastUpdated || null });
});

// POST /api/claude
app.post('/api/claude', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  console.log('Claude route hit, key exists:', !!apiKey, 'key prefix:', apiKey?.slice(0, 10));
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server' });
  const { model, messages, system, max_tokens } = req.body;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }
  try {
    const payload = { model: model || 'claude-sonnet-4-6', max_tokens: max_tokens || 4096, messages };
    if (system) payload.system = system;
    const response = await axios.post('https://api.anthropic.com/v1/messages', payload, {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
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
    const response = await axiosOdds(`${ODDS_API_BASE}/sports/${sport}/scores`, { daysFrom: daysFrom || 1 });
    res.json({ data: response.data });
  } catch (err) {
    console.error('Scores error:', err.message);
    res.status(err.statusCode || err.response?.status || 500).json({ error: err.message });
  }
});

// ─── ESPN UNOFFICIAL API ───────────────────────────────────────────────────────

const ESPN_LEAGUE_MAP = {
  'basketball_nba':         { sport: 'basketball', league: 'nba' },
  'icehockey_nhl':          { sport: 'hockey',     league: 'nhl' },
  'baseball_mlb':           { sport: 'baseball',   league: 'mlb' },
  'americanfootball_nfl':   { sport: 'football',   league: 'nfl' },
  'basketball_ncaab':       { sport: 'basketball', league: 'mens-college-basketball' },
  'americanfootball_ncaaf': { sport: 'football',   league: 'college-football' },
  'mma_mixed_martial_arts': { sport: 'mma',        league: 'ufc' },
};

// GET /api/espn-scores?sport=basketball_nba&date=20260318
app.get('/api/espn-scores', async (req, res) => {
  const { sport, date } = req.query;
  if (!sport) return res.status(400).json({ error: 'sport is required' });
  const mapping = ESPN_LEAGUE_MAP[sport];
  if (!mapping) return res.json({ data: [], source: 'espn' });

  const dateStr = (date || new Date().toISOString().slice(0, 10)).replace(/-/g, '');
  const url = `https://site.api.espn.com/apis/site/v2/sports/${mapping.sport}/${mapping.league}/scoreboard?dates=${dateStr}`;
  try {
    const r = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EdgeFinderPro/1.0)' },
      timeout: 8000,
    });
    const events = r.data.events || [];
    const games = events.map(ev => {
      const comp = ev.competitions?.[0];
      if (!comp) return null;
      const home = comp.competitors?.find(c => c.homeAway === 'home');
      const away = comp.competitors?.find(c => c.homeAway === 'away');
      if (!home || !away) return null;
      const completed = ev.status?.type?.completed || false;
      return {
        espn_id:    ev.id,
        home_team:  home.team.displayName || home.team.name,
        away_team:  away.team.displayName || away.team.name,
        home_score: completed ? parseInt(home.score || '0') : null,
        away_score: completed ? parseInt(away.score || '0') : null,
        completed,
        status:     ev.status?.type?.shortDetail || '',
      };
    }).filter(Boolean);
    console.log(`[ESPN Scores] ${sport} ${dateStr}: ${games.filter(g=>g.completed).length} completed`);
    res.json({ data: games, source: 'espn', date: dateStr });
  } catch (err) {
    console.error('[ESPN Scores]', sport, err.message);
    res.json({ data: [], source: 'espn', error: err.message });
  }
});

// GET /api/espn-injuries?sport=basketball_nba
app.get('/api/espn-injuries', async (req, res) => {
  const { sport } = req.query;
  const mapping = ESPN_LEAGUE_MAP[sport];
  if (!mapping || mapping.sport === 'mma') return res.json({ injuries: [], source: 'espn' });
  const url = `https://site.api.espn.com/apis/site/v2/sports/${mapping.sport}/${mapping.league}/injuries`;
  try {
    const r = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EdgeFinderPro/1.0)' },
      timeout: 8000,
    });
    const items = (r.data.injuries || []).flatMap(team =>
      (team.injuries || []).map(inj => ({
        title:   `${inj.athlete?.displayName || '?'} (${team.team?.displayName || '?'}) — ${inj.type?.text || 'Injury'}`,
        status:  (() => {
          const s = (inj.status || '').toLowerCase();
          if (s.includes('out'))         return 'OUT';
          if (s.includes('doubt'))       return 'DOUBTFUL';
          if (s.includes('question'))    return 'QUESTIONABLE';
          if (s.includes('probable'))    return 'PROBABLE';
          if (s.includes('day-to-day') || s.includes('day to day')) return 'DAY-TO-DAY';
          return 'NEWS';
        })(),
        desc:    inj.longComment || inj.shortComment || '',
        pubDate: inj.date || '',
        sport,
      }))
    );
    console.log(`[ESPN Injuries] ${sport}: ${items.length} items`);
    res.json({ injuries: items, source: 'espn' });
  } catch (err) {
    console.error('[ESPN Injuries]', sport, err.message);
    res.json({ injuries: [], source: 'espn', error: err.message });
  }
});

// GET /api/version — returns deploy metadata for the header badge
const DEPLOY_TIME = new Date().toISOString();
app.get('/api/version', (_req, res) => {
  res.json({
    deployedAt: DEPLOY_TIME,
    commitSha:  process.env.VERCEL_GIT_COMMIT_SHA   || null,
    commitMsg:  process.env.VERCEL_GIT_COMMIT_MESSAGE || null,
    env:        process.env.VERCEL_ENV               || 'local',
  });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`EdgeFinder Pro v2 running at http://localhost:${PORT}`);
  axios.get(`${ODDS_API_BASE}/sports`, { params: { apiKey: getOddsKey(), all: false } })
    .then(r => {
      const keys = r.data.map(s => s.key);
      console.log('[Odds API] Active sport keys:', keys.join(', '));
      const targets = ['baseball_ncaa', 'basketball_ncaab', 'basketball_nba', 'baseball_mlb', 'icehockey_nhl', 'americanfootball_nfl', 'americanfootball_ncaaf', 'mma_mixed_martial_arts'];
      targets.forEach(k => {
        const found = r.data.find(s => s.key === k);
        console.log(`[Odds API] ${k}: ${found ? `✓ active (${found.title})` : '✗ NOT FOUND or inactive'}`);
      });
    })
    .catch(err => console.warn('[Odds API] Could not fetch sports list on startup:', err.message));
});
