// Scopes requested for the bot account's Twitch user token.
// chat:read / chat:edit        -> read and send chat messages
// moderator:read:chatters      -> read who is connected to a channel's chat,
//                                 which is what watchtime points are counted
//                                 from. Twitch only honours it if the bot
//                                 account is a moderator in that channel.
//
// Moderation scopes (timeouts, bans, message deletion) will be added here
// once that functionality is built.
export const TWITCH_SCOPES = ["chat:read", "chat:edit", "moderator:read:chatters"];
