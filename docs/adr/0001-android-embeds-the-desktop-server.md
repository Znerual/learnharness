# Android app embeds the desktop server

The Android app (its own repo, `learnharness-android`, beside this one) runs this repo's Next.js standalone server on the phone under `nodejs-mobile` (Node 24, digidem fork) and shows the UI in a WebView, the same way `electron/` wraps it on desktop. We chose this over a native Kotlin rewrite and over a React Native/Capacitor port because the phone must read and write the exact same session and graph files as the desktop: running the same code makes format drift impossible by construction, and every desktop feature arrives on the phone with the next build.

## Consequences

- Mobile layout work happens in this repo, not in the Android repo. The Android repo is a shell: packaging, the Node runtime, and platform glue.
- Features that need a driveable browser (demo verification through `puppeteer-core`) degrade on the phone.
- The APK is large because it carries a Node runtime and the server bundle.
