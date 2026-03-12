import { useState, useEffect, useRef, useCallback } from 'react'
import Head from 'next/head'

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const FLOOR = -250
const TODAY = new Date()
const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']
const TODAY_NAME = DAYS[TODAY.getDay()]

const SPORTS = {
  NBA: { key:'basketball_nba', icon:'🏀', color:'#f97316', props:'player_points,player_rebounds,player_assists,player_points_rebounds_assists,player_double_double,player_triple_double,player_points_assists,player_points_rebounds,player_rebounds_assists' },
  MLB: { key:'baseball_mlb',  icon:'⚾', color:'#ef4444', props:'batter_hits,batter_runs_scored,batter_total_bases,batter_rbis,batter_hits_runs_rbis' },
  NHL: { key:'icehockey_nhl', icon:'🏒', color:'#06b6d4', props:'player_goals,player_shots_on_goal,player_assists' },
  WBC: { key:'baseball_wbc',  icon:'🌍', color:'#a855f7', props:'batter_hits,batter_runs_scored,batter_total_bases,batter_rbis' },
}

const SYSTEM_PROMPT = `You are an expert sports betting AI trained exclusively on the GOAT Sports Bets system. Today is ${TODAY_NAME}.

CRITICAL: Never pick odds heavier than -250. Always give both a SPREAD/ML pick AND an O/U pick per game.

DAY SLOTS — Vegas wins 4.5/7 days:
NBA: Mon=PUBLIC(1st=Vegas), Tue=VEGAS(1st=Public), Wed=PUBLIC, Thu=VEGAS, Fri=PUBLIC, Sat=VEGAS, Sun=VEGAS
MLB/WBC: Mon=Public, Tue=Vegas, Wed=Hybrid(early=Public/5:40pmCST=Vegas), Thu=Vegas, Fri=Public, Sat=Vegas(1st=Public), Sun=Vegas(1st=Public)
NHL: 1Game=Vegas(Scam), 2Games=Public(1st=Vegas), 4+Games=Public(1st=Vegas)

ALTERNATING SLOT: Within each slate, each new unique game time alternates slot.
PUBLIC day: 1st time=Vegas, 2nd=Public, 3rd=Vegas...
VEGAS day: 1st time=Public, 2nd=Vegas, 3rd=Public...
Same start time = both get same slot.

PEMDAS: P=Slot, E=Trell Rule, M=Line Movement, D=Injuries, A=H2H, S=History

PUBLIC slot: sensible outcome, underdog spread if even, OVER if high scorers+total drops, -6/-7 line = strong
VEGAS slot: scams/upsets, favorite if even, UNDER lean, +5/+6.5 line = strong
Trell Rule: star player first absence = covers in Vegas slot. HIGH CONFIDENCE.
NBA Flip Flop: big underdog win = FADE next game.
Rank Scam: top team after blowout in Vegas slot = fade.
Anti-Spam: 5 OVERs in a row = check 1-2 UNDERs.`

const ALL_SYS = ['P/V','TRL','LM','INJ','H2H','HIS','RNK','FLP','TOT','EVM']
const SYS_COLORS = {'P/V':'#00ff88','TRL':'#00cfff','LM':'#ffb300','INJ':'#ff6b6b','H2H':'#c084fc','HIS':'#fb923c','RNK':'#34d399','FLP':'#60a5fa','TOT':'#f472b6','EVM':'#a3e635'}
const TARGET_MARKETS = ['POINTS','REBOUNDS','ASSISTS','POINTS REBOUNDS ASSISTS','POINTS ASSISTS','POINTS REBOUNDS','REBOUNDS ASSISTS','DOUBLE DOUBLE','TRIPLE DOUBLE','HITS','RUNS SCORED','TOTAL BASES','RBIS','HITS RUNS RBIS','GOALS','SHOTS ON GOAL']

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function dayType(sport, count) {
  const vegas = ['Tuesday','Thursday','Saturday','Sunday']
  if (sport==='NBA') return vegas.includes(TODAY_NAME) ? 'VEGAS' : 'PUBLIC'
  if (sport==='MLB'||sport==='WBC') return vegas.includes(TODAY_NAME) ? 'VEGAS' : 'PUBLIC'
  if (sport==='NHL') return count===1 ? 'VEGAS' : 'PUBLIC'
  return 'PUBLIC'
}

function assignSlots(games, sport) {
  const dt = dayType(sport, games.length)
  const byTime = {}
  games.forEach(g => {
    const d = new Date(g.commence_time)
    const t = d.getHours()*60+d.getMinutes()
    ;(byTime[t]||(byTime[t]=[])).push(g.id)
  })
  const times = Object.keys(byTime).map(Number).sort((a,b)=>a-b)
  const slots = {}
  times.forEach((t,i) => {
    const slot = dt==='PUBLIC' ? (i%2===0?'VEGAS':'PUBLIC') : (i%2===0?'PUBLIC':'VEGAS')
    byTime[t].forEach(id => slots[id]=slot)
  })
  return { slots, dt }
}

const fmtOdds = o => (o===null||o===undefined) ? '—' : (o>0?'+'+o:''+o)
const fmtTime = iso => new Date(iso).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',hour12:true,timeZone:'America/New_York'})+' ET'
const oddsOk  = o => o===null||o===undefined||o>=FLOOR
const amerDec = o => { const n=parseFloat(o); if(!n)return 1; return n>0?n/100+1:100/Math.abs(n)+1 }
const confColor = c => c>=8?'#00ff88':c>=6?'#ffb300':'#ff6b6b'
const gradeColor = g => ({'A+':'#00ff88','A':'#34d399','B+':'#86efac','B':'#ffb300','C':'#fb923c','D':'#ff6b6b','F':'#ff6b6b'}[g]||'#888')
function scoreGrade(n) {
  if(n>=7)return{g:'A+',c:'#00ff88',l:'ELITE'}
  if(n>=5)return{g:'A',c:'#34d399',l:'STRONG'}
  if(n>=4)return{g:'B+',c:'#86efac',l:'GOOD'}
  if(n>=3)return{g:'B',c:'#ffb300',l:'PLAYABLE'}
  if(n>=2)return{g:'C',c:'#fb923c',l:'WEAK'}
  return{g:'D',c:'#ff6b6b',l:'SKIP'}
}
async function safeJSON(text) {
  try { const s=text.indexOf('{'),e=text.lastIndexOf('}'); if(s===-1||e===-1)return null; return JSON.parse(text.slice(s,e+1)) } catch{ return null }
}

function parseGame(raw) {
  const bk = raw.bookmakers?.find(b=>b.key==='bovada')||raw.bookmakers?.find(b=>b.key==='draftkings')||raw.bookmakers?.[0]
  if(!bk) return null
  const h2h=bk.markets?.find(m=>m.key==='h2h'), spr=bk.markets?.find(m=>m.key==='spreads'), tot=bk.markets?.find(m=>m.key==='totals')
  const homeML=h2h?.outcomes?.find(o=>o.name===raw.home_team)?.price??null
  const awayML=h2h?.outcomes?.find(o=>o.name===raw.away_team)?.price??null
  const homeSpr=spr?.outcomes?.find(o=>o.name===raw.home_team)
  const awaySpr=spr?.outcomes?.find(o=>o.name===raw.away_team)
  const over=tot?.outcomes?.find(o=>o.name==='Over'), under=tot?.outcomes?.find(o=>o.name==='Under')
  return { id:raw.id, home:raw.home_team, away:raw.away_team, commence_time:raw.commence_time,
    homeML, awayML, homeSpread:homeSpr?.point??null, homeSpreadOdds:homeSpr?.price??null,
    awaySpread:awaySpr?.point??null, awaySpreadOdds:awaySpr?.price??null,
    total:over?.point??null, overOdds:over?.price??null, underOdds:under?.price??null }
}

// ─── API CALLS ────────────────────────────────────────────────────────────────
async function apiOdds(sportKey) {
  const r = await fetch(`/api/odds?sport=${sportKey}`)
  if(!r.ok) throw new Error(`${r.status}`)
  return r.json()
}
async function apiProps(sportKey, eventId, markets) {
  const r = await fetch(`/api/odds?sport=${sportKey}&event=${eventId}&markets=${encodeURIComponent(markets)}`)
  if(!r.ok) return null
  return r.json()
}
async function apiInjuries(sport='basketball') {
  const r = await fetch(`/api/injuries?sport=${sport}`)
  if(!r.ok) return ''
  return r.text()
}
async function apiClaude(messages) {
  const r = await fetch('/api/claude', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:1000,system:SYSTEM_PROMPT,messages}),
  })
  const d = await r.json()
  if(d.error) return JSON.stringify({error:d.error?.message||JSON.stringify(d.error)})
  return d.content?.map(b=>b.text||'').join('')||''
}

// ─── INJURY FEED ──────────────────────────────────────────────────────────────
function InjuryFeed() {
  const [injuries,setInjuries]=useState([])
  const [lastUpdate,setLastUpdate]=useState(null)
  const [loading,setLoading]=useState(false)

  const refresh = useCallback(async()=>{
    setLoading(true)
    const results=[]
    for(const sp of ['basketball','baseball']) {
      try {
        const xml=await apiInjuries(sp)
        const items=[...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0,8).map(m=>{
          const title=(m[1].match(/<title><!\[CDATA\[(.*?)\]\]>/)?.[1]||m[1].match(/<title>(.*?)<\/title>/)?.[1]||'').replace(/<[^>]+>/g,'')
          const desc=(m[1].match(/<description><!\[CDATA\[(.*?)\]\]>/)?.[1]||m[1].match(/<description>(.*?)<\/description>/)?.[1]||'').replace(/<[^>]+>/g,'').slice(0,150)
          return {title,desc}
        })
        results.push(...items)
      } catch{}
    }
    setInjuries(results.length?results:[{title:'No injury data available',desc:'Check rotowire.com directly'}])
    setLastUpdate(new Date())
    setLoading(false)
  },[])

  useEffect(()=>{ refresh(); const t=setInterval(refresh,15*60*1000); return()=>clearInterval(t) },[refresh])

  return (
    <div style={{background:'rgba(0,0,0,0.4)',borderRadius:14,padding:16,border:'1px solid rgba(255,107,107,0.2)',marginBottom:20}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
        <div>
          <div style={{fontSize:12,fontWeight:800,color:'#ff6b6b',letterSpacing:2}}>⚠ INJURY FEED — ROTOWIRE</div>
          <div style={{fontSize:10,color:'#555',marginTop:2}}>Auto-refresh 15min · {lastUpdate?`Last: ${lastUpdate.toLocaleTimeString()}`:'Loading...'}</div>
        </div>
        <button onClick={refresh} disabled={loading} style={{padding:'6px 14px',background:'rgba(255,107,107,0.15)',border:'1px solid rgba(255,107,107,0.3)',borderRadius:8,color:'#ff6b6b',fontSize:11,cursor:loading?'not-allowed':'pointer',fontFamily:'inherit',fontWeight:700}}>
          {loading?'⟳ Updating...':'↻ Refresh Now'}
        </button>
      </div>
      <div style={{maxHeight:180,overflowY:'auto',display:'flex',flexDirection:'column',gap:6}}>
        {!injuries.length
          ? <div style={{color:'#555',fontSize:11,padding:8}}><span className="spin">⟳</span> Loading injury feed...</div>
          : injuries.map((inj,i)=>(
            <div key={i} style={{padding:'7px 11px',background:'rgba(255,107,107,0.05)',borderRadius:8,border:'1px solid rgba(255,107,107,0.1)'}}>
              <div style={{fontSize:12,fontWeight:600,color:'#ffb3b3'}}>{inj.title}</div>
              {inj.desc&&<div style={{fontSize:11,color:'#888',marginTop:2}}>{inj.desc}</div>}
            </div>
          ))}
      </div>
    </div>
  )
}

// ─── GAME CARD ────────────────────────────────────────────────────────────────
function GameCard({game,sport,slot,pick,loading,onAnalyze}) {
  const sc = slot==='VEGAS'?'#ffb300':'#00ff88'
  const homeOk=oddsOk(game.homeML), awayOk=oddsOk(game.awayML)
  return (
    <div style={{background:'rgba(255,255,255,0.025)',borderRadius:13,padding:14,marginBottom:10,border:`1px solid ${sc}22`}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:10}}>
        <div>
          <div style={{fontSize:14,fontWeight:700,color:'#fff'}}>{game.away} @ {game.home}</div>
          <div style={{fontSize:11,color:'#444',marginTop:2}}>{fmtTime(game.commence_time)}</div>
        </div>
        <div style={{display:'flex',gap:8,alignItems:'center',flexShrink:0}}>
          <span style={{fontSize:10,fontWeight:800,padding:'3px 10px',borderRadius:5,background:`${sc}18`,color:sc,border:`1px solid ${sc}35`}}>{slot}</span>
          {!pick&&!loading&&<button onClick={onAnalyze} style={{padding:'4px 11px',background:'rgba(0,255,136,0.1)',border:'1px solid rgba(0,255,136,0.3)',borderRadius:5,color:'#00ff88',fontSize:10,cursor:'pointer',fontFamily:'inherit',fontWeight:700}}>ANALYZE</button>}
        </div>
      </div>

      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:6,margin:'9px 0 11px'}}>
        {[
          {l:'SPREAD',v:game.homeSpread!==null?(game.homeSpread>0?'+':'')+game.homeSpread:'—',sub:fmtOdds(game.homeSpreadOdds),warn:false},
          {l:'HOME ML',v:fmtOdds(game.homeML),warn:!homeOk},
          {l:'AWAY ML',v:fmtOdds(game.awayML),warn:!awayOk},
          {l:'TOTAL',v:game.total??'—',sub:game.overOdds?`O${fmtOdds(game.overOdds)}/U${fmtOdds(game.underOdds)}`:'',warn:false},
        ].map(s=>(
          <div key={s.l} style={{textAlign:'center',background:'rgba(0,0,0,0.3)',borderRadius:7,padding:'5px 3px',border:s.warn?'1px solid rgba(255,107,107,0.3)':undefined}}>
            <div style={{fontSize:9,color:'#555',marginBottom:1}}>{s.l}</div>
            <div style={{fontSize:13,fontWeight:700,color:s.warn?'rgba(255,107,107,0.5)':'#ccc'}}>{s.v}</div>
            {s.sub&&<div style={{fontSize:9,color:'#555',marginTop:1}}>{s.sub}</div>}
            {s.warn&&<div style={{fontSize:8,color:'#ff6b6b'}}>⚠ OVER FLOOR</div>}
          </div>
        ))}
      </div>

      <div style={{borderRadius:9,padding:'10px 12px',background:pick?(slot==='VEGAS'?'rgba(255,179,0,0.04)':'rgba(0,255,136,0.04)'):'rgba(255,255,255,0.02)',border:`1px solid ${pick?sc+'25':'rgba(255,255,255,0.05)'}`}}>
        {loading
          ? <div style={{fontSize:11,color:'#555'}}>⟳ Analyzing with PEMDAS system...</div>
          : pick?.error
            ? <div style={{fontSize:11,color:'#ff6b6b'}}>⚠ {pick.error}</div>
            : pick
              ? <>
                  <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:9,marginBottom:8}}>
                    <div style={{padding:'8px 11px',borderRadius:7,background:'rgba(0,255,136,0.06)',border:'1px solid rgba(0,255,136,0.15)'}}>
                      <div style={{fontSize:9,color:'#555',marginBottom:2}}>SPREAD / ML PICK</div>
                      <div style={{fontSize:13,fontWeight:800,color:'#00ff88'}}>{pick.spreadPick||'—'}</div>
                      <div style={{fontSize:10,color:'#888'}}>{pick.spreadOdds||''}</div>
                    </div>
                    <div style={{padding:'8px 11px',borderRadius:7,background:'rgba(0,207,255,0.06)',border:'1px solid rgba(0,207,255,0.15)'}}>
                      <div style={{fontSize:9,color:'#555',marginBottom:2}}>O/U PICK</div>
                      <div style={{fontSize:13,fontWeight:800,color:'#00cfff'}}>{pick.totalPick||'—'}</div>
                      <div style={{fontSize:10,color:'#888'}}>{pick.totalLine||''}</div>
                    </div>
                  </div>
                  <div style={{fontSize:11,color:'#999',lineHeight:1.65,marginBottom:7}}>{pick.reasoning}</div>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                    <div style={{display:'flex',gap:5,flexWrap:'wrap'}}>
                      {(pick.flags||[]).map((f,i)=><span key={i} style={{fontSize:9,padding:'2px 7px',borderRadius:7,background:'rgba(255,179,0,0.1)',color:'#ffb300',border:'1px solid rgba(255,179,0,0.22)'}}>{f}</span>)}
                    </div>
                    <div style={{fontSize:12,fontWeight:800,color:confColor(pick.confidence)}}>{pick.confidence}/10</div>
                  </div>
                </>
              : <div style={{fontSize:11,color:'#444'}}>Click ANALYZE or use "Generate All Picks"</div>
        }
      </div>
    </div>
  )
}

// ─── PICKS TAB ────────────────────────────────────────────────────────────────
function PicksTab({onGamesLoaded}) {
  const [games,setGames]=useState({})
  const [picks,setPicks]=useState({})
  const [loadingGames,setLoadingGames]=useState(false)
  const [loadingAll,setLoadingAll]=useState(false)
  const [loadingPick,setLoadingPick]=useState({})
  const [collapsed,setCollapsed]=useState({})

  const loadSlate = useCallback(async()=>{
    setLoadingGames(true)
    const res={}
    for(const [sp,info] of Object.entries(SPORTS)){
      try{
        const raw=await apiOdds(info.key)
        if(raw?.length){ const g=raw.map(parseGame).filter(Boolean); if(g.length) res[sp]=g }
      }catch(e){console.warn(sp,e.message)}
    }
    setGames(res); if(onGamesLoaded) onGamesLoaded(res); setLoadingGames(false)
  },[onGamesLoaded])

  useEffect(()=>{loadSlate()},[loadSlate])

  const analyzeGame = async(gameId)=>{
    let game=null,sport=null
    for(const [sp,gs] of Object.entries(games)){ const g=gs.find(g=>g.id===gameId); if(g){game=g;sport=sp;break} }
    if(!game) return
    const {slots}=assignSlots(games[sport],sport)
    const slot=slots[game.id]||'PUBLIC'
    setLoadingPick(p=>({...p,[gameId]:true}))

    const prompt=`Analyze this ${sport} game using GOAT Sports Bets PEMDAS.
GAME: ${game.away} @ ${game.home} | TIME: ${fmtTime(game.commence_time)} | DAY: ${TODAY_NAME} | SLOT: ${slot}
HOME ML: ${fmtOdds(game.homeML)}${!oddsOk(game.homeML)?' (OVER -250 FLOOR - SKIP)':''}
AWAY ML: ${fmtOdds(game.awayML)}${!oddsOk(game.awayML)?' (OVER -250 FLOOR - SKIP)':''}
SPREAD: Home ${fmtOdds(game.homeSpread)} (${fmtOdds(game.homeSpreadOdds)}) / Away ${fmtOdds(game.awaySpread)} (${fmtOdds(game.awaySpreadOdds)})
TOTAL: ${game.total??'-'} | Over ${fmtOdds(game.overOdds)} | Under ${fmtOdds(game.underOdds)}

Return ONLY valid JSON, nothing else before or after:
{"spreadPick":"Team Name -3.5","spreadOdds":"-110","totalPick":"Over 224.5","totalLine":"-108","reasoning":"2-3 sentences PEMDAS analysis","confidence":7,"flags":["Trell Rule"]}

Flags: Trell Rule, Flip Flop, Rank Scam, Scam Alert, Anti-Spam, Line Movement, Short Slate, Safety Play, Underdog Value, Vegas Trap`

    const res=await apiClaude([{role:'user',content:prompt}])
    const parsed=await safeJSON(res)
    setPicks(p=>({...p,[gameId]:parsed||{spreadPick:'Parse error — retry',totalPick:'—',reasoning:res?.slice(0,300)||'No response',confidence:0,flags:[]}}))
    setLoadingPick(p=>({...p,[gameId]:false}))
  }

  const analyzeAll=async()=>{
    setLoadingAll(true)
    for(const [,gs] of Object.entries(games)) for(const g of gs) if(!picks[g.id]) await analyzeGame(g.id)
    setLoadingAll(false)
  }

  const totalGames=Object.values(games).reduce((a,g)=>a+g.length,0)

  return (
    <div>
      <InjuryFeed/>

      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'13px 16px',background:'rgba(0,0,0,0.4)',borderRadius:13,border:'1px solid rgba(255,255,255,0.07)',marginBottom:16,flexWrap:'wrap',gap:10}}>
        <div>
          <div style={{fontSize:13,fontWeight:700,color:'#fff'}}>Today's Slate — {TODAY_NAME}</div>
          <div style={{fontSize:11,color:'#555',marginTop:2}}>{loadingGames?'Loading live Bovada lines...':`${totalGames} games · ${Object.keys(picks).length} picks · Odds floor: -250`}</div>
        </div>
        <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
          <button onClick={loadSlate} disabled={loadingGames} style={{padding:'9px 16px',background:'rgba(255,255,255,0.05)',border:'1px solid rgba(255,255,255,0.1)',borderRadius:8,color:'#888',fontSize:12,cursor:'pointer',fontFamily:'inherit',fontWeight:600}}>
            {loadingGames?'⟳ Loading...':'↻ Reload Lines'}
          </button>
          <button onClick={analyzeAll} disabled={loadingAll||loadingGames} style={{padding:'9px 20px',background:loadingAll?'rgba(0,255,136,0.1)':'linear-gradient(135deg,#00ff88,#00cfff)',border:loadingAll?'1px solid #00ff88':'none',borderRadius:8,color:loadingAll?'#00ff88':'#000',fontWeight:800,fontSize:12,cursor:loadingAll?'not-allowed':'pointer',fontFamily:'inherit'}}>
            {loadingAll?'⟳ Analyzing...':'🧠 GENERATE ALL PICKS'}
          </button>
        </div>
      </div>

      {loadingGames&&<div style={{textAlign:'center',padding:48,color:'#555'}}><div style={{fontSize:26,display:'inline-block',animation:'spin 1s linear infinite',marginBottom:10}}>⟳</div><div style={{fontSize:13}}>Pulling live Bovada lines...</div></div>}

      {!loadingGames&&!Object.keys(games).length&&(
        <div style={{textAlign:'center',padding:48,color:'#444'}}>
          <div style={{fontSize:14,marginBottom:8}}>No games found for today.</div>
          <div style={{fontSize:11}}>Games appear when scheduled. Try Reload Lines or check back later.</div>
        </div>
      )}

      {Object.entries(games).map(([sport,gs])=>{
        const info=SPORTS[sport]
        const {slots,dt}=assignSlots(gs,sport)
        const vc=Object.values(slots).filter(s=>s==='VEGAS').length
        const isCollapsed=collapsed[sport]
        return (
          <div key={sport} style={{marginBottom:22}}>
            <div onClick={()=>setCollapsed(c=>({...c,[sport]:!c[sport]}))} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'11px 15px',background:`${info.color}14`,border:`1px solid ${info.color}28`,borderRadius:11,cursor:'pointer',marginBottom:isCollapsed?0:10}}>
              <div style={{display:'flex',alignItems:'center',gap:10}}>
                <span style={{fontSize:20}}>{info.icon}</span>
                <div>
                  <div style={{fontSize:15,fontWeight:800,color:info.color}}>{sport}</div>
                  <div style={{fontSize:11,color:'#777'}}>{gs.length} games · {TODAY_NAME} · <span style={{color:dt==='VEGAS'?'#ffb300':'#00ff88'}}>{dt} DAY</span></div>
                </div>
              </div>
              <div style={{display:'flex',gap:7,alignItems:'center'}}>
                <span style={{padding:'3px 9px',borderRadius:5,fontSize:10,fontWeight:700,background:'rgba(255,179,0,0.12)',color:'#ffb300',border:'1px solid rgba(255,179,0,0.25)'}}>{vc}V</span>
                <span style={{padding:'3px 9px',borderRadius:5,fontSize:10,fontWeight:700,background:'rgba(0,255,136,0.1)',color:'#00ff88',border:'1px solid rgba(0,255,136,0.22)'}}>{gs.length-vc}P</span>
                <span style={{color:'#555',fontSize:13}}>{isCollapsed?'▶':'▼'}</span>
              </div>
            </div>
            {!isCollapsed&&gs.map(game=>(
              <GameCard key={game.id} game={game} sport={sport} slot={slots[game.id]||'PUBLIC'}
                pick={picks[game.id]} loading={!!loadingPick[game.id]}
                onAnalyze={()=>analyzeGame(game.id)}/>
            ))}
          </div>
        )
      })}
    </div>
  )
}

// ─── PROPS TAB ────────────────────────────────────────────────────────────────
function PropsTab({games}) {
  const [props,setProps]=useState({})
  const [loading,setLoading]=useState(false)
  const [activeTab,setActiveTab]=useState('top10')

  const loadProps=async()=>{
    setLoading(true)
    const bySport={},all=[]
    for(const [sp,info] of Object.entries(SPORTS)){
      const gs=games[sp]||[]
      if(!gs.length) continue
      bySport[sp]=[]
      const {slots}=assignSlots(gs,sp)
      for(const g of gs.slice(0,3)){
        try{
          const data=await apiProps(info.key,g.id,info.props)
          if(!data?.bookmakers) continue
          const bk=data.bookmakers.find(b=>b.key==='bovada')||data.bookmakers[0]
          if(!bk) continue
          const slot=slots[g.id]||'PUBLIC'
          bk.markets?.forEach(mkt=>{
            mkt.outcomes?.forEach(out=>{
              if(!out.price||out.price<FLOOR) return
              const mktName=mkt.key.replace('player_','').replace('batter_','').replace(/_/g,' ').toUpperCase()
              if(!TARGET_MARKETS.some(m=>mktName.includes(m))) return
              const prop={player:out.description||out.name,market:mktName,name:out.name,point:out.point,odds:out.price,sport:sp,slot,game:`${g.away.split(' ').slice(-1)[0]} @ ${g.home.split(' ').slice(-1)[0]}`,confidence:Math.min(10,5+(slot==='PUBLIC'&&out.name==='Over'?2:0)+(slot==='VEGAS'&&out.name==='Under'?2:0)+(out.price>-120?1:0)+(out.price>0?1:0))}
              bySport[sp].push(prop); all.push(prop)
            })
          })
        }catch{}
      }
    }
    all.sort((a,b)=>b.confidence-a.confidence||Math.abs(a.odds)-Math.abs(b.odds))
    setProps({...bySport,top10:all.slice(0,10)}); setLoading(false)
  }

  const tabKeys=['top10',...Object.keys(games).filter(sp=>props[sp]?.length)]
  const current=props[activeTab]||[]

  return (
    <div>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'13px 16px',background:'rgba(0,0,0,0.4)',borderRadius:13,border:'1px solid rgba(255,255,255,0.07)',marginBottom:16,flexWrap:'wrap',gap:10}}>
        <div>
          <div style={{fontSize:13,fontWeight:700,color:'#fff'}}>Player Props — Bovada Lines</div>
          <div style={{fontSize:11,color:'#555',marginTop:2}}>Odds floor: -250 · Vegas=UNDER lean · Public=OVER lean</div>
        </div>
        <button onClick={loadProps} disabled={loading} style={{padding:'9px 18px',background:loading?'rgba(0,255,136,0.1)':'linear-gradient(135deg,#00ff88,#00cfff)',border:loading?'1px solid #00ff88':'none',borderRadius:8,color:loading?'#00ff88':'#000',fontWeight:800,fontSize:12,cursor:loading?'not-allowed':'pointer',fontFamily:'inherit'}}>
          {loading?'⟳ Loading...':'↻ Refresh Props'}
        </button>
      </div>

      {!Object.keys(games).length&&<div style={{padding:'12px 15px',background:'rgba(255,179,0,0.07)',border:'1px solid rgba(255,179,0,0.2)',borderRadius:10,fontSize:11,color:'#ffb300'}}>Load today's slate first (Today's Picks tab), then come back here.</div>}

      {loading&&<div style={{textAlign:'center',padding:48,color:'#555'}}><div style={{fontSize:26,display:'inline-block',animation:'spin 1s linear infinite',marginBottom:10}}>⟳</div><div style={{fontSize:13}}>Fetching Bovada props...</div></div>}

      {!loading&&Object.keys(props).length>0&&(
        <>
          <div style={{display:'flex',gap:4,marginBottom:14,flexWrap:'wrap'}}>
            {tabKeys.map(tk=>(
              <button key={tk} onClick={()=>setActiveTab(tk)} style={{padding:'7px 13px',borderRadius:8,border:'none',cursor:'pointer',fontSize:11,fontFamily:'inherit',fontWeight:600,background:activeTab===tk?'#00ff88':'rgba(255,255,255,0.04)',color:activeTab===tk?'#000':'#666'}}>
                {tk==='top10'?'⭐ Top 10 Today':`${SPORTS[tk]?.icon||''} ${tk}`}
              </button>
            ))}
          </div>
          {activeTab==='top10'&&<div style={{padding:'8px 12px',background:'rgba(0,255,136,0.06)',border:'1px solid rgba(0,255,136,0.15)',borderRadius:9,fontSize:11,color:'#00ff88',marginBottom:12}}>Ranked by system confidence · Slot alignment · -250 floor enforced</div>}
          {current.map((prop,i)=>{
            const sc=prop.slot==='VEGAS'?'#ffb300':'#00ff88'
            const sColor=SPORTS[prop.sport]?.color||'#888'
            return (
              <div key={i} style={{display:'grid',gridTemplateColumns:activeTab==='top10'?'30px 1fr auto':'1fr auto',gap:10,alignItems:'center',padding:'10px 13px',background:'rgba(255,255,255,0.025)',border:'1px solid rgba(255,255,255,0.07)',borderRadius:9,marginBottom:6}}>
                {activeTab==='top10'&&<div style={{width:28,height:28,borderRadius:'50%',background:i<3?'#00ff88':'rgba(255,255,255,0.08)',color:i<3?'#000':'#888',display:'flex',alignItems:'center',justifyContent:'center',fontWeight:800,fontSize:12}}>{i+1}</div>}
                <div>
                  <div style={{fontSize:13,fontWeight:700,color:'#fff'}}>{prop.player||'Player'}</div>
                  <div style={{fontSize:11,color:'#888'}}>{prop.market} {prop.name||''} {prop.point??''} · {prop.game}</div>
                  <div style={{display:'flex',gap:5,marginTop:3,flexWrap:'wrap'}}>
                    <span style={{fontSize:9,padding:'1px 6px',borderRadius:5,background:`${sColor}18`,color:sColor}}>{prop.sport}</span>
                    <span style={{fontSize:9,padding:'1px 6px',borderRadius:5,background:`${sc}15`,color:sc,border:`1px solid ${sc}30`}}>{prop.slot}</span>
                    {prop.confidence&&<span style={{fontSize:9,padding:'1px 6px',borderRadius:5,background:'rgba(0,255,136,0.1)',color:'#00ff88'}}>⭐ {prop.confidence}/10</span>}
                  </div>
                </div>
                <div style={{fontSize:16,fontWeight:800,color:'#00ff88',textAlign:'right'}}>{fmtOdds(prop.odds)}</div>
              </div>
            )
          })}
        </>
      )}

      {!loading&&!Object.keys(props).length&&Object.keys(games).length>0&&(
        <div style={{textAlign:'center',padding:48,color:'#444'}}>
          <div style={{fontSize:14,marginBottom:8}}>Click "Refresh Props" to load today's player props.</div>
        </div>
      )}
    </div>
  )
}

// ─── PARLAYS TAB ──────────────────────────────────────────────────────────────
function ParlaysTab({games}) {
  const [settings,setSettings]=useState({count:4,legsMin:4,legsMax:6,context:''})
  const [parlays,setParlays]=useState([])
  const [loading,setLoading]=useState(false)

  const generate=async()=>{
    setLoading(true); setParlays([])
    const lines=[]
    for(const [sp,gs] of Object.entries(games)){
      const {slots}=assignSlots(gs,sp)
      gs.forEach(g=>lines.push(`${sp}: ${g.away} @ ${g.home} | ${fmtTime(g.commence_time)} | Slot:${slots[g.id]||'?'} | HML:${fmtOdds(g.homeML)} AML:${fmtOdds(g.awayML)} | Spr:${g.homeSpread??'-'}(${fmtOdds(g.homeSpreadOdds)}) | Tot:${g.total??'-'} O${fmtOdds(g.overOdds)} U${fmtOdds(g.underOdds)}`))
    }
    const prompt=`Today is ${TODAY_NAME}. Build ${settings.count} parlay slips of ${settings.legsMin}-${settings.legsMax} legs targeting +1000 to +4000.
RULES: No leg heavier than -250. 3+ PEMDAS systems per leg. Mix spreads and totals. Anti-Spam: mix OVERs/UNDERs.
GAMES:\n${lines.join('\n')}
${settings.context?'Context: '+settings.context:''}
Return ONLY valid JSON, nothing before or after:
{"parlays":[{"name":"Sharp 4-Leg","legs":[{"game":"Away @ Home","pick":"Team -3.5","odds":"-110","sport":"NBA","slot":"VEGAS","reason":"brief"}],"totalOdds":"+1450","grade":"A","confidence":8,"method":"Safety Parlay","note":"4.2 avg systems"}]}`
    const res=await apiClaude([{role:'user',content:prompt}])
    const parsed=await safeJSON(res)
    setParlays(parsed?.parlays||[{name:'Error',legs:[],totalOdds:'—',grade:'F',confidence:0,method:'Retry',note:res?.slice(0,200)||'Check server logs'}])
    setLoading(false)
  }

  return (
    <div>
      <div style={{background:'rgba(0,0,0,0.4)',border:'1px solid rgba(255,255,255,0.07)',borderRadius:13,padding:18,marginBottom:18}}>
        <div style={{fontSize:12,fontWeight:700,color:'#fff',marginBottom:14}}>PARLAY GENERATION SETTINGS</div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:16,marginBottom:14}}>
          {[{l:'# Slips',k:'count',min:1,max:6},{l:'Min Legs',k:'legsMin',min:2,max:5},{l:'Max Legs',k:'legsMax',min:4,max:6}].map(x=>(
            <div key={x.k}>
              <div style={{display:'flex',justifyContent:'space-between',marginBottom:4}}>
                <span style={{fontSize:11,color:'#aaa'}}>{x.l}</span>
                <span style={{fontSize:12,color:'#00ff88',fontWeight:700}}>{settings[x.k]}</span>
              </div>
              <input type="range" min={x.min} max={x.max} value={settings[x.k]} onChange={e=>setSettings(s=>({...s,[x.k]:Number(e.target.value)}))} style={{width:'100%',accentColor:'#00ff88'}}/>
            </div>
          ))}
        </div>
        <textarea value={settings.context} onChange={e=>setSettings(s=>({...s,context:e.target.value}))} placeholder="e.g. Curry questionable, Shohei on hot streak..." style={{width:'100%',height:52,background:'rgba(255,255,255,0.05)',border:'1px solid rgba(255,255,255,0.12)',borderRadius:7,padding:'7px 10px',color:'#fff',fontFamily:'inherit',fontSize:12,resize:'vertical',marginBottom:14}}/>
        <button onClick={generate} disabled={loading||!Object.keys(games).length} style={{padding:'11px 24px',background:loading?'rgba(0,255,136,0.1)':'linear-gradient(135deg,#00ff88,#00cfff)',border:loading?'1px solid #00ff88':'none',borderRadius:9,color:loading?'#00ff88':'#000',fontWeight:800,fontSize:13,cursor:loading?'not-allowed':'pointer',fontFamily:'inherit'}}>
          {loading?'⟳ Building Parlays...':!Object.keys(games).length?'Load slate first':'🎯 GENERATE BEST PARLAY SLIPS'}
        </button>
      </div>

      {loading&&<div style={{textAlign:'center',padding:48,color:'#555'}}><div style={{fontSize:26,display:'inline-block',animation:'spin 1s linear infinite',marginBottom:10}}>⟳</div><div style={{fontSize:13}}>Building best parlays from today's lines...</div></div>}

      {!loading&&!parlays.length&&<div style={{textAlign:'center',padding:48,color:'#444'}}><div style={{fontSize:14,marginBottom:8}}>Hit generate to build optimized parlay slips.</div><div style={{fontSize:11}}>Uses today's live Bovada lines + full GOAT Sports Bets rules.</div></div>}

      {parlays.map((p,i)=>{
        const gc=gradeColor(p.grade)
        return (
          <div key={i} style={{background:'rgba(0,0,0,0.4)',border:`2px solid ${gc}30`,borderRadius:15,padding:19,marginBottom:13}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:13,flexWrap:'wrap',gap:9}}>
              <div>
                <div style={{fontSize:15,fontWeight:800,color:'#fff'}}>Slip #{i+1} — {p.name}</div>
                <div style={{fontSize:11,color:'#666',marginTop:2}}>{p.method||''} · {p.note||''}</div>
              </div>
              <div style={{display:'flex',gap:13,alignItems:'center'}}>
                {[{l:'ODDS',v:p.totalOdds,c:'#00ff88'},{l:'GRADE',v:p.grade,c:gc},{l:'CONF',v:`${p.confidence}/10`,c:p.confidence>=7?'#00ff88':p.confidence>=5?'#ffb300':'#ff6b6b'}].map(s=>(
                  <div key={s.l} style={{textAlign:'center'}}>
                    <div style={{fontSize:9,color:'#444'}}>{s.l}</div>
                    <div style={{fontSize:20,fontWeight:800,color:s.c}}>{s.v}</div>
                  </div>
                ))}
              </div>
            </div>
            {(p.legs||[]).map((leg,j)=>{
              const sc=leg.slot==='VEGAS'?'#ffb300':'#00ff88'
              return (
                <div key={j} style={{display:'grid',gridTemplateColumns:'26px 1fr auto auto',gap:9,alignItems:'center',padding:'7px 11px',background:'rgba(255,255,255,0.02)',borderRadius:7,border:'1px solid rgba(255,255,255,0.06)',marginBottom:5}}>
                  <div style={{width:23,height:23,borderRadius:'50%',background:'#00ff88',color:'#000',display:'flex',alignItems:'center',justifyContent:'center',fontWeight:800,fontSize:11}}>{j+1}</div>
                  <div>
                    <div style={{fontSize:12,fontWeight:700,color:'#fff'}}>{leg.pick}</div>
                    <div style={{fontSize:10,color:'#777'}}>{leg.game} · {leg.reason||''}</div>
                  </div>
                  <span style={{fontSize:10,padding:'2px 7px',borderRadius:5,background:`${sc}15`,color:sc,border:`1px solid ${sc}30`}}>{leg.slot||''}</span>
                  <span style={{fontSize:13,fontWeight:700,color:(leg.odds||'').includes('+')||leg.odds==='—'?'#00ff88':'#aaa'}}>{leg.odds}</span>
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

// ─── PARLAY BUILDER ───────────────────────────────────────────────────────────
function BuilderTab() {
  const [legs,setLegs]=useState([
    {id:1,game:'',pick:'',odds:'',sport:'NBA',systems:[]},
    {id:2,game:'',pick:'',odds:'',sport:'MLB',systems:[]},
    {id:3,game:'',pick:'',odds:'',sport:'NHL',systems:[]},
    {id:4,game:'',pick:'',odds:'',sport:'NBA',systems:[]},
  ])
  const [stake,setStake]=useState(50)

  const updLeg=(id,f,v)=>setLegs(legs.map(l=>l.id===id?{...l,[f]:v}:l))
  const togSys=(id,sys)=>setLegs(legs.map(l=>{if(l.id!==id)return l;const on=l.systems.includes(sys);return{...l,systems:on?l.systems.filter(s=>s!==sys):[...l.systems,sys]}}))

  const totalDec=legs.reduce((a,l)=>a*amerDec(l.odds),1)
  const parlayAm=totalDec>2?Math.round((totalDec-1)*100):Math.round(-100/(totalDec-1))
  const payout=(stake*totalDec).toFixed(2)
  const avgSys=(legs.reduce((a,l)=>a+(l.systems?.length||0),0)/legs.length).toFixed(1)
  const {g:grade,c:color,l:lbl}=scoreGrade(parseFloat(avgSys))
  const hasOdds=legs.some(l=>l.odds)
  const inRange=parlayAm>=1000&&parlayAm<=4000
  const overFloor=legs.some(l=>l.odds&&parseFloat(l.odds)<FLOOR)

  const iStyle={background:'rgba(255,255,255,0.05)',border:'1px solid rgba(255,255,255,0.12)',borderRadius:7,padding:'7px 10px',color:'#fff',fontFamily:'inherit',fontSize:12}
  const sStyle={background:'#0b0b18',border:'1px solid rgba(255,255,255,0.12)',borderRadius:7,padding:'7px 10px',color:'#aaa',fontFamily:'inherit',fontSize:12}

  return (
    <div>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',background:'rgba(0,0,0,0.35)',border:'1px solid rgba(255,255,255,0.07)',borderRadius:13,padding:'13px 16px',marginBottom:14,flexWrap:'wrap',gap:10}}>
        <div style={{fontSize:11,color:'#888',flex:1}}>Build a parlay manually. Tag PEMDAS systems per leg. -250 floor enforced.</div>
        <div style={{textAlign:'center'}}>
          <div style={{fontSize:9,color:'#555',marginBottom:3}}>STAKE ($)</div>
          <input type="number" value={stake} onChange={e=>setStake(Number(e.target.value))} style={{...iStyle,width:75,color:'#00ff88',textAlign:'center',fontSize:16,fontWeight:700}}/>
        </div>
      </div>

      {legs.map((leg,i)=>{
        const ok=!leg.odds||parseFloat(leg.odds)>=FLOOR
        return (
          <div key={leg.id} style={{background:'rgba(255,255,255,0.025)',border:`1px solid ${ok?'rgba(255,255,255,0.07)':'rgba(255,107,107,0.35)'}`,borderRadius:13,padding:14,marginBottom:10}}>
            <div style={{display:'flex',gap:8,alignItems:'center',marginBottom:8,flexWrap:'wrap'}}>
              <div style={{width:26,height:26,borderRadius:'50%',background:'#00ff88',color:'#000',display:'flex',alignItems:'center',justifyContent:'center',fontWeight:800,fontSize:12,flexShrink:0}}>{i+1}</div>
              <select value={leg.sport} onChange={e=>updLeg(leg.id,'sport',e.target.value)} style={sStyle}>
                {Object.keys(SPORTS).map(s=><option key={s}>{s}</option>)}
              </select>
              <input placeholder="Game (e.g. Heat @ Celtics)" value={leg.game} onChange={e=>updLeg(leg.id,'game',e.target.value)} style={{...iStyle,flex:1,minWidth:110}}/>
              <input placeholder="Pick (e.g. Celtics -8.5)" value={leg.pick} onChange={e=>updLeg(leg.id,'pick',e.target.value)} style={{...iStyle,width:135}}/>
              <input placeholder="Odds" value={leg.odds} onChange={e=>updLeg(leg.id,'odds',e.target.value)} style={{...iStyle,width:65,textAlign:'center',color:ok?'#00ff88':'#ff6b6b'}}/>
              {!ok&&<span style={{fontSize:9,color:'#ff6b6b',padding:'2px 6px',background:'rgba(255,107,107,0.1)',borderRadius:4,flexShrink:0}}>⚠FLOOR</span>}
              {legs.length>2&&<button onClick={()=>setLegs(legs.filter(l=>l.id!==leg.id))} style={{background:'rgba(255,80,80,0.1)',border:'1px solid rgba(255,80,80,0.2)',borderRadius:6,color:'#ff6b6b',width:26,height:26,cursor:'pointer',fontSize:16,flexShrink:0}}>×</button>}
            </div>
            <div style={{display:'flex',flexWrap:'wrap',gap:5}}>
              {ALL_SYS.map(sys=>{
                const on=(leg.systems||[]).includes(sys), c=SYS_COLORS[sys]||'#888'
                return <button key={sys} onClick={()=>togSys(leg.id,sys)} style={{padding:'2px 8px',borderRadius:16,fontSize:10,cursor:'pointer',fontFamily:'inherit',fontWeight:700,background:on?`${c}20`:'rgba(255,255,255,0.03)',border:`1px solid ${on?c:'rgba(255,255,255,0.07)'}`,color:on?c:'#555'}}>{sys}</button>
              })}
              <span style={{fontSize:10,alignSelf:'center',marginLeft:4,fontWeight:700,color:(leg.systems?.length||0)>=3?'#00ff88':'#ff6b6b'}}>{(leg.systems?.length||0)>=3?`✓ ${leg.systems?.length||0}`:`⚠ ${leg.systems?.length||0}/3`}</span>
            </div>
          </div>
        )
      })}

      {legs.length<6&&<button onClick={()=>setLegs([...legs,{id:Date.now(),game:'',pick:'',odds:'',sport:'NBA',systems:[]}])} style={{width:'100%',padding:10,background:'rgba(255,255,255,0.02)',border:'1px dashed rgba(255,255,255,0.1)',borderRadius:10,color:'#555',cursor:'pointer',fontSize:12,fontFamily:'inherit',marginBottom:12}}>+ Add Leg ({legs.length}/6)</button>}
      {overFloor&&<div style={{padding:'8px 13px',background:'rgba(255,107,107,0.08)',border:'1px solid rgba(255,107,107,0.25)',borderRadius:8,fontSize:11,color:'#ff6b6b',marginBottom:10}}>⚠ One or more legs exceed -250 floor. Adjust before playing.</div>}

      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,padding:18,background:'rgba(0,0,0,0.5)',border:`2px solid ${inRange&&hasOdds?color:'rgba(255,255,255,0.07)'}`,borderRadius:15}}>
        {[
          {l:'PARLAY ODDS',v:hasOdds?`+${parlayAm.toLocaleString()}`:'—',sub:inRange?'✓ IN RANGE':'⚠ OUTSIDE',sc:inRange?'#00ff88':'#ff6b6b',vc:inRange&&hasOdds?color:'#888'},
          {l:'POTENTIAL WIN',v:hasOdds?`$${(parseFloat(payout)-stake).toFixed(0)}`:'—',sub:`on $${stake}`,sc:'#555',vc:'#fff'},
          {l:'AVG SYSTEMS',v:avgSys,sub:parseFloat(avgSys)>=3?'✓ MET':'⚠ NEED 3+',sc:parseFloat(avgSys)>=3?'#00ff88':'#ff6b6b',vc:color},
          {l:'SLIP GRADE',v:grade,sub:lbl,sc:color,vc:color},
        ].map(s=>(
          <div key={s.l} style={{textAlign:'center'}}>
            <div style={{fontSize:9,color:'#555',marginBottom:4,letterSpacing:1}}>{s.l}</div>
            <div style={{fontSize:26,fontWeight:800,color:s.vc,lineHeight:1}}>{s.v}</div>
            <div style={{fontSize:10,color:s.sc,marginTop:4}}>{s.sub}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── TRACKER TAB ─────────────────────────────────────────────────────────────
const SAMPLE_BETS=[
  {id:1,date:'2025-03-10',sport:'NBA',game:'Celtics vs Heat',pick:'Celtics -8.5',odds:-110,result:'W',systems:['P/V','LM','H2H']},
  {id:2,date:'2025-03-10',sport:'MLB',game:'Yankees vs Sox',pick:'Under 8.5',odds:-108,result:'W',systems:['P/V','TOT','TRL']},
  {id:3,date:'2025-03-09',sport:'NHL',game:'Avs vs Knights',pick:'Avs ML',odds:-135,result:'L',systems:['P/V','EVM']},
]

function TrackerTab() {
  const [bets,setBets]=useState(SAMPLE_BETS)
  const [form,setForm]=useState({date:'',sport:'NBA',game:'',pick:'',odds:'',result:'P'})

  const settled=bets.filter(b=>b.result==='W'||b.result==='L')
  const wins=settled.filter(b=>b.result==='W').length
  const wr=settled.length?((wins/settled.length)*100).toFixed(1):0
  let profit=0; settled.forEach(b=>{profit+=b.result==='W'?(b.odds>0?b.odds/100:100/Math.abs(b.odds)):-1})
  const roi=settled.length?((profit/settled.length)*100).toFixed(1):0
  const iStyle={background:'rgba(255,255,255,0.05)',border:'1px solid rgba(255,255,255,0.12)',borderRadius:7,padding:'7px 10px',color:'#fff',fontFamily:'inherit',fontSize:12}

  return (
    <div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:10,marginBottom:16}}>
        {[{l:'WIN RATE',v:`${wr}%`,c:parseFloat(wr)>52?'#00ff88':'#ff6b6b'},{l:'ROI',v:`${parseFloat(roi)>0?'+':''}${roi}%`,c:parseFloat(roi)>0?'#00ff88':'#ff6b6b'},{l:'RECORD',v:`${wins}W–${settled.length-wins}L`,c:'#fff'},{l:'UNIT P/L',v:`${profit>=0?'+':''}${profit.toFixed(2)}u`,c:profit>=0?'#00ff88':'#ff6b6b'}].map(s=>(
          <div key={s.l} style={{background:'rgba(255,255,255,0.04)',borderRadius:12,padding:'13px 12px',textAlign:'center',border:'1px solid rgba(255,255,255,0.07)'}}>
            <div style={{fontSize:10,color:'#666',marginBottom:4,letterSpacing:1}}>{s.l}</div>
            <div style={{fontSize:22,fontWeight:800,color:s.c}}>{s.v}</div>
          </div>
        ))}
      </div>

      <div style={{background:'rgba(0,0,0,0.35)',border:'1px solid rgba(255,255,255,0.07)',borderRadius:13,padding:16,marginBottom:14}}>
        <div style={{fontSize:12,fontWeight:700,color:'#fff',marginBottom:12}}>+ LOG NEW BET</div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:10,marginBottom:10}}>
          {[['date','Date','date'],['game','Game','text'],['pick','Pick','text'],['odds','Odds','text']].map(([f,l,t])=>(
            <div key={f}>
              <div style={{fontSize:10,color:'#888',marginBottom:3}}>{l}</div>
              <input type={t} placeholder={l} value={form[f]} onChange={e=>setForm(ff=>({...ff,[f]:e.target.value}))} style={{...iStyle,width:'100%'}}/>
            </div>
          ))}
          <div>
            <div style={{fontSize:10,color:'#888',marginBottom:3}}>Sport</div>
            <select value={form.sport} onChange={e=>setForm(f=>({...f,sport:e.target.value}))} style={{...iStyle,width:'100%',background:'#0b0b18',color:'#aaa'}}>
              {Object.keys(SPORTS).map(s=><option key={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <div style={{fontSize:10,color:'#888',marginBottom:3}}>Result</div>
            <select value={form.result} onChange={e=>setForm(f=>({...f,result:e.target.value}))} style={{...iStyle,width:'100%',background:'#0b0b18',color:'#aaa'}}>
              <option value="P">Pending</option><option value="W">Win</option><option value="L">Loss</option>
            </select>
          </div>
        </div>
        <button onClick={()=>{if(!form.game||!form.odds)return;setBets([{...form,id:Date.now(),odds:parseFloat(form.odds),systems:[]},...bets]);setForm({date:'',sport:'NBA',game:'',pick:'',odds:'',result:'P'})}} style={{padding:'9px 22px',background:'linear-gradient(135deg,#00ff88,#00cfff)',border:'none',borderRadius:8,color:'#000',fontWeight:800,cursor:'pointer',fontFamily:'inherit',fontSize:12}}>SAVE BET</button>
      </div>

      {bets.map(bet=>{
        const {g:grade,c:color}=scoreGrade(bet.systems?.length||0)
        return (
          <div key={bet.id} style={{display:'grid',gridTemplateColumns:'55px 1fr 50px 60px 60px',gap:9,alignItems:'center',background:'rgba(255,255,255,0.025)',border:'1px solid rgba(255,255,255,0.05)',borderRadius:9,padding:'11px 13px',marginBottom:6}}>
            <div style={{fontSize:10,color:'#555'}}>{(bet.date||'').slice(5)}<br/>{bet.sport}</div>
            <div>
              <div style={{fontSize:13,fontWeight:600,color:'#e0e0e0'}}>{bet.game}</div>
              <div style={{fontSize:11,color:'#888'}}>{bet.pick}</div>
            </div>
            <div style={{textAlign:'center'}}><div style={{fontSize:9,color:'#555'}}>Grade</div><div style={{fontSize:17,fontWeight:800,color}}>{grade}</div></div>
            <div style={{textAlign:'center'}}><div style={{fontSize:9,color:'#555'}}>Odds</div><div style={{fontSize:14,fontWeight:600,color:bet.odds>0?'#00ff88':'#ccc'}}>{fmtOdds(bet.odds)}</div></div>
            <div style={{textAlign:'center'}}><div style={{padding:'4px 8px',borderRadius:6,fontWeight:700,fontSize:12,background:bet.result==='W'?'rgba(0,255,136,0.16)':bet.result==='L'?'rgba(255,107,107,0.14)':'rgba(255,255,255,0.06)',color:bet.result==='W'?'#00ff88':bet.result==='L'?'#ff6b6b':'#888',border:`1px solid ${bet.result==='W'?'rgba(0,255,136,0.35)':bet.result==='L'?'rgba(255,107,107,0.3)':'rgba(255,255,255,0.1)'}`}}>{bet.result==='P'?'PEND':bet.result}</div></div>
          </div>
        )
      })}
    </div>
  )
}

// ─── FOUNDATIONS TAB ─────────────────────────────────────────────────────────
function FoundationsTab() {
  return (
    <div>
      <div style={{fontSize:11,color:'#888',letterSpacing:2,marginBottom:16}}>GOAT SPORTS BETS — COMPLETE SYSTEM REFERENCE</div>
      <div style={{background:'rgba(0,0,0,0.4)',border:'1px solid rgba(0,255,136,0.2)',borderRadius:14,padding:20,marginBottom:20}}>
        <div style={{fontSize:13,fontWeight:800,color:'#00ff88',letterSpacing:3,marginBottom:13}}>PEMDAS — Pick Decision Order</div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:9}}>
          {[{s:'P',l:'Public or Vegas?',d:'Vegas wins 4.5/7 days. Determine slot FIRST.',c:'#00ff88'},{s:'E',l:'Trell Rule',d:'Star player out FIRST TIME = covers in Vegas slot.',c:'#00cfff'},{s:'M',l:'Line Movement',d:'Public: -6 to -7 good. Vegas: +5 to +6.5 good.',c:'#ffb300'},{s:'D',l:'Injuries',d:'Check all injury reports before every pick.',c:'#ff6b6b'},{s:'A',l:'H2H Matchup',d:'Head-to-head history between these teams.',c:'#c084fc'},{s:'S',l:'Team Histories',d:'Recent form, ATS records, situational spots.',c:'#fb923c'}].map(p=>(
            <div key={p.s} style={{background:`${p.c}08`,border:`1px solid ${p.c}20`,borderRadius:11,padding:13}}>
              <div style={{display:'flex',alignItems:'center',gap:9,marginBottom:8}}>
                <div style={{width:30,height:30,borderRadius:'50%',background:p.c,color:'#000',display:'flex',alignItems:'center',justifyContent:'center',fontWeight:900,fontSize:15}}>{p.s}</div>
                <div style={{fontSize:13,fontWeight:700,color:'#fff'}}>{p.l}</div>
              </div>
              <div style={{fontSize:11,color:'#999',lineHeight:1.6}}>{p.d}</div>
            </div>
          ))}
        </div>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:11}}>
        {[
          {t:'ALTERNATING SLOT',c:'#00ff88',r:['Each new game time flips Vegas↔Public','Same start time = both get same slot','PUBLIC day: 1st=Vegas,2nd=Public,3rd=Vegas...','VEGAS day: 1st=Public,2nd=Vegas,3rd=Public...']},
          {t:'TRELL RULE',c:'#00cfff',r:['Star player out FIRST TIME only','2nd/3rd absence = rule no longer applies','Team covers spread in their Vegas slot','Highest-confidence signal in the system']},
          {t:'PUBLIC SLOT',c:'#00ff88',r:['Sensible outcome happens','Evenly matched = take UNDERDOG spread','High scorers + total drops = OVER','-6 to -7 line movement = strong']},
          {t:'VEGAS SLOT',c:'#ffb300',r:['Look for scams/upsets','Evenly matched = take FAVORITE','Lean UNDER on totals','+5 to +6.5 line movement = strong']},
          {t:'NBA FLIP FLOP',c:'#60a5fa',r:['Team wins big as underdog','Books inflate line next game','FADE that team — they\'re the new scam','Counter: bet against or take their total']},
          {t:'RANK SCAM',c:'#34d399',r:['Ranked #1–#9 = prime scam candidates','After blowout win = fade candidate','Compare AP Poll to 4+ sportsbook lines','Line gap = your edge']},
          {t:'ODDS FLOOR',c:'#ff6b6b',r:['No picks heavier than -250 on teams','No props heavier than -250','Heavy juice = books protecting the line','Find alternate lines or totals instead']},
          {t:'SHORT SLATE / ANTI-SPAM',c:'#fb923c',r:['Short slate = underdog day','5 OVERs in a row? Check 1-2 UNDERs','4 underdog covers? Check 1-2 favorites','Vegas never makes it that simple']},
        ].map(s=>(
          <div key={s.t} style={{background:'rgba(0,0,0,0.3)',border:`1px solid ${s.c}22`,borderRadius:13,padding:15}}>
            <div style={{fontSize:12,fontWeight:800,color:s.c,letterSpacing:1,marginBottom:9}}>{s.t}</div>
            {s.r.map((r,i)=>(
              <div key={i} style={{display:'flex',gap:7,marginBottom:5,fontSize:11,color:'#999',lineHeight:1.5}}>
                <span style={{color:s.c,flexShrink:0}}>›</span>{r}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
const TABS=[{id:'picks',label:'🧠 Today\'s Picks'},{id:'props',label:'🎰 Player Props'},{id:'parlays',label:'🎯 Best Parlays'},{id:'builder',label:'✏️ Parlay Builder'},{id:'tracker',label:'📋 Bet Tracker'},{id:'foundations',label:'📚 Foundations'}]

export default function App() {
  const [tab,setTab]=useState('picks')
  const [games,setGames]=useState({})

  return (
    <>
      <Head>
        <title>EdgeFinder Pro — GOAT Sports Bets</title>
        <meta name="viewport" content="width=device-width,initial-scale=1"/>
        <style>{`
          *{box-sizing:border-box;margin:0;padding:0}
          body{background:#0b0b18;color:#e0e0e0;font-family:'Courier New',monospace;min-height:100vh}
          body::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse at 15% 15%,rgba(0,255,136,0.05) 0%,transparent 50%),radial-gradient(ellipse at 85% 80%,rgba(0,207,255,0.04) 0%,transparent 50%);pointer-events:none;z-index:0}
          ::-webkit-scrollbar{width:4px;height:4px}
          ::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.1);border-radius:2px}
          @keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
          input[type=range]{accent-color:#00ff88;width:100%}
          select option{background:#0b0b18}
          @media(max-width:680px){
            .pm-grid{grid-template-columns:1fr!important}
            .rules-grid{grid-template-columns:1fr!important}
          }
        `}</style>
      </Head>

      <div style={{maxWidth:1120,margin:'0 auto',padding:'24px 16px',position:'relative',zIndex:1}}>
        {/* Header */}
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-end',marginBottom:20,flexWrap:'wrap',gap:12}}>
          <div>
            <div style={{fontSize:9,letterSpacing:5,color:'#00ff88',marginBottom:4}}>GOAT SPORTS BETS INTELLIGENCE SYSTEM</div>
            <div style={{fontSize:28,fontWeight:900,letterSpacing:-1.5}}>
              <span style={{color:'#fff'}}>EDGE</span><span style={{color:'#00ff88'}}>FINDER</span><span style={{color:'rgba(255,255,255,0.1)'}}> PRO</span>
            </div>
            <div style={{fontSize:10,color:'#1e1e30',marginTop:4}}>Live Bovada Lines · PEMDAS · Trell Rule · Alternating Slots · Rank Scam · Flip Flop</div>
          </div>
          <div style={{display:'flex',gap:16,alignItems:'center',flexWrap:'wrap'}}>
            {[['TODAY',TODAY_NAME,'#00cfff'],['FLOOR','-250','#ff6b6b'],['TARGET','+1K/+4K','#00ff88'],['SPORTS','NBA·MLB·NHL·WBC','#ffb300']].map(([l,v,c])=>(
              <div key={l} style={{textAlign:'center'}}>
                <div style={{fontSize:9,letterSpacing:1,color:'#333',marginBottom:1}}>{l}</div>
                <div style={{fontSize:13,fontWeight:800,color:c}}>{v}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Tabs */}
        <div style={{display:'flex',gap:4,marginBottom:18,flexWrap:'wrap'}}>
          {TABS.map(t=>(
            <button key={t.id} onClick={()=>setTab(t.id)} style={{padding:'9px 15px',borderRadius:8,border:'none',cursor:'pointer',fontSize:12,fontFamily:'inherit',fontWeight:600,background:tab===t.id?'#00ff88':'rgba(255,255,255,0.04)',color:tab===t.id?'#000':'#666',transition:'background .15s,color .15s'}}>
              {t.label}
            </button>
          ))}
        </div>

        {/* Panel */}
        <div style={{background:'rgba(255,255,255,0.012)',border:'1px solid rgba(255,255,255,0.07)',borderRadius:18,padding:22,minHeight:400}}>
          {tab==='picks'&&<PicksTab onGamesLoaded={setGames}/>}
          {tab==='props'&&<PropsTab games={games}/>}
          {tab==='parlays'&&<ParlaysTab games={games}/>}
          {tab==='builder'&&<BuilderTab/>}
          {tab==='tracker'&&<TrackerTab/>}
          {tab==='foundations'&&<FoundationsTab/>}
        </div>

        <div style={{marginTop:14,textAlign:'center',fontSize:10,color:'#181828'}}>
          EDGEFINDER PRO · GOAT Sports Bets System · Live Bovada Lines · For analysis only · Bet responsibly
        </div>
      </div>
    </>
  )
}
