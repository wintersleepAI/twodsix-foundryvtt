import { fields, requiredBlankString, requiredInteger } from '../commonSchemaUtils.js';
import { TwodsixItemBaseData } from './baseItemData.js';

export class ShipPositionData extends TwodsixItemBaseData {
  static defineSchema() {
    const schema = super.defineSchema();
    schema.name = new fields.StringField({...requiredBlankString});
    schema.icon = new fields.StringField({...requiredBlankString});
    schema.actions = new fields.ObjectField({required: true, initial: {}});
    schema.order = new fields.NumberField({...requiredInteger, initial: 0});
    // Added to the ship's defaultSkillLevel when this position has no actor and the ship allows that
    schema.uncrewedSkillModifier = new fields.NumberField({...requiredInteger, initial: 0});
    return schema;
  }
}
