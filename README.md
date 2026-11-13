# D&D 5e Weapon Mastery Automation

Automates all eight D&D 5e (2024 rules) weapon mastery properties in Foundry VTT v14 with the dnd5e system (6.0 or later).

When you attack with a weapon whose mastery you know, the module works out which targets you hit from their AC.
After you roll damage, it posts a chat card with the mastery's rule and a button for each target.
Graze posts its card right after a missed attack, since it doesn't need a damage roll.

## The masteries

| Mastery | When | What the module does |
| --- | --- | --- |
| Cleave | Hit + damage | Opens a dialog listing creatures within 5 ft of the first target and within your reach. Pick one to roll the follow-up attack. Its damage drops a positive ability modifier. Once per turn in combat. |
| Graze | Miss | Button deals damage equal to the attack's ability modifier, of the weapon's damage type. |
| Nick | Hit + damage | Reminder card only. |
| Push | Hit + damage | Button pushes the target 10 ft straight away from you, if it's Large or smaller. Stops short at walls. |
| Sap | Hit + damage | Button adds a **Sapped** effect to the target. Its next attack roll has Disadvantage, then the effect is removed. |
| Slow | Hit + damage | Button adds a −10 ft Speed effect. A second Slow replaces the first, so it never stacks. |
| Topple | Hit + damage | Button rolls the target's Constitution save (DC 8 + your modifier + proficiency). On a fail it's Prone. |
| Vex | Hit + damage | Button adds a **Vexing** effect to you. Your next attack roll against that target has Advantage, then the effect is removed. |

### Sap, Slow and Vex effects

These are ordinary Active Effects. Open one on the actor sheet to see, edit or disable its changes.

| Effect | Change key | Change type | Value | Condition |
| --- | --- | --- | --- | --- |
| Sapped | `attack` | Advantage | `-1` | none |
| Slowed | `system.attributes.movement.bonus` | Add | `-10` | none |
| Vexing | `attack` | Advantage | `1` | `targetTokens` has the vexed token's uuid |

The module adds `targetTokens` to attack roll data: the uuids of the tokens you're targeting. You can use it in conditions on your own effects too.

In combat, Sap and Slow end at the start of the attacker's next turn and Vex ends at the end of it.
Outside combat they last until they're used or removed by hand.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Apply Automatically | Off | Applies Graze, Sap, Slow and Vex, and rolls Topple saves, as soon as the card is posted. Push stays a button. |
| Cleave Target Dialog | On | Opens the second-target dialog after a Cleave hit. When off, use the card's **Choose Target** button. |
| Players Can Use Buttons | On | Lets the attacking player use the card's buttons. When off, only the GM sees them. |

## Notes

- Targets you don't own (usually NPCs) are changed by the GM's client, so a GM must be logged in.
- Pick your targets before you attack. With no targets the card is still posted as a reminder.
- Choosing a mastery in the attack dialog (for example with a feature that grants extra masteries) is respected.

## Macro API

```js
const api = game.modules.get("dnd5e-weapon-mastery-automation").api;
api.openCleaveDialog(activity, firstTargetToken);
```
