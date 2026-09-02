# Vencord: FriendRequestInteractions

Adds a **Mutual Interactions** tab to Discord's user profile modal. It lists messages that person has sent mentioning/pinging you, so you can see *why* they might be adding you before accepting or review prior context with an implicit friend — someone Discord marks as frequently contacted even though you haven't added each other.

Clicking a result jumps straight to that message in its channel.

## Why

Discord's profile modal already shows **Mutual Friends** and **Mutual Servers** tabs when reviewing a friend request. It doesn't show whether you've actually interacted with that person at all. This plugin adds an extra **Mutual Interactions** tab (appended alongside Mutual Friends/Mutual Servers, and compatible with other plugins that add their own extra tabs) that surfaces any messages where they've mentioned you directly.

## Core Behavior

| Feature | What it does | How |
|---|---|---|
| **New profile tab** | Adds "Mutual Interactions" next to Mutual Friends / Mutual Servers | Patches both the legacy and v2 user profile modal item lists, following the same pattern Discord uses for its own tabs |
| **Configurable visibility** | Shows the tab for incoming requests, users not added as friends, or everyone | Checks `RelationshipStore.getRelationshipType` against the selected visibility mode before injecting the tab |
| **Mutual guild search** | Searches messages in servers you both share | Fetches Discord's authoritative mutual-server profile data, capped at 10 mutual guilds per lookup |
| **DM search** | Searches your existing DM with them, if one exists | Uses `ChannelStore.getDMFromUserId` |
| **Mention filtering** | Only shows messages they sent that mention you | Queries Discord's search endpoint with `author_id` set to them and `mentions` set to you |
| **Jump to message** | Clicking a result closes the modal, opens the channel, and scrolls to/flashes the message | `ChannelRouter.transitionToChannel` + `MessageActions.jumpToMessage` |
| **Grouped results** | Results are grouped into collapsible sections per server (plus a Direct Messages section), collapsed by default | Each section header shows the server's icon, name, and message count; click to expand into a compact chat-style message list |

## How it works

Discord exposes message-search endpoints:

- `GET /guilds/{guild.id}/messages/search`
- `GET /channels/{channel.id}/messages/search`

Both accept `author_id` and `mentions` query parameters. When the tab is opened, the plugin:

1. Confirms the profile being viewed matches the configured visibility mode.
2. Fetches the same mutual-guild profile data Discord uses for its native **Mutual Servers** tab, capped at 10 to avoid hammering the API.
3. Finds an existing DM channel with them, if one exists.
4. Runs a search against each of those, filtering to messages authored by them that mention you.
5. Deduplicates and sorts the combined results by timestamp (newest first), capped at 25.

All requests are read-only (`GET`) and only fire when the tab is actually rendered — not on every profile view.

## Settings

| Setting | Behavior |
|---|---|
| **Incoming friend requests only** | Default. Shows Mutual Interactions only for `INCOMING_REQUEST`, preserving the original behavior. |
| **Users not added as friends** | Shows it for `NONE`, `IMPLICIT`, `INCOMING_REQUEST`, and `OUTGOING_REQUEST` relationships, covering implicit/frequently-contacted users without including existing friends or blocked users. |
| **All users** | Shows it for any non-bot user profile supported by the profile and DM sidebar patches, regardless of relationship type. |

## Troubleshooting

Enable **Debug Logs** in the plugin settings to print relationship, guild, DM, request, response, retry, and result details prefixed with `[FriendRequestInteractions]` in the console.

## Limitations

- Relies on Discord's message-search endpoints. These can change or be rate-limited without notice.
- Only searches guilds you currently share with the requester (capped at 10) and your existing DM with them — it can't see messages in servers you don't have in common.
- Discord's search index determines what's searchable; very recent messages may not be indexed yet.
- The profile modal patches target Discord's current internal tab-list structure (legacy and v2 modals). A Discord client update that restructures these modals may require a patch update.
- Message content uses Discord's parser and attachments/stickers are indicated, but embeds and attachment thumbnails aren't rendered inline.

## Repository Layout

| Path | Purpose |
|---|---|
| `index.tsx` | Plugin metadata, profile modal patches, search/fetch logic, and tab rendering |
| `styles.css` | Scoped styles for the Mutual Interactions tab and result rows |

## Author

Created by [deanxbox](https://github.com/deanxbox).

## License

Licensed under the [GNU General Public License v3.0 or later](https://www.gnu.org/licenses/gpl-3.0.html), consistent with Vencord's source headers.
