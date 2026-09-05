async function get(path) {
  const r = await fetch(path);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Request failed');
  return data;
}
export const geocode = q => get(`/api/geocode?q=${encodeURIComponent(q)}`);
export const getWeather = (lat,lon) => get(`/api/weather?lat=${lat}&lon=${lon}`);
export const getAlerts = (lat,lon) => get(`/api/alerts?lat=${lat}&lon=${lon}`);
export const getHistorical = (lat,lon) => get(`/api/historical?lat=${lat}&lon=${lon}`);
export const getMapPoints = (lat,lon) => get(`/api/map-points?lat=${lat}&lon=${lon}`);
export const getHealth = () => get('/api/health');
export const verifyPost = async body => { const r=await fetch('/api/verify-post',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); const data=await r.json().catch(()=>({})); if(!r.ok) throw new Error(data.error||'Verification failed'); return data; };
