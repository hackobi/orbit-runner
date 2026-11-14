# Testing on a real phone

Everything about phones in `PLAN.md` is marked UNVERIFIED until this has been done on a real device. The automated tests use a phone's screen size and touch events inside desktop browser engines; that is not a phone.

## 1. Serve the game to the local network

On the Mac, in two terminals:

```
npm run server
npm run dev:lan
```

`dev:lan` prints a `Network:` address such as `https://192.168.1.20:5173/`. The page and the game socket share that one address.

**The first run changes this Mac.** It downloads the `mkcert` program from GitHub, creates a private certificate authority in `.cert/` (ignored by git; it contains a private key, so do not share the folder), and adds that authority to the Mac's keychain so that browsers on the Mac trust it. macOS asks for your password when it does. To undo it later: open Keychain Access, search for "mkcert", delete the certificate, and delete `.cert/`.

This step has not been run by the build: it needs your say-so, and nothing in the automated tests exercises it.

## 2. Make the phone trust the certificate

A phone will not open a secure game socket to a certificate it does not trust, even if you tap through the page warning.

**iPhone**

1. Send `.cert/rootCA.pem` to the phone (AirDrop is easiest).
2. Settings → General → VPN & Device Management → install the downloaded profile.
3. Settings → General → About → Certificate Trust Settings → switch on full trust for the mkcert certificate.
4. Open the `Network:` address in Safari.

To remove it afterwards: Settings → General → VPN & Device Management → the profile → Remove.

**Android**

1. Send `.cert/rootCA.pem` to the phone.
2. Settings → Security → Encryption & credentials → Install a certificate → CA certificate.
3. Open the `Network:` address in Chrome.

## 3. What to check

Hold the phone sideways. Fill in the result column; anything that fails is a bug to report with the phone model and OS version.

| # | Check | iPhone result | Android result |
|---|---|---|---|
| 1 | The page loads over HTTPS with no certificate warning, and the status line clears (the game socket connected) | | |
| 2 | Held upright, the page asks for the phone to be turned; sideways it shows the game | | |
| 3 | Nothing is hidden by the notch, the rounded corners or the home indicator | | |
| 4 | A finger on the left half shows the stick where it lands; the ship turns and pitches the way the stick moves | | |
| 5 | FIRE shoots while the stick is held; ▲ and ▼ change speed while both are held (three fingers) | | |
| 6 | No scrolling, zooming, text selection or long-press menu happens while playing | | |
| 7 | Flying feels smooth. Note the frame rate if you can (Safari: Develop menu from a Mac; Chrome: `chrome://inspect`) | | |
| 8 | After a minute, note whether the picture got coarser (the quality controller dropped a tier) | | |
| 9 | Settings (⚙) → "Tilt the phone to steer": iOS asks permission; tilting steers the right way round. Try both sideways orientations | | |
| 10 | Settings → "Invert pitch" flips the stick's up and down | | |
| 11 | Switch to another app for 3 s and back: the game resumes in the same seat, with the points intact | | |
| 12 | Switch away for 15 s and back: the ship was destroyed ("away too long") and respawns | | |
| 13 | Lock the phone for a minute and unlock: the game reconnects by itself | | |
| 14 | Turn Wi-Fi off for 5 s and on again: the game reconnects by itself | | |
| 15 | With Low Power Mode on (iPhone), the game is still playable at the lower frame rate | | |
| 16 | Add to Home Screen (iPhone: Share menu; Android: Chrome's install prompt), open it from there: no browser bars | | |
| 17 | Fly through a Zaphire orb (red): the store appears along the top and its buttons can be tapped | | |
| 18 | Two phones, or a phone and the Mac, in the same room: each sees the other move smoothly and can hit it | | |

The service worker (offline opening and the update prompt) is part of the production build only. To try it on a phone, run `npm run build`, then `ORBIT_LAN=1 npx vite preview`. It serves on port 4173, not the dev server's 5173, so that its service worker does not go on answering for the dev server afterwards. That command has not been run here either.
