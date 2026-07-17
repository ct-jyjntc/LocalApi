const http = require('http');
const crypto = require('crypto');
const ID = process.env.LINUXDO_CLIENT_ID;
const SECRET = process.env.LINUXDO_CLIENT_SECRET;
const RELAY_SECRET = process.env.LINUXDO_RELAY_SECRET;
const port = Number(process.env.PORT || 17890);
function json(res, code, body) { res.writeHead(code, {'content-type':'application/json'}); res.end(JSON.stringify(body)); }
const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/exchange' || !RELAY_SECRET || req.headers['x-relay-secret'] !== RELAY_SECRET) return json(res, 404, {error:'not found'});
  let raw=''; req.on('data', c => { raw += c; if (raw.length > 10000) req.destroy(); });
  req.on('end', async () => { try {
    const {code, redirect_uri} = JSON.parse(raw);
    const tokenRes = await fetch('https://connect.linux.do/oauth2/token', {method:'POST', headers:{'content-type':'application/x-www-form-urlencoded', accept:'application/json'}, body:new URLSearchParams({grant_type:'authorization_code', code, redirect_uri, client_id:ID, client_secret:SECRET})});
    if (!tokenRes.ok) return json(res, 502, {error:`token ${tokenRes.status}`});
    const token = await tokenRes.json();
    const profileRes = await fetch('https://connect.linux.do/api/user', {headers:{authorization:`Bearer ${token.access_token}`, accept:'application/json'}});
    if (!profileRes.ok) return json(res, 502, {error:`profile ${profileRes.status}`});
    return json(res, 200, await profileRes.json());
  } catch (e) { return json(res, 502, {error:e.message || 'relay failed'}); } });
});
server.listen(port, '0.0.0.0');
