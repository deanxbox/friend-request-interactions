/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { definePluginSettings } from "@api/Settings";
import { BaseText } from "@components/BaseText";
import ErrorBoundary from "@components/ErrorBoundary";
import { Logger } from "@utils/Logger";
import { classes } from "@utils/misc";
import definePlugin, { OptionType } from "@utils/types";
import type { MessageJSON, User } from "@vencord/discord-types";
import { RelationshipType } from "@vencord/discord-types/enums";
import { findByPropsLazy, findCssClassesLazy } from "@webpack";
import {
    ChannelRouter,
    ChannelStore,
    Clickable,
    DateUtils,
    GuildStore,
    IconUtils,
    MessageActions,
    Parser,
    RelationshipStore,
    RestAPI,
    ScrollerThin,
    useEffect,
    UserProfileStore,
    UserStore,
    useState
} from "@webpack/common";
import { ComponentType, JSX } from "react";

const ProfileListClasses = findCssClassesLazy("empty", "textContainer", "connectionIcon");
const TabBarClasses = findCssClassesLazy("tabPanelScroller", "tabBarPanel");
const MutualsListClasses = findCssClassesLazy("row", "icon", "name", "details");
const UserProfileActions = findByPropsLazy("fetchProfile", "fetchMutualFriends") as {
    fetchProfile(userId: string, options?: { withMutualGuilds?: boolean; withMutualFriendsCount?: boolean; }): Promise<void>;
};

let ExpandableList: ComponentType<any> = () => null;

const logger = new Logger("FriendRequestInteractions");
const MAX_GUILDS = 10;
const MAX_RESULTS = 25;

type InteractionMessage = MessageJSON & {
    _sourceGuildId: string | null;
    sticker_items?: unknown[];
    stickers?: unknown[];
};

type InteractionGroup = {
    id: string;
    iconUrl?: string;
    latestTimestamp: number;
    messages: InteractionMessage[];
    name: string;
};

enum VisibilityMode {
    IncomingRequests = "incoming-requests",
    NotFriends = "not-friends",
    AllUsers = "all-users"
}

const settings = definePluginSettings({
    debugLogs: {
        type: OptionType.BOOLEAN,
        description: "Print verbose [FriendRequestInteractions] debug logs to the console (relationship checks, mutual guilds, search requests/responses).",
        default: false
    },
    visibilityMode: {
        type: OptionType.SELECT,
        description: "Choose which user profiles show Mutual Interactions",
        options: [
            { label: "Incoming friend requests only", value: VisibilityMode.IncomingRequests, default: true },
            { label: "Users not added as friends", value: VisibilityMode.NotFriends },
            { label: "All users", value: VisibilityMode.AllUsers }
        ]
    }
});

// ponytail: single gated helper instead of a logging framework; every call site
// prefixes with the plugin name per user's explicit format requirement.
function dlog(...args: unknown[]) {
    if (settings.store.debugLogs) logger.info("[FriendRequestInteractions]", ...args);
}

function shouldShowMutualInteractions(userId: string) {
    const relationshipType = RelationshipStore.getRelationshipType(userId);
    const mode = settings.store.visibilityMode;
    const requiredRelationships = mode === VisibilityMode.AllUsers
        ? null
        : mode === VisibilityMode.NotFriends
            ? [
                RelationshipType.NONE,
                RelationshipType.INCOMING_REQUEST,
                RelationshipType.OUTGOING_REQUEST,
                RelationshipType.IMPLICIT
            ]
            : [RelationshipType.INCOMING_REQUEST];
    const matches = requiredRelationships === null || requiredRelationships.includes(relationshipType);

    dlog("Relationship visibility check", {
        userId,
        mode,
        actual: relationshipType,
        required: requiredRelationships ?? "any relationship type",
        matches
    });
    return matches;
}

function isInteractionMessage(message: unknown, authorId: string, mentionedUserId: string): message is MessageJSON {
    if (!message || typeof message !== "object") return false;

    const candidate = message as Partial<MessageJSON>;
    return typeof candidate.id === "string"
        && typeof candidate.channel_id === "string"
        && typeof candidate.timestamp === "string"
        && candidate.author?.id === authorId
        && Array.isArray(candidate.mentions)
        && candidate.mentions.some(mention => typeof mention === "string"
            ? mention === mentionedUserId
            : mention?.id === mentionedUserId);
}

function parseSearchMessages(body: unknown, authorId: string, mentionedUserId: string) {
    if (!body || typeof body !== "object") return [];

    const groups = (body as { messages?: unknown; }).messages;
    if (!Array.isArray(groups)) return [];

    return groups
        .flatMap(group => Array.isArray(group) ? group : [group])
        .filter(message => isInteractionMessage(message, authorId, mentionedUserId));
}

// ponytail: Discord's search index is lazily built per-guild. A guild that has
// never been searched returns 202 { retry_after, documents_indexed } instead of
// results, which is why "open the server first" made it "work" (that triggered
// indexing). Poll a few times honoring retry_after instead of treating 202 as empty.
const MAX_INDEX_RETRIES = 4;

async function searchInteractions(
    url: string,
    authorId: string,
    mentionedUserId: string,
    onIndexing?: (retryAfterSeconds: number) => void
) {
    for (let attempt = 0; attempt <= MAX_INDEX_RETRIES; attempt++) {
        try {
            const query = {
                author_id: authorId,
                mentions: mentionedUserId,
                sort_by: "timestamp",
                sort_order: "desc",
                include_nsfw: true,
                limit: MAX_RESULTS
            };

            dlog("RestAPI.get", {
                url,
                query,
                attempt: `${attempt + 1}/${MAX_INDEX_RETRIES + 1}`
            });
            const response = await RestAPI.get({
                url,
                query,
                retries: 1
            });

            dlog(`Response ${response.status} from ${url}`, response.body);

            if (response.status === 202 && attempt < MAX_INDEX_RETRIES) {
                const retryAfter = Number((response.body as { retry_after?: number; })?.retry_after) || 1;
                dlog(`${url} not indexed yet, retrying in ${retryAfter}s`);
                onIndexing?.(retryAfter);
                await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
                continue;
            }

            const parsed = parseSearchMessages(response.body, authorId, mentionedUserId);
            dlog(`${url} matched ${parsed.length} message(s)`);
            return parsed;
        } catch (error) {
            // ponytail: RestAPI rejects (rather than resolves) for the 202 "still indexing"
            // response, same as it does for 429s, so the not-indexed-yet case must also be
            // handled here or it gets silently swallowed as a generic failure.
            const requestError = error as {
                status?: number;
                body?: { retry_after?: number; };
                response?: {
                    status?: number;
                    body?: { retry_after?: number; };
                };
            };
            const status = requestError?.status ?? requestError?.response?.status;
            const body = requestError?.body ?? requestError?.response?.body;
            dlog(`${url} threw (status=${status})`, { body }, error);
            if (status === 202 && attempt < MAX_INDEX_RETRIES) {
                const retryAfter = Number(body?.retry_after) || 1;
                dlog(`${url} not indexed yet (via thrown error), retrying in ${retryAfter}s`);
                onIndexing?.(retryAfter);
                await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
                continue;
            }

            logger.warn(`Failed to search ${url}:`, error);
            return [];
        }
    }

    dlog(`${url} exhausted retries without indexing completing`);
    return [];
}

async function getMutualInteractions(
    userId: string,
    onProgress?: (current: number, total: number, label: string) => void
): Promise<InteractionMessage[]> {
    try {
        if (!shouldShowMutualInteractions(userId)) return [];

        const currentUser = UserStore.getCurrentUser();
        dlog("Current user resolution", currentUser
            ? { id: currentUser.id, username: currentUser.username }
            : null);
        if (!currentUser) return [];

        let mutualGuilds = UserProfileStore.getMutualGuilds(userId);
        const profileFetchTriggered = mutualGuilds == null;
        dlog("Mutual guild profile fetch", {
            userId,
            profileFetchTriggered,
            cached: !profileFetchTriggered
        });
        if (profileFetchTriggered) {
            try {
                await UserProfileActions.fetchProfile(userId, {
                    withMutualGuilds: true,
                    withMutualFriendsCount: false
                });
            } catch (error) {
                logger.warn("Failed to fetch mutual guild profile data:", error);
            }
            mutualGuilds = UserProfileStore.getMutualGuilds(userId);
        }

        // ponytail: cap searches at 10 mutual guilds; add pagination/concurrency controls only if broader coverage is needed.
        const mutualGuildIds = (mutualGuilds ?? [])
            .map(({ guild }) => guild.id)
            .slice(0, MAX_GUILDS);
        dlog("Mutual guilds", {
            source: "UserProfileStore.getMutualGuilds",
            count: mutualGuildIds.length,
            guilds: mutualGuildIds.map(id => ({
                id,
                name: GuildStore.getGuild(id)?.name ?? "Unknown Server"
            }))
        });

        const dmChannelId = ChannelStore.getDMFromUserId(userId);
        const dmChannel = dmChannelId ? ChannelStore.getChannel(dmChannelId) : null;
        dlog("DM channel lookup", {
            userId,
            id: dmChannelId ?? null,
            found: Boolean(dmChannel),
            name: dmChannel?.name ?? null
        });

        const messages: InteractionMessage[] = [];

        for (let i = 0; i < mutualGuildIds.length; i++) {
            const guildId = mutualGuildIds[i];
            const guildName = GuildStore.getGuild(guildId)?.name ?? "Unknown Server";
            dlog("Searching mutual guild", {
                id: guildId,
                name: guildName,
                index: i + 1,
                total: mutualGuildIds.length
            });
            onProgress?.(i + 1, mutualGuildIds.length, guildName);

            const guildMessages = await searchInteractions(
                `/guilds/${guildId}/messages/search`,
                userId,
                currentUser.id,
                retryAfter => onProgress?.(i + 1, mutualGuildIds.length, `${guildName} (indexing, retrying in ${retryAfter}s)`)
            );
            messages.push(...guildMessages.map(message => ({
                ...message,
                _sourceGuildId: guildId
            })));
        }

        if (dmChannelId) {
            const dmMessages = await searchInteractions(
                `/channels/${dmChannelId}/messages/search`,
                userId,
                currentUser.id
            );
            messages.push(...dmMessages.map(message => ({
                ...message,
                _sourceGuildId: null
            })));
        }

        const uniqueMessages = new Map(messages.map(message => [message.id, message]));
        const results = [...uniqueMessages.values()]
            .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
            .slice(0, MAX_RESULTS);

        dlog("Final interaction messages after dedup, sort, and cap", {
            collected: messages.length,
            unique: uniqueMessages.size,
            returned: results.length
        });
        return results;
    } catch (error) {
        logger.error("Failed to fetch mutual interactions:", error);
        return [];
    }
}

function getMessageContext(message: InteractionMessage) {
    const channel = ChannelStore.getChannel(message.channel_id);
    if (message._sourceGuildId === null) return "Direct Message";

    return `${GuildStore.getGuild(message._sourceGuildId)?.name ?? "Unknown Server"} · #${channel?.name ?? "unknown-channel"}`;
}

function getMessagePreview(message: InteractionMessage) {
    const content = message.content?.trim();
    const indicators = [
        message.attachments?.length ? "[image]" : null,
        message.sticker_items?.length || message.stickers?.length ? "[sticker]" : null
    ].filter(Boolean).join(" ");

    if (!content) return indicators || "[No text content]";

    return (
        <>
            {Parser.parse(content, true, {
                channelId: message.channel_id,
                messageId: message.id,
                allowLinks: true,
                allowEmojiLinks: true
            })}
            {indicators && ` ${indicators}`}
        </>
    );
}

function getAuthorAvatarUrl(message: InteractionMessage) {
    return UserStore.getUser(message.author.id)?.getAvatarURL(message._sourceGuildId, 32, true)
        ?? IconUtils.getDefaultAvatarURL(message.author.id, message.author.discriminator);
}

function groupInteractionMessages(messages: InteractionMessage[]) {
    const groups = new Map<string, InteractionGroup>();

    for (const message of messages) {
        const id = message._sourceGuildId ?? "direct-messages";
        let group = groups.get(id);

        if (!group) {
            const guild = message._sourceGuildId ? GuildStore.getGuild(message._sourceGuildId) : null;
            group = {
                id,
                iconUrl: guild
                    ? IconUtils.getGuildIconURL({ id: guild.id, icon: guild.icon, size: 32, canAnimate: true })
                    : getAuthorAvatarUrl(message),
                latestTimestamp: Date.parse(message.timestamp),
                messages: [],
                name: guild?.name ?? (message._sourceGuildId ? "Unknown Server" : "Direct Messages")
            };
            groups.set(id, group);
        }

        group.messages.push(message);
        group.latestTimestamp = Math.max(group.latestTimestamp, Date.parse(message.timestamp));
    }

    return [...groups.values()].sort((a, b) => b.latestTimestamp - a.latestTimestamp);
}

function renderMessage(message: InteractionMessage, onClose?: () => void) {
    return (
        <Clickable
            key={message.id}
            className={classes(MutualsListClasses.row, "vc-mutual-interactions-row")}
            onClick={() => {
                onClose?.();
                ChannelRouter.transitionToChannel(message.channel_id);
                setTimeout(() => MessageActions.jumpToMessage({
                    channelId: message.channel_id,
                    messageId: message.id,
                    flash: true,
                    jumpType: "INSTANT"
                }), 0);
            }}
        >
            <img
                alt=""
                className={classes(MutualsListClasses.icon, "vc-mutual-interactions-author-avatar")}
                src={getAuthorAvatarUrl(message)}
            />
            <div className={classes(MutualsListClasses.details, "vc-mutual-interactions-details")}>
                <div className="vc-mutual-interactions-author-row">
                    <BaseText size="sm" weight="semibold" className="vc-mutual-interactions-author">
                        {message.author.globalName ?? message.author.username}
                    </BaseText>
                    <BaseText size="xs" weight="medium">{DateUtils.calendarFormat(new Date(message.timestamp))}</BaseText>
                </div>
                <BaseText size="xs" weight="medium" className="vc-mutual-interactions-context">
                    {getMessageContext(message)}
                </BaseText>
                <div className={classes(MutualsListClasses.name, "vc-mutual-interactions-preview")}>
                    {getMessagePreview(message)}
                </div>
            </div>
        </Clickable>
    );
}

function InteractionGroupSection({ group, onClose }: { group: InteractionGroup; onClose?: () => void; }) {
    const [expanded, setExpanded] = useState(false);

    return (
        <section className="vc-mutual-interactions-group">
            <Clickable
                aria-expanded={expanded}
                aria-label={`${expanded ? "Collapse" : "Expand"} ${group.name}`}
                className="vc-mutual-interactions-group-header"
                onClick={() => setExpanded(value => !value)}
            >
                {group.iconUrl
                    ? <img alt="" className="vc-mutual-interactions-guild-icon" src={group.iconUrl} />
                    : <div className="vc-mutual-interactions-guild-icon vc-mutual-interactions-guild-icon-fallback">{group.name[0]}</div>
                }
                <BaseText size="sm" weight="semibold" className="vc-mutual-interactions-group-name">
                    {group.name}
                </BaseText>
                <span className="vc-mutual-interactions-count">{group.messages.length}</span>
                <svg
                    aria-hidden="true"
                    className={classes("vc-mutual-interactions-chevron", expanded && "vc-mutual-interactions-chevron-expanded")}
                    height="16"
                    viewBox="0 0 24 24"
                    width="16"
                >
                    <path fill="currentColor" d="M9.3 5.3a1 1 0 0 0 0 1.4l5.29 5.3-5.3 5.3a1 1 0 1 0 1.42 1.4l6-6a1 1 0 0 0 0-1.4l-6-6a1 1 0 0 0-1.42 0Z" />
                </svg>
            </Clickable>
            {expanded && (
                <div className="vc-mutual-interactions-group-messages">
                    {group.messages.map(message => renderMessage(message, onClose))}
                </div>
            )}
        </section>
    );
}

function renderInteractionGroups(messages: InteractionMessage[], onClose?: () => void) {
    return groupInteractionMessages(messages).map(group => (
        <InteractionGroupSection key={group.id} group={group} onClose={onClose} />
    ));
}

function EmptyState({ children }: { children: string; }) {
    return (
        <div className={ProfileListClasses.empty}>
            <div className={ProfileListClasses.textContainer}>
                <BaseText tag="h3" size="md" weight="medium" style={{ color: "var(--text-strong)" }}>
                    {children}
                </BaseText>
            </div>
        </div>
    );
}

export default definePlugin({
    name: "FriendRequestInteractions",
    description: "Shows messages from selected users that mentioned you",
    tags: ["Friends", "Chat"],
    authors: [{ name: "dean", id: 285021062578700289n }],
    settings,

    patches: [
        // Legacy User Profile Modal
        {
            find: ".BOT_DATA_ACCESS?(",
            replacement: [
                {
                    match: /(?<=initialSection:\i=\i\.\i\.USER_INFO,onClose:\i\}=)((?:Vencord\.Plugins\.plugins\["[^"]+"\]\.getProps\()*\i(?:\.\i\([^()]*\))*(?:\))*)(?![\w$.\[(])/,
                    replace: "$self.getProps($1)"
                },
                {
                    match: /\(0,\i\.jsx\)\(\i,\{items:\i,section:(\i)/,
                    replace: "$1==='MUTUAL_INTERACTIONS'?$self.renderMutualInteractions({...arguments[0],isLegacy:true}):$&"
                },
                {
                    match: /(className:\i\.\i(?:\s*\+\s*"[^"]*")*)(?=,type:"top")/,
                    replace: '$1 + " vc-mutual-interactions-modal-tab-bar"'
                }
            ]
        },
        // User Profile Modal v2
        {
            find: ".WIDGETS?",
            replacement: [
                {
                    match: /(?<=items:\i,initialSection:\i,onClose:\i\}=)((?:Vencord\.Plugins\.plugins\["[^"]+"\]\.getProps\()*\i(?:\.\i\([^()]*\))*(?:\))*)(?![\w$.\[(])/,
                    replace: "$self.getProps($1)"
                },
                {
                    match: /\(0,\i\.jsx\)\(\i(?:\.\i)?,\{component:(?=.{0,250}?children:\(0,\i\.jsx\)\(\i(?:\.\i)?,\{[^{}]{0,300}?section:(\i)\.section,[^{}]{0,100}?onClose:\i\}\))/,
                    replace: "$1.section==='MUTUAL_INTERACTIONS'?$self.renderMutualInteractions(arguments[0]):$&"
                },
                {
                    match: /type:"top",(className:"[^"]*",)?/,
                    replace: (m: string, existingClassName?: string) => existingClassName
                        ? `type:"top",${existingClassName.replace(/"(,)$/, ' vc-mutual-interactions-modal-v2-tab-bar"$1')}`
                        : 'type:"top",className:"vc-mutual-interactions-modal-v2-tab-bar",'
                }
            ]
        },
        // Legacy DM Sidebar
        {
            find: 'section:"MUTUAL_FRIENDS"',
            replacement: [
                {
                    match: /\?(?=\(0,\i\.jsxs?\)\(\i\.\i\.Overlay,\{[^}]{0,100}?children:\[.{0,1500}?section:"MUTUAL_FRIENDS")/,
                    replace: "||$self.shouldShowMutualInteractions(arguments[0].user.id)$&"
                },
                {
                    match: /\.openUserProfileModal.+?\)}\)}\)(?<=,(\i)&&(\i)&&(\(0,\i\.jsxs?\)\(\i\.\i,{className:(\i)\.\i}\)).{0,50}?"MUTUAL_FRIENDS".+?)/,
                    replace: (m, hasMutualGuilds, hasMutualFriends, Divider, classes) => "" +
                        `${m},$self.renderInteractionsDMPageList({user:arguments[0].user,hasDivider:${hasMutualGuilds}||${hasMutualFriends},Divider:${Divider},listStyle:${classes}.list})`
                },
                {
                    match: /(?=function (\i)\(\i\){let{section:\i,header:\i[^}]+?onExpand:)/,
                    replace: "$self.ExpandableList=$1;"
                }
            ]
        }
    ],

    set ExpandableList(value: any) {
        ExpandableList = value;
    },

    shouldShowMutualInteractions,

    getProps(props: { user: User, items: any[]; }) {
        try {
            const currentUser = UserStore.getCurrentUser();
            if (!currentUser
                || !props.user
                || props.user.bot
                || props.user.id === currentUser.id
                || !shouldShowMutualInteractions(props.user.id))
                return props;

            const items = [...props.items];
            const mutualGroupsIndex = items.findIndex(item => item.section === "MUTUAL_GDMS");
            items.splice(mutualGroupsIndex < 0 ? items.length : mutualGroupsIndex, 0, {
                text: "Mutual Interactions",
                section: "MUTUAL_INTERACTIONS"
            });

            return { ...props, items };
        } catch (error) {
            logger.error("Failed to append mutual interactions section:", error);
            return props;
        }
    },

    renderMutualInteractions: ErrorBoundary.wrap(({
        user,
        onClose,
        isLegacy
    }: {
        user: User;
        onClose?: () => void;
        isLegacy?: boolean;
    }) => {
        const [messages, setMessages] = useState<InteractionMessage[]>([]);
        const [loading, setLoading] = useState(true);
        const [progress, setProgress] = useState<{ current: number; total: number; label: string; } | null>(null);

        useEffect(() => {
            let cancelled = false;

            setLoading(true);
            setProgress(null);
            getMutualInteractions(user.id, (current, total, label) => {
                if (!cancelled) {
                    setProgress({ current, total, label });
                }
            }).then(results => {
                if (!cancelled) {
                    setMessages(results);
                    setLoading(false);
                    setProgress(null);
                }
            });

            return () => {
                cancelled = true;
            };
        }, [user.id]);

        return (
            <ScrollerThin
                className={classes(TabBarClasses.tabPanelScroller, !isLegacy && "vc-mutual-interactions-scroller")}
                fade={true}
                onClose={onClose}
            >
                {loading
                    ? (
                        <EmptyState>
                            {progress
                                ? `Scanning ${progress.label}... (${progress.current}/${progress.total})`
                                : "Loading mutual interactions..."}
                        </EmptyState>
                    )
                    : messages.length
                        ? renderInteractionGroups(messages, onClose)
                        : <EmptyState>No messages from this person mention you</EmptyState>
                }
            </ScrollerThin>
        );
    }),

    renderInteractionsDMPageList: ErrorBoundary.wrap(({ user, hasDivider, Divider, listStyle }: { user: User, hasDivider: boolean, Divider: JSX.Element, listStyle: string; }) => {
        const [messages, setMessages] = useState<InteractionMessage[]>([]);
        const [loading, setLoading] = useState(true);

        useEffect(() => {
            let cancelled = false;

            setLoading(true);
            getMutualInteractions(user.id).then(results => {
                if (!cancelled) {
                    setMessages(results);
                    setLoading(false);
                }
            });

            return () => {
                cancelled = true;
            };
        }, [user.id]);

        if (!loading && messages.length === 0) return null;

        return (
            <>
                {hasDivider && Divider}
                <ExpandableList
                    listClassName={classes(listStyle, "vc-mutual-interactions-dm-page-list")}
                    header={"Mutual Interactions"}
                    isLoading={loading}
                    items={renderInteractionGroups(messages)}
                />
            </>
        );
    }, { noop: true })
});
