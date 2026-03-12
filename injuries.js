export default async function handler(req, res) {
  const { sport = 'basketball' } = req.query
  const urls = {
    basketball: 'https://www.rotowire.com/basketball/rss-injuries.php',
    baseball:   'https://www.rotowire.com/baseball/rss-injuries.php',
    hockey:     'https://www.rotowire.com/hockey/rss-injuries.php',
  }
  try {
    const r = await fetch(urls[sport] || urls.basketball, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    })
    const xml = await r.text()
    res.setHeader('Content-Type', 'text/xml')
    res.setHeader('Cache-Control', 's-maxage=600')
    res.status(200).send(xml)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
}
