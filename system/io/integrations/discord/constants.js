// Discord-specific limits shared by the bot reply path and the discord_send
// tool. Kept in one place so the cap and the error message can't drift.

// Discord's hard message length cap. We slice by code points so emoji/non-BMP
// characters don't get truncated mid-surrogate.
export const DISCORD_MESSAGE_MAX = 2000;
