import assert from "node:assert/strict";
import test from "node:test";
import { clearCaptchas, createCaptcha, verifyCaptcha } from "../src/services/captcha";

function answerFromImage(image: string) {
  const base64 = image.replace("data:image/svg+xml;base64,", "");
  const svg = Buffer.from(base64, "base64").toString("utf8");
  const match = svg.match(/>(\d+)\s([+×-])\s(\d+)\s=\s\?</);
  assert.ok(match, "captcha svg should include an arithmetic question");
  const left = Number(match[1]);
  const op = match[2];
  const right = Number(match[3]);
  if (op === "+") return String(left + right);
  if (op === "-") return String(left - right);
  return String(left * right);
}

test("captcha verifies the correct answer once", () => {
  clearCaptchas();
  const created = createCaptcha();
  assert.ok(created.captcha_id);
  assert.ok(created.image.startsWith("data:image/svg+xml;base64,"));
  assert.equal(created.expires_in, 300);

  const answer = answerFromImage(created.image);
  const ok = verifyCaptcha(created.captcha_id, answer);
  assert.equal(ok.ok, true);

  const reused = verifyCaptcha(created.captcha_id, answer);
  assert.equal(reused.ok, false);
  assert.equal(reused.code, "captcha_expired");
});

test("captcha rejects wrong or missing answers", () => {
  clearCaptchas();
  const created = createCaptcha();
  assert.equal(verifyCaptcha("", "1").code, "captcha_required");
  assert.equal(verifyCaptcha(created.captcha_id, "").code, "captcha_required");
  assert.equal(verifyCaptcha(created.captcha_id, "99999").code, "captcha_invalid");
  assert.equal(verifyCaptcha("missing-id", "1").code, "captcha_expired");
});
