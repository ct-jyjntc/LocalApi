const http = require('http');
const crypto = require('crypto');
const ID = process.env.LINUXDO_CLIENT_ID;
const SECRET = process.env.LINUXDO_CLIENT_SECRET;
const RELAY_SECRET = process.env.LINUXDO_RELAY_SECRET;
const port = Number(process.env.PORT || 17890);
const CREDIT_PID = process.env.LINUXDO_CREDIT_PID;
const CREDIT_KEY = process.env.LINUXDO_CREDIT_KEY;
const CREDIT_GATEWAY = (process.env.LINUXDO_CREDIT_GATEWAY || 'https://credit.linux.do/epay').replace(/\/$/, '');
function json(res, code, body) { res.writeHead(code, {'content-type':'application/json'}); res.end(JSON.stringify(body)); }
const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || !RELAY_SECRET || req.headers['x-relay-secret'] !== RELAY_SECRET) return json(res, 404, {error:'not found'});
  let raw=''; req.on('data', c => { raw += c; if (raw.length > 10000) req.destroy(); });
  req.on('end', async () => { try {
    const input = JSON.parse(raw);
    if (req.url === '/credit/query') {
      const url = new URL(`${CREDIT_GATEWAY}/api.php`); url.search = new URLSearchParams({act:'order', pid:CREDIT_PID, key:CREDIT_KEY, out_trade_no:input.order_no}).toString();
      const response = await fetch(url); return json(res, 200, await response.json());
    }
    if (req.url === '/credit/refund') {
      const response = await fetch(`${CREDIT_GATEWAY}/api.php`, {method:'POST', headers:{'content-type':'application/x-www-form-urlencoded'}, body:new URLSearchParams({pid:CREDIT_PID,key:CREDIT_KEY,trade_no:input.trade_no,out_trade_no:input.order_no,money:input.money})});
      return json(res, 200, await response.json());
    }
    if (req.url !== '/exchange') return json(res, 404, {error:'not found'});
    const {code, redirect_uri} = input;
    const tokenRes = await fetch('https://connect.linux.do/oauth2/token', {method:'POST', headers:{'content-type':'application/x-www-form-urlencoded', accept:'application/json'}, body:new URLSearchParams({grant_type:'authorization_code', code, redirect_uri, client_id:ID, client_secret:SECRET})});
    if (!tokenRes.ok) return json(res, 502, {error:`token ${tokenRes.status}`});
    const token = await tokenRes.json();
    const profileRes = await fetch('https://connect.linux.do/api/user', {headers:{authorization:`Bearer ${token.access_token}`, accept:'application/json'}});
    if (!profileRes.ok) return json(res, 502, {error:`profile ${profileRes.status}`});
    return json(res, 200, await profileRes.json());
  } catch (e) { return json(res, 502, {error:e.message || 'relay failed'}); } });
});
server.listen(port, '0.0.0.0');
