import test from "node:test";
import assert from "node:assert/strict";
import {
  shouldAcceptFocusSettle,
  type ActiveElementMeta,
} from "../src/shared/click-type-settle.js";

const user: ActiveElementMeta = {
  editable: true,
  key: "input#user_login[log]",
  tag: "input",
};
const pass: ActiveElementMeta = {
  editable: true,
  key: "input#user_pass[pwd]",
  tag: "input",
};
const body: ActiveElementMeta = {
  editable: false,
  key: "body",
  tag: "body",
};

test("settle accepts focus move from username to password (order 01→02)", () => {
  assert.equal(shouldAcceptFocusSettle(user, pass, 16), true);
  assert.equal(shouldAcceptFocusSettle(user, user, 16), false);
  assert.equal(shouldAcceptFocusSettle(user, user, 80), true);
});

test("settle accepts first focus from body to username", () => {
  assert.equal(shouldAcceptFocusSettle(body, user, 0), true);
});

test("settle rejects non-editable after click", () => {
  assert.equal(shouldAcceptFocusSettle(user, body, 200), false);
});

test("settle accepts password→username reverse order", () => {
  assert.equal(shouldAcceptFocusSettle(pass, user, 20), true);
});
