# Changelog

## 1.0.0 (2026-11-12)
### Added
- Rebuilt for Foundry VTT v14 and dnd5e 6.
- Chat card for each weapon mastery after a hit and damage roll, with a button per target.
- Graze card after a missed attack, with a button to deal the damage.
- Cleave dialog to choose a second target and roll the follow-up attack without a positive ability modifier.
- Push moves the target 10 ft away and stops at walls.
- Sap, Slow and Vex are Active Effects that end on the attacker's turn or when used. Sap and Vex use dnd5e advantage rule changes, so they can be edited or disabled on the effect sheet.
- Attack roll data includes `targetTokens`, the uuids of the targeted tokens, for effect rule conditions.

### Requirements
- Foundry VTT v14 and dnd5e 6.0 or later, for the effect rule changes.
- Topple rolls the Constitution save and applies Prone on a fail.
- Settings: Apply Automatically, Cleave Target Dialog, Players Can Use Buttons.
