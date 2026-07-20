import crypto from "crypto";

type CaptchaEntry = {
  answer: string;
  expiresAt: number;
};

const CAPTCHA_TTL_MS = 5 * 60_000;
const captchas = new Map<string, CaptchaEntry>();

function randomInt(min: number, max: number) {
  return crypto.randomInt(min, max + 1);
}

function cleanupExpired(now = Date.now()) {
  for (const [id, entry] of captchas) {
    if (entry.expiresAt <= now) captchas.delete(id);
  }
}

function buildChallenge(): { question: string; answer: string } {
  const ops = ["+", "-", "×"] as const;
  const op = ops[randomInt(0, ops.length - 1)];
  let a = randomInt(1, 12);
  let b = randomInt(1, 12);
  let answer = 0;

  if (op === "+") {
    answer = a + b;
  } else if (op === "-") {
    if (b > a) [a, b] = [b, a];
    answer = a - b;
  } else {
    a = randomInt(2, 9);
    b = randomInt(2, 9);
    answer = a * b;
  }

  return { question: `${a} ${op} ${b} = ?`, answer: String(answer) };
}

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function renderSvg(question: string) {
  const width = 180;
  const height = 56;
  const noiseLines = Array.from({ length: 5 }, () => {
    const x1 = randomInt(0, width);
    const y1 = randomInt(0, height);
    const x2 = randomInt(0, width);
    const y2 = randomInt(0, height);
    const opacity = (randomInt(18, 35) / 100).toFixed(2);
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#94a3b8" stroke-width="1" opacity="${opacity}" />`;
  }).join("");
  const dots = Array.from({ length: 18 }, () => {
    const cx = randomInt(4, width - 4);
    const cy = randomInt(4, height - 4);
    const r = randomInt(1, 2);
    const opacity = (randomInt(15, 40) / 100).toFixed(2);
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#64748b" opacity="${opacity}" />`;
  }).join("");
  const rotate = randomInt(-6, 6);
  const textX = randomInt(18, 28);
  const textY = randomInt(34, 40);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#f8fafc"/>
      <stop offset="100%" stop-color="#e2e8f0"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" rx="10" fill="url(#bg)"/>
  <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="9" fill="none" stroke="#cbd5e1"/>
  ${noiseLines}
  ${dots}
  <text x="${textX}" y="${textY}" font-family="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" font-size="22" font-weight="700" fill="#0f172a" letter-spacing="1" transform="rotate(${rotate} ${width / 2} ${height / 2})">${escapeXml(question)}</text>
</svg>`;
}

export function createCaptcha() {
  cleanupExpired();
  const { question, answer } = buildChallenge();
  const id = crypto.randomBytes(16).toString("hex");
  captchas.set(id, {
    answer,
    expiresAt: Date.now() + CAPTCHA_TTL_MS,
  });
  const svg = renderSvg(question);
  const image = `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
  return {
    captcha_id: id,
    image,
    expires_in: Math.floor(CAPTCHA_TTL_MS / 1000),
  };
}

export function verifyCaptcha(id: string | undefined, answer: string | undefined) {
  cleanupExpired();
  const captchaId = (id || "").trim();
  const provided = (answer || "").trim();
  if (!captchaId || !provided) {
    return { ok: false as const, code: "captcha_required" as const };
  }

  const entry = captchas.get(captchaId);
  captchas.delete(captchaId);
  if (!entry || entry.expiresAt <= Date.now()) {
    return { ok: false as const, code: "captcha_expired" as const };
  }

  const normalized = provided.replace(/\s+/g, "");
  if (normalized !== entry.answer) {
    return { ok: false as const, code: "captcha_invalid" as const };
  }

  return { ok: true as const };
}

export function clearCaptchas() {
  captchas.clear();
}

const cleanupTimer = setInterval(() => cleanupExpired(), 60_000);
cleanupTimer.unref?.();
