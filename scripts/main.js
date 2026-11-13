/**
 * D&D 5e Weapon Mastery Automation
 * Automates the eight 2024 weapon mastery properties: Cleave, Graze, Nick, Push, Sap, Slow, Topple and Vex.
 *
 * Flow:
 *  - dnd5e.rollAttackV2 records which mastery was used and which targets were hit or missed.
 *  - A miss with Graze posts its card straight away.
 *  - dnd5e.rollDamageV2 posts the card for every other mastery, for the targets that were hit.
 *  - Cleave also opens a dialog to pick the second target and rolls that attack.
 *  - Sap, Slow and Vex are Active Effects that expire on the attacker's turn (or when used).
 */

const MODULE_ID = "dnd5e-weapon-mastery-automation";
const QUERY = `${MODULE_ID}.action`;
const PENDING_TTL = 10 * 60 * 1000;
const PUSHABLE = new Set(["tiny", "sm", "med", "lg"]);
const ON_HIT = ["cleave", "nick", "push", "sap", "slow", "topple", "vex"];

/** Attacks waiting for their damage roll, keyed by activity uuid. */
const pending = new Map();
/** Sap/Vex effects to remove once the attack they modified has been rolled, keyed by activity uuid. */
const toConsume = new Map();
/** The activity uuid of a Cleave follow-up attack that's about to be rolled. */
let cleaveNext = null;
/** Combat turn keys in which each actor already used Cleave. */
const cleaveUsed = new Map();

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

const t = (key, data) => data
  ? game.i18n.format(`DND5EWM.${key}`, data)
  : game.i18n.localize(`DND5EWM.${key}`);
const setting = key => game.settings.get(MODULE_ID, key);
const esc = str => foundry.utils.escapeHTML(String(str ?? ""));
const masteryLabel = key => CONFIG.DND5E.weaponMasteries?.[key]?.label ?? key;

function turnKey() {
  const c = game.combat;
  return c?.started ? `${c.id}.${c.round}.${c.turn}` : null;
}

function combatStamp() {
  const c = game.combat;
  return c?.started ? { combat: c.id, round: c.round, turn: c.turn } : null;
}

function tokenFor(actor) {
  return actor?.token?.object ?? actor?.getActiveTokens?.()[0] ?? null;
}

function describe(token) {
  const actor = token.actor;
  return {
    token: token.document?.uuid ?? token.uuid,
    actor: actor.uuid,
    name: token.name,
    img: token.document?.texture?.src ?? actor.img,
    ac: actor.statuses?.has("coverTotal") ? null : (actor.system.attributes?.ac?.value ?? null)
  };
}

function damageType(activity) {
  const fromActivity = activity.damage?.parts?.[0]?.types;
  const fromItem = activity.item?.system.damage?.base?.types;
  return [...(fromActivity?.size ? fromActivity : fromItem ?? [])][0] ?? null;
}

function damageTypeLabel(type) {
  return CONFIG.DND5E.damageTypes?.[type]?.label ?? type ?? "";
}

/** Edge-to-edge gap between two tokens, in grid squares (0 = adjacent). */
function gapSquares(a, b) {
  const size = canvas.grid.size;
  const dx = Math.max(0, Math.abs(a.center.x - b.center.x) - (a.w + b.w) / 2);
  const dy = Math.max(0, Math.abs(a.center.y - b.center.y) - (a.h + b.h) / 2);
  return Math.round(Math.max(dx, dy) / size);
}

/* -------------------------------------------- */
/*  Owner / GM actions                          */
/* -------------------------------------------- */

const ACTIONS = {
  async damage({ actor, value, type, properties }) {
    const doc = await fromUuid(actor);
    await doc?.applyDamage([{ value, type, properties: new Set(properties ?? []) }]);
    return true;
  },

  async createEffect({ actor, data, replaceType }) {
    const doc = await fromUuid(actor);
    if ( !doc ) return false;
    if ( replaceType ) {
      const old = doc.effects.filter(e => e.getFlag(MODULE_ID, "type") === replaceType).map(e => e.id);
      if ( old.length ) await doc.deleteEmbeddedDocuments("ActiveEffect", old);
    }
    await doc.createEmbeddedDocuments("ActiveEffect", [data]);
    return true;
  },

  async deleteEffects({ uuids }) {
    for ( const uuid of uuids ) {
      const effect = await fromUuid(uuid);
      await effect?.delete();
    }
    return true;
  },

  async topple({ actor, dc }) {
    const doc = await fromUuid(actor);
    if ( !doc ) return null;
    const rolls = await doc.rollSavingThrow({ ability: "con", target: dc }, { configure: false });
    const roll = rolls?.[0];
    if ( !roll ) return null;
    const failed = roll.total < dc;
    if ( failed ) await doc.toggleStatusEffect("prone", { active: true });
    return failed ? "fail" : "pass";
  },

  async move({ token, x, y }) {
    const doc = await fromUuid(token);
    await doc?.update({ x, y });
    return true;
  }
};

/** Run an action as the owner of `uuid`, relaying to the active GM when this user doesn't own it. */
async function run(action, data, uuid, name) {
  const doc = fromUuidSync(uuid, { strict: false });
  if ( doc?.isOwner ) return ACTIONS[action](data);
  const gm = game.users.activeGM;
  if ( !gm ) {
    ui.notifications.warn(t("NoGM", { name }));
    return null;
  }
  return gm.query(QUERY, { action, data }, { timeout: 30000 });
}

/* -------------------------------------------- */
/*  Mastery effects                             */
/* -------------------------------------------- */

function effectData(type, { name, img, source, expire, changes = [], extra = {} }) {
  return {
    name,
    img,
    origin: source,
    statuses: [`${MODULE_ID}-${type}`],
    // v14 only shows the token icon for timed effects unless told otherwise. v13 ignores this field.
    showIcon: CONST.ACTIVE_EFFECT_SHOW_ICON?.ALWAYS,
    changes,
    flags: { [MODULE_ID]: { type, source, expire: combatStamp() ? { ...combatStamp(), when: expire } : null, ...extra } }
  };
}

/**
 * Apply one mastery to one target.
 * @returns {Promise<string|null>} A result key stored on the card, or null if nothing happened.
 */
async function applyMastery(mastery, card, target) {
  const attacker = card.attacker;
  try {
    switch ( mastery ) {
      case "graze": {
        if ( card.graze.value <= 0 ) return null;
        await run("damage", {
          actor: target.actor, value: card.graze.value, type: card.graze.type, properties: card.graze.properties
        }, target.actor, target.name);
        return "done";
      }
      case "sap": {
        const data = effectData("sap", {
          name: t("Effect.sap"), img: "icons/svg/downgrade.svg", source: attacker.actor, expire: "start"
        });
        await run("createEffect", { actor: target.actor, data, replaceType: "sap" }, target.actor, target.name);
        return "done";
      }
      case "slow": {
        const data = effectData("slow", {
          name: t("Effect.slow"), img: "icons/svg/net.svg", source: attacker.actor, expire: "start",
          changes: [{ key: "system.attributes.movement.bonus", mode: CONST.ACTIVE_EFFECT_MODES.ADD, value: "-10" }]
        });
        await run("createEffect", { actor: target.actor, data, replaceType: "slow" }, target.actor, target.name);
        return "done";
      }
      case "vex": {
        const data = effectData("vex", {
          name: t("Effect.vex", { name: target.name }), img: "icons/svg/target.svg", source: attacker.actor,
          expire: "end", extra: { target: target.token, targetActor: target.actor }
        });
        await run("createEffect", { actor: attacker.actor, data }, attacker.actor, attacker.name);
        return "done";
      }
      case "topple": {
        return await run("topple", { actor: target.actor, dc: card.dc }, target.actor, target.name);
      }
      case "push": return await push(card, target);
      case "cleave": {
        const first = fromUuidSync(target.token)?.object;
        const activity = fromUuidSync(card.activity);
        if ( first && activity ) await openCleaveDialog(activity, first);
        return null;
      }
    }
  } catch(err) {
    console.error(`${MODULE_ID} | ${mastery}`, err);
    ui.notifications.error(t("Failed", { mastery: masteryLabel(mastery), name: target.name }));
  }
  return null;
}

async function push(card, target) {
  const tokenDoc = fromUuidSync(target.token);
  const from = fromUuidSync(card.attacker.token)?.object;
  const token = tokenDoc?.object;
  if ( !token || !from ) return null;

  let dx = token.center.x - from.center.x;
  let dy = token.center.y - from.center.y;
  const len = Math.hypot(dx, dy) || 1;
  dx = Math.round(dx / len);
  dy = Math.round(dy / len);
  if ( !dx && !dy ) return null;

  const squares = Math.max(1, Math.round(10 / (canvas.scene.grid.distance || 5)));
  const step = canvas.grid.size;
  let moved = 0;
  for ( let i = 1; i <= squares; i++ ) {
    const origin = { x: token.center.x + dx * step * (i - 1), y: token.center.y + dy * step * (i - 1) };
    const dest = { x: token.center.x + dx * step * i, y: token.center.y + dy * step * i };
    let blocked = false;
    try {
      blocked = CONFIG.Canvas.polygonBackends.move.testCollision(origin, dest, { type: "move", mode: "any" });
    } catch(err) { /* collision API unavailable: allow the move */ }
    if ( blocked ) break;
    moved = i;
  }
  if ( !moved ) {
    ui.notifications.warn(t("PushBlocked"));
    return null;
  }
  await run("move", {
    token: target.token, x: tokenDoc.x + dx * step * moved, y: tokenDoc.y + dy * step * moved
  }, target.token, target.name);
  return "done";
}

/* -------------------------------------------- */
/*  Chat card                                   */
/* -------------------------------------------- */

function buttonLabel(mastery, card) {
  switch ( mastery ) {
    case "graze": return t("Button.graze", { value: card.graze.value, type: damageTypeLabel(card.graze.type) });
    case "topple": return t("Button.topple", { dc: card.dc });
    default: return t(`Button.${mastery}`);
  }
}

function targetRow(mastery, card, target) {
  const result = card.results?.[target.token.replaceAll(".", "_")];
  let right;
  if ( mastery === "nick" ) right = "";
  else if ( result ) {
    const text = mastery === "topple" ? t(`ToppleResult.${result}`) : t("Applied");
    right = `<span class="done"><i class="fas fa-check"></i> ${esc(text)}</span>`;
  }
  else if ( (mastery === "graze") && (card.graze.value <= 0) ) {
    right = `<span class="note">${esc(t("GrazeNone", { mod: card.graze.value }))}</span>`;
  }
  else if ( (mastery === "push") && !target.pushable ) right = `<span class="note">${esc(t("TooLarge"))}</span>`;
  else right = `<button type="button" data-wm-target="${esc(target.token)}">${esc(buttonLabel(mastery, card))}</button>`;
  return `<li><img src="${esc(target.img)}" alt=""><span class="name">${esc(target.name)}</span>${right}</li>`;
}

function cardContent(card) {
  const { mastery } = card;
  const rows = card.targets.length
    ? card.targets.map(tg => targetRow(mastery, card, tg)).join("")
    : `<li class="note">${esc(t("NoTargets"))}</li>`;
  return `<div class="dnd5e-wm-card" data-mastery="${mastery}">
    <header>
      <img src="${esc(card.img)}" alt="">
      <div><h3>${esc(masteryLabel(mastery))}</h3>
      <div class="subtitle">${esc(t("CardSubtitle", { weapon: card.weapon }))}</div></div>
    </header>
    <p class="rule">${esc(t(`Rule.${mastery}`, { dc: card.dc }))}</p>
    <ul class="targets">${rows}</ul>
  </div>`;
}

async function postCard(card) {
  const actor = fromUuidSync(card.attacker.actor);
  const message = await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor, token: fromUuidSync(card.attacker.token) }),
    content: cardContent(card),
    flags: { [MODULE_ID]: { card } }
  });

  if ( setting("autoApply") && ["graze", "sap", "slow", "vex", "topple"].includes(card.mastery) ) {
    for ( const target of card.targets ) await resolveButton(message, target.token);
  }
  return message;
}

async function resolveButton(message, tokenUuid) {
  const card = message.getFlag(MODULE_ID, "card");
  const target = card?.targets.find(tg => tg.token === tokenUuid);
  if ( !target ) return;
  const result = await applyMastery(card.mastery, card, target);
  if ( !result ) return;
  card.results ??= {};
  card.results[tokenUuid.replaceAll(".", "_")] = result;
  if ( message.isOwner ) {
    await message.update({ content: cardContent(card), [`flags.${MODULE_ID}.card`]: card });
  }
}

function buildCard(mastery, activity, info, targets) {
  const actor = activity.actor;
  const token = tokenFor(actor);
  const abilityMod = actor.system.abilities?.[info.ability]?.mod ?? 0;
  return {
    mastery,
    activity: activity.uuid,
    weapon: activity.item.name,
    img: activity.item.img,
    attacker: {
      actor: actor.uuid,
      token: token?.document?.uuid ?? null,
      name: token?.name ?? actor.name
    },
    dc: 8 + abilityMod + (actor.system.attributes?.prof ?? 0),
    graze: {
      value: abilityMod,
      type: damageType(activity),
      properties: [...(activity.item.system.properties ?? [])]
    },
    targets: targets.map(tg => ({
      ...tg,
      pushable: PUSHABLE.has(fromUuidSync(tg.actor)?.system.traits?.size ?? "med")
    })),
    results: {}
  };
}

/* -------------------------------------------- */
/*  Cleave                                      */
/* -------------------------------------------- */

async function openCleaveDialog(activity, first) {
  const actor = activity.actor;
  const attacker = tokenFor(actor);
  if ( !attacker ) return;

  const key = turnKey();
  if ( key && (cleaveUsed.get(actor.uuid) === key) ) {
    ui.notifications.info(t("Cleave.Used"));
    return;
  }

  const gridFt = canvas.scene.grid.distance || 5;
  const reachFt = activity.item.system.properties?.has("rch") ? 10 : 5;
  const reach = Math.max(0, Math.round(reachFt / gridFt) - 1);
  const candidates = canvas.tokens.placeables.filter(tk => {
    if ( !tk.actor || (tk === attacker) || (tk === first) || tk.document.hidden ) return false;
    if ( (tk.actor.system.attributes?.hp?.value ?? 1) <= 0 ) return false;
    return (gapSquares(tk, first) === 0) && (gapSquares(tk, attacker) <= reach);
  });

  if ( !candidates.length ) {
    ui.notifications.info(t("Cleave.None", { name: first.name }));
    return;
  }

  const choices = candidates.map((tk, i) => `<label>
      <input type="radio" name="target" value="${esc(tk.id)}" ${i === 0 ? "checked" : ""}>
      <img src="${esc(tk.document.texture.src)}" alt=""><span>${esc(tk.name)}</span>
    </label>`).join("");

  const chosen = await foundry.applications.api.DialogV2.wait({
    window: { title: t("Cleave.Title", { weapon: activity.item.name }), icon: "fas fa-axe" },
    classes: ["dnd5e-wm-cleave"],
    content: `<p class="hint">${esc(t("Cleave.Hint", { name: first.name, reach: reachFt }))}</p>
      <div class="choices">${choices}</div>`,
    buttons: [
      {
        action: "attack", label: t("Cleave.Attack"), icon: "fas fa-swords", default: true,
        callback: (event, button) => button.form.elements.target?.value ?? null
      },
      { action: "skip", label: t("Cleave.Skip"), icon: "fas fa-times" }
    ],
    rejectClose: false
  });
  const token = (typeof chosen === "string") && (chosen !== "skip") ? canvas.tokens.get(chosen) : null;
  if ( !token ) return;

  if ( key ) cleaveUsed.set(actor.uuid, key);
  setTargets(token);
  cleaveNext = activity.uuid;
  try {
    await activity.rollAttack({});
  } finally {
    if ( cleaveNext === activity.uuid ) cleaveNext = null;
  }
}

function setTargets(token) {
  if ( typeof canvas.tokens.setTargets === "function" ) canvas.tokens.setTargets([token.id]);
  else token.setTarget(true, { user: game.user, releaseOthers: true });
}

/* -------------------------------------------- */
/*  Roll hooks                                  */
/* -------------------------------------------- */

/** Sap gives disadvantage, Vex gives advantage against its target. */
function onPreRollAttack(config) {
  const activity = config.subject;
  const actor = activity?.actor;
  const options = config.rolls?.[0]?.options;
  if ( !actor || !options ) return;

  const used = [];
  const targetUuids = new Set([...game.user.targets].map(tk => tk.document.uuid));
  for ( const effect of actor.appliedEffects ?? actor.effects ) {
    const type = effect.getFlag(MODULE_ID, "type");
    if ( type === "sap" ) {
      options.disadvantage = true;
      used.push(effect.uuid);
    } else if ( (type === "vex") && targetUuids.has(effect.getFlag(MODULE_ID, "target")) ) {
      options.advantage = true;
      used.push(effect.uuid);
    }
  }
  if ( used.length ) toConsume.set(activity.uuid, used);
  else toConsume.delete(activity.uuid);
}

/** Record which targets were hit, consume Sap/Vex, and post Graze on a miss. */
async function onRollAttack(rolls, { subject: activity } = {}) {
  const roll = rolls?.[0];
  if ( !roll || !activity?.actor ) return;

  const consumed = toConsume.get(activity.uuid);
  if ( consumed ) {
    toConsume.delete(activity.uuid);
    const actor = activity.actor;
    run("deleteEffects", { uuids: consumed }, actor.uuid, actor.name);
  }

  const isCleave = cleaveNext === activity.uuid;
  if ( isCleave ) cleaveNext = null;
  const mastery = isCleave ? null : roll.options.mastery;
  if ( !mastery && !isCleave ) {
    pending.delete(activity.uuid);
    return;
  }

  const targets = [...game.user.targets].filter(tk => tk.actor).map(describe);
  const hits = [];
  const misses = [];
  for ( const target of targets ) {
    let hit;
    if ( roll.isCritical ) hit = true;
    else if ( roll.isFumble ) hit = false;
    else hit = (target.ac === null) || (roll.total >= target.ac);
    (hit ? hits : misses).push(target);
  }

  const info = { ability: roll.options.ability };
  if ( (mastery === "graze") && misses.length ) await postCard(buildCard("graze", activity, info, misses));

  if ( (isCleave || (mastery !== "graze")) && (hits.length || !targets.length) ) {
    pending.set(activity.uuid, { mastery, isCleave, info, hits, time: Date.now() });
  } else pending.delete(activity.uuid);
}

/** Cleave's follow-up attack doesn't add a positive ability modifier to its damage. */
function onPreRollDamage(config) {
  const entry = pending.get(config.subject?.uuid);
  if ( !entry?.isCleave || (Date.now() - entry.time > PENDING_TTL) ) return;
  for ( const roll of config.rolls ?? [] ) {
    if ( roll.data?.mod > 0 ) roll.data.mod = 0;
  }
}

/** Post the mastery card once damage is rolled for a hit. */
async function onRollDamage(rolls, { subject: activity } = {}) {
  const entry = activity ? pending.get(activity.uuid) : null;
  if ( !entry ) return;
  pending.delete(activity.uuid);
  if ( entry.isCleave || !ON_HIT.includes(entry.mastery) ) return;
  if ( Date.now() - entry.time > PENDING_TTL ) return;

  const card = buildCard(entry.mastery, activity, entry.info, entry.hits);
  await postCard(card);

  if ( (entry.mastery === "cleave") && setting("cleaveDialog") && entry.hits.length
    && (activity.attack?.type?.value !== "ranged") ) {
    const first = fromUuidSync(entry.hits[0].token)?.object;
    if ( first ) await openCleaveDialog(activity, first);
  }
}

/* -------------------------------------------- */
/*  Effect expiry                               */
/* -------------------------------------------- */

function isAfter(point, stamp) {
  return (point.round > stamp.round) || ((point.round === stamp.round) && (point.turn > stamp.turn));
}

async function onUpdateCombat(combat, changed) {
  if ( !game.user.isActiveGM ) return;
  if ( !("turn" in changed) && !("round" in changed) ) return;
  const current = { round: combat.round, turn: combat.turn, actor: combat.combatant?.actor?.uuid };
  const prevCombatant = combat.combatants.get(combat.previous?.combatantId);
  const previous = combat.previous
    ? { round: combat.previous.round, turn: combat.previous.turn, actor: prevCombatant?.actor?.uuid }
    : null;

  const actors = new Set(game.actors);
  for ( const tk of canvas.tokens?.placeables ?? [] ) if ( tk.actor ) actors.add(tk.actor);

  for ( const actor of actors ) {
    const expired = actor.effects.filter(effect => {
      const exp = effect.getFlag(MODULE_ID, "expire");
      if ( !exp || (exp.combat !== combat.id) ) return false;
      const source = effect.getFlag(MODULE_ID, "source");
      if ( exp.when === "start" ) return (current.actor === source) && isAfter(current, exp);
      return previous && (previous.actor === source) && isAfter(previous, exp);
    }).map(e => e.id);
    if ( expired.length ) await actor.deleteEmbeddedDocuments("ActiveEffect", expired);
  }
}

/* -------------------------------------------- */
/*  Registration                                */
/* -------------------------------------------- */

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "autoApply", {
    name: "DND5EWM.Settings.autoApply.name",
    hint: "DND5EWM.Settings.autoApply.hint",
    scope: "world", config: true, type: Boolean, default: false
  });
  game.settings.register(MODULE_ID, "cleaveDialog", {
    name: "DND5EWM.Settings.cleaveDialog.name",
    hint: "DND5EWM.Settings.cleaveDialog.hint",
    scope: "world", config: true, type: Boolean, default: true
  });
  game.settings.register(MODULE_ID, "playerButtons", {
    name: "DND5EWM.Settings.playerButtons.name",
    hint: "DND5EWM.Settings.playerButtons.hint",
    scope: "world", config: true, type: Boolean, default: true
  });

  CONFIG.queries[QUERY] = async ({ action, data }) => {
    if ( !game.user.isGM || !ACTIONS[action] ) return null;
    return ACTIONS[action](data);
  };
});

Hooks.on("dnd5e.preRollAttackV2", onPreRollAttack);
Hooks.on("dnd5e.rollAttackV2", onRollAttack);
Hooks.on("dnd5e.preRollDamageV2", onPreRollDamage);
Hooks.on("dnd5e.rollDamageV2", onRollDamage);
Hooks.on("updateCombat", onUpdateCombat);

Hooks.on("renderChatMessageHTML", (message, html) => {
  const card = message.getFlag(MODULE_ID, "card");
  if ( !card ) return;
  const canUse = game.user.isGM || (message.isAuthor && setting("playerButtons"));
  for ( const button of html.querySelectorAll(".dnd5e-wm-card button[data-wm-target]") ) {
    if ( !canUse ) {
      button.remove();
      continue;
    }
    button.addEventListener("click", async event => {
      event.preventDefault();
      button.disabled = true;
      try {
        await resolveButton(message, button.dataset.wmTarget);
      } finally {
        button.disabled = false;
      }
    });
  }
});

Hooks.once("ready", () => {
  game.modules.get(MODULE_ID).api = { openCleaveDialog, applyMastery };
});
