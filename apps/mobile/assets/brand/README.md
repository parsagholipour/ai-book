# Tomeza — Promptbook

`google-g.png` is Google's unmodified [official sign-in icon](https://developers.google.com/static/identity/images/g-logo.png), used by the Google authentication button. Follow the [Google sign-in branding guidelines](https://developers.google.com/identity/branding-guidelines) when changing it.

The source SVG retains the exact vector geometry of [13 / Promptbook in Figma](https://www.figma.com/design/ax7QQ2zzRWgVx4Owtr3zcK?node-id=58-290), with its fill mapped to the app theme's primary green (`#0F6B5C`).

`tomeza-promptbook-symbol.png` is a transparent 520px render of that SVG. The Flutter brand widget tints it with the current theme's primary color, including in dark mode.

`tomeza-promptbook-app-icon.png` is the opaque 1024px launcher master: theme green (`#0F6B5C`) on ivory (`#FAFAF6`), with the symbol occupying 52% of the width. Android and iOS launcher sizes are derived from it. The Android adaptive foreground is transparent and includes its own safe-area padding.
