# Non-Visual Chemistry

Browser tools for reading ¹H NMR and IR spectra, molecular shape and conformational energy by ear and
by hand, built for students who are blind or have low vision. Each tool works with a PlayStation
DualSense controller (taps, vibration and adaptive-trigger resistance over WebHID) or with the keyboard
and sound alone.

> Designed with expert review; user evaluation pending.

## Modules

Built in this order:

| Module | What it does | Status |
|---|---|---|
| ¹H NMR by ear and hand | Pitch follows shift in ppm, taps give multiplicity (singlet to quartet, one pattern for anything more complex), speech gives integration and J in Hz | Next; target 2026-12-04 |
| Energy by force | Feel the Barrier, made fully non-visual: trigger resistance follows energy in kJ/mol | After NMR |
| IR by ear and hand | Same interaction on a 4000–400 cm⁻¹ axis; band shape by feel | Later |
| Shape by touch | Probe around a central atom; one bump per bonded atom | Later |

Phase 0 (this version): the shared controller driver and a [controller test page](controller-test.html).

Every page must be fully usable by keyboard and speech with a screen reader running (tested with
NVDA in Chrome on Windows). The controller is an optional extra layer.

## Running it

No build step. Open `index.html` in Chrome or Edge, either from disk or from GitHub Pages.

- **Chrome and Edge** reach the controller directly (WebHID), over a USB cable or Bluetooth:
  full-strength taps and trigger resistance.
- **Other browsers** read the sticks and buttons through the Gamepad API and give weaker vibration,
  with no trigger resistance.
- **No controller**: every action has a key, readings can be spoken, and taps play as clicks.

## Layout

```
index.html            landing page
controller-test.html  checks taps, trigger resistance, sticks and buttons
shared/dualsense.js   controller driver (WebHID + Gamepad API fallback)
shared/ui.css         shared styles, light and dark
docs/mappings.md      every sound and haptic mapping, with its numbers and the reason for it
```

## License

Code: MIT License (full text in `LICENSE`). Content (text, data, figures): CC BY 4.0.

The DualSense driver is adapted from *Feel the Barrier* by the same author.
