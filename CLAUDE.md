# EdgeFinder Pro — Claude Code Instructions

## Auto-Deploy Workflow (REQUIRED after every change)

After EVERY code change, run the following sequence without exception:

```bash
git add .
git commit -m "Update: [brief description of what changed]"
git push origin main
```

Vercel detects the push and auto-deploys to production within 2-3 minutes.
**Never leave changes uncommitted and unpushed.**

### Pre-push check
A git pre-push hook runs `node --check server.js` before every push.
If the check fails, fix the syntax error before pushing.

## Project Overview

- **Frontend**: Vanilla React 18 CDN + Babel standalone, single file: `public/index.html`
- **Backend**: Node.js + Express (`server.js`)
- **Hosting**: Vercel (auto-deploy from `main` branch via GitHub integration)
- **Production URL**: https://edgefinder-pro.vercel.app

## Environment Variables

Required in Vercel dashboard (Settings > Environment Variables):
- `ANTHROPIC_API_KEY` — Claude API key
- `ODDS_API_KEY` — Primary Odds API key
- `ODDS_API_KEY_2` — Fallback Odds API key
- `PORT` — Not needed on Vercel (handled automatically)

## Do NOT Change These Systems

The following are configured and verified working — do not alter without explicit user instruction:
- Slot logic (`assignSlots` / per-sport day rules)
- Odds cap pre-filter (`applyOddsGate`, hard -185 gate)
- Best bet scoring (`computeBestBetForGame`)
- Parlay construction logic
- ESPN score cross-reference logic
- Push voiding logic for parlays
