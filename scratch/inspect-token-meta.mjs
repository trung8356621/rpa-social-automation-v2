import fs from "node:fs";
const p = ".local/qa-profile-facebook-sandbox/seo-ops-rpa-admin.token";
const b = fs.readFileSync(p);
const asUtf8 = b.toString("utf8");
const printable = [...asUtf8].filter((ch) => ch.charCodeAt(0) <= 255).length;
console.log(JSON.stringify({
  bytes: b.length,
  hexHead: b.subarray(0, 24).toString("hex"),
  utf8Len: asUtf8.length,
  charsOver255: [...asUtf8].filter((ch) => ch.charCodeAt(0) > 255).length,
  printableRatio: printable / Math.max(asUtf8.length, 1),
  looksLikeJwt: /^eyJ/.test(asUtf8.trim()),
  looksLikeHex: /^[0-9a-f]+$/i.test(asUtf8.trim()),
}));
