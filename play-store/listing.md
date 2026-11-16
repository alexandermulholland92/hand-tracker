# Hand Mouse: Google Play listing (draft, 2026-11-16)

## App name (30 characters max)

Hand Mouse

## Short description (80 characters max)

Control your phone or computer with your hand: a touch-free mouse by camera.

(75 characters)

## Full description (4,000 characters max)

Hand Mouse turns your phone's camera into a touch-free mouse. Hold your hand up in front of the camera and move it: a pointer follows your index finger, and simple finger movements tap, swipe, drag and long-press. Use your phone without touching the screen, or use your phone as the mouse and keyboard of your computer.

CONTROL THIS PHONE WITHOUT TOUCHING IT
• Move your hand to move the pointer over any app.
• A quick curl of your index finger taps.
• A quick flick of your open hand up or down scrolls the page.
• Curl your index finger and move your hand to drag.
• A quick curl of your middle finger is a long press.
• Make a fist to hold the pointer still while you move your hand.
• Back, Home, Recents, volume and media keys, and typing into the text box you're in.
• A small camera window stays in a corner while you use other apps; its × stops it.

Handy when your hands are messy, gloved or busy, when the phone is out of reach on a stand, or for anyone who finds the touchscreen hard to use.

CONTROL YOUR COMPUTER
• Bluetooth: your phone pairs with your computer as a Bluetooth mouse and keyboard. Nothing to install on the computer.
• Wi-Fi: scan the code the free Hand Tracker app shows on your computer, and your hand moves its pointer, clicks and types.

BROWSE BY HAND
• Open websites in Hand Mouse and browse them with your hand.

PRIVATE BY DESIGN
• Hand tracking runs entirely on your phone. Camera pictures are never saved or sent anywhere.
• No account, no ads, no analytics, no trackers.
• Hand control uses Android's Accessibility service only to tap, swipe and type for you while you've started it. It reads nothing on screen except the text box you're typing in, and nothing it does leaves your phone.

Privacy policy: https://hand-tracker.com/privacy.html

## Category

Tools (or: Productivity)

## Tags / keywords to pick in the Console

hand tracking, gesture control, touch-free, accessibility, mouse, remote control

## Pictures

- App icon: play-store/icon-512.png (512 × 512)
- Feature graphic: play-store/feature-graphic.png (1024 × 500)
- Phone screenshots: still needed, at least 2 (taken on the phone: the app's screen with the camera on; the pointer over another app; pairing with a computer).

## Accessibility declaration (Play Console → App content → Accessibility API)

Hand Mouse is an accessibility tool (isAccessibilityTool="true"). It lets people use their phone without touching the screen: the camera follows their hand, and the accessibility service performs the taps, long presses, swipes, global actions (Back, Home, Recents) and media/volume keys they make with hand gestures, and types into the focused text box. It retrieves only the focused text field (typeViewFocused events) so it can type into it. It acts only while the user has started "This phone" in the app. No data from the service is collected, stored, or shared. The app shows a notice explaining this, with "Agree and open Accessibility" and "Not now", before it opens the Accessibility settings.

Video to record: open Hand Mouse → tap "2. Turn on hand control in Accessibility" → show the notice → Agree → turn it on → start "This phone" → tap, scroll and type in another app by hand.

## Foreground service declaration (camera)

PhoneControlService keeps following the user's hand with the camera while they use other apps (the hand-controlled pointer); it shows a notification while it runs and stops when the user taps × on the camera window or stops it in the app.

## Display over other apps

Draws the pointer and a small camera window over other apps while the user controls the phone by hand.

## Data safety form (suggested answers)

- Does the app collect or share any of the required user data types? No.
- Camera: processed on the device only, not collected (pictures never leave the device).
- Is data encrypted in transit? Not applicable (no data collected). The Wi-Fi link to the user's own computer is signed with a pairing key.
- Can users request data deletion? Not applicable (nothing is collected).

## Content rating

Fill in the IARC questionnaire: no violence, no user-generated content shared with others, no ads, no purchases → expected "Everyone" / PEGI 3.

## Target audience

18+ (or 13+); not designed for children.

## App access

All functions available without an account or login.

## Ads

No ads.
