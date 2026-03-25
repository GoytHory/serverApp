const isExpoPushTokenFormat = (value) => {
  const token = (value || "").toString().trim();
  return /^(ExponentPushToken|ExpoPushToken)\[.+\]$/.test(token);
};

const normalizePresenceState = (state) => {
  return state === "active" ? "active" : "background";
};

const hasActiveChatViewer = (presenceStates, chatId) => {
  return (presenceStates || []).some((presence) => {
    if (!presence) {
      return false;
    }

    const appState = normalizePresenceState(presence.appState);
    const activeChatId =
      typeof presence.activeChatId === "string"
        ? presence.activeChatId.trim()
        : "";

    return appState === "active" && activeChatId === chatId;
  });
};

const evaluatePushEligibility = ({
  expoPushToken,
  presenceStates,
  chatId,
  tokenValidator = isExpoPushTokenFormat,
}) => {
  if (!tokenValidator(expoPushToken)) {
    return { send: false, reason: "missing_or_invalid_token" };
  }

  if (hasActiveChatViewer(presenceStates, chatId)) {
    return { send: false, reason: "recipient_active_in_chat" };
  }

  return { send: true, reason: "eligible" };
};

module.exports = {
  isExpoPushTokenFormat,
  normalizePresenceState,
  hasActiveChatViewer,
  evaluatePushEligibility,
};
