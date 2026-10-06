import assert from "node:assert/strict";
import test from "node:test";
import {
  accountClientFrom,
  accountClientMetadata,
  localeFromAcceptLanguage,
  loginCallbackOrigin,
  loginSource,
  signInFailed,
} from "./account.js";

test("account client metadata prefers the running harness version", () => {
  assert.deepEqual(
    accountClientMetadata(
      { locale: "en", timezoneOffsetSeconds: -28_800 },
      { DSH_CLIENT_VERSION: "0.2.0-rc.2" },
    ),
    { version: "0.2.0-rc.2", locale: "en", timezoneOffsetSeconds: -28_800 },
  );
});

test("account client metadata falls back when the process has no client version", () => {
  assert.equal(accountClientMetadata({}, {}).version, "0.2.0-rc.2");
  assert.equal(accountClientMetadata({}, {}).locale, "zh-CN");
});

test("accept-language supplies the account locale", () => {
  assert.equal(localeFromAcceptLanguage("en-US,en;q=0.8"), "en-US");
  assert.deepEqual(
    accountClientFrom({ headers: { "accept-language": "zh-CN,zh;q=0.9" } }, { DSH_CLIENT_VERSION: "0.2.0-rc.2" }),
    { version: "0.2.0-rc.2", locale: "zh-CN", timezoneOffsetSeconds: accountClientMetadata().timezoneOffsetSeconds },
  );
});

test("login callback origin is a loopback http URL with an explicit port", () => {
  assert.equal(loginCallbackOrigin("127.0.0.1:19387"), "http://127.0.0.1:19387");
  assert.equal(loginCallbackOrigin("localhost:3081"), "http://localhost:3081");
  assert.equal(loginCallbackOrigin("[::1]:19387"), "http://[::1]:19387");
  assert.equal(loginCallbackOrigin(""), "http://127.0.0.1:19387");
  assert.equal(loginSource("http://127.0.0.1:19387"), "desktop");
  assert.equal(loginSource("http://127.0.0.1:3081"), "web");
  assert.throws(() => loginCallbackOrigin("example.com:19387"), /本机 http 端口/);
  assert.throws(() => loginCallbackOrigin("127.0.0.1"), /本机 http 端口/);
});

test("cancelled, failed, and expired sign-in attempts stop the wait", () => {
  assert.equal(signInFailed("failed"), true);
  assert.equal(signInFailed("expired"), true);
  assert.equal(signInFailed("cancelled"), true);
  assert.equal(signInFailed("waiting-browser"), false);
  assert.equal(signInFailed("succeeded"), false);
});
