const test = require("node:test");
const assert = require("node:assert/strict");

const {
  evaluatePushEligibility,
  hasActiveChatViewer,
} = require("./pushRouting");

test("hasActiveChatViewer returns true only for active state in the same chat", () => {
  assert.equal(
    hasActiveChatViewer(
      [
        { appState: "background", activeChatId: "chat-1" },
        { appState: "active", activeChatId: "chat-2" },
      ],
      "chat-2",
    ),
    true,
  );

  assert.equal(
    hasActiveChatViewer(
      [
        { appState: "background", activeChatId: "chat-2" },
        { appState: "active", activeChatId: "chat-3" },
      ],
      "chat-2",
    ),
    false,
  );
});

test("evaluatePushEligibility blocks push when token is invalid", () => {
  const result = evaluatePushEligibility({
    expoPushToken: "",
    presenceStates: [{ appState: "active", activeChatId: "chat-1" }],
    chatId: "chat-1",
  });

  assert.deepEqual(result, {
    send: false,
    reason: "missing_or_invalid_token",
  });
});

test("evaluatePushEligibility blocks push when user is active in the same chat", () => {
  const result = evaluatePushEligibility({
    expoPushToken: "ExponentPushToken[test]",
    presenceStates: [{ appState: "active", activeChatId: "chat-1" }],
    chatId: "chat-1",
  });

  assert.deepEqual(result, {
    send: false,
    reason: "recipient_active_in_chat",
  });
});

test("evaluatePushEligibility allows push when user is active in another chat", () => {
  const result = evaluatePushEligibility({
    expoPushToken: "ExponentPushToken[test]",
    presenceStates: [{ appState: "active", activeChatId: "chat-2" }],
    chatId: "chat-1",
  });

  assert.deepEqual(result, {
    send: true,
    reason: "eligible",
  });
});

test("evaluatePushEligibility allows push when app is backgrounded", () => {
  const result = evaluatePushEligibility({
    expoPushToken: "ExponentPushToken[test]",
    presenceStates: [{ appState: "background", activeChatId: "chat-1" }],
    chatId: "chat-1",
  });

  assert.deepEqual(result, {
    send: true,
    reason: "eligible",
  });
});
