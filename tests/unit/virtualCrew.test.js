import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

// Unit tests for ship positions that act without an assigned actor, using the ship's in-memory "virtual crew"
// (ShipActor#getVirtualCrewActor).  Foundry is stubbed: documents are plain objects on a fake Actor base class.

const CHARACTERISTICS = {
  strength: 'STR', dexterity: 'DEX', endurance: 'END', intelligence: 'INT', education: 'EDU',
  socialStanding: 'SOC', psionicStrength: 'PSI', alternative1: 'ALT1', alternative2: 'ALT2', alternative3: 'ALT3'
};

vi.mock('../../src/module/config', () => ({
  TWODSIX: {
    CHARACTERISTICS: {
      strength: 'STR', dexterity: 'DEX', endurance: 'END', intelligence: 'INT', education: 'EDU',
      socialStanding: 'SOC', psionicStrength: 'PSI', alternative1: 'ALT1', alternative2: 'ALT2', alternative3: 'ALT3'
    },
    DIFFICULTIES: {standard: {Average: {mod: 0, target: 8}}},
    ROLLTYPES: {Normal: {key: 'Normal', formula: '2d6'}},
    SHIP_ACTION_TYPE: {chatMessage: 'chatMessage', skillRoll: 'skillRoll', fireEnergyWeapons: 'fireEnergyWeapons', executeMacro: 'executeMacro'},
    TARGET_DM: {},
    TimeUnits: {}
  },
  COMPONENT_SUBTYPES: {},
  CONSUMABLE_SUBTYPES: {}
}));
vi.mock('../../src/module/utils/actorDamage', () => ({}));
vi.mock('../../src/module/utils/migration-utils', () => ({}));
vi.mock('../../src/module/utils/sheetUtils', () => ({
  confirmRollFormula: vi.fn(),
  enrichContextFields: vi.fn(),
  getDamageTypes: vi.fn(),
  getDataFromDropEvent: vi.fn(),
  getDifficultiesSelectObject: () => ({}),
  getDocFromDropData: vi.fn(),
  getRollTypeSelectObject: () => ({})
}));
vi.mock('../../src/module/utils/targetModifiers', () => ({getTargetDMSelectObject: () => ({})}));
vi.mock('../../src/module/utils/shipDamage', () => ({}));
vi.mock('../../src/module/hooks/timeIntegration', () => ({}));
vi.mock('../../src/module/hooks/updateFinances', () => ({}));
vi.mock('../../src/module/i18n', () => ({}));
vi.mock('../../src/module/entities/TwodsixActiveEffect', () => ({}));
vi.mock('../../src/module/entities/TwodsixItem', () => ({default: class {}}));
vi.mock('../../src/module/sheets/AbstractTwodsixActorSheet', () => ({AbstractTwodsixActorSheet: class {}}));
vi.mock('../../src/module/sheets/TwodsixShipPositionSheet', () => ({TwodsixShipPositionSheet: class {}}));
vi.mock('../../src/module/sheets/TwodsixVehicleSheet', () => ({getControlledTraveller: vi.fn()}));

/** Flatten en.json so the stubbed localize uses the real strings (and a missing key shows up as the key) */
function flatten(object, prefix = '') {
  return Object.entries(object).reduce((flat, [key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return Object.assign(flat, (value && typeof value === 'object') ? flatten(value, path) : {[path]: value});
  }, {});
}
const LANG = flatten(JSON.parse(readFileSync(new URL('../../static/lang/en.json', import.meta.url), 'utf8')));

const settings = {
  difficultyListUsed: 'standard',
  ruleset: 'CE',
  rangeModifierType: 'none',
  invertSkillRollShiftClick: false,
  hideUntrainedSkills: false,
  showAlternativeCharacteristics: 'base',
  useWoundedStatusIndicators: false,
  useEncumbranceStatusIndicators: false,
  componentDamageDM: -1
};

let TwodsixActor;
let ShipActor;
let TwodsixRollSettings;
let TwodsixDiceRoll;
let TwodsixShipActions;
let TwodsixShipSheet;
let onChatCardAction;
let getControlledTraveller;
let getSkillFromSelectionKey;

/**
 * Minimal stand-in for Foundry's Actor.  An actor built without an _id is unsaved, so (as in Foundry) it and its
 * items have a null uuid.
 */
class FakeActor {
  constructor(source) {
    this.id = source._id ?? null;
    this.uuid = this.id ? `Actor.${this.id}` : null;
    this.name = source.name;
    this.type = source.type;
    this.img = source.img;
    this.flags = source.flags ?? {};
    this.system = {
      characteristics: Object.fromEntries(Object.entries(CHARACTERISTICS).map(([key, label]) => [
        key, {key, shortLabel: label, displayShortLabel: label, mod: 0}
      ])),
      conditions: {},
      ...structuredClone(source.system ?? {})
    };
    this.appliedEffects = [];
    this._items = (source.items ?? []).map(data => ({
      ...data,
      id: data._id,
      system: {...data.system},
      actor: this,
      uuid: this.uuid ? `${this.uuid}.Item.${data._id}` : null,
      getFlag: (scope, key) => data.flags?.[scope]?.[key]
    }));
    this.items = {
      get: id => this._items.find(item => item.id === id),
      find: predicate => this._items.find(predicate),
      getName: name => this._items.find(item => item.name === name),
      [Symbol.iterator]: () => this._items[Symbol.iterator]()
    };
  }

  get itemTypes() {
    return {
      skills: this._items.filter(item => item.type === 'skills'),
      ship_position: this._items.filter(item => item.type === 'ship_position')
    };
  }

  getFlag(scope, key) {
    return this.flags?.[scope]?.[key];
  }

  getActiveTokens() {
    return [];
  }

  prepareDerivedData() {}
}

beforeAll(async () => {
  vi.stubGlobal('Actor', FakeActor);
  vi.stubGlobal('game', {
    i18n: {
      lang: 'en',
      localize: key => LANG[key] ?? key,
      format: (key, data = {}) => Object.entries(data).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, value), LANG[key] ?? key)
    },
    settings: {get: (_scope, key) => settings[key]},
    user: {isGM: true},
    messages: {get: vi.fn()},
    actors: {get: vi.fn()}
  });
  let nextId = 0;
  vi.stubGlobal('foundry', {
    utils: {randomID: () => `item${++nextId}`},
    applications: {
      api: {DialogV2: {wait: vi.fn()}, HandlebarsApplicationMixin: base => base},
      sidebar: {tabs: {ChatLog: class {}}, apps: {ChatPopout: class {}}},
      handlebars: {renderTemplate: vi.fn()}
    }
  });
  vi.stubGlobal('CONFIG', {
    ChatMessage: {modes: {}},
    Item: {dataModels: {skills: {schema: {getInitialValue: () => ({value: -3})}}}}
  });
  vi.stubGlobal('ui', {notifications: {error: vi.fn(), warn: vi.fn()}});
  vi.stubGlobal('fromUuid', vi.fn());
  vi.stubGlobal('fromUuidSync', vi.fn());
  vi.stubGlobal('ChatMessage', {getSpeaker: vi.fn(), create: vi.fn()});
  vi.stubGlobal('CONST', {CHAT_MESSAGE_STYLES: {OTHER: 0}});

  ({default: TwodsixActor} = await import('../../src/module/entities/actors/actor-base.js'));
  ({ShipActor} = await import('../../src/module/entities/actors/ShipActor.js'));
  ({TwodsixRollSettings} = await import('../../src/module/utils/TwodsixRollSettings.js'));
  ({TwodsixDiceRoll} = await import('../../src/module/utils/TwodsixDiceRoll.js'));
  ({TwodsixShipActions} = await import('../../src/module/utils/TwodsixShipActions.js'));
  ({TwodsixShipSheet} = await import('../../src/module/sheets/TwodsixShipSheet.js'));
  ({onChatCardAction} = await import('../../src/module/entities/TwodsixChat.js'));
  ({getControlledTraveller} = await import('../../src/module/sheets/TwodsixVehicleSheet.js'));
  ({getSkillFromSelectionKey} = await import('../../src/module/utils/utils.js'));

  // What `new Actor.implementation(...)` builds: a traveller whose skill proxy is prepared, as Foundry would
  FakeActor.implementation = class extends TwodsixActor {
    constructor(source) {
      super(source);
      this._prepareSkillProxy();
    }
  };
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.resetAllMocks();
  game.user.isGM = true;
});

/** A position as ShipActor#_prepareShipPositions leaves it, with system.actors resolved */
function position(id, {modifier = 0, actors = [], actions = {}} = {}) {
  return {_id: id, name: id, type: 'ship_position', system: {uncrewedSkillModifier: modifier, actors, actions}};
}

function ship({allow = true, defaultSkillLevel = 1, positions = [position('Pilot')]} = {}) {
  return new ShipActor({
    _id: 'ship', name: 'Beowulf', type: 'ship', img: 'ship.webp',
    system: {shipAllowNoActorPositions: allow, defaultSkillLevel}, items: positions
  });
}

function traveller({saved = true, skills = []} = {}) {
  const untrained = {_id: 'untrained', name: 'Untrained', type: 'skills', system: {value: -3, characteristic: 'NONE'}, flags: {twodsix: {untrainedSkill: true}}};
  return new Actor.implementation({
    _id: saved ? 'crew' : undefined, name: 'Jamison', type: 'traveller',
    system: {untrainedSkill: 'untrained'}, items: [untrained, ...skills]
  });
}

describe('ShipActor virtual crew', () => {
  test('the uncrewed skill level is the ship default plus the position modifier', () => {
    const shipActor = ship({defaultSkillLevel: 1, positions: [position('Pilot', {modifier: 2})]});
    expect(shipActor.getUncrewedSkillLevel(shipActor.items.get('Pilot'))).toBe(3);
  });

  test('a cleared default skill level falls back to the untrained level', () => {
    const shipActor = ship({defaultSkillLevel: null, positions: [position('Pilot', {modifier: 1})]});
    expect(shipActor.getUncrewedSkillLevel(shipActor.items.get('Pilot'))).toBe(-2);
  });

  test('a position is uncrewed only when the ship allows it and no actor is assigned', () => {
    const crewed = position('Gunner', {actors: [{id: 'a1'}]});
    expect(ship({allow: true}).isUncrewedPosition(position('Pilot'))).toBe(true);
    expect(ship({allow: false}).isUncrewedPosition(position('Pilot'))).toBe(false);
    expect(ship({allow: true}).isUncrewedPosition(crewed)).toBe(false);
  });

  test('the virtual crew is an unsaved traveller that uses the uncrewed level for every skill', () => {
    const shipActor = ship({defaultSkillLevel: 1, positions: [position('Pilot', {modifier: 1})]});
    const crew = shipActor.getVirtualCrewActor(shipActor.items.get('Pilot'));
    expect(crew.uuid).toBeNull();
    expect(crew.type).toBe('traveller');
    expect(crew.name).toBe('Beowulf Crew');
    expect(crew.img).toBe('ship.webp');
    expect(crew.getUntrainedSkill().system.value).toBe(2);
    expect(crew.system.skills.Pilot).toBe(2);
    expect(crew.system.skills.Astrogation).toBe(2);
  });

  test('each position keeps its own actor until its skill level changes', () => {
    const shipActor = ship({positions: [position('Pilot'), position('Gunner', {modifier: 2})]});
    const pilot = shipActor.items.get('Pilot');
    const pilotCrew = shipActor.getVirtualCrewActor(pilot);
    const gunnerCrew = shipActor.getVirtualCrewActor(shipActor.items.get('Gunner'));
    expect(shipActor.getVirtualCrewActor(pilot)).toBe(pilotCrew);
    expect(gunnerCrew).not.toBe(pilotCrew);
    expect(gunnerCrew.getUntrainedSkill().system.value).toBe(3);

    pilot.system.uncrewedSkillModifier = 1;
    const rebuilt = shipActor.getVirtualCrewActor(pilot);
    expect(rebuilt).not.toBe(pilotCrew);
    expect(rebuilt.getUntrainedSkill().system.value).toBe(2);

    shipActor.system.defaultSkillLevel = 0;
    expect(shipActor.getVirtualCrewActor(pilot).getUntrainedSkill().system.value).toBe(1);
  });
});

describe('skill selection', () => {
  test('an unsaved actor lists and preselects its skills by item id, so the dialog choice sticks', async () => {
    const shipActor = ship();
    const crew = shipActor.getVirtualCrewActor(shipActor.items.get('Pilot'));
    const skill = crew.getUntrainedSkill();
    const rollSettings = new TwodsixRollSettings({}, skill, null, crew);
    await rollSettings._throwDialog('Untrained', skill);

    const dialogData = foundry.applications.handlebars.renderTemplate.mock.calls[0][1];
    expect(dialogData.skillsList).toEqual({[skill.id]: 'Untrained (1)'});
    expect(dialogData.initialSkill).toBe(skill.id);
  });

  test('a saved actor still lists and preselects its skills by uuid', () => {
    const actor = traveller();
    const skill = actor.getUntrainedSkill();
    expect(actor.getSkillNameList()).toEqual({[skill.uuid]: 'Untrained (-3)'});
    expect(new TwodsixRollSettings({}, skill, null, actor).rollModifiers.selectedSkill).toBe(skill.uuid);
  });

  test('item id keys resolve on the unsaved actor without fromUuidSync', () => {
    const actor = traveller({saved: false});
    expect(getSkillFromSelectionKey('untrained', actor)).toBe(actor.getUntrainedSkill());
    expect(getSkillFromSelectionKey('missing', actor)).toBeNull();
    expect(fromUuidSync).not.toHaveBeenCalled();
  });

  test('uuid keys on a saved actor resolve through fromUuidSync', () => {
    const actor = traveller();
    const other = {name: 'Other'};
    fromUuidSync.mockReturnValue(other);
    expect(getSkillFromSelectionKey('Actor.other.Item.x', actor)).toBe(other);
    expect(fromUuidSync).toHaveBeenCalledWith('Actor.other.Item.x');
  });

  test('the roll uses the skill chosen in the dialog for an unsaved actor', () => {
    const pilot = {_id: 'pilot', name: 'Pilot', type: 'skills', system: {value: 2, characteristic: 'DEX'}};
    const actor = traveller({saved: false, skills: [pilot]});
    const roll = new TwodsixDiceRoll({rollModifiers: {selectedSkill: 'pilot'}}, actor, actor.getUntrainedSkill());
    expect(roll.skill).toBe(actor.items.get('pilot'));
  });

  test('changing the dialog skill finds the new skill by item id', async () => {
    const pilot = {_id: 'pilot', name: 'Pilot', type: 'skills', system: {value: 2, characteristic: 'DEX'}};
    const actor = traveller({saved: false, skills: [pilot]});
    const untrained = actor.getUntrainedSkill();
    const characteristic = {value: 'NONE'};
    const title = {innerText: 'Untrained'};
    let onSkillChange;
    const elements = {
      '.select-skill': {addEventListener: (_type, listener) => {
        onSkillChange = listener;
      }},
      '[name="rollModifiers.characteristic"]': characteristic,
      '[name="rollModifiers.selectedSkill"]': {value: 'pilot'},
      '.window-title': title
    };
    foundry.applications.api.DialogV2.wait.mockImplementation(async ({render}) => {
      render({}, {element: {querySelector: selector => elements[selector]}});
      onSkillChange();
    });

    await new TwodsixRollSettings({}, untrained, null, actor)._throwDialog('Untrained', untrained);
    expect(characteristic.value).toBe('DEX');
    expect(title.innerText).toBe('Pilot');
    expect(fromUuidSync).not.toHaveBeenCalled();
  });
});

describe('ship actions by the virtual crew', () => {
  function extra(shipActor, crew, component) {
    return {actor: crew, ship: shipActor, component, event: {shiftKey: true}, actionName: 'Fly', positionName: 'Pilot'};
  }

  test('skill rolls send chat-card actions through the ship', async () => {
    const shipActor = ship();
    const crew = shipActor.getVirtualCrewActor(shipActor.items.get('Pilot'));
    const skill = crew.getUntrainedSkill();
    skill.skillRoll = vi.fn().mockResolvedValue('rolled');

    expect(await TwodsixShipActions.skillRoll('Pilot 8+', extra(shipActor, crew))).toBe('rolled');
    const options = skill.skillRoll.mock.calls[0][1];
    expect(options.flags.actorUUID).toBe(shipActor.uuid);
    expect(options.flags.tokenUUID).toBe(shipActor.uuid);
    expect(options.rollModifiers.skillValue).toBe(1);
  });

  test('component actions hand the virtual crew to the component', async () => {
    const shipActor = ship();
    const crew = shipActor.getVirtualCrewActor(shipActor.items.get('Pilot'));
    const component = {type: 'component', name: 'Laser', uuid: 'Actor.ship.Item.laser', system: {}, skillRoll: vi.fn()};

    await TwodsixShipActions.skillRoll('Pilot 8+', extra(shipActor, crew, component));
    const [, options, , rollOptions] = component.skillRoll.mock.calls[0];
    expect(rollOptions).toEqual({actor: crew});
    expect(options.flags.actorUUID).toBe(shipActor.uuid);
  });

  test('characteristic-only actions carry the same chat-card flags', async () => {
    const shipActor = ship();
    const crew = shipActor.getVirtualCrewActor(shipActor.items.get('Pilot'));
    crew.characteristicRoll = vi.fn();

    await TwodsixShipActions.skillRoll('None/INT 8+', extra(shipActor, crew));
    expect(crew.characteristicRoll.mock.calls[0][0].flags).toEqual({tokenUUID: shipActor.uuid, actorUUID: shipActor.uuid});
  });
});

describe('performShipAction', () => {
  const action = {name: 'Fly', type: 'skillRoll', command: 'Pilot 8+', component: ''};
  let skillRollAction;

  beforeEach(() => {
    skillRollAction = TwodsixShipActions.availableMethods.skillRoll.action;
    TwodsixShipActions.availableMethods.skillRoll.action = vi.fn();
  });

  afterEach(() => {
    TwodsixShipActions.availableMethods.skillRoll.action = skillRollAction;
  });

  test('an uncrewed position acts through its virtual crew when the ship allows it', () => {
    const shipActor = ship({positions: [position('Pilot', {actions: {fly: action}})]});
    expect(TwodsixShipSheet.performShipAction({}, 'Pilot', '', 'fly', shipActor)).toBe(true);
    const extra = TwodsixShipActions.availableMethods.skillRoll.action.mock.calls[0][1];
    expect(extra.actor).toBe(shipActor.getVirtualCrewActor(shipActor.items.get('Pilot')));
  });

  test('an uncrewed position still needs an actor when the ship does not allow it', () => {
    const shipActor = ship({allow: false, positions: [position('Pilot', {actions: {fly: action}})]});
    expect(TwodsixShipSheet.performShipAction({}, 'Pilot', '', 'fly', shipActor)).toBe(false);
    expect(ui.notifications.warn).toHaveBeenCalledWith('TWODSIX.Ship.ActorMustBeSelectedForAction', {localize: true});
    expect(TwodsixShipActions.availableMethods.skillRoll.action).not.toHaveBeenCalled();
  });

  test('a crewed position still needs one of its actors chosen', () => {
    const shipActor = ship({positions: [position('Pilot', {actions: {fly: action}, actors: [{id: 'a1'}]})]});
    expect(TwodsixShipSheet.performShipAction({}, 'Pilot', '', 'fly', shipActor)).toBe(false);
    expect(TwodsixShipActions.availableMethods.skillRoll.action).not.toHaveBeenCalled();
  });

  test('a chosen actor is used as before', () => {
    const shipActor = ship({positions: [position('Pilot', {actions: {fly: action}, actors: [{id: 'crew'}]})]});
    const actor = traveller();
    game.actors.get.mockReturnValue(actor);
    TwodsixShipSheet.performShipAction({}, 'Pilot', 'crew', 'fly', shipActor);
    expect(TwodsixShipActions.availableMethods.skillRoll.action.mock.calls[0][1].actor).toBe(actor);
  });
});

describe('chat card buttons', () => {
  function clickButton(action, flags, speaker = {actor: 'crew'}, alias = 'Jamison') {
    const message = {getFlag: (_scope, key) => flags[key], speaker, alias};
    game.messages.get.mockReturnValue(message);
    const target = {dataset: {action}, closest: () => ({dataset: {messageId: 'message'}})};
    return onChatCardAction({preventDefault() {}, shiftKey: true}, target);
  }

  test('chain rolls do not look up the rolled item', async () => {
    fromUuid.mockResolvedValue({isOwner: true});
    await clickButton('chain', {actorUUID: 'Actor.ship', itemUUID: 'Actor.ship.Item.deleted'});
    expect(fromUuid).toHaveBeenCalledTimes(1);
    expect(fromUuid).toHaveBeenCalledWith('Actor.ship');
  });

  test('damage still needs the rolled item', async () => {
    const weapon = {rollDamage: vi.fn()};
    fromUuid.mockImplementation(async uuid => uuid === 'Actor.ship' ? {isOwner: true} : weapon);
    await clickButton('damage', {actorUUID: 'Actor.ship', itemUUID: 'Actor.ship.Item.laser', effect: 2});
    expect(weapon.rollDamage).toHaveBeenCalled();
  });

  async function opposedWinner(speaker, alias) {
    const opponent = traveller();
    const opponentSkill = opponent.getUntrainedSkill();
    opponentSkill.skillRoll = vi.fn().mockResolvedValue({effect: 1});
    getControlledTraveller.mockReturnValue(opponent);
    foundry.applications.api.DialogV2.wait.mockImplementation(async ({buttons}) => {
      buttons[0].callback(null, null, {element: {querySelector: () => ({value: opponentSkill.uuid})}});
    });
    fromUuid.mockImplementation(async uuid => uuid === 'Actor.ship' ? {name: 'Beowulf', isOwner: true} : opponentSkill);
    await clickButton('opposed', {actorUUID: 'Actor.ship', effect: 3}, speaker, alias);
    return ChatMessage.create.mock.calls[0][0].content;
  }

  test('an opposed roll won by the virtual crew names the crew, not the ship', async () => {
    expect(await opposedWinner({actor: null, alias: 'Beowulf Crew'}, 'Beowulf Crew')).toBe('Beowulf Crew wins contested / opposed roll.');
  });

  test('an opposed roll won by a saved actor still names the actor', async () => {
    expect(await opposedWinner({actor: 'ship'}, 'A token name')).toBe('Beowulf wins contested / opposed roll.');
  });
});
