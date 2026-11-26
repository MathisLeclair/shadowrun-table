// Core actions: chat, whispers, settings, player management, language, pings.
import { isLang } from '../lib/i18n.js';

export default {
  name: 'core',

  init(state, { table } = {}) {
    state.sessions = state.sessions || {};
    state.users = state.users || {};
    state.log = state.log || [];
    state.ui = state.ui || { announcement: null }; // GM banner shown to everyone
    state.config = state.config || {};
    // Table language (game.config.lang): default language of everyone who did not pick one.
    if (!isLang(state.config.lang)) state.config.lang = isLang(table?.lang) ? table.lang : 'fr';
    if (state.config.gmLang !== undefined && state.config.gmLang !== null && !isLang(state.config.gmLang)) state.config.gmLang = null;
  },

  actions: {
    // payload: { text, to?: userId[] (whisper), as?: actorId (speak as character/NPC, GM or owner) }
    'chat/send': {
      role: 'any',
      handler(ctx, { text, to, as }) {
        const clean = String(text || '').trim().slice(0, 2000);
        if (!clean) ctx.fail('Message vide');
        let author = ctx.displayName();
        if (as && ctx.state.actors[as] && ctx.owns(as)) author = ctx.state.actors[as].name;
        const whisper = Array.isArray(to) && to.length ? [...new Set([...to, 'gm'])] : undefined;
        ctx.log({ kind: whisper ? 'whisper' : 'chat', userId: ctx.user.id, author, text: clean, to: whisper });
      },
    },
    'log/clear': {
      role: 'gm',
      handler(ctx) {
        ctx.state.log = [];
      },
    },
    'log/delete': {
      role: 'gm',
      handler(ctx, { id }) {
        ctx.state.log = ctx.state.log.filter((e) => e.id !== id);
      },
    },
    // payload: { campaignName?, gmPassword?, lang?: 'fr'|'en' } — campaignName is also the table's display name.
    'config/update': {
      role: 'gm',
      handler(ctx, { campaignName, gmPassword, lang }) {
        if (campaignName !== undefined) {
          const name = String(campaignName).trim().slice(0, 80);
          if (!name) ctx.fail('Le nom de la campagne ne peut pas être vide');
          ctx.state.config.campaignName = name;
        }
        if (gmPassword) {
          if (String(gmPassword).length < 4) ctx.fail('Mot de passe MJ trop court (4 caractères minimum)');
          ctx.state.config.gmPassword = String(gmPassword).slice(0, 80);
        }
        if (lang !== undefined) {
          if (!isLang(lang)) ctx.fail('Langue inconnue');
          ctx.state.config.lang = lang;
        }
      },
    },
    // Anyone: own UI language. payload: { lang: 'fr'|'en'|null } (null = follow the table's language).
    // Players: state.users[id].lang; the GM: state.config.gmLang. The view exposes it as game.me.lang.
    'users/setLang': {
      role: 'any',
      handler(ctx, { lang }) {
        if (lang !== null && lang !== undefined && !isLang(lang)) ctx.fail('Langue inconnue');
        const value = isLang(lang) ? lang : null;
        if (ctx.isGM) ctx.state.config.gmLang = value;
        else {
          const u = ctx.state.users[ctx.user.id];
          if (!u) ctx.fail('Joueur introuvable');
          u.lang = value;
        }
        return { lang: value };
      },
    },
    // GM: give or remove a character from a player. payload: { userId, characterId, assign: bool }
    'users/assign': {
      role: 'gm',
      handler(ctx, { userId, characterId, assign }) {
        const u = ctx.state.users[userId];
        if (!u) ctx.fail('Joueur introuvable');
        u.characterIds = (u.characterIds || []).filter((id) => id !== characterId);
        if (assign) {
          for (const other of Object.values(ctx.state.users)) other.characterIds = (other.characterIds || []).filter((id) => id !== characterId);
          u.characterIds.push(characterId);
        }
      },
    },
    'users/remove': {
      role: 'gm',
      handler(ctx, { userId }) {
        delete ctx.state.users[userId];
        for (const [tok, id] of Object.entries(ctx.state.sessions)) if (id === userId) delete ctx.state.sessions[tok];
      },
    },
    'users/resetPin': {
      role: 'gm',
      handler(ctx, { userId }) {
        if (ctx.state.users[userId]) ctx.state.users[userId].pin = null;
      },
    },
    // Banner text shown on every screen (null to clear).
    'ui/announce': {
      role: 'gm',
      handler(ctx, { text }) {
        ctx.state.ui.announcement = text ? String(text).slice(0, 500) : null;
      },
    },
    // Transient "look here" ping on the map. payload: { mapId, x, y } (cell coords, may be fractional)
    'ui/ping': {
      role: 'any',
      handler(ctx, { mapId, x, y }) {
        ctx.emitTo('all', 'ping', { mapId, x, y, userId: ctx.user.id, name: ctx.displayName() });
      },
    },
  },
};
