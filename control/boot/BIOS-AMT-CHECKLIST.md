# At the PC: BIOS + Intel AMT (one time, ~5 min)

Dell OptiPlex 7050, BIOS 1.27.0, Intel ME 11.8.94.4494 (already past the 2017 AMT fixes, no update needed).
Keep this open on the phone: the PC screen is busy with the BIOS.

## 1. BIOS: press F2 repeatedly at the Dell logo
- Power Management → **AC Recovery** = **Power On** (boots by itself after a power cut)
- Power Management → **Wake on LAN/WLAN** = **LAN Only**
- Power Management → **Deep Sleep Control** = **Disabled** (keeps the network card powered when off)
- Intel AMT (may sit under "Manageability" or "Intel AMT Capability") → **Enable Intel AMT Capability**, **MEBx Hotkey** = Enabled
- POST Behavior → **Warnings and Errors** = **Continue on Warnings and Errors** (a boot warning no longer stops at "Press F1 to retry boot" waiting for a key nobody can press remotely)
- General → Date/Time: set the current date and time.
- Apply → Exit. Leave everything else as it is.

### "Time-of-day not set – please run SETUP program" (F1 / F2 / F5 screen)
The CMOS coin cell (CR2032, on the motherboard) is dead or weak, so the clock resets after every power loss and POST stops at this screen. Replace the battery (power off, unplug, wait 30 s, swap the cell, then set Date/Time in F2); the "Continue on Warnings and Errors" setting above is the safety net until then. Linux corrects the clock from the network once it is up. If the screen still appears on a remote power-on, press F1 through MeshCentral → the PC → Intel AMT → Remote Desktop (AMT KVM works before the OS).

## 2. AMT setup (MEBx): press Ctrl+P at the Dell logo
(Missed it? F12 at the logo → "Intel Management Engine BIOS Extension".)
- Login: default password `admin`. It forces a new one: 8-32 chars with upper, lower, digit and a symbol.
  **Save it in your password manager. Never send it to Claude or Discord.**
- Intel AMT Configuration:
  - Manageability Feature Selection = **Enabled**
  - SOL / Storage Redirection / KVM → **KVM Feature Selection = Enabled**
  - User Consent → **User Opt-in = NONE** (otherwise AMT shows a code on this screen that nobody remote can read)
  - Power Control → **Desktop: ON in S0, ME Wake in S3, S4-5**
  - Network Setup → TCP/IP → keep **DHCP** on
  - **Activate Network Access → Y**
- Exit MEBx. The PC boots, auto-logs in and locks as usual.

## 3. Check from the phone (on home Wi-Fi)
Open `http://<PC LAN IP>:16992` in the phone browser, log in as `admin` with the new AMT password.
If the Intel AMT page loads, tell Claude "amt works". (The PC cannot test this itself: its own OS can't reach its own AMT.)

## Why "User Opt-in = NONE" matters
It lets you see the screen and power-cycle without anyone at the desk. The AMT password becomes the key
to the machine below the OS, so make it long and unique. Claude will only connect it to your own
MeshCentral server over TLS (step 3), never expose port 16992 to the internet.
