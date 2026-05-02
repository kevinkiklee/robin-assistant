export function isAllowedUser(userId, { allowedUserIds }) {
  return allowedUserIds.includes(userId);
}

export function isAllowedContext(message, allow) {
  if (!isAllowedUser(message.author.id, allow)) return false;
  if (message.guildId === null) return true;
  return message.guildId === allow.allowedGuildId;
}
