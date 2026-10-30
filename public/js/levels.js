// What each station laptop shows the players. Edit the wording here.
// The facts match the firmware: decode_morse / level1 sketch, wheatstone_game2 /
// level2 sketch, findout_switches / level4 sketch, and lfc.ino (levels 5 and 6).

export const LEVEL_INFO = {
  1: {
    name: 'Dead Signal',
    tag: 'Optional · opens Box 1 (resistor colour-code sheet)',
    story: 'The reactor control panel display is dead. One LED is still alive, blinking a maintenance code in Morse, over and over.',
    how: [
      'Watch the LED. Short flash = dot, long flash = dash. Each digit is five symbols.',
      'Decode each digit with the Morse chart on this screen.',
      'The code loops forever. A long dark gap marks the start of the code, so find it before you write anything down.',
      'Type the code on the keypad and press <b>A</b> (<b>B</b> deletes a digit, <b>C</b> clears), or type it in the code box on this screen.',
      'A correct code scores the level and the coordinator opens Box 1.',
    ],
    rules: [
      'Do not touch, cover or move the ESP32 or the LED.',
      'No phone recording and no slow motion. Use only this laptop and the printed chart.',
      '3 attempts. Each wrong attempt costs 10 points.',
      'Same digits in the wrong order are wrong.',
      'Skipping is allowed only before Level 2 starts, and you cannot come back.',
    ],
  },
  2: {
    name: 'Failing Instrument',
    tag: 'Opens Box 2 (rule book + fault logs)',
    story: 'The plant instruments can no longer be trusted. Find the one resistor that balances the bridge and the instrument will read true again.',
    how: [
      'Use the resistor colour-code sheet to read the colour bands on the kit resistors.',
      'Place one resistor in the bridge slot on the breadboard.',
      'Watch the bridge voltage. Off balance it is away from zero.',
      'Bring the voltage to zero: when the bridge stays balanced for a moment, your code appears.',
      'Type that code in the code box on this screen to score the level. You can also enter it later.',
      'The coordinator then opens Box 2. Keep the rule book safe; you need it at the end.',
    ],
    rules: [
      'Use only the resistors in the kit. Place them gently and never force the breadboard.',
      'Do not touch the ESP32 or its wires.',
      '3 attempts at the Box 2 code; each wrong attempt costs 10 points.',
    ],
  },
  3: {
    name: 'Blackout',
    tag: 'Paper station · first code slip',
    story: 'Three control room logs describe the night the power failed. Only one of them is genuine.',
    how: [
      'Read all three log sheets and the verification card.',
      'Check each log against the card: times, breaker states and the power calculation.',
      'Only one log passes every check. In that log, find the entry where the real fault happens.',
      'The entry code of that row is your answer. Tell it to the coordinator.',
    ],
    rules: ['Read all three logs before you answer.', 'Keep the sheets in order and leave them at the station.', '3 attempts.'],
  },
  4: {
    name: 'Shutdown Interlock',
    tag: 'Second code slip',
    story: 'The protection panel is dark. Only one switch pattern satisfies every interlock and brings all six lamps back.',
    how: [
      'Each lamp L1–L6 lights when its logic condition is met by the switches S1–S6.',
      'Work out from the truth table sheet which switches must be ON and which OFF.',
      'Set the switches. This screen mirrors the panel lamps live.',
      'When all six lamps are lit together, the interlock releases. Read the labels on the switches that are ON.',
      'Type that code in the code box on this screen to score the level.',
    ],
    rules: ['Use the truth table provided.', 'Flip switches gently; never force them.', 'All six lamps must be lit at the same time.'],
  },
  5: {
    name: 'The Last Stable Second',
    tag: 'Third code slip',
    story: 'The grid is slipping and the turbine has stalled. Match generation to load and hold the frequency at 50 Hz to bring it back to life.',
    how: [
      'Move the slider to raise or lower generator output (blue line).',
      'The load (orange line) drifts and jumps on its own.',
      'Frequency stays near 50 Hz only while generation matches load. While it is stable, the turbine spins up; lose it and the turbine stalls.',
      'Keep it between 49.3 and 50.7 Hz for 15 seconds without a break. Losing balance resets the count.',
      'When the grid is stable, your code appears on this screen. Type it in the code box to score the level.',
    ],
    rules: ['Use only the slider.', 'Do not close or change anything on this laptop.', 'The 15 seconds must be continuous.'],
  },
  6: {
    name: 'AZ-5 Final Sequence',
    tag: 'Final level · beat the room clock or the siren sounds',
    story: 'The room clock is running out. Use every code slip and the rule book to find the final lock code, then press AZ-5 to shut the reactor down before the siren goes off.',
    how: [
      'Lay out the three code slips from Levels 3, 4 and 5.',
      'Find the rules in the rule book whose numbers match your codes.',
      'Read those rules closely. Each hides a digit or value in its wording, not in the rule number.',
      'Combine them in order, open the final lock, and press the AZ-5 mushroom button before the room clock runs out. If it runs out, the siren sounds.',
      'Codes you have not typed in yet can be entered on this screen. They only score once entered.',
    ],
    rules: ['All three codes are needed.', 'Press the button only once the lock is open.', 'The exit is never locked.'],
  },
};

// Standard Morse digits (same table as MORSE[] in the firmware).
export const MORSE = ['-----', '.----', '..---', '...--', '....-', '.....', '-....', '--...', '---..', '----.'];
