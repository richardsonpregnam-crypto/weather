import http from 'node:http';
import { URL } from 'node:url';

const PORT = process.env.PORT || 5000;
const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function send(res, status, data) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(data));
}

async function fetchJSON(url, options = {}) {
  const r = await fetch(url, { ...options, headers: { 'User-Agent': 'WeatherIQ-Hackathon/2.0' } });
  if (!r.ok) throw new Error(`Upstream service returned ${r.status}`);
  return r.json();
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

function forecastUrl(lat, lon) {
  const p = new URLSearchParams({
    latitude: lat, longitude: lon, timezone: 'auto', forecast_days: '7',
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,rain,weather_code,cloud_cover,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m',
    hourly: 'temperature_2m,relative_humidity_2m,precipitation_probability,precipitation,wind_speed_10m,wind_gusts_10m,weather_code,visibility,pressure_msl,cloud_cover',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,sunrise,sunset,uv_index_max'
  });
  return `https://api.open-meteo.com/v1/forecast?${p}`;
}

async function getWeather(lat, lon) { return fetchJSON(forecastUrl(lat, lon)); }

function riskAlerts(w) {
  const a = [];
  const max = Math.max(...(w.daily?.temperature_2m_max || [0]));
  const gust = Math.max(...(w.daily?.wind_gusts_10m_max || [0]));
  const rain = Math.max(...(w.daily?.precipitation_sum || [0]));
  const uv = Math.max(...(w.daily?.uv_index_max || [0]));
  if (max >= 40) a.push({ level: 'danger', title: 'Extreme heat risk', message: `Forecast maximum reaches ${Math.round(max)}°C.` });
  else if (max >= 35) a.push({ level: 'warning', title: 'High heat advisory', message: `Forecast maximum reaches ${Math.round(max)}°C.` });
  if (gust >= 70) a.push({ level: 'danger', title: 'Strong wind risk', message: `Forecast gusts may reach ${Math.round(gust)} km/h.` });
  else if (gust >= 50) a.push({ level: 'warning', title: 'Strong wind advisory', message: `Forecast gusts may reach ${Math.round(gust)} km/h.` });
  if (rain >= 80) a.push({ level: 'danger', title: 'Heavy rainfall risk', message: `Daily precipitation may reach ${Math.round(rain)} mm.` });
  else if (rain >= 40) a.push({ level: 'warning', title: 'Heavy rainfall advisory', message: `Daily precipitation may reach ${Math.round(rain)} mm.` });
  if (uv >= 8) a.push({ level: 'warning', title: 'High UV index', message: `Maximum UV index is forecast near ${Math.round(uv)}.` });
  return a.length ? a : [{ level: 'safe', title: 'No threshold-based severe risk detected', message: 'Continue checking official local warnings for emergency decisions.' }];
}

async function historical(lat, lon) {
  const end = new Date(Date.now() - 86400000).toISOString().slice(0,10);
  const start = new Date(Date.now() - 30 * 86400000).toISOString().slice(0,10);
  const p = new URLSearchParams({ latitude: lat, longitude: lon, start_date: start, end_date: end, timezone: 'auto',
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,weather_code' });
  return fetchJSON(`https://archive-api.open-meteo.com/v1/archive?${p}`);
}

async function officialImdFeed() {
  try {
    const r = await fetch('https://mausam.imd.gov.in/imd_latest/contents/dist_nowcast_rss.php', { headers: { 'User-Agent': 'WeatherIQ-Hackathon/2.0' } });
    if (!r.ok) throw new Error(String(r.status));
    const text = await r.text();
    const items = [...text.matchAll(/<item>([\s\S]*?)<\/item>/gi)].slice(0, 12).map(m => {
      const block = m[1];
      const get = tag => (block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1] || '').replace(/<!\[CDATA\[|\]\]>/g,'').trim();
      return { title: get('title') || 'IMD Nowcast', description: get('description'), link: get('link'), source: 'India Meteorological Department' };
    });
    return { available: true, source: 'India Meteorological Department', items };
  } catch (e) {
    return { available: false, source: 'India Meteorological Department', items: [], error: e.message };
  }
}

async function mapPoints(lat, lon) {
  const offsets = [[0,0],[0.7,0.6],[-0.7,0.8],[0.5,-0.9],[-0.8,-0.6],[1.0,-0.2],[-1.0,0.2]];
  return Promise.all(offsets.map(async ([a,b]) => {
    const d = await getWeather(lat + a, lon + b);
    return { lat: lat+a, lon: lon+b, temp: d.current.temperature_2m, wind: d.current.wind_speed_10m, rain: d.current.precipitation, humidity: d.current.relative_humidity_2m, code: d.current.weather_code };
  }));
}



function stripHtml(s='') { return s.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim(); }
function extractMeta(html) {
  const get = (re) => (html.match(re)?.[1] || '').trim();
  return {
    title: get(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i) || get(/<title[^>]*>([\s\S]*?)<\/title>/i),
    description: get(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i) || get(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i),
    image: get(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']*)["']/i),
    published: get(/<meta[^>]+(?:property|name)=["'](?:article:published_time|date|publish_date)["'][^>]+content=["']([^"']*)["']/i)
  };
}
function extractCoords(text='') {
  const patterns = [
    /(?:lat(?:itude)?)[^\d-]{0,15}(-?\d{1,2}(?:\.\d+)?)[^\d-]{0,20}(?:lon(?:gitude)?|lng)[^\d-]{0,15}(-?\d{1,3}(?:\.\d+)?)/i,
    /(-?\d{1,2}\.\d+)\s*[,;]\s*(-?\d{1,3}\.\d+)/
  ];
  for (const re of patterns) { const m=text.match(re); if(m){const lat=Number(m[1]),lon=Number(m[2]); if(Math.abs(lat)<=90&&Math.abs(lon)<=180)return {latitude:lat,longitude:lon};} }
  return null;
}
function eventRisk(text='') {
  const t=text.toLowerCase();
  const tags=[];
  if(/flood|flooding|waterlogging|inundat/.test(t)) tags.push('flood');
  if(/cyclone|hurricane|typhoon/.test(t)) tags.push('cyclone');
  if(/storm|thunderstorm|lightning/.test(t)) tags.push('storm');
  if(/heavy rain|torrential|cloudburst|rainfall/.test(t)) tags.push('heavy-rain');
  if(/heatwave|heat wave|extreme heat/.test(t)) tags.push('heat');
  if(/landslide|mudslide/.test(t)) tags.push('landslide');
  if(/wildfire|forest fire/.test(t)) tags.push('wildfire');
  return [...new Set(tags)];
}
function corroborate(tags, weather, officialItems=[]) {
  const c=weather.current||{}, d=weather.daily||{};
  const maxRain=Math.max(...(d.precipitation_sum||[0]));
  const maxWind=Math.max(...(d.wind_gusts_10m_max||[0]));
  const maxTemp=Math.max(...(d.temperature_2m_max||[0]));
  const evidence=[];
  let points=0;
  if(tags.includes('heavy-rain')||tags.includes('flood')) { if(maxRain>=40){points+=2;evidence.push(`Forecast rainfall reaches about ${Math.round(maxRain)} mm/day.`)} else evidence.push(`Forecast rainfall peaks near ${Math.round(maxRain)} mm/day.`); }
  if(tags.includes('storm')||tags.includes('cyclone')) { if(maxWind>=50){points+=2;evidence.push(`Forecast gusts reach about ${Math.round(maxWind)} km/h.`)} else evidence.push(`Forecast gusts peak near ${Math.round(maxWind)} km/h.`); }
  if(tags.includes('heat')) { if(maxTemp>=35){points+=2;evidence.push(`Forecast maximum temperature reaches about ${Math.round(maxTemp)}°C.`)} else evidence.push(`Forecast maximum temperature is about ${Math.round(maxTemp)}°C.`); }
  const officialText=officialItems.map(x=>`${x.title||''} ${x.description||''}`).join(' ').toLowerCase();
  if(tags.some(t=>officialText.includes(t.replace('-',' '))) || (tags.includes('storm')&&/thunderstorm|cyclone|storm/.test(officialText))) { points+=3; evidence.push('A matching term appears in the official IMD feed.'); }
  let verdict='insufficient';
  if(points>=3) verdict='corroborated'; else if(points===0 && tags.length) verdict='not-corroborated';
  return {verdict,score:Math.min(100,Math.round(points/5*100)),evidence};
}
async function historicalAt(lat, lon, date) { const p=new URLSearchParams({latitude:lat,longitude:lon,start_date:date,end_date:date,timezone:'auto',daily:'temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,weather_code'}); return fetchJSON(`https://archive-api.open-meteo.com/v1/archive?${p}`); }

async function verifyPost(body) {
  const postUrl=String(body?.url||'').trim();
  const suppliedText=String(body?.text||'').trim();
  const suppliedLocation=String(body?.location||'').trim();
  if(!postUrl) throw new Error('A public post URL is required.');
  let html='';
  try { const r=await fetch(postUrl,{redirect:'follow',headers:{'User-Agent':'Mozilla/5.0 WeatherIQ-Verifier/1.0'}}); if(r.ok) html=await r.text(); } catch(e) {}
  const meta=extractMeta(html);
  const visible=stripHtml(html).slice(0,30000);
  const text=[meta.title,meta.description,suppliedText,suppliedLocation,visible].filter(Boolean).join(' ');
  const tags=eventRisk(text);
  let coords=body?.imageGps?.latitude&&body?.imageGps?.longitude ? {latitude:Number(body.imageGps.latitude),longitude:Number(body.imageGps.longitude)} : extractCoords(text);
  let locationName=suppliedLocation || '';
  if(!coords && suppliedLocation){ const g=await fetchJSON(`https://geocoding-api.open-meteo.com/v1/search?${new URLSearchParams({name:suppliedLocation,count:'1',language:'en',format:'json'})}`); if(g.results?.[0]){coords={latitude:g.results[0].latitude,longitude:g.results[0].longitude};locationName=g.results[0].name;} }
  if(!coords) { const locMatch=text.match(/(?:at|in|near|location)\s+([A-Z][A-Za-z .'-]{2,50})/); if(locMatch){ try{const g=await fetchJSON(`https://geocoding-api.open-meteo.com/v1/search?${new URLSearchParams({name:locMatch[1].trim(),count:'1',language:'en',format:'json'})}`); if(g.results?.[0]){coords={latitude:g.results[0].latitude,longitude:g.results[0].longitude};locationName=g.results[0].name;}}catch(e){} } }
  if(!coords) return {verdict:'location-unresolved',score:0,post:{url:postUrl,title:meta.title,description:meta.description,image:meta.image,published:meta.published},tags,location:null,evidence:['No reliable coordinates or location could be extracted from the public post.','Add the location manually or upload an image containing GPS EXIF metadata.'],limitations:['Many social platforms block automated page access; a URL alone cannot guarantee access to the original post data.']};
  let weather=await getWeather(coords.latitude,coords.longitude);
  let eventWeather=null;
  if(body?.eventTime){ const date=new Date(body.eventTime).toISOString().slice(0,10); try{eventWeather=await historicalAt(coords.latitude,coords.longitude,date);}catch(e){} }
  const official=await officialImdFeed();
  const result=corroborate(tags,eventWeather||weather,official.items);
  if(eventWeather?.daily){ const rain=Number(eventWeather.daily.precipitation_sum?.[0]||0), wind=Number(eventWeather.daily.wind_speed_10m_max?.[0]||0), temp=Number(eventWeather.daily.temperature_2m_max?.[0]||0); result.evidence.unshift(`Historical weather for ${eventWeather.daily.time?.[0]||'the selected date'}: ${rain} mm rain, ${Math.round(wind)} km/h max wind, ${Math.round(temp)}°C max.`); } 
  return { ...result, tags, post:{url:postUrl,title:meta.title,description:meta.description,image:meta.image,published:meta.published}, location:{name:locationName||'Resolved coordinates',latitude:coords.latitude,longitude:coords.longitude}, weather:{current:weather.current,daily:{time:weather.daily.time?.slice(0,7),precipitation_sum:weather.daily.precipitation_sum?.slice(0,7),wind_gusts_10m_max:weather.daily.wind_gusts_10m_max?.slice(0,7),temperature_2m_max:weather.daily.temperature_2m_max?.slice(0,7)}}, official:{available:official.available,items:official.items?.slice(0,8)}, limitations:['This is evidence-based corroboration, not proof of authenticity. A matching weather signal does not prove the photo/video was taken at the claimed place or time.','Official warnings should be treated as the authority for emergency decisions.'] };
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'OPTIONS') { res.writeHead(204, JSON_HEADERS); return res.end(); }
    if (u.pathname === '/api/health') return send(res, 200, { ok: true, service: 'WeatherIQ API', time: new Date().toISOString(), sources: ['Open-Meteo', 'IMD RSS'] });
    if (u.pathname === '/api/geocode') {
      const q = u.searchParams.get('q'); if (!q) return send(res,400,{error:'Missing q'});
      const p = new URLSearchParams({ name:q, count:'8', language:'en', format:'json' });
      return send(res,200,await fetchJSON(`https://geocoding-api.open-meteo.com/v1/search?${p}`));
    }
    if (u.pathname === '/api/verify-post' && req.method === 'POST') {
      let raw=''; for await (const chunk of req) raw += chunk;
      const body=JSON.parse(raw||'{}');
      return send(res,200,await verifyPost(body));
    }
    const lat = num(u.searchParams.get('lat')), lon = num(u.searchParams.get('lon'));
    if (u.pathname !== '/api/health' && (!Number.isFinite(lat) || !Number.isFinite(lon))) return send(res,400,{error:'Valid lat and lon are required'});
    if (u.pathname === '/api/weather') return send(res,200,await getWeather(lat,lon));
    if (u.pathname === '/api/alerts') { const w = await getWeather(lat,lon); const imd = await officialImdFeed(); return send(res,200,{ alerts:riskAlerts(w), official:imd }); }
    if (u.pathname === '/api/historical') return send(res,200,await historical(lat,lon));
    if (u.pathname === '/api/map-points') return send(res,200,{points:await mapPoints(lat,lon)});
    if (u.pathname === '/api/official-alerts') return send(res,200,await officialImdFeed());
    if (u.pathname === '/api/reverse-geocode') {
      const p = new URLSearchParams({ latitude: lat, longitude: lon, language: 'en', format: 'json' });
      return send(res,200,await fetchJSON(`https://geocoding-api.open-meteo.com/v1/reverse?${p}`));
    }
    return send(res,404,{error:'Not found'});
  } catch (e) {
    console.error(e);
    send(res,502,{error:'Weather service unavailable',detail:e.message});
  }
});
server.listen(PORT,()=>console.log(`WeatherIQ API running on http://localhost:${PORT}`));
