export default async function handler(req, res) {
  const { sport, event, markets } = req.query
  const key = process.env.ODDS_API_KEY

  let url
  if (event) {
    url = `https://api.the-odds-api.com/v4/sports/${sport}/events/${event}/odds?apiKey=${key}&regions=us&markets=${encodeURIComponent(markets)}&oddsType=american&bookmakers=bovada,draftkings`
  } else {
    url = `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${key}&regions=us&markets=h2h,spreads,totals&oddsType=american&bookmakers=bovada,draftkings`
  }

  try {
    const r = await fetch(url)
    const data = await r.json()
    res.setHeader('Cache-Control', 's-maxage=300')
    res.status(r.status).json(data)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
}
