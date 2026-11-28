// Core actions: chat, whispers, settings, player management, language, pings.
import { isLang } from '../lib/i18n.ts';
import { syncSpiritControl } from '../../shared/magic.ts';
import type { ActionContext, InitOptions, Lang, ServerModule, TableConfig, TableState, UserId, ActorId, MapId } from '../../shared/types.ts';

type ChatSendPayload = {
  text?: unknown;
  to?: unknown;
  as?: ActorId;
};
type IdPayload = {
  id?: string;
};
type ConfigUpdatePayload = {
  campaignName?: unknown;
  gmPassword?: unknown;
  lang?: unknown;
};
type SetLangPayload = {
  lang?: unknown;
};
type AssignPayload = {
  userId: UserId;
  characterId: ActorId;
  assign?: boolean;
};
type UserPayload = {
  userId: UserId;
};
type AnnouncePayload = {
  text?: unknown;
};
type PingPayload = {
  mapId: MapId;
  x: number;
  y: number;
};

const mod: ServerModule = {
  name: 'core',

  init(state: TableState, { table }: Partial<InitOptions> = {}) {
    state.sessions = state.sessions || {};
    state.users = state.users || {};
    state.log = state.log || [];
    state.ui = state.ui || { announcement: null }; // GM banner shown to everyone
    state.config = state.config || ({} as TableConfig);
    // Table language (game.config.lang): default language of everyone who did not pick one.
    if (!isLang(state.config.lang)) state.config.lang = table && isLang(table.lang) ? table.lang : 'fr';
    if (state.config.gmLang !== undefined && state.config.gmLang !== null && !isLang(state.config.gmLang)) state.config.gmLang = null;
  },

  actions: {
    // payload: { text, to?: userId[] (whisper), as?: actorId (speak as character/NPC, GM or owner) }
    'chat/send': {
      role: 'any',
      handler(ctx: ActionContext, { text, to, as }: ChatSendPayload) {
        const clean = String(text || '').trim().slice(0, 2000);
        if (!clean) ctx.fail('Empty message');
        let author = ctx.displayName();
        if (as && ctx.state.actors[as] && ctx.owns(as)) author = ctx.state.actors[as].name;
        const whisper = Array.isArray(to) && to.length ? [...new Set<UserId>([...(to as UserId[]), 'gm'])] : undefined;
        ctx.log({ kind: whisper ? 'whisper' : 'chat', userId: ctx.user.id, author, text: clean, to: whisper });
      },
    },
    'log/clear': {
      role: 'gm',
      handler(ctx: ActionContext) {
        ctx.state.log = [];
      },
    },
    'log/delete': {
      role: 'gm',
      handler(ctx: ActionContext, { id }: IdPayload) {
        ctx.state.log = ctx.state.log.filter((e) => e.id !== id);
      },
    },
    // payload: { campaignName?, gmPassword?, lang?: 'fr'|'en' } — campaignName is also the table's display name.
    'config/update': {
      role: 'gm',
      handler(ctx: ActionContext, { campaignName, gmPassword, lang }: ConfigUpdatePayload) {
        if (campaignName !== undefined) {
          const name = String(campaignName).trim().slice(0, 80);
          if (!name) ctx.fail('The campaign name cannot be empty');
          ctx.state.config.campaignName = name;
        }
        if (gmPassword) {
          if (String(gmPassword).length < 4) ctx.fail('GM password too short (4 characters minimum)');
          ctx.state.config.gmPassword = String(gmPassword).slice(0, 80);
        }
        if (lang !== undefined) {
          if (!isLang(lang)) ctx.fail('Unknown language');
          ctx.state.config.lang = lang;
        }
      },
    },
    // Anyone: own UI language. payload: { lang: 'fr'|'en'|null } (null = follow the table's language).
    // Players: state.users[id].lang; the GM: state.config.gmLang. The view exposes it as game.me.lang.
    'users/setLang': {
      role: 'any',
      handler(ctx: ActionContext, { lang }: SetLangPayload) {
        if (lang !== null && lang !== undefined && !isLang(lang)) ctx.fail('Unknown language');
        const value = isLang(lang) ? lang : null;
        if (ctx.isGM) ctx.state.config.gmLang = value;
        else {
          const u = ctx.state.users[ctx.user.id];
          if (!u) ctx.fail('Player not found');
          u.lang = value;
        }
        return { lang: value };
      },
    },
    // GM: give or remove a character from a player. payload: { userId, characterId, assign: bool }
    'users/assign': {
      role: 'gm',
      handler(ctx: ActionContext, { userId, characterId, assign }: AssignPayload) {
        const u = ctx.state.users[userId];
        if (!u) ctx.fail('Player not found');
        u.characterIds = (u.characterIds || []).filter((id) => id !== characterId);
        if (assign) {
          for (const other of Object.values(ctx.state.users)) other.characterIds = (other.characterIds || []).filter((id) => id !== characterId);
          u.characterIds.push(characterId);
        }
        syncSpiritControl(ctx.state); // a summoner's spirits follow it
      },
    },
    'users/remove': {
      role: 'gm',
      handler(ctx: ActionContext, { userId }: UserPayload) {
        delete ctx.state.users[userId];
        for (const [tok, id] of Object.entries(ctx.state.sessions)) if (id === userId) delete ctx.state.sessions[tok];
      },
    },
    'users/resetPin': {
      role: 'gm',
      handler(ctx: ActionContext, { userId }: UserPayload) {
        const u = ctx.state.users[userId];
        if (!u) return;
        u.pin = null;
        // The player is told: without a PIN anyone could log in under their name (and read their private notes).
        ctx.log({ kind: 'system', author: 'MJ', i18n: { key: 'The GM cleared {name}’s PIN.', params: { name: u.name } }, to: [u.id, 'gm'] });
      },
    },
    // Banner text shown on every screen (null to clear).
    'ui/announce': {
      role: 'gm',
      handler(ctx: ActionContext, { text }: AnnouncePayload) {
        ctx.state.ui.announcement = text ? String(text).slice(0, 500) : null;
      },
    },
    // Transient "look here" ping on the map. payload: { mapId, x, y } (cell coords, may be fractional)
    'ui/ping': {
      role: 'any',
      handler(ctx: ActionContext, { mapId, x, y }: PingPayload) {
        ctx.emitTo('all', 'ping', { mapId, x, y, userId: ctx.user.id, name: ctx.displayName() });
      },
    },
  },
};

export default mod;
