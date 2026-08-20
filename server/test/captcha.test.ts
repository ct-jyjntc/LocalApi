import assert from "node:assert/strict";
import test from "node:test";
import { clearCaptchas, createCaptcha, peekCaptchaAnswerForTests, verifyCaptcha } from "../src/services/captcha";

function decodeSvg(image: string) {
  const base64 = image.replace("data:image/svg+xml;base64,", "");
  return Buffer.from(base64, "base64").toString("utf8");
}

test("captcha verifies the correct answer once", () => {
  clearCaptchas();
  const created = createCaptcha();
  assert.ok(created.captcha_id);
  assert.ok(created.image.startsWith("data:image/svg+xml;base64,"));
  assert.equal(created.expires_in, 300);

  const answer = peekCaptchaAnswerForTests(created.captcha_id);
  assert.ok(answer);
  const ok = verifyCaptcha(created.captcha_id, answer!);
  assert.equal(ok.ok, true);

  const reused = verifyCaptcha(created.captcha_id, answer!);
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

test("captcha svg does not expose the question as plain text", () => {
  // Regression guard: the pre-obfuscation SVG carried "3 × 4 = ?" as a single
  // <text> node, so a bot could solve it with one regex and no OCR.
  clearCaptchas();
  for (let i = 0; i < 20; i++) {
    const created = createCaptcha();
    const svg = decodeSvg(created.image);
    assert.ok(
      !/>(\d+)\s([+×-])\s(\d+)\s=\s\?</.test(svg),
      `question must not appear as a contiguous string: ${svg}`,
    );
    // The answer stays server-side only.
    const answer = peekCaptchaAnswerForTests(created.captcha_id);
    assert.ok(answer && answer.length > 0);
  }
});
